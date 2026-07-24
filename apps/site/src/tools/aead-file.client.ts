/**
 * AEAD file crypto client controller. Drives `aead-file-client` (chunked
 * streaming WASM) for encrypt/decrypt with progress + cancel, header hex
 * output, and blob download — legacy parity (1 MiB chunks, Argon2id,
 * `<name>.aead` / strip-`.aead`-or-append-`.dec` download names).
 */
import {
  aeadEncryptFile,
  aeadDecryptFile,
  type AeadAlgorithm,
  type AeadProgress,
} from "@/scripts/wasm/aead-file-client";

interface Strings {
  fileProgressTitle: string;
  cancel: string;
  fileDropSubtitle: string;
  errorSelectFileToEncrypt: string;
  errorSelectFileToDecrypt: string;
  errorPasswordRequired: string;
  errorOperationCanceled: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-aead-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

/** Legacy formatBytes parity. */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const digits = unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

/** Legacy formatDuration parity. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-aead-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const encFile = root.querySelector<HTMLInputElement>("[data-aead-enc-file]");
  const encFileName = root.querySelector<HTMLElement>("[data-aead-enc-filename]");
  const decFile = root.querySelector<HTMLInputElement>("[data-aead-dec-file]");
  const decFileName = root.querySelector<HTMLElement>("[data-aead-dec-filename]");
  const algorithm = root.querySelector<HTMLSelectElement>("[data-aead-algorithm]");
  const password = root.querySelector<HTMLInputElement>("[data-aead-password]");
  const togglePassword = root.querySelector<HTMLButtonElement>("[data-aead-toggle-password]");
  const encryptBtn = root.querySelector<HTMLButtonElement>("[data-aead-encrypt]");
  const decryptBtn = root.querySelector<HTMLButtonElement>("[data-aead-decrypt]");
  const progress = root.querySelector<HTMLElement>("[data-aead-progress]");
  const progressFile = root.querySelector<HTMLElement>("[data-aead-progress-file]");
  const progressFill = root.querySelector<HTMLElement>("[data-aead-progress-fill]");
  const progressStats = root.querySelector<HTMLElement>("[data-aead-progress-stats]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-aead-cancel]");
  const headerOut = root.querySelector<HTMLTextAreaElement>("[data-aead-header]");
  const resultOut = root.querySelector<HTMLInputElement>("[data-aead-result]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-aead-download]");
  const errorBox = root.querySelector<HTMLElement>("[data-aead-error]");

  if (
    !encFile || !encFileName || !decFile || !decFileName || !algorithm || !password ||
    !encryptBtn || !decryptBtn || !progress || !progressFile || !progressFill ||
    !progressStats || !cancelBtn || !headerOut || !resultOut || !downloadBtn || !errorBox
  ) return;

  const encFileInput: HTMLInputElement = encFile;
  const encFileLabel: HTMLElement = encFileName;
  const decFileInput: HTMLInputElement = decFile;
  const decFileLabel: HTMLElement = decFileName;
  const algorithmSelect: HTMLSelectElement = algorithm;
  const passwordInput: HTMLInputElement = password;
  const encryptButton: HTMLButtonElement = encryptBtn;
  const decryptButton: HTMLButtonElement = decryptBtn;
  const progressPanel: HTMLElement = progress;
  const progressFileEl: HTMLElement = progressFile;
  const progressFillEl: HTMLElement = progressFill;
  const progressStatsEl: HTMLElement = progressStats;
  const headerField: HTMLTextAreaElement = headerOut;
  const resultField: HTMLInputElement = resultOut;
  const downloadButton: HTMLButtonElement = downloadBtn;
  const errorEl: HTMLElement = errorBox;

  let lastBlob: Blob | null = null;
  let lastName: string | null = null;
  let abortController: AbortController | null = null;

  function showError(msg: string) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
  }

  function updateFileName(input: HTMLInputElement, label: HTMLElement) {
    const file = input.files && input.files.length > 0 ? input.files[0] : null;
    label.textContent = file ? file.name : strings.fileDropSubtitle;
  }

  function showProgress(file: File) {
    progressFileEl.textContent = `${file.name} • ${formatBytes(file.size)}`;
    progressFillEl.style.width = "0%";
    progressStatsEl.textContent = "";
    progressPanel.hidden = false;
  }
  /** Legacy updateProgress parity: percent bar + `X / Y • Z/s • ETA t`. */
  function updateProgress({ processed, total, elapsedMs }: AeadProgress) {
    const percent = total === 0 ? 0 : Math.min(100, Math.round((processed / total) * 100));
    const seconds = elapsedMs / 1000;
    const speed = seconds > 0 ? processed / seconds : 0;
    const remaining = speed > 0 ? (total - processed) / speed : 0;
    progressFillEl.style.width = `${percent}%`;
    progressStatsEl.textContent = `${formatBytes(processed)} / ${formatBytes(total)} • ${formatBytes(speed)}/s • ETA ${formatDuration(remaining)}`;
  }

  function setBusy(busy: boolean) {
    encryptButton.disabled = busy;
    decryptButton.disabled = busy;
    if (busy) downloadButton.disabled = true;
  }

  function handleError(e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      showError(strings.errorOperationCanceled);
    } else {
      showError(e instanceof Error ? e.message : String(e));
    }
  }

  function readPassword(): string | null {
    const pw = passwordInput.value.trim();
    if (!pw) {
      showError(strings.errorPasswordRequired);
      return null;
    }
    return pw;
  }

  async function runEncrypt() {
    clearError();
    const file = encFileInput.files && encFileInput.files.length > 0 ? encFileInput.files[0] : null;
    if (!file) {
      showError(strings.errorSelectFileToEncrypt);
      return;
    }
    const pw = readPassword();
    if (pw === null) return;

    setBusy(true);
    abortController = new AbortController();
    showProgress(file);
    try {
      const algo = (algorithmSelect.value || "aes-256-gcm") as AeadAlgorithm;
      const { blob, headerHex } = await aeadEncryptFile(file, pw, algo, {
        signal: abortController.signal,
        onProgress: updateProgress,
      });
      const outName = `${file.name}.aead`;
      lastBlob = blob;
      lastName = outName;
      headerField.value = headerHex;
      resultField.value = `${outName} • ${formatBytes(blob.size)}`;
      downloadButton.disabled = false;
    } catch (e) {
      handleError(e);
    } finally {
      progressPanel.hidden = true;
      setBusy(false);
      abortController = null;
    }
  }

  async function runDecrypt() {
    clearError();
    const file = decFileInput.files && decFileInput.files.length > 0 ? decFileInput.files[0] : null;
    if (!file) {
      showError(strings.errorSelectFileToDecrypt);
      return;
    }
    const pw = readPassword();
    if (pw === null) return;

    setBusy(true);
    abortController = new AbortController();
    showProgress(file);
    try {
      const { blob, headerHex } = await aeadDecryptFile(file, pw, {
        signal: abortController.signal,
        onProgress: updateProgress,
      });
      const outName = file.name.endsWith(".aead") ? file.name.slice(0, -5) : `${file.name}.dec`;
      lastBlob = blob;
      lastName = outName;
      headerField.value = headerHex;
      resultField.value = `${outName} • ${formatBytes(blob.size)}`;
      downloadButton.disabled = false;
    } catch (e) {
      handleError(e);
    } finally {
      progressPanel.hidden = true;
      setBusy(false);
      abortController = null;
    }
  }

  encFileInput.addEventListener("change", () => updateFileName(encFileInput, encFileLabel));
  decFileInput.addEventListener("change", () => updateFileName(decFileInput, decFileLabel));
  encryptButton.addEventListener("click", () => void runEncrypt());
  decryptButton.addEventListener("click", () => void runDecrypt());
  cancelBtn.addEventListener("click", () => abortController?.abort());

  togglePassword?.addEventListener("click", () => {
    passwordInput.type = passwordInput.type === "password" ? "text" : "password";
  });

  downloadButton.addEventListener("click", () => {
    if (!lastBlob || !lastName) return;
    const url = URL.createObjectURL(lastBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = lastName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
