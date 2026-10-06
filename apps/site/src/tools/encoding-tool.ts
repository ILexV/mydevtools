/**
 * Shared browser controller for the text-or-file encoders (base32, base58,
 * hex): encode/decode text via `encoding-client`, files via the worker
 * (`encoding-file-client`, progress + cancel), drag & drop, swap/clear,
 * copy/download, localized errors with caret placement, preview/full output,
 * workbench empty states (input overlay + "Load example", compact output
 * placeholder). Each tool's `*.client.ts` passes its prefix (`data-<prefix>-*`
 * hooks), option reader, file extension and example text. Shell markup:
 * `HexEncoder.astro` et al.
 */
import { formatBytes, formatString, progressPercent } from "@/lib/format";
import { bindDropzone, bindLoadExample, copyWithFeedback, setFieldValue, syncEmptyState } from "@/scripts/tool-ui";
import {
  encodeBytes,
  decodeToBytes,
  textToBytes,
  bytesToText,
  type EncodingOptions,
} from "@/scripts/wasm/encoding-client";
import { encodeFile, decodeFile } from "@/scripts/wasm/encoding-file-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { classifyEncodingError, outputFileName, previewText, type EncodingErrorKey } from "@/tools/encoding-ui";

/** "preview" output mode truncates the textarea at this many chars. */
const PREVIEW_CHAR_LIMIT = 200_000;

export interface EncodingToolStrings {
  copied: string;
  copyFailed?: string;
  fileProgressTitle: string;
  previewTruncated: string;
  fileDecoded: string;
  statsOutput: string;
  errInvalidChar: string;
  errNotRepresentable: string;
  errInvalidLength: string;
  errWhitespace: string;
  errPadding: string;
  errNotText: string;
  errInvalidData: string;
  errCopyFailed: string;
  error: string;
  fileSizeLimitEncode?: string;
  fileSizeLimitDecode?: string;
}

export interface EncodingToolConfig {
  /** Data-attribute prefix: "hex" → `[data-hex-tool]`, `[data-hex-input]`, … */
  prefix: string;
  /** Format name for "not valid {0}" errors (not translated: Base32, Hex…). */
  formatName: string;
  /** Download extension for encoded output ("hex", "b32", "b58"). */
  ext: string;
  readOptions(root: HTMLElement): EncodingOptions;
  /** Language-neutral sample inserted by "Load example" (only on click). */
  example?: string;
  /** Optional input caps (base58 is O(n²)): raw bytes to encode / encoded chars to decode. */
  encodeLimit?: number;
  decodeLimit?: number;
}

const ERROR_STRING: Record<EncodingErrorKey, keyof EncodingToolStrings> = {
  Error_InvalidChar: "errInvalidChar",
  Error_NotRepresentable: "errNotRepresentable",
  Error_InvalidLength: "errInvalidLength",
  Error_Whitespace: "errWhitespace",
  Error_Padding: "errPadding",
  Error_NotText: "errNotText",
  Error_InvalidData: "errInvalidData",
};

function readStrings(prefix: string): EncodingToolStrings | null {
  const island = document.querySelector<HTMLScriptElement>(`[data-${prefix}-strings]`);
  if (!island) return null;
  try {
    return JSON.parse(island.textContent || "{}") as EncodingToolStrings;
  } catch {
    return null;
  }
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

export function initEncodingTool(config: EncodingToolConfig): void {
  const p = config.prefix;
  const root = document.querySelector<HTMLElement>(`[data-${p}-tool]`);
  if (!root || root.dataset.initialized) return;
  const raw = readStrings(p);
  if (!raw) return;
  const strings: EncodingToolStrings = raw;
  const q = <T extends Element>(name: string) => root.querySelector<T>(`[data-${p}-${name}]`);

  const input = q<HTMLTextAreaElement>("input");
  const output = q<HTMLTextAreaElement>("output");
  const errorBox = q<HTMLElement>("error");
  if (!input || !output || !errorBox) return;
  root.dataset.initialized = "true";
  const inputArea: HTMLTextAreaElement = input;
  const outputArea: HTMLTextAreaElement = output;
  const errorArea: HTMLElement = errorBox;

  const fileInput = q<HTMLInputElement>("file");
  const drop = q<HTMLElement>("drop");
  const fileName = q<HTMLElement>("filename");
  const fileClearBtn = q<HTMLButtonElement>("file-clear");
  const outputModeSel = q<HTMLSelectElement>("output-mode");
  const encodeBtn = q<HTMLButtonElement>("encode");
  const decodeBtn = q<HTMLButtonElement>("decode");
  const swapBtn = q<HTMLButtonElement>("swap");
  const clearBtn = q<HTMLButtonElement>("clear");
  const copyBtn = q<HTMLButtonElement>("copy");
  const downloadBtn = q<HTMLButtonElement>("download");
  const cancelBtn = q<HTMLButtonElement>("cancel");
  const progress = q<HTMLElement>("progress");
  const progressBar = q<HTMLElement>("progress-bar");
  const progressFill = q<HTMLElement>("progress-fill");
  const progressLabel = q<HTMLElement>("progress-label");
  const stats = q<HTMLElement>("stats");
  const inputHost = q<HTMLElement>("input-host");
  const outputPanel = q<HTMLElement>("output-panel");
  const exampleBtn = q<HTMLButtonElement>("example");
  const lang = document.documentElement.lang || "en";

  let currentFile: File | null = null;
  let abortController: AbortController | null = null;
  let lastDownload: { blob: Blob; name: string } | null = null;

  /** Input overlay shows while there is neither text nor a selected file. */
  function syncInput() {
    if (inputHost) syncEmptyState(inputHost, inputArea.value === "" && !currentFile);
  }
  /** Output placeholder while there is no result; Copy needs text. */
  function syncOutput() {
    const empty = outputArea.value === "";
    if (outputPanel) syncEmptyState(outputPanel, empty && !lastDownload);
    if (copyBtn) copyBtn.disabled = empty;
  }
  /** Write the result box and refresh the output empty state. */
  function setOutput(text: string) {
    outputArea.value = text;
    syncOutput();
  }

  function showError(msg: string) {
    errorArea.textContent = msg;
    errorArea.hidden = false;
  }
  function clearError() {
    errorArea.hidden = true;
    errorArea.textContent = "";
    inputArea.removeAttribute("aria-invalid");
  }

  function setStats(chars: number | null, bytes = 0) {
    if (!stats) return;
    stats.textContent =
      chars === null ? "" : formatString(strings.statsOutput, chars.toLocaleString(lang), formatBytes(bytes));
  }

  function setLastDownload(dl: { blob: Blob; name: string } | null) {
    lastDownload = dl;
    if (downloadBtn) downloadBtn.disabled = !dl;
    syncOutput();
  }

  function setBusy(busy: boolean, trigger?: HTMLButtonElement | null) {
    for (const b of [encodeBtn, decodeBtn, swapBtn, clearBtn]) if (b) b.disabled = busy;
    if (trigger) trigger.setAttribute("aria-busy", String(busy));
    if (!busy) {
      encodeBtn?.removeAttribute("aria-busy");
      decodeBtn?.removeAttribute("aria-busy");
    }
    if (fileInput) fileInput.disabled = busy;
    if (drop) drop.setAttribute("aria-disabled", String(busy));
  }

  function setProgress(visible: boolean) {
    if (progress) progress.hidden = !visible;
    if (progressFill) progressFill.style.width = "0%";
    progressBar?.setAttribute("aria-valuenow", "0");
    if (progressLabel) progressLabel.textContent = visible ? strings.fileProgressTitle : "";
  }

  function onProgress({ processed, total, elapsedMs }: { processed: number; total: number; elapsedMs: number }) {
    const pct = progressPercent(processed, total);
    if (progressFill) progressFill.style.width = `${pct}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(pct)));
    if (progressLabel) {
      const speed = elapsedMs > 0 ? (processed / elapsedMs) * 1000 : 0;
      progressLabel.textContent = `${pct.toFixed(1)}% · ${formatBytes(processed)} / ${formatBytes(total)} · ${formatBytes(speed)}/s`;
    }
  }

  /** Localize a WASM error; in text mode select the offending character. */
  function handleError(e: unknown) {
    if (e instanceof WasmError && e.code === "aborted") {
      clearError(); // cancellation is not an error to surface
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    // Size caps are pre-checked; a Rust-side cap message is shown as-is.
    if (/limited to/.test(message)) {
      showError(`${strings.error}: ${message}`);
      return;
    }
    const { key, position } = classifyEncodingError(message);
    // Never leave a stale result next to an error. Not-text decodes keep the
    // raw-bytes download (set before the charset conversion failed).
    setOutput("");
    if (key !== "Error_NotText") {
      setStats(null);
      setLastDownload(null);
    }
    const template = strings[ERROR_STRING[key]] ?? strings.error;
    const arg = key === "Error_InvalidData" ? config.formatName : String((position ?? 0) + 1);
    showError(formatString(template, arg));
    if (currentFile) return;
    inputArea.setAttribute("aria-invalid", "true");
    if (position !== undefined && position >= 0 && key !== "Error_NotText") {
      try {
        inputArea.focus();
        inputArea.setSelectionRange(position, Math.min(position + 1, inputArea.value.length));
      } catch {
        /* selection unsupported */
      }
    }
  }

  function updateFileUi() {
    if (fileName) fileName.textContent = currentFile ? `${currentFile.name} (${formatBytes(currentFile.size)})` : "";
    if (fileClearBtn) fileClearBtn.hidden = !currentFile;
  }

  function setFile(file: File | null) {
    currentFile = file;
    if (file) {
      // File mode replaces the text input (legacy parity).
      inputArea.value = "";
      setOutput("");
      setLastDownload(null);
      setStats(null);
      clearError();
    } else if (fileInput) {
      fileInput.value = "";
    }
    updateFileUi();
    syncInput();
  }

  if (drop) {
    bindDropzone(drop, fileInput, (files) => setFile(files[0] ?? null));
  } else {
    fileInput?.addEventListener("change", () => setFile(fileInput.files?.[0] ?? null));
  }
  fileClearBtn?.addEventListener("click", () => setFile(null));

  /** Pre-check an optional size cap; shows the localized limit error. */
  function tooLarge(limit: number | undefined, template: string | undefined, size: number): boolean {
    if (!limit || !template || size <= limit) return false;
    setOutput("");
    setStats(null);
    setLastDownload(null);
    showError(formatString(template, formatBytes(limit), formatBytes(size)));
    return true;
  }

  async function handleEncode() {
    clearError();
    const options = config.readOptions(root!);
    abortController = new AbortController();
    setBusy(true, encodeBtn);
    try {
      if (currentFile) {
        if (tooLarge(config.encodeLimit, strings.fileSizeLimitEncode, currentFile.size)) return;
        setProgress(true);
        const result = await encodeFile(options, currentFile, { signal: abortController.signal, onProgress });
        const full = result.text;
        setOutput(previewText(full, outputModeSel?.value ?? "preview", PREVIEW_CHAR_LIMIT, strings.previewTruncated).text);
        setStats(full.length, currentFile.size);
        setLastDownload({ blob: new Blob([full], { type: "text/plain" }), name: outputFileName(currentFile.name, config.ext) });
      } else {
        const bytes = await textToBytes(inputArea.value, options.charset);
        if (tooLarge(config.encodeLimit, strings.fileSizeLimitEncode, bytes.length)) return;
        const out = await encodeBytes(options, bytes);
        setOutput(out);
        setStats(out.length, bytes.length);
        setLastDownload({ blob: new Blob([out], { type: "text/plain" }), name: outputFileName(null, config.ext) });
      }
    } catch (e) {
      handleError(e);
    } finally {
      setProgress(false);
      setBusy(false);
      abortController = null;
    }
  }

  async function handleDecode() {
    clearError();
    const options = config.readOptions(root!);
    abortController = new AbortController();
    setBusy(true, decodeBtn);
    try {
      if (currentFile) {
        if (tooLarge(config.decodeLimit, strings.fileSizeLimitDecode, currentFile.size)) return;
        setProgress(true);
        const result = await decodeFile(options, currentFile, { signal: abortController.signal, onProgress });
        const bytes = result.bytes ?? new Uint8Array(0);
        const binName = outputFileName(currentFile.name, "bin");
        setOutput(formatString(strings.fileDecoded, currentFile.name, binName));
        setStats(currentFile.size, bytes.length);
        setLastDownload({ blob: new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), name: binName });
      } else {
        const encoded = inputArea.value;
        if (tooLarge(config.decodeLimit, strings.fileSizeLimitDecode, encoded.length)) return;
        const bytes = await decodeToBytes(options, encoded);
        // Raw bytes stay downloadable even when they aren't text in the charset.
        setLastDownload({ blob: new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), name: "decoded.bin" });
        setStats(encoded.length, bytes.length);
        setOutput(await bytesToText(bytes, options.charset));
      }
    } catch (e) {
      handleError(e);
    } finally {
      setProgress(false);
      setBusy(false);
      abortController = null;
    }
  }

  encodeBtn?.addEventListener("click", handleEncode);
  decodeBtn?.addEventListener("click", handleDecode);
  cancelBtn?.addEventListener("click", () => abortController?.abort());
  inputArea.addEventListener("input", () => {
    inputArea.removeAttribute("aria-invalid");
    syncInput();
  });
  if (exampleBtn && config.example) {
    const sample = config.example;
    bindLoadExample(exampleBtn, () => setFieldValue(inputArea, sample));
  }

  swapBtn?.addEventListener("click", () => {
    clearError();
    // Swapping moves the result into the text input, so leave file mode.
    if (currentFile) setFile(null);
    const a = inputArea.value;
    inputArea.value = outputArea.value;
    setStats(null);
    setLastDownload(null);
    setOutput(a);
    syncInput();
  });

  clearBtn?.addEventListener("click", () => {
    inputArea.value = "";
    setOutput("");
    setFile(null);
    setLastDownload(null);
    setStats(null);
    clearError();
    inputArea.focus();
  });

  copyBtn?.addEventListener("click", async () => {
    const ok = await copyWithFeedback(copyBtn, outputArea.value, strings.copied, undefined, {
      failedLabel: strings.copyFailed,
    });
    if (!ok) showError(strings.errCopyFailed);
  });

  syncInput();
  syncOutput();

  downloadBtn?.addEventListener("click", () => {
    if (lastDownload) downloadBlob(lastDownload.blob, lastDownload.name);
  });
}

/** Run `fn` once the DOM is ready (SSR-safe for module scripts). */
export function onReady(fn: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}
