/**
 * AEAD file crypto client controller. Drives `aead-file-client` (chunked
 * streaming WASM) for encrypt/decrypt with progress + cancel, header hex
 * output, and blob download — legacy parity (1 MiB chunks, Argon2id,
 * `<name>.aead` / strip-`.aead`-or-append-`.dec` download names, trimmed
 * password). Wrong password / tampered file / non-.aead input surface as
 * localized errors (AeadError.failure), not raw WASM strings.
 */
import {
  aeadEncryptFile,
  aeadDecryptFile,
  AeadError,
  type AeadAlgorithm,
  type AeadProgress,
} from "@/scripts/wasm/aead-file-client";
import { formatBytes } from "@/lib/format";
import { aeadProgressView, decryptedName, encryptedName } from "@/tools/aead-file-helpers";

interface Strings {
  fileProgressTitle: string;
  cancel: string;
  errorSelectFileToEncrypt: string;
  errorSelectFileToDecrypt: string;
  errorPasswordRequired: string;
  errorOperationCanceled: string;
  errorDecryptFailed: string;
  errorInvalidContainer: string;
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
  const progressBar = root.querySelector<HTMLElement>("[data-aead-progress-bar]");
  const progressFill = root.querySelector<HTMLElement>("[data-aead-progress-fill]");
  const progressStats = root.querySelector<HTMLElement>("[data-aead-progress-stats]");
  const cancelBtn = root.querySelector<HTMLButtonElement>("[data-aead-cancel]");
  const headerOut = root.querySelector<HTMLTextAreaElement>("[data-aead-header]");
  const resultOut = root.querySelector<HTMLInputElement>("[data-aead-result]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-aead-download]");
  const errorBox = root.querySelector<HTMLElement>("[data-aead-error]");

  if (
    !encFile || !encFileName || !decFile || !decFileName || !algorithm || !password ||
    !encryptBtn || !decryptBtn || !progress || !progressFill ||
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
    passwordInput.removeAttribute("aria-invalid");
  }

  function selectedFile(input: HTMLInputElement): File | null {
    return input.files && input.files.length > 0 ? input.files[0] : null;
  }

  function updateFileName(input: HTMLInputElement, label: HTMLElement) {
    const file = selectedFile(input);
    label.textContent = file ? `${file.name} (${formatBytes(file.size, 2)})` : "";
  }

  function setProgress(percent: number, text: string) {
    progressFillEl.style.width = `${percent}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    progressStatsEl.textContent = text;
  }

  function showProgress(file: File) {
    setProgress(0, `${file.name} • ${formatBytes(file.size, 2)}`);
    progressPanel.hidden = false;
  }

  function updateProgress({ processed, total, elapsedMs }: AeadProgress) {
    const view = aeadProgressView(processed, total, elapsedMs);
    setProgress(view.percent, view.text);
  }

  function setBusy(busy: boolean, active: HTMLButtonElement | null) {
    encryptButton.disabled = busy;
    decryptButton.disabled = busy;
    encFileInput.disabled = busy;
    decFileInput.disabled = busy;
    active?.setAttribute("aria-busy", String(busy));
    if (!busy) {
      encryptButton.removeAttribute("aria-busy");
      decryptButton.removeAttribute("aria-busy");
    }
    if (busy) downloadButton.disabled = true;
  }

  function resetOutput() {
    lastBlob = null;
    lastName = null;
    headerField.value = "";
    resultField.value = "";
    downloadButton.disabled = true;
  }

  function handleError(e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      showError(strings.errorOperationCanceled);
    } else if (e instanceof AeadError && e.failure === "auth") {
      passwordInput.setAttribute("aria-invalid", "true");
      showError(strings.errorDecryptFailed);
    } else if (e instanceof AeadError && e.failure === "header") {
      showError(strings.errorInvalidContainer);
    } else {
      showError(e instanceof Error ? e.message : String(e));
    }
  }

  function readPassword(): string | null {
    // Trimmed for legacy parity: files encrypted by the legacy site used the trimmed password.
    const pw = passwordInput.value.trim();
    if (!pw) {
      passwordInput.setAttribute("aria-invalid", "true");
      showError(strings.errorPasswordRequired);
      passwordInput.focus();
      return null;
    }
    return pw;
  }

  async function run(mode: "encrypt" | "decrypt") {
    clearError();
    const file = selectedFile(mode === "encrypt" ? encFileInput : decFileInput);
    if (!file) {
      showError(mode === "encrypt" ? strings.errorSelectFileToEncrypt : strings.errorSelectFileToDecrypt);
      return;
    }
    const pw = readPassword();
    if (pw === null) return;

    resetOutput();
    setBusy(true, mode === "encrypt" ? encryptButton : decryptButton);
    abortController = new AbortController();
    showProgress(file);
    try {
      const opts = { signal: abortController.signal, onProgress: updateProgress };
      const { blob, headerHex } =
        mode === "encrypt"
          ? await aeadEncryptFile(file, pw, (algorithmSelect.value || "aes-256-gcm") as AeadAlgorithm, opts)
          : await aeadDecryptFile(file, pw, opts);
      const outName = mode === "encrypt" ? encryptedName(file.name) : decryptedName(file.name);
      lastBlob = blob;
      lastName = outName;
      headerField.value = headerHex;
      resultField.value = `${outName} • ${formatBytes(blob.size, 2)}`;
      downloadButton.disabled = false;
    } catch (e) {
      handleError(e);
    } finally {
      progressPanel.hidden = true;
      setBusy(false, null);
      abortController = null;
    }
  }

  encFileInput.addEventListener("change", () => updateFileName(encFileInput, encFileLabel));
  decFileInput.addEventListener("change", () => updateFileName(decFileInput, decFileLabel));
  encryptButton.addEventListener("click", () => void run("encrypt"));
  decryptButton.addEventListener("click", () => void run("decrypt"));
  cancelBtn.addEventListener("click", () => abortController?.abort());
  passwordInput.addEventListener("input", () => passwordInput.removeAttribute("aria-invalid"));

  togglePassword?.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    // Constant label ("Show password") + aria-pressed conveys the state.
    togglePassword.setAttribute("aria-pressed", String(show));
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
    // Revoke on the next tick: some browsers start the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
