/**
 * OpenSSH keys client controller. Generate (ed25519/ecdsa/rsa with bits),
 * import (OpenSSH public/private, SPKI PEM, PKCS#8 PEM) and convert via the
 * cryptography WASM module. Legacy parity: RSA bits select enabled only for
 * RSA algorithms, download names (id_key/id_key.pub on generate,
 * imported.key/imported.pub on import), raw WASM warning strings, trimmed
 * passphrase, convert on empty input reports "unsupported format".
 * Fixes vs. the first port: Import button was bound to the textarea (shared
 * data hook), "RSA 4096" generated 3072-bit keys, ECDSA public lines were
 * "unsupported", malformed public lines were accepted, "id_key" downloaded
 * as "id_key.txt", the drop zone had no drop handling.
 *
 * `crypto-client` covers sshPublicKeyInfo/sshToPkcs8Pem; the
 * remaining legacy WASM calls (private-key warnings, public-line derivation,
 * SPKI/PKCS#8 import) go through the generated module directly, initialized
 * once here.
 */
import init, * as crypto from "@/generated/wasm/cryptography/cryptography.js";
import { sshPublicKeyInfo, sshToPkcs8Pem } from "@/scripts/wasm/crypto-client";
import { sshGenerateInWorker } from "@/scripts/wasm/keygen-client";
import type { SshKeygenType } from "@/scripts/wasm/keygen-protocol";
import { WasmError } from "@/scripts/wasm/worker-protocol";
import { bindDropzone, bindEmptyState, copyWithFeedback, syncEmptyState } from "@/scripts/tool-ui";
import { formatBytes } from "@/lib/format";
import { guessSshInput, rsaBits, sshErrorKey } from "@/tools/openssh-keys-helpers";
import { hasEdgeWhitespace, passwordCandidates } from "@/tools/crypto-password";

interface Strings {
  copy: string;
  copied: string;
  copyFailed: string;
  warningsTitle: string;
  error: string;
  unsupportedFormat: string;
  errorPassphraseRequired: string;
  errorWrongPassphrase: string;
  algorithmLabel: string;
  commentLabel: string;
  noteTrimmedPassphrase: string;
  generationCanceled: string;
}

/** Key files are tiny; anything bigger is certainly not a key. */
const MAX_KEY_FILE_BYTES = 1024 * 1024;

let rawReady: Promise<void> | null = null;
function ensureRaw(): Promise<void> {
  if (!rawReady) rawReady = init().then(() => undefined);
  return rawReady;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-ssh-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}


function downloadText(filename: string, text: string): void {
  // octet-stream: with text/plain Chrome saves "id_key" as "id_key.txt".
  const blob = new Blob([text], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function initTool(): void {
  const root = document.querySelector<HTMLElement>("[data-ssh-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const algorithm = q<HTMLSelectElement>("[data-ssh-algorithm]");
  const keySize = q<HTMLSelectElement>("[data-ssh-keysize]");
  const passphrase = q<HTMLInputElement>("[data-ssh-passphrase]");
  const generateBtn = q<HTMLButtonElement>("[data-ssh-generate]");
  const importText = q<HTMLTextAreaElement>("[data-ssh-import-text]");
  const dropzone = q<HTMLElement>("[data-ssh-dropzone]");
  const importFile = q<HTMLInputElement>("[data-ssh-importfile]");
  const importFileName = q<HTMLElement>("[data-ssh-importfilename]");
  const importBtn = q<HTMLButtonElement>("[data-ssh-import-btn]");
  const convertBtn = q<HTMLButtonElement>("[data-ssh-convert]");
  const publicKey = q<HTMLTextAreaElement>("[data-ssh-public]");
  const privateKey = q<HTMLTextAreaElement>("[data-ssh-private]");
  const publicCopy = q<HTMLButtonElement>("[data-ssh-public-copy]");
  const privateCopy = q<HTMLButtonElement>("[data-ssh-private-copy]");
  const publicDownload = q<HTMLButtonElement>("[data-ssh-public-download]");
  const privateDownload = q<HTMLButtonElement>("[data-ssh-private-download]");
  const info = q<HTMLElement>("[data-ssh-info]");
  const warnings = q<HTMLElement>("[data-ssh-warnings]");
  const errorEl = q<HTMLElement>("[data-ssh-error]");
  const noteEl = q<HTMLElement>("[data-ssh-note]");
  const wsHint = q<HTMLElement>("[data-ssh-passphrase-ws]");
  const progress = q<HTMLElement>("[data-ssh-progress]");
  const progressLabel = q<HTMLElement>("[data-ssh-progress-label]");
  const cancelBtn = q<HTMLButtonElement>("[data-ssh-cancel]");
  const publicPanel = q<HTMLElement>("[data-ssh-public-panel]");
  const privatePanel = q<HTMLElement>("[data-ssh-private-panel]");

  if (
    !algorithm || !keySize || !passphrase || !generateBtn || !importText || !dropzone ||
    !importFile || !importFileName || !importBtn || !convertBtn || !publicKey || !privateKey ||
    !publicCopy || !privateCopy || !publicDownload || !privateDownload || !info || !warnings || !errorEl
  ) {
    return;
  }
  const algorithmSelect: HTMLSelectElement = algorithm;
  const keySizeSelect: HTMLSelectElement = keySize;
  const passInput: HTMLInputElement = passphrase;
  const importArea: HTMLTextAreaElement = importText;
  const fileInput: HTMLInputElement = importFile;
  const fileNameLabel: HTMLElement = importFileName;
  const publicArea: HTMLTextAreaElement = publicKey;
  const privateArea: HTMLTextAreaElement = privateKey;
  const infoBox: HTMLElement = info;
  const warningsBox: HTMLElement = warnings;
  const errorBox: HTMLElement = errorEl;
  const actionButtons = [generateBtn, importBtn, convertBtn];

  let lastPublicName: string | null = null;
  let lastPrivateName: string | null = null;

  function setOutputs(publicLine: string, privatePem: string): void {
    publicArea.value = publicLine;
    privateArea.value = privatePem;
    publicCopy!.disabled = publicDownload!.disabled = !publicLine;
    privateCopy!.disabled = privateDownload!.disabled = !privatePem;
    if (publicPanel) syncEmptyState(publicPanel, !publicLine);
    if (privatePanel) syncEmptyState(privatePanel, !privatePem);
  }

  function setWarnings(list: string[]): void {
    warningsBox.textContent = "";
    if (!list || list.length === 0) {
      warningsBox.hidden = true;
      return;
    }
    const strong = document.createElement("strong");
    strong.textContent = `${strings.warningsTitle}:`;
    warningsBox.append(strong, ` ${list.join("; ")}`);
    warningsBox.hidden = false;
  }

  function setError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const key = sshErrorKey(message);
    if (key) passInput.setAttribute("aria-invalid", "true");
    const text = key === "ErrorPassphraseRequired"
      ? strings.errorPassphraseRequired
      : key === "ErrorWrongPassphrase"
        ? strings.errorWrongPassphrase
        : message;
    errorBox.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = `${strings.error}:`;
    errorBox.append(strong, ` ${text}`);
    errorBox.hidden = false;
  }

  function clearMessages(): void {
    for (const box of [warningsBox, infoBox, errorBox, noteEl]) {
      if (!box) continue;
      box.hidden = true;
      box.textContent = "";
    }
    passInput.removeAttribute("aria-invalid");
  }

  function showInfo(algorithmName: string, comment: string): void {
    const parts = [`${strings.algorithmLabel}: ${algorithmName}`];
    if (comment) parts.push(`${strings.commentLabel}: ${comment}`);
    infoBox.textContent = parts.join(" · ");
    infoBox.hidden = false;
  }

  function showNote(text: string): void {
    if (!noteEl) return;
    noteEl.textContent = text;
    noteEl.hidden = false;
  }

  function updateWhitespaceHint(): void {
    if (wsHint) wsHint.hidden = !hasEdgeWhitespace(passInput.value);
  }

  /** Passphrase exactly as typed; empty → no encryption. */
  function readPass(): string | null {
    return passInput.value || null;
  }

  /**
   * Runs a passphrase-dependent step with the typed passphrase; if it is
   * rejected as wrong and a trimmed variant exists (old site trimmed),
   * retries once with that and shows a note.
   */
  async function withPassFallback<T>(fn: (pass: string | null) => T | Promise<T>): Promise<T> {
    const candidates = passwordCandidates(passInput.value);
    if (candidates.length === 0) return fn(null);
    try {
      return await fn(candidates[0]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (candidates.length < 2 || sshErrorKey(message) !== "ErrorWrongPassphrase") throw err;
      const result = await fn(candidates[1]);
      showNote(strings.noteTrimmedPassphrase);
      return result;
    }
  }

  /** Runs an action with all buttons disabled and `aria-busy` on the active one. */
  async function busy(btn: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
    clearMessages();
    for (const b of actionButtons) b.disabled = true;
    btn.setAttribute("aria-busy", "true");
    try {
      await action();
    } catch (err) {
      if (err instanceof WasmError && err.code === "aborted") showNote(strings.generationCanceled);
      else setError(err);
    } finally {
      btn.removeAttribute("aria-busy");
      for (const b of actionButtons) b.disabled = false;
    }
  }

  let generation: AbortController | null = null;

  /** Key generation in the worker: indeterminate progress + elapsed seconds + Cancel. */
  async function generateAction(): Promise<void> {
    const pass = readPass();
    const algorithmValue = algorithmSelect.value;
    const keyType: SshKeygenType = algorithmValue.startsWith("rsa") ? "rsa" : (algorithmValue as SshKeygenType);
    const controller = new AbortController();
    generation = controller;
    const started = performance.now();
    const tick = () => {
      if (progressLabel) progressLabel.textContent = `${Math.floor((performance.now() - started) / 1000)} s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    if (progress) progress.hidden = false;
    try {
      const key = await sshGenerateInWorker(
        { keyType, rsaBits: rsaBits(algorithmValue, keySizeSelect.value), passphrase: pass },
        controller.signal,
      );
      setOutputs(key.publicKey, key.privateKey);
      setWarnings(key.warnings);
      lastPublicName = "id_key.pub";
      lastPrivateName = "id_key";
    } finally {
      clearInterval(timer);
      if (progress) progress.hidden = true;
      generation = null;
    }
  }

  async function importAction(): Promise<void> {
    await withPassFallback((pass) => importWith(pass));
  }

  async function importWith(pass: string | null): Promise<void> {
    const input = importArea.value.trim();
    const kind = guessSshInput(input);
    if (kind === "empty") return;

    await ensureRaw();
    let publicKeyLine = "";
    let privateKeyPem = "";

    if (kind === "openssh-private") {
      privateKeyPem = input;
      publicKeyLine = crypto.openssh_private_key_to_public_key_line(input, pass, null);
      setWarnings(crypto.openssh_private_key_warnings(input, pass));
    } else if (kind === "openssh-public") {
      // Full parse (base64 + key blob): the algorithm probe alone accepts garbage after the type.
      crypto.openssh_public_key_bytes(input);
      publicKeyLine = input;
      const keyInfo = await sshPublicKeyInfo(input);
      showInfo(keyInfo.algorithm, keyInfo.comment);
      setWarnings(keyInfo.warnings);
    } else if (kind === "spki-public") {
      publicKeyLine = crypto.openssh_public_key_from_spki_pem(input, null);
      const keyInfo = await sshPublicKeyInfo(publicKeyLine);
      showInfo(keyInfo.algorithm, keyInfo.comment);
      setWarnings(keyInfo.warnings);
    } else if (kind === "pkcs8-private") {
      privateKeyPem = crypto.openssh_private_key_from_pkcs8_pem(input, pass, null, pass);
      publicKeyLine = crypto.openssh_private_key_to_public_key_line(privateKeyPem, pass, null);
      setWarnings(crypto.openssh_private_key_warnings(privateKeyPem, pass));
    } else {
      throw new Error(strings.unsupportedFormat);
    }

    setOutputs(publicKeyLine, privateKeyPem);
    lastPublicName = "imported.pub";
    lastPrivateName = "imported.key";
  }

  async function convertAction(): Promise<void> {
    await withPassFallback((pass) => convertWith(pass));
  }

  async function convertWith(pass: string | null): Promise<void> {
    const input = importArea.value.trim();
    const kind = guessSshInput(input);

    await ensureRaw();
    let publicKeyLine = "";
    let privateKeyPem = "";

    if (kind === "openssh-private") {
      privateKeyPem = await sshToPkcs8Pem(input, pass ?? "");
      publicKeyLine = crypto.openssh_private_key_to_public_key_line(input, pass, null);
    } else if (kind === "openssh-public") {
      publicKeyLine = crypto.openssh_public_key_to_spki_pem(input);
    } else if (kind === "spki-public") {
      publicKeyLine = crypto.openssh_public_key_from_spki_pem(input, null);
    } else if (kind === "pkcs8-private") {
      privateKeyPem = crypto.openssh_private_key_from_pkcs8_pem(input, pass, null, pass);
      publicKeyLine = crypto.openssh_private_key_to_public_key_line(privateKeyPem, pass, null);
    } else {
      throw new Error(strings.unsupportedFormat);
    }

    setOutputs(publicKeyLine, privateKeyPem);
  }

  /** A picked/dropped key file is loaded into the textarea, so what gets imported is visible. */
  async function loadKeyFile(files: File[]): Promise<void> {
    clearMessages();
    const file = files[0];
    if (!file) return;
    fileNameLabel.textContent = `${file.name} (${formatBytes(file.size)})`;
    try {
      if (file.size > MAX_KEY_FILE_BYTES) throw new Error(strings.unsupportedFormat);
      importArea.value = (await file.text()).trim();
      syncImport();
    } catch (err) {
      setError(err);
    }
  }

  algorithmSelect.addEventListener("change", () => {
    const isRsa = algorithmSelect.value.startsWith("rsa");
    keySizeSelect.disabled = !isRsa;
    keySizeSelect.value = "default";
  });

  // The import editor is the drop target (no click-to-pick: clicks belong to the
  // textarea); the header "Open" button is the picker.
  const syncImport = bindEmptyState(dropzone, importArea);
  bindDropzone(dropzone, fileInput, (files) => void loadKeyFile(files), { clickToOpen: false });
  passInput.addEventListener("input", () => {
    passInput.removeAttribute("aria-invalid");
    updateWhitespaceHint();
  });
  updateWhitespaceHint();
  cancelBtn?.addEventListener("click", () => generation?.abort());

  generateBtn.addEventListener("click", () => void busy(generateBtn, generateAction));
  importBtn.addEventListener("click", () => void busy(importBtn, importAction));
  convertBtn.addEventListener("click", () => void busy(convertBtn, convertAction));
  const copyOpts = { failedLabel: strings.copyFailed };
  publicCopy.addEventListener("click", () => void copyWithFeedback(publicCopy, publicArea.value, strings.copied, undefined, copyOpts));
  privateCopy.addEventListener("click", () => void copyWithFeedback(privateCopy, privateArea.value, strings.copied, undefined, copyOpts));
  publicDownload.addEventListener("click", () => {
    if (publicArea.value) downloadText(lastPublicName || "id_key.pub", publicArea.value);
  });
  privateDownload.addEventListener("click", () => {
    if (privateArea.value) downloadText(lastPrivateName || "id_key", privateArea.value);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTool, { once: true });
} else {
  initTool();
}
