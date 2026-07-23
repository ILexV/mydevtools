/**
 * Base64 client controller. Text ops via `encoding-client`; file ops via
 * `encoding-file-client` (worker, progress + cancel). Decode detection:
 * image → preview, binary → info panel (legacy parity).
 */
import { encodeText, decodeText, decodeToBytes, type EncodingOptions } from "@/scripts/wasm/encoding-client";
import { encodeFile, decodeFile } from "@/scripts/wasm/encoding-file-client";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { detectFileType, isLikelyText, formatBytes, formatDuration } from "@/tools/base64";

interface Strings {
  copy: string;
  copied: string;
  cancel: string;
  fileProgressTitle: string;
  imageDetected: string;
  binaryDetected: string;
  binaryDownloadHint: string;
  statsChars: string;
  statsBytes: string;
  statsEncoded: string;
  statsDecoded: string;
  copyBase64?: string;
}

const PREVIEW_LIMIT = 200_000;

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
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const textarea = root.querySelector<HTMLTextAreaElement>("[data-b64-textarea]");
  const fileInput = root.querySelector<HTMLInputElement>("[data-b64-file]");
  const fileName = root.querySelector<HTMLElement>("[data-b64-filename]");
  const clearFileBtn = root.querySelector<HTMLButtonElement>("[data-b64-clearfile]");
  const charset = root.querySelector<HTMLSelectElement>("[data-b64-charset]");
  const alphabet = root.querySelector<HTMLSelectElement>("[data-b64-alphabet]");
  const padding = root.querySelector<HTMLSelectElement>("[data-b64-padding]");
  const lineWrap = root.querySelector<HTMLSelectElement>("[data-b64-linewrap]");
  const outputMode = root.querySelector<HTMLSelectElement>("[data-b64-outputmode]");
  const allowWs = root.querySelector<HTMLInputElement>("[data-b64-allowws]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-b64-output]");
  const stats = root.querySelector<HTMLElement>("[data-b64-stats]");
  const detect = root.querySelector<HTMLElement>("[data-b64-detect]");
  const encodeBtn = root.querySelector<HTMLButtonElement>("[data-b64-encode]");
  const decodeBtn = root.querySelector<HTMLButtonElement>("[data-b64-decode]");
  const swapBtn = root.querySelector<HTMLButtonElement>("[data-b64-swap]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-b64-clear]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-b64-copy]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-b64-download]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-b64-cancel]");
  const progress = root.querySelector<HTMLElement>("[data-b64-progress]");
  const progressFill = root.querySelector<HTMLElement>("[data-b64-progress-fill]");
  const progressLabel = root.querySelector<HTMLElement>("[data-b64-progress-label]");
  const errorBox = root.querySelector<HTMLElement>("[data-b64-error]");

  let currentFile: File | null = null;
  let lastBytes: Uint8Array | null = null;
  let lastExt = "txt";
  let lastMime = "text/plain";
  let abortController: AbortController | null = null;

  if (!textarea || !output) return;
  const inputArea: HTMLTextAreaElement = textarea;
  const outputArea: HTMLTextAreaElement = output;

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
    if (errorBox) { errorBox.textContent = msg; errorBox.hidden = false; }
  }
  function clearError() {
    if (errorBox) errorBox.hidden = true;
  }

  function showDetect(html: string) {
    if (detect) { detect.innerHTML = html; detect.hidden = false; }
  }
  function clearDetect() {
    if (detect) { detect.innerHTML = ""; detect.hidden = true; }
  }

  function setStats(text: string) {
    if (stats) stats.textContent = text;
  }

  function setBusy(busy: boolean) {
    for (const b of [encodeBtn, decodeBtn]) if (b) b.disabled = busy;
    if (cancelBtn) cancelBtn.hidden = !busy || !currentFile;
  }

  function setOutput(text: string, statText: string) {
    const preview = outputMode?.value !== "full" && text.length > PREVIEW_LIMIT;
    outputArea.value = preview ? text.slice(0, PREVIEW_LIMIT) : text;
    setStats(preview ? `${statText} · truncated` : statText);
  }

  function setFileResult(bytes: Uint8Array | undefined, direction: "encode" | "decode", text: string) {
    if (direction === "decode" && bytes) {
      lastBytes = bytes;
      const detected = detectFileType(bytes);
      if (detected) {
        lastExt = detected.ext;
        lastMime = detected.mime;
        if (detected.kind === "image") {
          const blob = new Blob([bytes.slice()], { type: detected.mime });
          const url = URL.createObjectURL(blob);
          showDetect(
            `${strings.imageDetected.replace("{type}", detected.label)}<br/><img src="${url}" alt="${detected.label}" />`,
          );
        } else {
          showDetect(
            `${strings.binaryDetected.replace("{type}", detected.label)} — ${formatBytes(bytes.length)}<br/><small>${strings.binaryDownloadHint}</small>`,
          );
        }
      } else if (isLikelyText(bytes)) {
        lastExt = "txt";
        lastMime = "text/plain";
        clearDetect();
      } else {
        lastExt = "bin";
        lastMime = "application/octet-stream";
        showDetect(`${strings.binaryDetected.replace("{type}", "BIN")} — ${formatBytes(bytes.length)}<br/><small>${strings.binaryDownloadHint}</small>`);
      }
      setOutput(text, strings.statsDecoded.replace("{size}", formatBytes(bytes.length)));
    } else {
      lastBytes = null;
      lastExt = "txt";
      lastMime = "text/plain";
      clearDetect();
      setOutput(text, strings.statsEncoded.replace("{size}", formatBytes(text.length)));
    }
  }

  function resetFile() {
    currentFile = null;
    if (fileInput) fileInput.value = "";
    if (fileName) fileName.textContent = "";
    if (clearFileBtn) clearFileBtn.hidden = true;
  }

  fileInput?.addEventListener("change", () => {
    currentFile = fileInput.files?.[0] ?? null;
    if (currentFile && fileName) {
      fileName.textContent = `${currentFile.name} (${formatBytes(currentFile.size)})`;
      if (clearFileBtn) clearFileBtn.hidden = false;
    }
  });
  clearFileBtn?.addEventListener("click", resetFile);

  async function run(direction: "encode" | "decode") {
    clearError();
    const start = performance.now();
    setBusy(true);
    abortController = new AbortController();
    try {
      if (currentFile) {
        if (progress) progress.hidden = false;
        const fn = direction === "encode" ? encodeFile : decodeFile;
        const result = await fn(options(), currentFile, {
          signal: abortController.signal,
          onProgress: ({ processed, total, elapsedMs }) => {
            const pct = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
            if (progressFill) progressFill.style.width = `${pct}%`;
            if (progressLabel) {
              progressLabel.textContent = `${strings.fileProgressTitle} ${formatBytes(processed)} / ${formatBytes(total)} · ${formatDuration(elapsedMs / 1000)}`;
            }
          },
        });
        setFileResult(result.bytes, direction, result.text);
      } else {
        const input = inputArea.value;
        if (direction === "encode") {
          const text = await encodeText(options(), input);
          setFileResult(undefined, "encode", text);
        } else {
          const bytes = await decodeToBytes(options(), input);
          try {
            const cs = charset?.value ?? "utf-8";
            const label = cs === "utf-16le" ? "utf-16le" : cs === "utf-16be" ? "utf-16be" : cs === "latin1" ? "latin1" : "utf-8";
            const text = new TextDecoder(label).decode(bytes);
            setFileResult(bytes, "decode", text);
          } catch {
            setFileResult(bytes, "decode", "");
          }
        }
      }
    } catch (e) {
      if (!(e instanceof WasmError && e.code === "aborted")) {
        showError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (progress) { progress.hidden = true; if (progressFill) progressFill.style.width = "0%"; }
      setBusy(false);
      abortController = null;
    }
  }

  encodeBtn?.addEventListener("click", () => run("encode"));
  decodeBtn?.addEventListener("click", () => run("decode"));
  cancelBtn?.addEventListener("click", () => abortController?.abort());

  swapBtn?.addEventListener("click", () => {
    const a = inputArea.value;
    inputArea.value = outputArea.value;
    outputArea.value = a;
  });

  clearBtn?.addEventListener("click", () => {
    inputArea.value = "";
    outputArea.value = "";
    clearDetect();
    clearError();
    setStats("");
    resetFile();
  });

  copyBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(outputArea.value);
      if (copyBtn) {
        const orig = copyBtn.textContent;
        copyBtn.textContent = strings.copied;
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      }
    } catch {
      /* clipboard unavailable */
    }
  });

  downloadBtn?.addEventListener("click", () => {
    let blob: Blob;
    if (lastBytes) {
      blob = new Blob([lastBytes.slice()], { type: lastMime });
    } else {
      blob = new Blob([outputArea.value], { type: "text/plain" });
      lastExt = "txt";
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFile ? `${currentFile.name.replace(/\.[^.]+$/, "")}.${lastExt}` : `output.${lastExt}`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
