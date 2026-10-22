import { loadEditorKit, type MdtEditor } from "@/scripts/codemirror-loader";
import type { ScriptLog, ScriptTestResult } from "@/tools/http-script-runtime";
import type { HttpScripts } from "@/tools/http-workspace";

type ScriptKind = keyof HttpScripts;

export interface ScriptsPanelStrings {
  ScriptsLabel: string;
  ScriptEditorError: string;
  TestsPassed: string;
  TestsSkipped: string;
  ScriptErrorIn: string;
  ScriptPre: string;
  ScriptTest: string;
  phrases?: Record<string, string>;
}

/**
 * Scripts tab of a request: one editor switched between the pre-request and
 * post-response script (Postman's Scripts tab), CodeMirror with a plain
 * textarea while it loads or if it fails.
 */
export function bindScriptsEditor(root: HTMLElement, options: {
  strings: ScriptsPanelStrings;
  onChange(): void;
  onSubmit(): void;
}): { get(): HttpScripts | undefined; set(scripts: HttpScripts | undefined): void; mount(): void } {
  const s = options.strings;
  const panel = root.querySelector<HTMLElement>("#http-request-scripts-panel")!;
  const kinds = [...panel.querySelectorAll<HTMLButtonElement>("[data-http-script-kind]")];
  const textarea = panel.querySelector<HTMLTextAreaElement>("[data-http-script]")!;
  const host = panel.querySelector<HTMLElement>("[data-http-script-editor]")!;
  const editorError = panel.querySelector<HTMLElement>("[data-http-script-editor-error]")!;
  const mark = root.querySelector<HTMLElement>("[data-http-scripts-mark]")!;
  const values: HttpScripts = { pre: "", test: "" };
  let kind: ScriptKind = "pre";
  let editor: MdtEditor | null = null;
  let loading = false;
  let hydrating = false;

  const syncMark = (): void => {
    mark.textContent = values.pre.trim() || values.test.trim() ? "●" : "";
  };
  const show = (): void => {
    for (const button of kinds) button.setAttribute("aria-pressed", String(button.dataset.httpScriptKind === kind));
    textarea.value = values[kind];
    if (editor) {
      hydrating = true;
      editor.setValue(values[kind]);
      hydrating = false;
    }
  };
  const edited = (text: string): void => {
    values[kind] = text;
    syncMark();
    options.onChange();
  };

  textarea.addEventListener("input", () => edited(textarea.value));
  for (const button of kinds) {
    button.addEventListener("click", () => {
      kind = button.dataset.httpScriptKind as ScriptKind;
      show();
    });
  }

  return {
    get: () => values.pre.trim() || values.test.trim() ? { ...values } : undefined,
    set(scripts) {
      values.pre = scripts?.pre ?? "";
      values.test = scripts?.test ?? "";
      show();
      syncMark();
    },
    mount() {
      if (editor) {
        editor.view.requestMeasure();
        return;
      }
      if (loading) return;
      loading = true;
      void (async () => {
        try {
          const kit = await loadEditorKit();
          const mountPoint = document.createElement("div");
          mountPoint.style.height = "100%";
          const created = await kit.createEditor(mountPoint, {
            language: "typescript", label: s.ScriptsLabel, hintId: "http-script-hint", phrases: s.phrases,
            onSubmit: options.onSubmit,
            onChange: () => {
              textarea.value = created.getValue();
              if (!hydrating) edited(created.getValue());
            },
          });
          editor = created;
          show();
          host.replaceChildren(mountPoint);
          host.hidden = false;
          textarea.hidden = true;
          created.view.requestMeasure();
        } catch {
          editorError.textContent = s.ScriptEditorError;
          editorError.hidden = false;
        } finally {
          loading = false;
        }
      })();
    },
  };
}

export interface ScriptResults {
  tests: ScriptTestResult[];
  logs: ScriptLog[];
  error: { event: "prerequest" | "test"; script: string; message: string } | null;
}

/** The response's Tests tab: results with failures first explained, then the script console. */
export function bindTestsPanel(root: HTMLElement, strings: ScriptsPanelStrings): { render(results: ScriptResults | null): void } {
  const tab = root.querySelector<HTMLButtonElement>("#http-response-tests-tab")!;
  const count = root.querySelector<HTMLElement>("[data-http-tests-count]")!;
  const list = root.querySelector<HTMLElement>("[data-http-tests-list]")!;
  const empty = root.querySelector<HTMLElement>("[data-http-tests-empty]")!;
  const summary = root.querySelector<HTMLElement>("[data-http-tests-summary]")!;
  const error = root.querySelector<HTMLElement>("[data-http-script-error]")!;
  const consoleTitle = root.querySelector<HTMLElement>("[data-http-console-title]")!;
  const consoleOutput = root.querySelector<HTMLElement>("[data-http-console]")!;

  return {
    render(results) {
      const tests = results?.tests ?? [];
      const passed = tests.filter((entry) => entry.status === "pass").length;
      const failed = tests.filter((entry) => entry.status === "fail").length;
      const skipped = tests.length - passed - failed;
      const counted = tests.length - skipped;
      count.textContent = counted ? `${passed}/${counted}` : "";
      count.classList.toggle("is-error", failed > 0 || !!results?.error);
      count.classList.toggle("is-success", counted > 0 && failed === 0 && !results?.error);
      tab.classList.toggle("has-failures", failed > 0);
      summary.hidden = tests.length === 0;
      summary.textContent = strings.TestsPassed.replace("{passed}", String(passed)).replace("{total}", String(counted))
        + (skipped ? ` · ${strings.TestsSkipped.replace("{count}", String(skipped))}` : "");
      list.replaceChildren(...tests.map((entry) => {
        const item = document.createElement("li");
        item.className = `http-test is-${entry.status}`;
        const badge = document.createElement("span");
        badge.className = "http-test-badge mono";
        badge.textContent = entry.status === "pass" ? "PASS" : entry.status === "fail" ? "FAIL" : "SKIP";
        const name = document.createElement("span");
        name.className = "http-test-name";
        name.textContent = entry.name;
        item.append(badge, name);
        if (entry.error) {
          const detail = document.createElement("span");
          detail.className = "http-test-error mono";
          detail.textContent = entry.error;
          item.append(detail);
        }
        return item;
      }));
      empty.hidden = tests.length > 0 || !!results?.error || (results?.logs.length ?? 0) > 0;
      error.hidden = !results?.error;
      error.textContent = results?.error ? strings.ScriptErrorIn
        .replace("{event}", results.error.event === "prerequest" ? strings.ScriptPre : strings.ScriptTest)
        .replace("{script}", results.error.script)
        .replace("{message}", results.error.message) : "";
      const logs = results?.logs ?? [];
      consoleTitle.hidden = consoleOutput.hidden = logs.length === 0;
      consoleOutput.replaceChildren(...logs.map((entry) => {
        const line = document.createElement("span");
        line.className = `http-console-line is-${entry.level}`;
        line.textContent = `${entry.text}\n`;
        return line;
      }));
    },
  };
}
