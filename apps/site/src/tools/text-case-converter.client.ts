/**
 * Text Case Converter client. Wires each case button to apply its transform
 * in-place to the textarea. Clear empties; Copy writes to clipboard with
 * transient feedback. All transforms come from `text-case.ts` (pure JS).
 */
import { convertCase, type CaseType } from "@/tools/text-case";

interface Strings {
  copied: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-tcc-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-tcc-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const textarea = root.querySelector<HTMLTextAreaElement>("[data-tcc-textarea]");
  if (!textarea) return;
  const input = textarea;

  root.addEventListener("click", (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const caseBtn = target.closest<HTMLButtonElement>("[data-tcc-case]");
    if (caseBtn) {
      e.preventDefault();
      const type = caseBtn.dataset.tccCase as CaseType;
      input.value = convertCase(input.value, type);
      return;
    }
    if (target.closest("[data-tcc-clear]")) {
      e.preventDefault();
      input.value = "";
      input.focus();
      return;
    }
    const copyBtn = target.closest<HTMLButtonElement>("[data-tcc-copy]");
    if (copyBtn) {
      e.preventDefault();
      void navigator.clipboard
        .writeText(input.value)
        .then(() => {
          const orig = copyBtn.textContent;
          copyBtn.textContent = strings.copied;
          window.setTimeout(() => {
            copyBtn.textContent = orig;
          }, 1200);
        })
        .catch(() => {
          /* clipboard unavailable */
        });
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
