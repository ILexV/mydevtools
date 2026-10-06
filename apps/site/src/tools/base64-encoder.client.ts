/**
 * Base64 client controller. Text ops via `encoding-client`; file ops via
 * `encoding-file-client` (worker, progress + cancel); drag & drop via the
 * shared `bindDropzone`. Decode detection (legacy parity): image → preview,
 * known binary → info panel, other non-text → generic binary info; the
 * decoded bytes are always downloadable with the detected extension.
 */
import { formatBytes, formatString, progressPercent } from "@/lib/format";
import { copyWithFeedback, bindDropzone } from "@/scripts/tool-ui";
import { encodeBytes, decodeToBytes, textToBytes, type EncodingOptions } from "@/scripts/wasm/encoding-client";
import { encodeFile, decodeFile } from "@/scripts/wasm/encoding-file-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { detectFileType, isLikelyText } from "@/tools/base64";
import { classifyEncodingError, outputFileName, previewText, type EncodingErrorKey } from "@/tools/encoding-ui";
import { onReady } from "@/tools/encoding-tool";

interface Strings {
  copied: string;
  fileProgressTitle: string;
  imageDetected: string;
  binaryDetected: string;
  binaryDownloadHint: string;
  statsChars: string;
  statsBytes: string;
  statsEncoded: string;
  statsDecoded: string;
  statsImage: string;
  previewTruncated: string;
  fileDecoded: string;
  errInvalidChar: string;
  errNotRepresentable: string;
  errInvalidLength: string;
  errWhitespace: string;
  errPadding: string;
  errNotText: string;
  errInvalidData: string;
  errCopyFailed: string;
  error: string;
}

const PREVIEW_LIMIT = 200_000;

const ERROR_STRING: Record<EncodingErrorKey, keyof Strings> = {
  Error_InvalidChar: "errInvalidChar",
  Error_NotRepresentable: "errNotRepresentable",
  Error_InvalidLength: "errInvalidLength",
  Error_Whitespace: "errWhitespace",
  Error_Padding: "errPadding",
  Error_NotText: "errNotText",
  Error_InvalidData: "errInvalidData",
};

/** WHATWG TextDecoder labels for the charset select (lenient display decode). */
const DECODER_LABEL: Record<string, string> = {
  "utf-8": "utf-8",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
  ascii: "windows-1252",
  latin1: "windows-1252",
};

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-b64-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-b64-tool]");
  if (!root || root.dataset.initialized) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;
  const q = <T extends Element>(name: string) => root.querySelector<T>(`[data-b64-${name}]`);

  const textarea = q<HTMLTextAreaElement>("input");
  const output = q<HTMLTextAreaElement>("output");
  const errorBox = q<HTMLElement>("error");
  if (!textarea || !output || !errorBox) return;
  root.dataset.initialized = "true";
  const inputArea: HTMLTextAreaElement = textarea;
  const outputArea: HTMLTextAreaElement = output;
  const errorArea: HTMLElement = errorBox;

  const fileInput = q<HTMLInputElement>("file");
  const drop = q<HTMLElement>("drop");
  const fileName = q<HTMLElement>("filename");
  const clearFileBtn = q<HTMLButtonElement>("file-clear");
  const charset = q<HTMLSelectElement>("charset");
  const alphabet = q<HTMLSelectElement>("alphabet");
  const padding = q<HTMLSelectElement>("padding");
  const lineWrap = q<HTMLSelectElement>("linewrap");
  const outputMode = q<HTMLSelectElement>("output-mode");
  const allowWs = q<HTMLInputElement>("allow-whitespace");
  const stats = q<HTMLElement>("stats");
  const detect = q<HTMLElement>("detect");
  const detectLabel = q<HTMLElement>("detect-label");
  const detectHint = q<HTMLElement>("detect-hint");
  const detectImg = q<HTMLImageElement>("detect-img");
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

  let currentFile: File | null = null;
  let abortController: AbortController | null = null;
  let previewUrl: string | null = null;
  /** What Download saves: decoded bytes (with detected type) or the text output. */
  let lastDownload: { blob: Blob; name: string } | null = null;

  function options(): EncodingOptions {
    return {
      format: "base64",
      alphabet: alphabet?.value ?? "standard",
      padding: padding?.value ?? "required",
      lineWrap: lineWrap?.value === "76" ? 76 : null,
      allowWhitespace: allowWs?.checked ?? true,
      charset: charset?.value ?? "utf-8",
    };
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

  function setLastDownload(dl: { blob: Blob; name: string } | null) {
    lastDownload = dl;
    if (downloadBtn) downloadBtn.disabled = !dl;
  }

  function clearDetect() {
    if (detect) detect.hidden = true;
    if (detectImg) {
      detectImg.hidden = true;
      detectImg.removeAttribute("src");
    }
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    outputArea.hidden = false;
  }

  function setStats(text: string) {
    if (stats) stats.textContent = text;
  }

  function resetOutput() {
    outputArea.value = "";
    clearDetect();
    setStats("");
    setLastDownload(null);
  }

  function setBusy(busy: boolean, trigger?: HTMLButtonElement | null) {
    for (const b of [encodeBtn, decodeBtn, swapBtn, clearBtn]) if (b) b.disabled = busy;
    if (busy && trigger) trigger.setAttribute("aria-busy", "true");
    if (!busy) {
      encodeBtn?.removeAttribute("aria-busy");
      decodeBtn?.removeAttribute("aria-busy");
    }
    if (fileInput) fileInput.disabled = busy;
    drop?.setAttribute("aria-disabled", String(busy));
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

  function handleError(e: unknown) {
    if (e instanceof WasmError && e.code === "aborted") {
      clearError();
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const { key, position } = classifyEncodingError(message);
    resetOutput();
    const arg = key === "Error_InvalidData" ? "Base64" : String((position ?? 0) + 1);
    showError(formatString(strings[ERROR_STRING[key]] ?? strings.error, arg));
    if (currentFile) return;
    inputArea.setAttribute("aria-invalid", "true");
    if (position !== undefined && key === "Error_NotRepresentable") {
      try {
        inputArea.focus();
        inputArea.setSelectionRange(position, Math.min(position + 1, inputArea.value.length));
      } catch {
        /* selection unsupported */
      }
    }
  }

  function showEncoded(text: string, rawBytes: number, sourceName: string | null) {
    clearDetect();
    outputArea.value = previewText(text, outputMode?.value ?? "preview", PREVIEW_LIMIT, strings.previewTruncated).text;
    setStats(`${strings.statsBytes.replace("{n}", rawBytes.toLocaleString())} ${strings.statsEncoded.replace("{size}", formatBytes(text.length))}`);
    setLastDownload({ blob: new Blob([text], { type: "text/plain" }), name: outputFileName(sourceName, "b64") });
  }

  /** Decoded bytes → text output, or image preview / binary info (legacy parity). */
  function showDecoded(bytes: Uint8Array, encodedChars: number, sourceName: string | null) {
    clearDetect();
    const decodedStat = `${strings.statsChars.replace("{n}", encodedChars.toLocaleString())} ${strings.statsDecoded.replace("{size}", formatBytes(bytes.length))}`;
    const detected = detectFileType(bytes);
    const base = sourceName ? sourceName.replace(/\.(b64|base64|txt)$/i, "") : "decoded";
    if (!detected && isLikelyText(bytes)) {
      const cs = charset?.value ?? "utf-8";
      const text = new TextDecoder(DECODER_LABEL[cs] ?? "utf-8").decode(bytes);
      outputArea.value = previewText(text, outputMode?.value ?? "preview", PREVIEW_LIMIT, strings.previewTruncated).text;
      setStats(decodedStat);
      setLastDownload({ blob: new Blob([new Uint8Array(bytes)], { type: "text/plain" }), name: `${base}.txt` });
      return;
    }
    const kind = detected ?? { kind: "binary" as const, mime: "application/octet-stream", ext: "bin", label: "BIN" };
    const blob = new Blob([new Uint8Array(bytes)], { type: kind.mime });
    setLastDownload({ blob, name: `${base}.${kind.ext}` });
    outputArea.value = "";
    outputArea.hidden = true;
    if (detect) detect.hidden = false;
    setStats(decodedStat);
    if (kind.kind === "image" && detectImg && detectLabel) {
      detectLabel.textContent = strings.imageDetected.replace("{type}", kind.label);
      if (detectHint) detectHint.textContent = strings.binaryDownloadHint;
      previewUrl = URL.createObjectURL(blob);
      detectImg.alt = kind.label;
      detectImg.onload = () => {
        setStats(
          strings.statsImage
            .replace("{size}", formatBytes(bytes.length))
            .replace("{w}", String(detectImg.naturalWidth))
            .replace("{h}", String(detectImg.naturalHeight)),
        );
      };
      detectImg.src = previewUrl;
      detectImg.hidden = false;
    } else if (detectLabel) {
      detectLabel.textContent = `${strings.binaryDetected.replace("{type}", kind.label)} · ${formatBytes(bytes.length)}`;
      if (detectHint) detectHint.textContent = strings.binaryDownloadHint;
    }
  }

  function updateFileUi() {
    if (fileName) fileName.textContent = currentFile ? `${currentFile.name} (${formatBytes(currentFile.size)})` : "";
    if (clearFileBtn) clearFileBtn.hidden = !currentFile;
  }

  function setFile(file: File | null) {
    currentFile = file;
    if (file) {
      inputArea.value = "";
      resetOutput();
      clearError();
    } else if (fileInput) {
      fileInput.value = "";
    }
    updateFileUi();
  }

  if (drop) bindDropzone(drop, fileInput, (files) => setFile(files[0] ?? null));
  else fileInput?.addEventListener("change", () => setFile(fileInput.files?.[0] ?? null));
  clearFileBtn?.addEventListener("click", () => setFile(null));

  async function run(direction: "encode" | "decode") {
    clearError();
    abortController = new AbortController();
    setBusy(true, direction === "encode" ? encodeBtn : decodeBtn);
    try {
      if (currentFile) {
        setProgress(true);
        const fn = direction === "encode" ? encodeFile : decodeFile;
        const result = await fn(options(), currentFile, { signal: abortController.signal, onProgress });
        if (direction === "encode") showEncoded(result.text, currentFile.size, currentFile.name);
        else showDecoded(result.bytes ?? new Uint8Array(0), currentFile.size, currentFile.name);
      } else if (direction === "encode") {
        const bytes = await textToBytes(inputArea.value, options().charset);
        showEncoded(await encodeBytes(options(), bytes), bytes.length, null);
      } else {
        const bytes = await decodeToBytes(options(), inputArea.value);
        showDecoded(bytes, inputArea.value.length, null);
      }
    } catch (e) {
      handleError(e);
    } finally {
      setProgress(false);
      setBusy(false);
      abortController = null;
    }
  }

  encodeBtn?.addEventListener("click", () => run("encode"));
  decodeBtn?.addEventListener("click", () => run("decode"));
  cancelBtn?.addEventListener("click", () => abortController?.abort());
  inputArea.addEventListener("input", () => inputArea.removeAttribute("aria-invalid"));

  swapBtn?.addEventListener("click", () => {
    clearError();
    if (currentFile) setFile(null);
    const a = inputArea.value;
    inputArea.value = outputArea.hidden ? "" : outputArea.value;
    resetOutput();
    outputArea.value = a;
  });

  clearBtn?.addEventListener("click", () => {
    inputArea.value = "";
    resetOutput();
    clearError();
    setFile(null);
  });

  copyBtn?.addEventListener("click", async () => {
    const ok = await copyWithFeedback(copyBtn, outputArea.value, strings.copied);
    if (!ok) showError(strings.errCopyFailed);
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

onReady(init);
