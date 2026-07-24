/**
 * JSON Beautifier client controller. CodeMirror 5 editor (via
 * `ensureCodeMirror`, vendored legacy build) with format (indent 2/4/tab,
 * sort keys, compact/minify), open/save .json file, drag & drop, copy/clear,
 * Ctrl/Cmd-Enter format + Ctrl/Cmd-K clear shortcuts.
 *
 * Pure JS (JSON.parse / JSON.stringify) — legacy parity, no WASM.
 * Legacy persisted the input text to localStorage; that is intentionally NOT
 * ported (privacy). Only the formatting settings persist.
 */
import { ensureCodeMirror } from "@/scripts/codemirror-loader";

/** Minimal vendored CodeMirror 5 surface this tool uses. */
interface CodeMirrorEditor {
  getValue(): string;
  setValue(value: string): void;
  setSize(width: number | string | null, height: number | string | null): void;
  setOption(option: string, value: unknown): void;
  refresh(): void;
}

type CodeMirrorConstructor = (element: HTMLElement, options: Record<string, unknown>) => CodeMirrorEditor;

interface Strings {
  errorInvalidJson: string;
  copied: string;
  copy: string;
  inputPlaceholder: string;
}

const COPY_RESET_MS = 2000; // legacy used 2000ms here (not 1200)

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-json-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-json-tool]");
  if (!root) return;
  const strings = readStrings();
  if (!strings) return;

  const editorEl = root.querySelector<HTMLElement>("[data-json-editor]");
  const formatBtn = root.querySelector<HTMLButtonElement>("[data-json-format]");
  if (!editorEl || !formatBtn) return;
  const editorContainer: HTMLElement = editorEl;

  const clearBtn = root.querySelector<HTMLButtonElement>("[data-json-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-json-copy]");
  const indentSelect = root.querySelector<HTMLSelectElement>("[data-json-indent]");
  const sortKeysCheckbox = root.querySelector<HTMLInputElement>("[data-json-sort]");
  const compactModeCheckbox = root.querySelector<HTMLInputElement>("[data-json-compact]");
  const openFileBtn = root.querySelector<HTMLButtonElement>("[data-json-open]");
  const saveFileBtn = root.querySelector<HTMLButtonElement>("[data-json-save]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-json-file]");

  const str: Strings = strings;

  ensureCodeMirror()
    .then(() => {
      // `window.CodeMirror` is `unknown` (declared by codemirror-loader); the
      // vendored script defines exactly this constructor — narrow, then cast.
      const CM: CodeMirrorConstructor | null =
        typeof window.CodeMirror === "function" ? (window.CodeMirror as CodeMirrorConstructor) : null;
      if (!CM) return;

      const editor = CM(editorContainer, {
        mode: { name: "javascript", json: true },
        lineNumbers: true,
        lineWrapping: true,
        autoCloseBrackets: true,
        matchBrackets: true,
        indentUnit: 4,
        tabSize: 4,
        theme: "default",
        placeholder: str.inputPlaceholder,
        viewportMargin: Infinity,
        foldGutter: true,
        gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
      });

      editor.setSize(null, "600px");

      // Restore saved settings (input text persistence intentionally dropped — privacy).
      const savedIndent = storageGet("json-beautifier-indent");
      if (savedIndent && indentSelect) indentSelect.value = savedIndent;
      const savedSortKeys = storageGet("json-beautifier-sort-keys");
      if (savedSortKeys && sortKeysCheckbox) sortKeysCheckbox.checked = savedSortKeys === "true";
      const savedCompactMode = storageGet("json-beautifier-compact-mode");
      if (savedCompactMode && compactModeCheckbox) compactModeCheckbox.checked = savedCompactMode === "true";

      // Refresh on theme change so CSS-variable styling re-applies (legacy parity).
      const themeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "attributes" && mutation.attributeName === "data-theme") {
            editor.refresh();
          }
        }
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      editor.refresh();

      function clearError() {
        editorContainer.classList.remove("is-error");
      }

      function showNotification(message: string, type: "error" | "info" = "info") {
        const notification = document.createElement("div");
        notification.className = `json-notification json-notification-${type}`;
        notification.textContent = message;
        editorContainer.parentElement?.insertBefore(notification, editorContainer);
        setTimeout(() => {
          notification.remove();
        }, 3000);
      }

      function formatJSON() {
        const input = String(editor.getValue()).trim();
        if (!input) return;

        try {
          const parsed = JSON.parse(input);
          // Sort-keys replacer (legacy parity): rebuild plain objects with sorted keys.
          const sortReplacer = (_key: string, value: unknown): unknown => {
            if (value && typeof value === "object" && !Array.isArray(value)) {
              const sorted: Record<string, unknown> = {};
              for (const k of Object.keys(value as Record<string, unknown>).sort()) {
                sorted[k] = (value as Record<string, unknown>)[k];
              }
              return sorted;
            }
            return value;
          };

          const indentValue = indentSelect?.value ?? "4";
          const space = compactModeCheckbox?.checked ? 0 : indentValue === "tab" ? "\t" : parseInt(indentValue, 10);
          const formatted = sortKeysCheckbox?.checked
            ? JSON.stringify(parsed, sortReplacer, space)
            : JSON.stringify(parsed, null, space);

          editor.setValue(formatted);

          // Sync CodeMirror indent options with the chosen style (legacy parity).
          if (!compactModeCheckbox?.checked) {
            if (indentValue === "tab") {
              editor.setOption("indentWithTabs", true);
            } else {
              editor.setOption("indentWithTabs", false);
              editor.setOption("indentUnit", parseInt(indentValue, 10));
              editor.setOption("tabSize", parseInt(indentValue, 10));
            }
          }

          clearError();
        } catch (e) {
          editorContainer.classList.add("is-error");
          console.error("JSON Error:", (e as Error)?.message);
          showNotification(str.errorInvalidJson, "error");
        }
      }

      function clearAll() {
        editor.setValue("");
        clearError();
      }

      function copyToClipboard() {
        if (!copyBtn) return;
        const btn: HTMLButtonElement = copyBtn;
        navigator.clipboard
          .writeText(String(editor.getValue()))
          .then(() => {
            const originalText = btn.textContent;
            btn.textContent = str.copied;
            setTimeout(() => {
              btn.textContent = originalText || str.copy;
            }, COPY_RESET_MS);
          })
          .catch((err) => {
            console.error("Failed to copy:", err);
          });
      }

      function readFileIntoEditor(file: File) {
        const reader = new FileReader();
        reader.onload = (e) => {
          editor.setValue(String(e.target?.result ?? ""));
        };
        reader.readAsText(file);
      }

      function saveFile() {
        const text = String(editor.getValue());
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "formatted.json";
        a.click();
        URL.revokeObjectURL(url);
      }

      // Event listeners
      formatBtn.addEventListener("click", formatJSON);
      clearBtn?.addEventListener("click", clearAll);
      copyBtn?.addEventListener("click", copyToClipboard);
      openFileBtn?.addEventListener("click", () => fileInput?.click());
      fileInput?.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file) readFileIntoEditor(file);
      });
      saveFileBtn?.addEventListener("click", saveFile);

      // Auto-format on settings change (legacy parity; settings persist, input does not).
      indentSelect?.addEventListener("change", () => {
        storageSet("json-beautifier-indent", indentSelect.value);
        if (String(editor.getValue()).trim()) formatJSON();
      });
      sortKeysCheckbox?.addEventListener("change", () => {
        storageSet("json-beautifier-sort-keys", String(sortKeysCheckbox.checked));
        if (String(editor.getValue()).trim()) formatJSON();
      });
      compactModeCheckbox?.addEventListener("change", () => {
        storageSet("json-beautifier-compact-mode", String(compactModeCheckbox.checked));
        if (String(editor.getValue()).trim()) formatJSON();
      });

      // Keyboard shortcuts (legacy parity)
      editor.setOption("extraKeys", {
        "Ctrl-Enter": formatJSON,
        "Cmd-Enter": formatJSON,
        "Ctrl-K": clearAll,
        "Cmd-K": clearAll,
      });

      // Drag and drop (legacy parity)
      editorContainer.addEventListener("dragover", (e) => {
        e.preventDefault();
        editorContainer.classList.add("drag-over");
      });
      editorContainer.addEventListener("dragleave", (e) => {
        e.preventDefault();
        editorContainer.classList.remove("drag-over");
      });
      editorContainer.addEventListener("drop", (e) => {
        e.preventDefault();
        editorContainer.classList.remove("drag-over");
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          const file = files[0];
          if (file.type === "application/json" || file.name.endsWith(".json")) {
            readFileIntoEditor(file);
          }
        }
      });
    })
    .catch((err) => {
      console.error("JSON Beautifier: failed to load CodeMirror:", err);
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
