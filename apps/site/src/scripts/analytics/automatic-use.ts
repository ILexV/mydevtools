import type { ToolErrorCategory, ToolEvent, ToolId } from "./events.ts";
import { durationBucket, type ToolEventSink } from "./instrumentation.ts";
import { trackToolEvent } from "./trackToolEvent.ts";

export interface AutomaticToolRun {
  complete(): void;
  fail(reason: ToolErrorCategory): void;
}

export interface AutomaticToolUse {
  /** Mark a meaningful human edit/configuration change. Do not call for initialization or examples. */
  changed(): void;
  /** Start the resulting processing after debounce/validation, so duration excludes typing and waiting. */
  start(): AutomaticToolRun | null;
  discard(): void;
}

type TimerHandle = Parameters<typeof clearTimeout>[0];

export interface AutomaticUseDependencies {
  emit?: ToolEventSink;
  clock?: () => number;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  unschedule?: (handle: TimerHandle | undefined) => void;
}


/**
 * Coalesces a burst of live edits into the final settled operation. Superseded
 * runs are discarded without being reported as failures or cancellations.
 */
export function createAutomaticToolUse(
  tool: ToolId,
  settleMs = 600,
  dependencies: AutomaticUseDependencies = {},
): AutomaticToolUse {
  let revision = 0;
  let changed = false;
  let timer: TimerHandle | undefined;
  const emit = dependencies.emit ?? trackToolEvent;
  const clock = dependencies.clock ?? (() => typeof performance === "undefined" ? Date.now() : performance.now());
  const schedule = dependencies.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const unschedule = dependencies.unschedule ?? ((handle) => clearTimeout(handle));

  const discard = () => {
    revision++;
    changed = false;
    unschedule(timer);
    timer = undefined;
  };

  return {
    changed() {
      revision++;
      changed = true;
      unschedule(timer);
      timer = undefined;
    },
    start() {
      if (!changed) return null;
      unschedule(timer);
      timer = undefined;
      const mine = ++revision;
      const startedAt = clock();
      let settled = false;
      const finish = (reason?: ToolErrorCategory) => {
        if (settled || mine !== revision) return;
        settled = true;
        const finishedAt = clock();
        const elapsed = Math.max(0, finishedAt - startedAt);
        timer = schedule(() => {
          timer = undefined;
          if (mine !== revision) return;
          changed = false;
          const started: ToolEvent = { tool, event: "tool_started" };
          emit(started);
          if (reason) emit({ tool, event: "tool_failed", reason });
          else emit({ tool, event: "tool_completed", duration: durationBucket(elapsed) });
        }, settleMs);
      };
      return {
        complete: () => finish(),
        fail: (reason) => finish(reason),
      };
    },
    discard,
  };
}
