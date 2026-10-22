import { runHttpRequest, type RequestRun, type RunDeps } from "./http-run.ts";
import type { ScriptTestResult } from "./http-script-runtime.ts";
import type { HttpSavedRequest, HttpWorkspace } from "./http-workspace.ts";

/**
 * Collection Runner of the HTTP client (Postman-style): runs the requests of a
 * folder, or of the whole tree, in tree order for a number of iterations, one
 * data row per iteration from a CSV or JSON file, honouring
 * `pm.execution.setNextRequest`, with a delay between requests and a stop.
 */
export const RUNNER_MAX_ITERATIONS = 1000;
export const RUNNER_MAX_ROWS = 10_000;
/** Steps per iteration before a `setNextRequest` loop is cut off. */
const MAX_STEPS_FACTOR = 50;

/** Requests under `folderId` (null: everything) in tree order: subfolders first, then the folder's own requests. */
export function runnerRequests(workspace: HttpWorkspace, folderId: string | null): HttpSavedRequest[] {
  const result: HttpSavedRequest[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null): void => {
    for (const folder of workspace.folders) {
      if (folder.parentId !== parentId || seen.has(folder.id)) continue;
      seen.add(folder.id);
      walk(folder.id);
    }
    result.push(...workspace.requests.filter((request) => request.folderId === parentId));
  };
  walk(folderId);
  return result;
}

export class RunnerDataError extends Error {
  readonly code: "json" | "json_shape" | "csv" | "rows";
  constructor(code: RunnerDataError["code"]) {
    super(code);
    this.code = code;
  }
}

/** RFC 4180 CSV: quoted fields with "" escapes and line breaks, CRLF or LF; the first row names the columns. */
function parseCsv(text: string): [string, unknown][][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === "\"" && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new RunnerDataError("csv");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((entry) => entry.some((cell) => cell !== ""));
  if (!header) return [];
  return body.map((cells) => header.map((name, column) => [name.trim(), cells[column] ?? ""] as [string, unknown]).filter(([name]) => name));
}

/** Iteration data from a `.json` file (an array of objects) or a CSV file. */
export function parseRunnerData(text: string, fileName: string): [string, unknown][][] {
  let rows: [string, unknown][][];
  if (/\.json$/iu.test(fileName) || /^\s*[[{]/u.test(text)) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new RunnerDataError("json");
    }
    if (!Array.isArray(data) || !data.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))) {
      throw new RunnerDataError("json_shape");
    }
    rows = data.map((entry) => Object.entries(entry as Record<string, unknown>));
  } else {
    rows = parseCsv(text);
  }
  if (rows.length > RUNNER_MAX_ROWS) throw new RunnerDataError("rows");
  return rows;
}

export interface RunnerStep {
  iteration: number;
  request: HttpSavedRequest;
  /** Present when the request ran (with or without a response). */
  run: RequestRun | null;
  /** A build or send error; the run goes on with the next request. */
  error: unknown;
}

export interface RunnerSummary {
  steps: number;
  tests: { passed: number; failed: number; skipped: number };
  /** Requests with a build, send or script error. */
  errors: number;
  totalMs: number;
  /** Why the run ended early, if it did. */
  stopped: "aborted" | "next_null" | "next_missing" | "loop" | null;
  /** Name given to setNextRequest that is not in the run. */
  missing?: string;
}

export interface RunnerOptions {
  requests: HttpSavedRequest[];
  iterations: number;
  data: [string, unknown][][];
  delayMs: number;
  signal: AbortSignal;
  onStep(step: RunnerStep, position: { iteration: number; index: number }): void;
  onStart?(position: { iteration: number; index: number; request: HttpSavedRequest }): void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const count = (tests: ScriptTestResult[], status: ScriptTestResult["status"]): number => tests.filter((entry) => entry.status === status).length;

/** Runs the collection; the deps carry the abort signal into scripts and the agent. */
export async function runCollection(workspace: HttpWorkspace, options: RunnerOptions, deps: RunDeps): Promise<RunnerSummary> {
  const summary: RunnerSummary = { steps: 0, tests: { passed: 0, failed: 0, skipped: 0 }, errors: 0, totalMs: 0, stopped: null };
  const iterations = Math.max(1, Math.min(RUNNER_MAX_ITERATIONS, options.data.length || options.iterations));
  const list = options.requests;
  let first = true;
  outer: for (let iteration = 0; iteration < iterations; iteration++) {
    let index = 0;
    let steps = 0;
    while (index < list.length) {
      if (options.signal.aborted) {
        summary.stopped = "aborted";
        break outer;
      }
      if (++steps > list.length * MAX_STEPS_FACTOR) {
        summary.stopped = "loop";
        break outer;
      }
      if (!first) await sleep(options.delayMs, options.signal);
      first = false;
      if (options.signal.aborted) {
        summary.stopped = "aborted";
        break outer;
      }
      const request = list[index]!;
      options.onStart?.({ iteration, index, request });
      const step: RunnerStep = { iteration, request, run: null, error: null };
      try {
        step.run = await runHttpRequest(workspace, request, deps, {
          iteration, iterationCount: iterations, iterationData: options.data[iteration] ?? [],
        });
      } catch (error) {
        if (options.signal.aborted) {
          summary.stopped = "aborted";
          break outer;
        }
        step.error = error;
      }
      summary.steps++;
      const run = step.run;
      if (run) {
        summary.tests.passed += count(run.tests, "pass");
        summary.tests.failed += count(run.tests, "fail");
        summary.tests.skipped += count(run.tests, "skip");
        if (run.response) summary.totalMs += run.response.elapsedMs;
      }
      if (step.error || run?.scriptError) summary.errors++;
      options.onStep(step, { iteration, index });
      const next = run?.nextRequest;
      if (next === null) {
        summary.stopped = "next_null";
        break outer;
      }
      if (next !== undefined) {
        const target = list.findIndex((entry) => entry.name === next);
        if (target < 0) {
          summary.stopped = "next_missing";
          summary.missing = next;
          break outer;
        }
        index = target;
      } else {
        index++;
      }
    }
  }
  return summary;
}
