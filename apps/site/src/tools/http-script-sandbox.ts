import { runHttpScripts, type ScriptJob, type ScriptOutcome } from "@/tools/http-script-runtime";

/**
 * Runs HTTP client scripts away from the page: a Worker inside a sandboxed
 * iframe (opaque origin, no storage or cookies) whose CSP allows no network,
 * no imports and nothing but blob workers. Variables never leave the browser,
 * even from a script that came with an imported collection. A script that
 * runs too long is stopped by terminating its worker.
 */
export class ScriptTimeoutError extends Error {
  constructor() {
    super("script_timeout");
    this.name = "ScriptTimeoutError";
  }
}

const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:";

// The frame only relays: each job gets a fresh worker, terminated when it answers or is cancelled.
const FRAME_SCRIPT = `
const workers = new Map();
onmessage = (event) => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message.cancel) {
    workers.get(message.cancel)?.terminate();
    workers.delete(message.cancel);
    return;
  }
  const url = URL.createObjectURL(new Blob([message.source], { type: "text/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  workers.set(message.id, worker);
  const finish = (reply) => {
    worker.terminate();
    workers.delete(message.id);
    parent.postMessage({ id: message.id, ...reply }, "*");
  };
  worker.onmessage = (reply) => finish({ outcome: reply.data });
  worker.onerror = (error) => { error.preventDefault(); finish({ failure: error.message || "Script worker failed" }); };
  worker.postMessage(message.job);
};
`;

const WORKER_SOURCE = `const runHttpScripts = ${runHttpScripts.toString()};
onmessage = async (event) => {
  try {
    postMessage(await runHttpScripts(event.data));
  } catch (error) {
    postMessage({ ops: [], locals: [], request: event.data.request, tests: [], logs: [], skipRequest: false,
      error: { script: "", message: error instanceof Error ? error.name + ": " + error.message : String(error) } });
  }
};`;

export class ScriptSandbox {
  #frame: HTMLIFrameElement | null = null;
  #ready: Promise<Window> | null = null;
  #pending = new Map<string, { resolve(outcome: ScriptOutcome): void; reject(error: unknown): void }>();
  #next = 0;

  constructor() {
    window.addEventListener("message", (event) => {
      if (!this.#frame || event.source !== this.#frame.contentWindow) return;
      const data = event.data as { id?: string; outcome?: ScriptOutcome; failure?: string };
      const pending = typeof data?.id === "string" ? this.#pending.get(data.id) : undefined;
      if (!pending) return;
      this.#pending.delete(data.id!);
      if (data.outcome) pending.resolve(data.outcome);
      else pending.reject(new Error(data.failure ?? "Script worker failed"));
    });
  }

  #window(): Promise<Window> {
    this.#ready ??= new Promise<Window>((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.sandbox.add("allow-scripts");
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><script>${FRAME_SCRIPT}</script>`;
      frame.addEventListener("load", () => frame.contentWindow ? resolve(frame.contentWindow) : reject(new Error("Script sandbox unavailable")), { once: true });
      this.#frame = frame;
      document.body.append(frame);
    });
    return this.#ready;
  }

  /** Runs a job; rejects with ScriptTimeoutError after `timeoutMs`, or AbortError on `signal`. */
  async run(job: ScriptJob, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ScriptOutcome> {
    const target = await this.#window();
    const id = `s${++this.#next}`;
    return new Promise<ScriptOutcome>((resolve, reject) => {
      const stop = (error: unknown) => {
        if (!this.#pending.delete(id)) return;
        done();
        target.postMessage({ cancel: id }, "*");
        reject(error);
      };
      const timer = window.setTimeout(() => stop(new ScriptTimeoutError()), options.timeoutMs ?? 10_000);
      const onAbort = () => stop(new DOMException("Aborted", "AbortError"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        window.clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.#pending.set(id, {
        resolve: (outcome) => { done(); resolve(outcome); },
        reject: (error) => { done(); reject(error); },
      });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      // The frame has an opaque origin, so "*" is the only target; it is our own window reference.
      target.postMessage({ id, source: WORKER_SOURCE, job }, "*");
    });
  }
}
