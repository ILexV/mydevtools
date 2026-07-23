/**
 * Hex Encoder / Decoder client controller. Drives the `HexEncoder.astro`
 * shell: one-shot text encode/decode via `encoding-client`, worker-backed file
 * encode/decode with progress + cancel via `encoding-file-client`.
 *
 * Parity with the legacy `hex-encoder.js`: separate Encode/Decode buttons,
 * swap/clear, charset + case (lower/upper → `upper`) settings, decode toggles
 * (ignore whitespace, allow `:`/`-` separators, allow `0x` prefix), and a
 * preview/full output mode for file encodes (preview truncates the rendered
 * text; download always carries the full output). Text-mode errors that carry
 * a "position N" marker move the caret to the offending character, like the
 * legacy tool did.
 *
 * Loads only on the hex tool page; SSR-safe no-op when the shell is absent.
 */
import { encodeText, decodeText, decodeToBytes } from "@/scripts/wasm/encoding-client";
import type { EncodingOptions } from "@/scripts/wasm/encoding-client";
import { encodeFile, decodeFile } from "@/scripts/wasm/encoding-file-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

interface Strings {
  copy: string;
  copied: string;
  cancel: string;
  fileProgressTitle: string;
  error: string;
}

const PREVIEW_CHAR_LIMIT = 200_000;

function readStrings(): Strings | null {
  const island = document.querySelector<HTMLScriptElement>("[data-hex-strings]");
  if (!island) return null;
  try {
    return JSON.parse(island.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-hex-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const input = root.querySelector<HTMLTextAreaElement>("[data-hex-input]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-hex-output]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-hex-file]");
  const fileName = root.querySelector<HTMLElement>("[data-hex-filename]");
  const fileClearBtn = root.querySelector<HTMLButtonElement>("[data-hex-file-clear]");
  const charsetSel = root.querySelector<HTMLSelectElement>("[data-hex-charset]");
  const caseSel = root.querySelector<HTMLSelectElement>("[data-hex-case]");
  const outputModeSel = root.querySelector<HTMLSelectElement>("[data-hex-output-mode]");
  const ignoreWsBox = root.querySelector<HTMLInputElement>("[data-hex-ignore-whitespace]");
  const allowSepBox = root.querySelector<HTMLInputElement>("[data-hex-allow-separators]");
  const allow0xBox = root.querySelector<HTMLInputElement>("[data-hex-allow-0x]");
  const encodeBtn = root.querySelector<HTMLButtonElement>("[data-hex-encode]");
  const decodeBtn = root.querySelector<HTMLButtonElement>("[data-hex-decode]");
  const swapBtn = root.querySelector<HTMLButtonElement>("[data-hex-swap]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-hex-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-hex-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-hex-download]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-hex-cancel]");
  const progress = root.querySelector<HTMLElement>("[data-hex-progress]");
  const progressFill = root.querySelector<HTMLElement>("[data-hex-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-hex-progress-label]");
  const errorBox = root.querySelector<HTMLElement>("[data-hex-error]");
  if (!input || !output || !errorBox) return;
  // Explicit non-null aliases: narrowing doesn't flow into hoisted function
  // declarations, so the handlers below use these instead.
  const inputArea: HTMLTextAreaElement = input;
  const outputArea: HTMLTextAreaElement = output;
  const errorArea: HTMLElement = errorBox;

  let currentFile: File | null = null;
  let abortController: AbortController | null = null;
  let lastDownload: { blob: Blob; name: string } | null = null;

  function readOptions(): EncodingOptions {
    return {
      format: "hex",
      upper: caseSel?.value === "upper",
      ignoreWhitespace: ignoreWsBox?.checked ?? true,
      allowSeparators: allowSepBox?.checked ?? true,
      allow0x: allow0xBox?.checked ?? true,
      charset: charsetSel?.value ?? "utf-8",
    };
  }

  function showError(msg: string) {
    errorArea.textContent = msg;
    errorArea.hidden = false;
  }
  function clearError() {
    errorArea.hidden = true;
  }

  /** Text-mode error: surface message and move the caret to "position N" when present. */
  function showTextError(msg: string) {
    showError(msg);
    const match = msg.match(/position (\d+)/);
    if (!match) return;
    const index = Number.parseInt(match[1], 10);
    try {
      inputArea.focus();
      inputArea.setSelectionRange(index, Math.min(index + 1, inputArea.value.length));
    } catch {
      /* ignore */
    }
  }

  function setLastDownload(dl: { blob: Blob; name: string } | null) {
    lastDownload = dl;
    if (downloadBtn) downloadBtn.disabled = !dl;
  }

  function setBusy(busy: boolean) {
    if (encodeBtn) encodeBtn.disabled = busy;
    if (decodeBtn) decodeBtn.disabled = busy;
  }

  function setProgressVisible(visible: boolean) {
    if (progress) progress.hidden = !visible;
    if (!visible && progressFill) progressFill.style.width = "0%";
  }

  function updateFileUi() {
    if (fileName) {
      fileName.textContent = currentFile ? `${currentFile.name} (${formatBytes(currentFile.size)})` : "";
    }
    if (fileClearBtn) fileClearBtn.hidden = !currentFile;
  }

  fileInput?.addEventListener("change", () => {
    currentFile = fileInput.files?.[0] ?? null;
    if (currentFile) {
      // File mode replaces the text input (legacy parity).
      inputArea.value = "";
      outputArea.value = "";
      setLastDownload(null);
      clearError();
    }
    updateFileUi();
  });

  fileClearBtn?.addEventListener("click", () => {
    currentFile = null;
    if (fileInput) fileInput.value = "";
    updateFileUi();
  });

  function onProgress({ processed, total, elapsedMs }: { processed: number; total: number; elapsedMs: number }) {
    const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressLabel) {
      const speed = elapsedMs > 0 ? (processed / elapsedMs) * 1000 : 0;
      progressLabel.textContent =
        `${pct.toFixed(1)}% · ${formatBytes(processed)} / ${formatBytes(total)} · ${formatBytes(speed)}/s`;
    }
  }

  function handleError(e: unknown) {
    if (e instanceof WasmError && e.code === "aborted") {
      clearError();
      return;
    }
    const msg = e instanceof Error ? e.message : strings.error;
    if (currentFile) {
      showError(msg);
    } else {
      showTextError(msg);
    }
  }

  async function handleEncode() {
    clearError();
    const options = readOptions();
    abortController = new AbortController();
    setBusy(true);
    try {
      if (currentFile) {
        setProgressVisible(true);
        const result = await encodeFile(options, currentFile, {
          signal: abortController.signal,
          onProgress,
        });
        const fullText = result.text;
        const previewMode = (outputModeSel?.value ?? "preview") !== "full";
        if (previewMode && fullText.length > PREVIEW_CHAR_LIMIT) {
          outputArea.value =
            fullText.slice(0, PREVIEW_CHAR_LIMIT) +
            "\n…(preview truncated, use Download for full output)";
        } else {
          outputArea.value = fullText;
        }
        setLastDownload({
          blob: new Blob([fullText], { type: "text/plain" }),
          name: `${currentFile.name}.hex`,
        });
      } else {
        const out = await encodeText(options, inputArea.value ?? "");
        outputArea.value = out;
        setLastDownload({ blob: new Blob([out], { type: "text/plain" }), name: "text.hex" });
      }
    } catch (e) {
      handleError(e);
    } finally {
      setProgressVisible(false);
      setBusy(false);
      abortController = null;
    }
  }

  async function handleDecode() {
    clearError();
    const options = readOptions();
    abortController = new AbortController();
    setBusy(true);
    try {
      if (currentFile) {
        setProgressVisible(true);
        const result = await decodeFile(options, currentFile, {
          signal: abortController.signal,
          onProgress,
        });
        const bytes = result.bytes ?? new Uint8Array(0);
        outputArea.value = `Decoded ${currentFile.name} → ${currentFile.name}.bin`;
        setLastDownload({
          blob: new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }),
          name: `${currentFile.name}.bin`,
        });
      } else {
        const text = await decodeText(options, inputArea.value ?? "");
        const bytes = await decodeToBytes(options, inputArea.value ?? "");
        outputArea.value = text;
        setLastDownload({
          blob: new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }),
          name: "decoded.bin",
        });
      }
    } catch (e) {
      handleError(e);
    } finally {
      setProgressVisible(false);
      setBusy(false);
      abortController = null;
    }
  }

  encodeBtn?.addEventListener("click", handleEncode);
  decodeBtn?.addEventListener("click", handleDecode);
  cancelBtn?.addEventListener("click", () => abortController?.abort());

  swapBtn?.addEventListener("click", () => {
    clearError();
    const a = inputArea.value;
    inputArea.value = outputArea.value;
    outputArea.value = a;
  });

  clearBtn?.addEventListener("click", () => {
    inputArea.value = "";
    outputArea.value = "";
    currentFile = null;
    if (fileInput) fileInput.value = "";
    updateFileUi();
    setLastDownload(null);
    clearError();
  });

  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(outputArea.value ?? "");
      const orig = copyBtn.textContent;
      copyBtn.textContent = strings.copied;
      setTimeout(() => { copyBtn.textContent = orig; }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  downloadBtn?.addEventListener("click", () => {
    if (!lastDownload) return;
    downloadBlob(lastDownload.blob, lastDownload.name);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
