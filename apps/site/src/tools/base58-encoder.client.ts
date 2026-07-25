/**
 * Base58 Encoder / Decoder client controller. Drives the `Base58Encoder.astro`
 * shell: text ops run on the main thread via `encoding-client`; file ops run in
 * the worker via `encoding-file-client` (progress + cancel, no UI blocking).
 *
 * Base58 is O(n²), so legacy capped file encode at 1 MiB and decode at 2 MiB —
 * kept here. The worker reports real progress while READING the file; the
 * base58 math itself is one opaque call, so instead of legacy's synthetic
 * 33/50/66/100% steps the bar simply fills during the read and stays full while
 * the math runs (honest, semi-indeterminate progress).
 *
 * Loads only on the base58 tool page; SSR-safe no-op when the shell is absent.
 */
import { formatString } from "@/lib/format";
import { encodeText, decodeText, decodeToBytes } from "@/scripts/wasm/encoding-client";
import type { EncodingOptions } from "@/scripts/wasm/encoding-client";
import { encodeFile, decodeFile } from "@/scripts/wasm/encoding-file-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";

/** Base58 big-int math is O(n²) — same caps as the legacy tool. */
const ENCODE_FILE_LIMIT = 1024 * 1024; // 1 MiB
const DECODE_FILE_LIMIT = 2 * 1024 * 1024; // 2 MiB
/** "preview" output mode truncates the textarea at this many chars. */
const PREVIEW_CHAR_LIMIT = 200_000;

interface Strings {
  fileProgressTitle: string;
  cancel: string;
  copy: string;
  copied: string;
  download: string;
  errorLabel: string;
  fileSizeLimitEncode: string;
  fileSizeLimitDecode: string;
  fileDecoded: string;
  previewTruncated: string;
}

interface DownloadState {
  blob: Blob;
  name: string;
}

function readStrings(): Strings | null {
  const island = document.querySelector<HTMLScriptElement>("[data-b58-strings]");
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

function init() {
  const root = document.querySelector<HTMLElement>("[data-b58-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const input = root.querySelector<HTMLTextAreaElement>("[data-b58-input]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-b58-output]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-b58-file]");
  const fileName = root.querySelector<HTMLElement>("[data-b58-filename]");
  const fileClearBtn = root.querySelector<HTMLButtonElement>("[data-b58-file-clear]");
  const charsetSel = root.querySelector<HTMLSelectElement>("[data-b58-charset]");
  const alphabetSel = root.querySelector<HTMLSelectElement>("[data-b58-alphabet]");
  const outputModeSel = root.querySelector<HTMLSelectElement>("[data-b58-output-mode]");
  const allowWs = root.querySelector<HTMLInputElement>("[data-b58-allow-whitespace]");
  const encodeBtn = root.querySelector<HTMLButtonElement>("[data-b58-encode]");
  const decodeBtn = root.querySelector<HTMLButtonElement>("[data-b58-decode]");
  const swapBtn = root.querySelector<HTMLButtonElement>("[data-b58-swap]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-b58-clear]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-b58-cancel]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-b58-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-b58-download]");
  const progress = root.querySelector<HTMLElement>("[data-b58-progress]");
  const progressFill = root.querySelector<HTMLElement>("[data-b58-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-b58-progress-label]");
  const errorBox = root.querySelector<HTMLElement>("[data-b58-error]");
  if (!input || !output) return;
  const inputArea: HTMLTextAreaElement = input;
  const outputArea: HTMLTextAreaElement = output;

  let currentFile: File | null = null;
  let abortController: AbortController | null = null;
  let lastDownload: DownloadState | null = null;

  function currentOptions(): EncodingOptions {
    return {
      format: "base58",
      alphabet: alphabetSel?.value || "bitcoin",
      allowWhitespace: allowWs?.checked ?? true,
      charset: charsetSel?.value || "utf-8",
    };
  }

  function showError(msg: string, index?: number) {
    if (!errorBox) return;
    errorBox.textContent = msg || strings.errorLabel;
    errorBox.hidden = false;
    if (typeof index === "number" && index >= 0) {
      try {
        inputArea.focus();
        inputArea.setSelectionRange(index, Math.min(index + 1, inputArea.value.length));
      } catch {
        /* ignore */
      }
    }
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  function setBusy(busy: boolean) {
    if (encodeBtn) encodeBtn.disabled = busy;
    if (decodeBtn) decodeBtn.disabled = busy;
    if (cancelBtn) cancelBtn.hidden = !busy;
  }

  function showProgress() {
    if (progress) progress.hidden = false;
    if (progressFill) progressFill.style.width = "0%";
    if (progressLabel) progressLabel.textContent = strings.fileProgressTitle;
  }
  function hideProgress() {
    if (progress) progress.hidden = true;
    if (progressFill) progressFill.style.width = "0%";
  }

  /** Progress while the worker streams file bytes; the base58 math itself is opaque. */
  function onFileProgress({ processed, total }: { processed: number; total: number; elapsedMs: number }) {
    const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressLabel) {
      progressLabel.textContent = `${strings.fileProgressTitle} ${formatBytes(processed)} / ${formatBytes(total)}`;
    }
  }

  function handleError(e: unknown) {
    if (e instanceof WasmError && e.code === "aborted") {
      clearError(); // cancellation is not an error to surface
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const indexMatch = message.match(/(?:position|byte) (\d+)/);
    const index = indexMatch ? parseInt(indexMatch[1], 10) : undefined;
    showError(message, index);
  }

  function clearFile() {
    currentFile = null;
    if (fileInput) fileInput.value = "";
    if (fileName) fileName.textContent = "";
    if (fileClearBtn) fileClearBtn.hidden = true;
  }

  async function handleEncode() {
    clearError();
    const options = currentOptions();
    setBusy(true);
    abortController = new AbortController();
    try {
      if (currentFile) {
        if (currentFile.size > ENCODE_FILE_LIMIT) {
          showError(
            formatString(strings.fileSizeLimitEncode, formatBytes(ENCODE_FILE_LIMIT), formatBytes(currentFile.size)),
          );
          return;
        }
        showProgress();
        const res = await encodeFile(options, currentFile, {
          signal: abortController.signal,
          onProgress: onFileProgress,
        });
        const full = res.text;
        const preview =
          outputModeSel?.value === "full" || full.length <= PREVIEW_CHAR_LIMIT
            ? full
            : `${full.slice(0, PREVIEW_CHAR_LIMIT)}\n…${strings.previewTruncated}`;
        outputArea.value = preview;
        lastDownload = {
          blob: new Blob([full], { type: "text/plain" }),
          name: `${currentFile.name}.b58`,
        };
      } else {
        const out = await encodeText(options, inputArea.value);
        outputArea.value = out;
        lastDownload = { blob: new Blob([out], { type: "text/plain" }), name: "text.b58" };
      }
    } catch (e) {
      handleError(e);
    } finally {
      hideProgress();
      setBusy(false);
      abortController = null;
    }
  }

  async function handleDecode() {
    clearError();
    const options = currentOptions();
    setBusy(true);
    abortController = new AbortController();
    try {
      if (currentFile) {
        if (currentFile.size > DECODE_FILE_LIMIT) {
          showError(
            formatString(strings.fileSizeLimitDecode, formatBytes(DECODE_FILE_LIMIT), formatBytes(currentFile.size)),
          );
          return;
        }
        showProgress();
        const res = await decodeFile(options, currentFile, {
          signal: abortController.signal,
          onProgress: onFileProgress,
        });
        const bytes = res.bytes ?? new Uint8Array();
        const binName = `${currentFile.name}.bin`;
        outputArea.value = formatString(strings.fileDecoded, currentFile.name, binName);
        lastDownload = {
          blob: new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
          name: binName,
        };
      } else {
        const inputValue = inputArea.value;
        // Bytes are kept for download; decodeText re-runs the (cheap, text-sized)
        // decode to also convert through the selected charset.
        const bytes = await decodeToBytes(options, inputValue);
        const text = await decodeText(options, inputValue);
        outputArea.value = text;
        lastDownload = {
          blob: new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
          name: "decoded.bin",
        };
      }
    } catch (e) {
      handleError(e);
    } finally {
      hideProgress();
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
    clearFile();
    clearError();
    lastDownload = null;
  });

  fileInput?.addEventListener("change", () => {
    currentFile = fileInput.files?.[0] ?? null;
    if (currentFile) {
      inputArea.value = "";
      outputArea.value = "";
      clearError();
      if (fileName) fileName.textContent = `${currentFile.name} (${formatBytes(currentFile.size)})`;
      if (fileClearBtn) fileClearBtn.hidden = false;
    } else {
      clearFile();
    }
  });
  fileClearBtn?.addEventListener("click", clearFile);

  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(outputArea.value || "");
      const original = copyBtn.textContent;
      copyBtn.textContent = strings.copied;
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  downloadBtn?.addEventListener("click", () => {
    if (!lastDownload) return;
    const url = URL.createObjectURL(lastDownload.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = lastDownload.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
