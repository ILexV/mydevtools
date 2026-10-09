/**
 * AEAD file crypto client controller. Drives `aead-file-client` (Argon2id +
 * chunked streaming WASM in a Web Worker) for encrypt/decrypt with progress + cancel, header hex
 * output, and blob download (1 MiB chunks, Argon2id, `<name>.aead` /
 * strip-`.aead`-or-append-`.dec` download names). Encryption writes MDT3 and
 * uses the password exactly as typed (a hint flags edge whitespace);
 * decryption also reads legacy MDT2 and falls back to the trimmed password
 * (the old site trimmed), with a note when either legacy path was used.
 * Wrong password / tampered or truncated file / non-.aead input surface as
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
import { revealOutput, startPreparing, syncEmptyState } from "@/scripts/tool-ui";
import { aeadProgressView, decryptedName, encryptedName } from "@/tools/aead-file-helpers";
import { hasEdgeWhitespace, passwordCandidates } from "@/tools/crypto-password";

interface Strings {
  fileProgressTitle: string;
  cancel: string;
  errorSelectFileToEncrypt: string;
  errorSelectFileToDecrypt: string;
  errorPasswordRequired: string;
  errorOperationCanceled: string;
  errorDecryptFailed: string;
  errorInvalidContainer: string;
  noteTrimmedPassword: string;
  noteLegacyFormat: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
  processingFailed: string;
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
  const headerOut = root.querySelector<HTMLElement>("[data-aead-header]");
  const resultOut = root.querySelector<HTMLElement>("[data-aead-result]");
  const outputPanel = root.querySelector<HTMLElement>("[data-aead-output]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-aead-download]");
  const errorBox = root.querySelector<HTMLElement>("[data-aead-error]");
  const noteBox = root.querySelector<HTMLElement>("[data-aead-note]");
  const whitespaceHint = root.querySelector<HTMLElement>("[data-aead-password-ws]");

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
  const headerField: HTMLElement = headerOut;
  const resultField: HTMLElement = resultOut;
  const downloadButton: HTMLButtonElement = downloadBtn;
  const errorEl: HTMLElement = errorBox;

  let lastBlob: Blob | null = null;
  let lastName: string | null = null;
  let abortController: AbortController | null = null;
  let operationEpoch = 0;

  function showError(msg: string) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() {
    errorEl.hidden = true;
    passwordInput.removeAttribute("aria-invalid");
    if (noteBox) {
      noteBox.hidden = true;
      noteBox.textContent = "";
    }
  }

  function showNotes(notes: string[]) {
    if (!noteBox || notes.length === 0) return;
    noteBox.textContent = notes.join(" ");
    noteBox.hidden = false;
  }

  function updateWhitespaceHint() {
    if (whitespaceHint) whitespaceHint.hidden = !hasEdgeWhitespace(passwordInput.value);
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
    headerField.textContent = "";
    resultField.textContent = "";
    downloadButton.disabled = true;
    if (outputPanel) syncEmptyState(outputPanel, true);
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
      showError(strings.processingFailed);
    }
  }

  /** The password exactly as typed (no trim); empty → localized error. */
  function readPassword(): string | null {
    const pw = passwordInput.value;
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

    // Programmatic or rapid reruns supersede the old operation immediately.
    // Its catch/finally paths are epoch-guarded so they cannot clear fresh UI.
    abortController?.abort();
    const mine = ++operationEpoch;
    const ctrl = new AbortController();
    abortController = ctrl;
    resetOutput();
    const trigger = mode === "encrypt" ? encryptButton : decryptButton;
    setBusy(true, trigger);
    showProgress(file);
    // First-run "Preparing…" until the AEAD worker reports progress or finishes.
    const prepared = startPreparing("cryptography:aead", {
      host: trigger.closest<HTMLElement>(".ds-action-row"),
      label: strings.preparing,
    });
    try {
      const opts = {
        signal: ctrl.signal,
        onProgress: (info: AeadProgress) => {
          if (mine !== operationEpoch) return;
          prepared();
          updateProgress(info);
        },
      };
      const notes: string[] = [];
      let blob: Blob;
      let headerHex: string;
      if (mode === "encrypt") {
        ({ blob, headerHex } = await aeadEncryptFile(file, pw, (algorithmSelect.value || "aes-256-gcm") as AeadAlgorithm, opts));
      } else {
        const res = await aeadDecryptFile(file, passwordCandidates(pw), opts);
        ({ blob, headerHex } = res);
        if (res.passwordIndex > 0) notes.push(strings.noteTrimmedPassword);
        if (res.format === 2) notes.push(strings.noteLegacyFormat);
      }
      if (mine !== operationEpoch) return;
      const outName = mode === "encrypt" ? encryptedName(file.name) : decryptedName(file.name);
      lastBlob = blob;
      lastName = outName;
      headerField.textContent = headerHex;
      resultField.textContent = `${outName} • ${formatBytes(blob.size, 2)}`;
      downloadButton.disabled = false;
      if (outputPanel) syncEmptyState(outputPanel, false);
      showNotes(notes);
      revealOutput(outputPanel);
    } catch (e) {
      if (mine === operationEpoch) handleError(e);
    } finally {
      prepared();
      if (mine === operationEpoch) {
        progressPanel.hidden = true;
        setBusy(false, null);
        if (abortController === ctrl) abortController = null;
      }
    }
  }

  encFileInput.addEventListener("change", () => updateFileName(encFileInput, encFileLabel));
  decFileInput.addEventListener("change", () => updateFileName(decFileInput, decFileLabel));
  encryptButton.addEventListener("click", () => void run("encrypt"));
  decryptButton.addEventListener("click", () => void run("decrypt"));
  cancelBtn.addEventListener("click", () => abortController?.abort());
  passwordInput.addEventListener("input", () => {
    passwordInput.removeAttribute("aria-invalid");
    updateWhitespaceHint();
  });
  updateWhitespaceHint();

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
