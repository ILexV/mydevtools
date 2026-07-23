/**
 * OpenSSH keys client controller. Generate (ed25519/ecdsa/rsa with bits),
 * import (OpenSSH public/private, SPKI PEM, PKCS#8 PEM) and convert via the
 * cryptography WASM module. Legacy parity: RSA bits select enabled only for
 * RSA algorithms, download names (id_key/id_key.pub on generate,
 * imported.key/imported.pub on import), 1200ms copy label swap, raw WASM
 * warning strings, convert on empty input reports "unsupported format".
 *
 * `crypto-client` covers sshGenerate/sshPublicKeyInfo/sshToPkcs8Pem; the
 * remaining legacy WASM calls (private-key warnings, public-line derivation,
 * SPKI/PKCS#8 import) go through the generated module directly, initialized
 * once here.
 */
import init, * as crypto from "@/generated/wasm/cryptography/cryptography.js";
import {
  sshGenerate,
  sshPublicKeyInfo,
  sshToPkcs8Pem,
  type SshKeyType,
} from "@/scripts/wasm/crypto-client";

interface Strings {
  copy: string;
  copied: string;
  warningsTitle: string;
  error: string;
  unsupportedFormat: string;
  algorithmLabel: string;
  commentLabel: string;
  fileDropSubtitle: string;
}

type InputKind =
  | "empty"
  | "openssh-public"
  | "openssh-private"
  | "spki-public"
  | "pkcs8-private"
  | "unknown";

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

function guessInput(text: string): InputKind {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("ssh-")) return "openssh-public";
  if (trimmed.includes("BEGIN OPENSSH PRIVATE KEY")) return "openssh-private";
  if (trimmed.includes("BEGIN PUBLIC KEY")) return "spki-public";
  if (trimmed.includes("BEGIN PRIVATE KEY") || trimmed.includes("BEGIN ENCRYPTED PRIVATE KEY"))
    return "pkcs8-private";
  return "unknown";
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function initTool(): void {
  const root = document.querySelector<HTMLElement>("[data-ssh-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const algorithm = root.querySelector<HTMLSelectElement>("[data-ssh-algorithm]");
  const keySize = root.querySelector<HTMLSelectElement>("[data-ssh-keysize]");
  const passphrase = root.querySelector<HTMLInputElement>("[data-ssh-passphrase]");
  const generateBtn = root.querySelector<HTMLButtonElement>("[data-ssh-generate]");
  const importText = root.querySelector<HTMLTextAreaElement>("[data-ssh-import]");
  const importFile = root.querySelector<HTMLInputElement>("[data-ssh-importfile]");
  const importFileName = root.querySelector<HTMLElement>("[data-ssh-importfilename]");
  const importBtn = root.querySelector<HTMLButtonElement>("[data-ssh-import]");
  const convertBtn = root.querySelector<HTMLButtonElement>("[data-ssh-convert]");
  const publicKey = root.querySelector<HTMLTextAreaElement>("[data-ssh-public]");
  const privateKey = root.querySelector<HTMLTextAreaElement>("[data-ssh-private]");
  const publicCopy = root.querySelector<HTMLButtonElement>("[data-ssh-public-copy]");
  const privateCopy = root.querySelector<HTMLButtonElement>("[data-ssh-private-copy]");
  const publicDownload = root.querySelector<HTMLButtonElement>("[data-ssh-public-download]");
  const privateDownload = root.querySelector<HTMLButtonElement>("[data-ssh-private-download]");
  const info = root.querySelector<HTMLElement>("[data-ssh-info]");
  const warnings = root.querySelector<HTMLElement>("[data-ssh-warnings]");

  if (
    !algorithm ||
    !keySize ||
    !passphrase ||
    !generateBtn ||
    !importText ||
    !importFile ||
    !importFileName ||
    !importBtn ||
    !convertBtn ||
    !publicKey ||
    !privateKey ||
    !publicCopy ||
    !privateCopy ||
    !publicDownload ||
    !privateDownload ||
    !info ||
    !warnings
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

  let lastPublicName: string | null = null;
  let lastPrivateName: string | null = null;

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
    warningsBox.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = `${strings.error}:`;
    warningsBox.append(strong, ` ${message}`);
    warningsBox.hidden = false;
  }

  function clearMessages(): void {
    warningsBox.hidden = true;
    warningsBox.textContent = "";
    infoBox.hidden = true;
    infoBox.textContent = "";
  }

  function showInfo(algorithmName: string, comment: string): void {
    const parts = [`${strings.algorithmLabel}: ${algorithmName}`];
    if (comment) parts.push(`${strings.commentLabel}: ${comment}`);
    infoBox.textContent = parts.join(" · ");
    infoBox.hidden = false;
  }

  function copyText(textarea: HTMLTextAreaElement, button: HTMLButtonElement): void {
    const original = button.textContent;
    void navigator.clipboard.writeText(textarea.value || "").then(() => {
      button.textContent = strings.copied;
      button.classList.add("copied");
      setTimeout(() => {
        button.textContent = original;
        button.classList.remove("copied");
      }, 1200);
    });
  }

  async function readImportText(): Promise<string> {
    const text = importArea.value.trim();
    if (text) return text;
    const file = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    if (!file) return "";
    return await file.text();
  }

  async function generateAction(): Promise<void> {
    clearMessages();
    try {
      const pass = passInput.value.trim();
      const algorithmValue = algorithmSelect.value;
      let privateKeyPem: string;
      let publicKeyLine: string;

      if (algorithmValue.startsWith("rsa")) {
        await ensureRaw();
        const bits = parseInt(keySizeSelect.value, 10) || 3072;
        const pkcs8 = crypto.rsa_generate_private_key_pkcs8(bits);
        privateKeyPem = crypto.openssh_rsa_private_key_from_pkcs8(pkcs8, null, pass || null, null);
        publicKeyLine = crypto.openssh_private_key_to_public_key_line(privateKeyPem, pass || null, null);
      } else {
        const pair = await sshGenerate(algorithmValue as SshKeyType, "", pass);
        privateKeyPem = pair.privateKey;
        publicKeyLine = pair.publicKey;
      }

      privateArea.value = privateKeyPem;
      publicArea.value = publicKeyLine;

      await ensureRaw();
      setWarnings(crypto.openssh_private_key_warnings(privateKeyPem, pass || null));

      lastPublicName = "id_key.pub";
      lastPrivateName = "id_key";
    } catch (err) {
      setError(err);
    }
  }

  async function importAction(): Promise<void> {
    clearMessages();
    try {
      const pass = passInput.value.trim() || null;
      const input = await readImportText();
      const kind = guessInput(input);
      if (kind === "empty") return;

      await ensureRaw();
      let publicKeyLine = "";
      let privateKeyPem = "";

      if (kind === "openssh-private") {
        privateKeyPem = input;
        publicKeyLine = crypto.openssh_private_key_to_public_key_line(input, pass, null);
        setWarnings(crypto.openssh_private_key_warnings(input, pass));
      } else if (kind === "openssh-public") {
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

      publicArea.value = publicKeyLine;
      privateArea.value = privateKeyPem;

      lastPublicName = "imported.pub";
      lastPrivateName = "imported.key";
    } catch (err) {
      setError(err);
    }
  }

  async function convertAction(): Promise<void> {
    clearMessages();
    try {
      const pass = passInput.value.trim() || null;
      const input = await readImportText();
      const kind = guessInput(input);

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

      publicArea.value = publicKeyLine;
      privateArea.value = privateKeyPem;
    } catch (err) {
      setError(err);
    }
  }

  algorithmSelect.addEventListener("change", () => {
    const isRsa = algorithmSelect.value.startsWith("rsa");
    keySizeSelect.disabled = !isRsa;
    if (!isRsa) keySizeSelect.value = "default";
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
      fileNameLabel.textContent = fileInput.files[0].name;
      fileNameLabel.classList.add("file-selected");
    } else {
      fileNameLabel.textContent = strings.fileDropSubtitle;
      fileNameLabel.classList.remove("file-selected");
    }
  });

  generateBtn.addEventListener("click", () => void generateAction());
  importBtn.addEventListener("click", () => void importAction());
  convertBtn.addEventListener("click", () => void convertAction());
  publicCopy.addEventListener("click", () => copyText(publicArea, publicCopy));
  privateCopy.addEventListener("click", () => copyText(privateArea, privateCopy));
  publicDownload.addEventListener("click", () => {
    if (!publicArea.value) return;
    downloadText(lastPublicName || "id_key.pub", publicArea.value);
  });
  privateDownload.addEventListener("click", () => {
    if (!privateArea.value) return;
    downloadText(lastPrivateName || "id_key", privateArea.value);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTool, { once: true });
} else {
  initTool();
}
