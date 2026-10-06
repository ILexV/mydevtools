/**
 * UUID Generator client. Reads settings, generates via `uuid.ts`, renders the
 * list (ds-result-row) with per-row copy + copy-all + download .txt + clear;
 * the output panel's empty state returns when the list is cleared.
 * SSR-safe; one-time init guard on the tool root.
 */
import { generateBatch, type UuidVersion, type UuidFormat, type UuidCase } from "@/tools/uuid";
import { copyWithFeedback, prepareCopyButton, syncEmptyState } from "@/scripts/tool-ui";

interface Strings {
  copy: string;
  copied: string;
  copyFailed: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-uuid-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const rootEl = document.querySelector<HTMLElement>("[data-uuid-tool]");
  if (!rootEl || rootEl.dataset.initialized) return;
  rootEl.dataset.initialized = "1";
  const root: HTMLElement = rootEl;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const list = root.querySelector<HTMLOListElement>("[data-uuid-list]");
  const output = root.querySelector<HTMLElement>("[data-uuid-output]");
  const countInput = root.querySelector<HTMLInputElement>("[data-uuid-count]");
  const countVal = root.querySelector<HTMLElement>("[data-uuid-count-val]");
  const genBtn = root.querySelector<HTMLButtonElement>("[data-uuid-generate]");
  const copyAllBtn = root.querySelector<HTMLButtonElement>("[data-uuid-copyall]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-uuid-download]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-uuid-clear]");
  const errorEl = root.querySelector<HTMLElement>("[data-uuid-error]");

  let items: string[] = [];

  const radio = (name: string): string =>
    root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? "";

  function showError(msg: string): void {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function render(next: string[]) {
    items = next;
    const has = items.length > 0;
    if (list) {
      list.replaceChildren(
        ...items.map((u, i) => {
          const li = document.createElement("li");
          li.className = "ds-result-row ds-result-row-index";
          const idx = document.createElement("span");
          idx.className = "ds-result-key";
          idx.textContent = String(i + 1);
          const val = document.createElement("span");
          val.className = "ds-result-value";
          val.textContent = u;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "ds-btn ds-btn-small ds-btn-ghost";
          btn.dataset.copy = u;
          btn.textContent = strings.copy;
          btn.setAttribute("aria-label", `${strings.copy} #${i + 1}`);
          prepareCopyButton(btn, strings.copied);
          li.append(idx, val, btn);
          return li;
        }),
      );
    }
    if (output) syncEmptyState(output, !has);
    if (copyAllBtn) copyAllBtn.hidden = !has;
    if (downloadBtn) downloadBtn.hidden = !has;
    if (clearBtn) clearBtn.hidden = !has;
    showError("");
  }

  list?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
    if (!btn) return;
    if (!(await copyWithFeedback(btn, btn.dataset.copy ?? "", strings.copied))) showError(strings.copyFailed);
  });

  countInput?.addEventListener("input", () => {
    if (countVal) countVal.textContent = countInput.value;
  });

  genBtn?.addEventListener("click", () => {
    render(
      generateBatch(
        radio("uuid-version") as UuidVersion,
        radio("uuid-format") as UuidFormat,
        radio("uuid-case") as UuidCase,
        countInput ? Number(countInput.value) : 1,
      ),
    );
  });

  copyAllBtn?.addEventListener("click", async () => {
    if (!(await copyWithFeedback(copyAllBtn, items.join("\n"), strings.copied))) showError(strings.copyFailed);
  });

  downloadBtn?.addEventListener("click", () => {
    const blob = new Blob([items.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uuids-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the download has started (Firefox/Safari need the URL alive).
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  clearBtn?.addEventListener("click", () => {
    render([]);
    genBtn?.focus();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
