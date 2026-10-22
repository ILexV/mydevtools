import { formatBytes } from "@/lib/format";
import { bindDialogClose } from "@/tools/http-scope-dialogs";
import type { RunDeps } from "@/tools/http-run";
import {
  parseRunnerData, runCollection, RunnerDataError, runnerRequests, RUNNER_MAX_ITERATIONS, type RunnerStep, type RunnerSummary,
} from "@/tools/http-runner";
import { folderChain } from "@/tools/http-variables";
import type { HttpSavedRequest, HttpWorkspace } from "@/tools/http-workspace";

export interface RunnerStrings {
  RunnerTitle: string;
  RunnerAll: string;
  RunnerIteration: string;
  RunnerProgress: string;
  RunnerSummary: string;
  RunnerStoppedAborted: string;
  RunnerStoppedNull: string;
  RunnerStoppedMissing: string;
  RunnerStoppedLoop: string;
  RunnerDataRows: string;
  RunnerDataJson: string;
  RunnerDataShape: string;
  RunnerDataCsv: string;
  RunnerDataTooMany: string;
  RunnerNoRequests: string;
  RunnerConnect: string;
  RunnerSkipped: string;
  ScriptErrorIn: string;
  ScriptPre: string;
  ScriptTest: string;
  UntitledRequest: string;
}

const DATA_LIMIT = 5 * 1024 * 1024;

/**
 * Collection Runner window: pick requests, iterations, delay and a data file,
 * run with live results (status, time, test counts and failures per request),
 * stop, and export the results as JSON. Closing the window stops the run.
 */
export function bindRunnerDialog(dialog: HTMLDialogElement, options: {
  strings: RunnerStrings;
  workspace(): HttpWorkspace;
  /** Saves the open request into the workspace first; false when saving failed. */
  prepare(): boolean;
  connected(): boolean;
  /** Request dependencies bound to the run's signal; `cancel` stops the agent request in flight. */
  deps(signal: AbortSignal): RunDeps & { cancel(): void };
  errorText(error: unknown): string;
  changed(): void;
}): { open(trigger: HTMLElement, folderId: string | null): void } {
  const s = options.strings;
  const title = dialog.querySelector<HTMLElement>("[data-http-runner-title]")!;
  const iterationsField = dialog.querySelector<HTMLInputElement>("[data-http-runner-iterations]")!;
  const delayField = dialog.querySelector<HTMLInputElement>("[data-http-runner-delay]")!;
  const dataInput = dialog.querySelector<HTMLInputElement>("[data-http-runner-data]")!;
  const dataPick = dialog.querySelector<HTMLButtonElement>("[data-http-runner-data-pick]")!;
  const dataName = dialog.querySelector<HTMLElement>("[data-http-runner-data-name]")!;
  const dataClear = dialog.querySelector<HTMLButtonElement>("[data-http-runner-data-clear]")!;
  const list = dialog.querySelector<HTMLElement>("[data-http-runner-list]")!;
  const setup = dialog.querySelector<HTMLElement>("[data-http-runner-setup]")!;
  const error = dialog.querySelector<HTMLElement>("[data-http-runner-error]")!;
  const start = dialog.querySelector<HTMLButtonElement>("[data-http-runner-start]")!;
  const stop = dialog.querySelector<HTMLButtonElement>("[data-http-runner-stop]")!;
  const exportButton = dialog.querySelector<HTMLButtonElement>("[data-http-runner-export]")!;
  const progress = dialog.querySelector<HTMLElement>("[data-http-runner-progress]")!;
  const summaryBox = dialog.querySelector<HTMLElement>("[data-http-runner-summary]")!;
  const results = dialog.querySelector<HTMLElement>("[data-http-runner-results]")!;
  const remember = bindDialogClose(dialog, dialog.querySelector<HTMLButtonElement>("[data-http-runner-close]")!);
  let folderId: string | null = null;
  let data: [string, unknown][][] = [];
  let controller: AbortController | null = null;
  let runDeps: (RunDeps & { cancel(): void }) | null = null;
  let report: Record<string, unknown> | null = null;

  const showError = (text: string | null): void => {
    error.textContent = text ?? "";
    error.hidden = !text;
  };
  const folderName = (): string => folderId === null ? s.RunnerAll
    : options.workspace().folders.find((folder) => folder.id === folderId)?.name ?? s.RunnerAll;
  const requestLabel = (request: HttpSavedRequest): string => {
    const workspace = options.workspace();
    const path = folderChain(workspace, request.folderId).filter((id) => id !== folderId && !folderChain(workspace, folderId).includes(id))
      .map((id) => workspace.folders.find((folder) => folder.id === id)?.name ?? "");
    return [...path, request.name || request.url || s.UntitledRequest].join(" / ");
  };
  const setRunning = (running: boolean): void => {
    start.hidden = running;
    stop.hidden = !running;
    for (const field of setup.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) field.disabled = running;
    iterationsField.disabled = running || data.length > 0;
  };
  const showData = (name: string | null): void => {
    dataName.textContent = name === null ? "" : s.RunnerDataRows.replace("{name}", name).replace("{rows}", String(data.length));
    dataClear.hidden = name === null;
    iterationsField.disabled = data.length > 0;
    if (data.length) iterationsField.value = String(Math.min(RUNNER_MAX_ITERATIONS, data.length));
  };

  dataPick.addEventListener("click", () => dataInput.click());
  dataClear.addEventListener("click", () => {
    data = [];
    dataInput.value = "";
    showData(null);
  });
  dataInput.addEventListener("change", async () => {
    const file = dataInput.files?.[0];
    if (!file) return;
    showError(null);
    try {
      if (file.size > DATA_LIMIT) throw new RunnerDataError("rows");
      data = parseRunnerData(await file.text(), file.name);
      showData(file.name);
    } catch (failure) {
      data = [];
      showData(null);
      const code = failure instanceof RunnerDataError ? failure.code : "json";
      showError(code === "json" ? s.RunnerDataJson : code === "json_shape" ? s.RunnerDataShape : code === "csv" ? s.RunnerDataCsv : s.RunnerDataTooMany);
    }
  });

  function renderList(): void {
    list.replaceChildren(...runnerRequests(options.workspace(), folderId).map((request) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      label.className = "ds-check-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "ds-check";
      box.checked = true;
      box.value = request.id;
      const method = document.createElement("span");
      method.className = "http-runner-method mono";
      method.textContent = request.method;
      const name = document.createElement("span");
      name.textContent = requestLabel(request);
      label.append(box, method, name);
      item.append(label);
      return item;
    }));
  }

  const iterationHeading = (iteration: number): HTMLLIElement => {
    const heading = document.createElement("li");
    heading.className = "http-runner-iteration";
    heading.textContent = s.RunnerIteration.replace("{n}", String(iteration + 1));
    return heading;
  };

  function renderStep(step: RunnerStep, showIterations: boolean, lastIteration: { value: number }): void {
    if (showIterations && step.iteration !== lastIteration.value) {
      results.append(iterationHeading(step.iteration));
      lastIteration.value = step.iteration;
    }
    const run = step.run;
    const item = document.createElement("li");
    item.className = "http-runner-result";
    const head = document.createElement("div");
    head.className = "http-runner-head";
    const method = document.createElement("span");
    method.className = "http-runner-method mono";
    method.textContent = run?.request.method ?? step.request.method;
    const name = document.createElement("span");
    name.className = "http-runner-name";
    name.textContent = requestLabel(step.request);
    name.title = run?.built?.url ?? step.request.url;
    const meta = document.createElement("span");
    meta.className = "http-runner-meta mono";
    const response = run?.response;
    const status = document.createElement("span");
    status.className = `http-runner-status${!response || response.status >= 400 ? " is-error" : ""}`;
    status.textContent = response ? String(response.status) : run?.skipped ? s.RunnerSkipped : "—";
    meta.append(status);
    if (response) meta.append(` · ${response.elapsedMs} ms · ${formatBytes(atob(response.bodyBase64).length)}`);
    const tests = run?.tests ?? [];
    const failed = tests.filter((entry) => entry.status === "fail");
    const counted = tests.filter((entry) => entry.status !== "skip");
    if (counted.length) {
      const badge = document.createElement("span");
      badge.className = `http-runner-tests${failed.length ? " is-error" : ""}`;
      badge.textContent = ` · ${counted.length - failed.length}/${counted.length}`;
      meta.append(badge);
    }
    head.append(method, name, meta);
    item.append(head);
    const notes: string[] = [];
    if (step.error) notes.push(options.errorText(step.error));
    if (run?.scriptError) {
      notes.push(s.ScriptErrorIn.replace("{event}", run.scriptError.event === "prerequest" ? s.ScriptPre : s.ScriptTest)
        .replace("{script}", run.scriptError.script).replace("{message}", run.scriptError.message));
    }
    for (const entry of failed) notes.push(`${entry.name}: ${entry.error ?? ""}`);
    if (notes.length) {
      const detail = document.createElement("ul");
      detail.className = "http-runner-notes mono";
      detail.append(...notes.map((text) => {
        const line = document.createElement("li");
        line.textContent = text;
        return line;
      }));
      item.append(detail);
      item.classList.add("is-error");
    }
    results.append(item);
  }

  function summaryText(summary: RunnerSummary): string {
    const text = s.RunnerSummary.replace("{steps}", String(summary.steps)).replace("{passed}", String(summary.tests.passed))
      .replace("{failed}", String(summary.tests.failed)).replace("{errors}", String(summary.errors)).replace("{time}", String(summary.totalMs));
    const stopped = summary.stopped === "aborted" ? s.RunnerStoppedAborted : summary.stopped === "next_null" ? s.RunnerStoppedNull
      : summary.stopped === "loop" ? s.RunnerStoppedLoop
      : summary.stopped === "next_missing" ? s.RunnerStoppedMissing.replace("{name}", summary.missing ?? "") : "";
    return stopped ? `${text} ${stopped}` : text;
  }

  start.addEventListener("click", async () => {
    showError(null);
    if (!options.prepare()) return;
    if (!options.connected()) {
      showError(s.RunnerConnect);
      return;
    }
    const chosen = new Set([...list.querySelectorAll<HTMLInputElement>("input:checked")].map((box) => box.value));
    const requests = runnerRequests(options.workspace(), folderId).filter((request) => chosen.has(request.id));
    if (!requests.length) {
      showError(s.RunnerNoRequests);
      return;
    }
    const iterations = Math.max(1, Math.min(RUNNER_MAX_ITERATIONS, Math.floor(Number(iterationsField.value)) || 1));
    const delayMs = Math.max(0, Math.min(60_000, Math.floor(Number(delayField.value)) || 0));
    const total = Math.min(RUNNER_MAX_ITERATIONS, data.length || iterations);
    const current = new AbortController();
    controller = current;
    const deps = options.deps(current.signal);
    runDeps = deps;
    results.replaceChildren();
    summaryBox.hidden = true;
    exportButton.hidden = true;
    progress.hidden = false;
    setRunning(true);
    const lastIteration = { value: -1 };
    const startedAt = new Date();
    const entries: Record<string, unknown>[] = [];
    let summary: RunnerSummary;
    try {
      summary = await runCollection(options.workspace(), {
        requests, iterations, data, delayMs, signal: current.signal,
        onStart: ({ iteration, index, request }) => {
          progress.textContent = s.RunnerProgress.replace("{iteration}", String(iteration + 1)).replace("{iterations}", String(total))
            .replace("{index}", String(index + 1)).replace("{count}", String(requests.length)).replace("{name}", requestLabel(request));
        },
        onStep: (step) => {
          if (step.run?.variablesChanged) options.changed();
          renderStep(step, total > 1, lastIteration);
          entries.push({
            iteration: step.iteration + 1, name: step.request.name, method: step.run?.request.method ?? step.request.method,
            url: step.run?.built?.url ?? step.request.url, status: step.run?.response?.status ?? null,
            timeMs: step.run?.response?.elapsedMs ?? null, skipped: step.run?.skipped ?? false,
            tests: step.run?.tests ?? [], ...(step.error ? { error: options.errorText(step.error) } : {}),
            ...(step.run?.scriptError ? { scriptError: step.run.scriptError } : {}),
          });
        },
      }, deps);
    } catch (failure) {
      summary = { steps: entries.length, tests: { passed: 0, failed: 0, skipped: 0 }, errors: 1, totalMs: 0, stopped: "aborted" };
      showError(options.errorText(failure));
    } finally {
      if (controller === current) {
        controller = null;
        runDeps = null;
      }
      setRunning(false);
      progress.hidden = true;
    }
    summaryBox.textContent = summaryText(summary);
    summaryBox.classList.toggle("is-error", summary.tests.failed > 0 || summary.errors > 0);
    summaryBox.hidden = false;
    report = { collection: folderName(), startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      iterations: total, delayMs, summary, results: entries };
    exportButton.hidden = false;
  });

  const stopRun = (): void => {
    if (!controller) return;
    runDeps?.cancel();
    controller.abort();
  };
  stop.addEventListener("click", stopRun);
  dialog.addEventListener("close", stopRun);

  exportButton.addEventListener("click", () => {
    if (!report) return;
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${folderName().replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim() || "run"}.run.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  return {
    open(trigger, id) {
      if (dialog.open) return;
      folderId = id;
      remember(trigger);
      title.textContent = s.RunnerTitle.replace("{name}", folderName());
      renderList();
      results.replaceChildren();
      summaryBox.hidden = true;
      exportButton.hidden = true;
      progress.hidden = true;
      report = null;
      showError(null);
      setRunning(false);
      dialog.showModal();
      start.focus();
    },
  };
}
