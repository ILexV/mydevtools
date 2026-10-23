/**
 * File Signature controller. Two modes on one form: Verify (file + signature
 * text or .sig file + trusted public key(s) + SSH namespace) and Sign (file
 * + private key + passphrase + SSHSIG/raw options). Both run in the worker
 * (`file-signature-client`) with progress and cancel; the verdict shows as a
 * success/error banner plus detail rows (format, scheme, hash, fingerprint,
 * signer, namespace, minisign key id/trusted comment), the signature as text
 * with download/copy, the public key and a ready `ssh-keygen`/`openssl`
 * command to check it elsewhere. Nothing is persisted: keys, passphrases and
 * signatures live only in the form.
 */
import { signFile, verifyFileSignature, type SignOutput, type VerifyVerdict } from "@/scripts/wasm/file-signature-client";
import type { SignOptions } from "@/scripts/wasm/file-signature-protocol";
import { startToolOperation } from "@/scripts/analytics/instrumentation";
import { localizeResourceError, WasmError } from "@/scripts/wasm/worker-protocol";
import {
  bindDropzone,
  copyWithFeedback,
  prepareCopyButton,
  revealOutput,
  setDropzoneHasFile,
  startPreparing,
  syncEmptyState,
} from "@/scripts/tool-ui";
import { formatBytes, formatMs, formatString, progressPercent } from "@/lib/format";
import {
  detectSignatureKind,
  FAILURE_KEYS,
  signatureErrorKey,
  signatureFileName,
  signatureFileText,
  verifyCommand,
} from "@/tools/file-signature";

type Strings = Record<string, string>;
type Mode = "verify" | "sign";

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-fs-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-fs-tool]");
  if (!root || root.dataset.initialized) return;
  const strings = readStrings();
  if (!strings) return;
  const s = strings;
  const $ = <T extends Element = HTMLElement>(name: string) => root.querySelector<T>(`[data-fs-${name}]`);

  const panelTitle = $("panel")?.querySelector<HTMLElement>(".ds-panel-title") ?? null;
  const modeButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-fs-mode]")];
  const zone = $("dropzone");
  const fileInput = $<HTMLInputElement>("file");
  const fileName = $("file-name");
  const verifyBox = $("verify");
  const signBox = $("sign");
  const signatureInput = $<HTMLTextAreaElement>("signature");
  const signatureFile = $<HTMLInputElement>("signature-file");
  const signatureName = $("signature-name");
  const publicKeyInput = $<HTMLTextAreaElement>("public-key");
  const publicKeyFile = $<HTMLInputElement>("public-key-file");
  const publicKeyName = $("public-key-name");
  const publicKeyHint = $("public-key-hint");
  const namespaceField = $("namespace-field");
  const verifyNamespace = $<HTMLInputElement>("verify-namespace");
  const verifyBtn = $<HTMLButtonElement>("verify-run");
  const privateKeyInput = $<HTMLTextAreaElement>("private-key");
  const privateKeyFile = $<HTMLInputElement>("private-key-file");
  const privateKeyName = $("private-key-name");
  const passphraseInput = $<HTMLInputElement>("passphrase");
  const passphraseToggle = $<HTMLButtonElement>("passphrase-toggle");
  const formatSel = $<HTMLSelectElement>("format");
  const signNamespaceField = $("sign-namespace-field");
  const signNamespace = $<HTMLInputElement>("sign-namespace");
  const hashSel = $<HTMLSelectElement>("hash");
  const paddingSel = $<HTMLSelectElement>("padding");
  const encodingSel = $<HTMLSelectElement>("encoding");
  const rawFields = [...root.querySelectorAll<HTMLElement>("[data-fs-raw-field]")];
  const signBtn = $<HTMLButtonElement>("sign-run");
  const progress = $("progress");
  const progressBar = $("progress-bar");
  const progressFill = $("progress-fill");
  const progressLabel = $("progress-label");
  const cancelBtn = $<HTMLButtonElement>("cancel");
  const errorBox = $("error");
  const noteBox = $("note");
  const output = $("output");
  const loaded = $("loaded");
  const validBox = $("valid");
  const invalidBox = $("invalid");
  const warningBox = $("warning");
  const signedBox = $("signed");
  const signatureOut = $<HTMLTextAreaElement>("signature-out");
  const downloadBtn = $<HTMLButtonElement>("download");
  const copySignatureBtn = $<HTMLButtonElement>("copy-signature");
  const signedNote = $("signed-note");
  const rowsEl = $("rows");
  if (!zone || !fileInput || !verifyBox || !signBox || !signatureInput || !publicKeyInput || !verifyNamespace || !verifyBtn) return;
  if (!privateKeyInput || !passphraseInput || !formatSel || !signNamespace || !hashSel || !paddingSel || !encodingSel || !signBtn) return;
  if (!output || !loaded || !rowsEl || !signatureOut) return;
  root.dataset.initialized = "true";

  let mode: Mode = "verify";
  let file: File | null = null;
  let busy = false;
  let job: AbortController | null = null;
  let signed: { name: string; bytes: Uint8Array | null; text: string } | null = null;

  function show(box: HTMLElement | null, text: string) {
    if (!box) return;
    box.textContent = text;
    box.hidden = !text;
  }

  function clearResult() {
    for (const box of [validBox, invalidBox, warningBox, errorBox, noteBox]) show(box, "");
    rowsEl!.replaceChildren();
    signedBox!.hidden = true;
    signatureOut!.value = "";
    signed = null;
    loaded!.hidden = true;
    syncEmptyState(output!, true);
  }

  function syncControls() {
    for (const btn of modeButtons) btn.disabled = busy;
    for (const el of [verifyBtn, signBtn, fileInput, signatureFile, publicKeyFile, privateKeyFile]) if (el) el.disabled = busy;
    zone!.setAttribute("aria-disabled", String(busy));
    setDropzoneHasFile(zone!, file !== null);
    if (fileName) fileName.textContent = file ? `${file.name} · ${formatBytes(file.size, 1)}` : "";
  }

  function syncSignatureKind() {
    const kind = detectSignatureKind(signatureInput!.value);
    // The namespace only matters for SSH signatures; keep it visible until the kind is known.
    if (namespaceField) namespaceField.hidden = kind === "minisign" || kind === "raw";
    if (publicKeyHint) publicKeyHint.textContent = kind === "sshsig" ? `${s.PublicKeyHint} ${s.PublicKeyOptionalHint}` : s.PublicKeyHint;
  }

  function syncSignFormat() {
    const raw = formatSel!.value === "raw";
    for (const el of rawFields) el.hidden = !raw;
    if (signNamespaceField) signNamespaceField.hidden = raw;
  }

  function setMode(next: Mode) {
    if (busy || next === mode) return;
    mode = next;
    for (const btn of modeButtons) btn.setAttribute("aria-pressed", String(btn.dataset.fsMode === mode));
    verifyBox!.hidden = mode !== "verify";
    signBox!.hidden = mode !== "sign";
    if (panelTitle) panelTitle.textContent = mode === "verify" ? s.PanelVerify : s.PanelSign;
    clearResult();
  }

  async function loadText(input: HTMLInputElement, target: HTMLTextAreaElement, nameEl: HTMLElement | null, binaryAware: boolean) {
    const picked = input.files?.[0];
    input.value = "";
    if (!picked) return;
    const bytes = new Uint8Array(await picked.arrayBuffer());
    const { text, binary } = binaryAware ? signatureFileText(bytes) : { text: new TextDecoder().decode(bytes), binary: false };
    target.value = text;
    target.dispatchEvent(new Event("input"));
    if (nameEl) nameEl.textContent = picked.name;
    show(noteBox, binary ? formatString(s.SignatureBinaryNote, bytes.length) : "");
  }

  function addRow(key: string, value: string, options: { copy?: boolean; pre?: boolean } = {}) {
    if (!value) return;
    const row = document.createElement("div");
    row.className = options.copy ? "ds-result-row" : "ds-result-row ds-result-row-info";
    const dt = document.createElement("dt");
    dt.className = "ds-result-key";
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.className = options.pre ? "ds-result-value fs-pre" : "ds-result-value";
    dd.textContent = value;
    row.append(dt, dd);
    if (options.copy) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ds-icon-btn";
      btn.setAttribute("aria-label", `${s.Copy}: ${key}`);
      btn.title = `${s.Copy}: ${key}`;
      prepareCopyButton(btn, null, s.CopyFailed);
      btn.addEventListener("click", () => void copyWithFeedback(btn, value, null, undefined, { failedLabel: s.CopyFailed }));
      row.append(btn);
    }
    rowsEl!.append(row);
  }

  function formatName(format: string): string {
    if (format === "sshsig") return s.FormatNameSshsig;
    if (format === "minisign") return s.FormatNameMinisign;
    return s.FormatNameRaw;
  }

  function errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const key = signatureErrorKey(message);
    if (key) return s[key];
    return localizeResourceError(error, s as never) ?? s.ProcessingFailed;
  }

  function startProgress(total: number) {
    if (progress) progress.hidden = false;
    if (progressFill) progressFill.style.width = "0%";
    progressBar?.setAttribute("aria-valuenow", "0");
    if (progressLabel) progressLabel.textContent = formatString(s.ProgressLabel, formatBytes(0, 1), formatBytes(total, 1), formatBytes(0, 1));
  }

  function onProgress(p: { processed: number; total: number; elapsedMs: number }) {
    const percent = progressPercent(p.processed, p.total);
    if (progressFill) progressFill.style.width = `${percent}%`;
    progressBar?.setAttribute("aria-valuenow", String(Math.round(percent)));
    const speed = p.elapsedMs > 0 ? p.processed / (p.elapsedMs / 1000) : 0;
    if (progressLabel) progressLabel.textContent = formatString(s.ProgressLabel, formatBytes(p.processed, 1), formatBytes(p.total, 1), formatBytes(speed, 1));
  }

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    clearResult();
    if (!file) {
      show(errorBox, s.ErrorNoFile);
      return;
    }
    const operation = startToolOperation("file-signature");
    const ctrl = new AbortController();
    job = ctrl;
    busy = true;
    syncControls();
    const runBtn = mode === "verify" ? verifyBtn : signBtn;
    const prepared = startPreparing("cryptography", { host: runBtn!.closest<HTMLElement>(".ds-action-row"), label: s.Preparing });
    startProgress(file.size);
    try {
      await work(ctrl.signal);
      operation.complete();
      revealOutput(output);
    } catch (error) {
      if (error instanceof WasmError && error.code === "aborted") {
        operation.cancel();
        show(noteBox, s.Canceled);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        operation.fail(signatureErrorKey(message) ? "invalid_input" : "processing_error");
        show(errorBox, errorText(error));
      }
    } finally {
      prepared();
      if (progress) progress.hidden = true;
      busy = false;
      job = null;
      syncControls();
    }
  }

  function renderVerdict(v: VerifyVerdict, ms: number) {
    loaded!.hidden = false;
    syncEmptyState(output!, false);
    if (v.valid) {
      show(validBox, s.VerdictValid);
    } else {
      const reason = v.failure ? s[FAILURE_KEYS[v.failure]] : "";
      const detail =
        v.failure === "namespace"
          ? formatString(reason, v.namespace ?? "", verifyNamespace!.value.trim())
          : v.failure === "untrusted"
            ? formatString(reason, v.fingerprint ?? "")
            : v.failure === "key-mismatch"
              ? formatString(reason, v.keyId ?? "", v.expectedKeyId ?? "")
              : reason;
      show(invalidBox, `${s.VerdictInvalid}. ${detail}`);
    }
    if (v.valid && v.format === "sshsig" && v.trusted !== true) show(warningBox, s.UntrustedNote);

    addRow(s.RowFile, file ? `${file.name} · ${formatBytes(file.size, 1)}` : "");
    addRow(s.RowFormat, formatName(v.format));
    addRow(s.RowAlgorithm, v.algorithm);
    addRow(s.RowScheme, v.scheme ?? "");
    addRow(s.RowHash, v.hash && v.hash !== "—" ? v.hash : "");
    addRow(s.RowEncoding, v.encoding ? (v.encoding === "binary" ? s.EncodingBinary : v.encoding) : "");
    addRow(s.RowSigner, v.principal ?? "");
    addRow(s.RowNamespace, v.namespace ?? "");
    addRow(s.RowKeyId, v.keyId ?? "");
    addRow(s.RowComment, v.trustedComment ?? "", { pre: true });
    addRow(s.RowFingerprint, v.fingerprint ?? "", { copy: true });
    addRow(s.RowPublicKey, v.format === "sshsig" ? v.publicKey ?? "" : "", { copy: true });
    addRow(s.RowTime, formatMs(ms));
  }

  function renderSigned(out: SignOutput, options: SignOptions, ms: number) {
    loaded!.hidden = false;
    syncEmptyState(output!, false);
    const name = signatureFileName(file!.name);
    if (out.armored !== undefined) {
      signed = { name, bytes: null, text: out.armored };
      signatureOut!.value = out.armored;
      show(signedNote, s.SignedNote);
    } else {
      const bytes = out.signature ?? new Uint8Array();
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      signed = { name, bytes, text: btoa(bin) };
      signatureOut!.value = signed.text;
      show(signedNote, formatString(s.SignedRawNote, name));
    }
    signedBox!.hidden = false;
    const { info } = out;
    addRow(s.RowFile, `${file!.name} · ${formatBytes(file!.size, 1)}`);
    addRow(s.RowFormat, formatName(info.format));
    addRow(s.RowAlgorithm, info.algorithm);
    addRow(s.RowScheme, info.scheme);
    addRow(s.RowNamespace, info.namespace);
    addRow(s.RowFingerprint, info.fingerprint, { copy: true });
    if (info.format === "sshsig") {
      addRow(s.RowAllowedSigners, `signer ${info.publicKey}`, { copy: true });
    } else {
      addRow(s.RowPublicKey, info.publicKeyPem.trim(), { copy: true, pre: true });
    }
    const command = verifyCommand({ ...options, format: info.format, algorithm: info.algorithm, fileName: file!.name });
    addRow(s.RowCommand, command ?? "", { copy: true, pre: true });
    addRow(s.RowTime, formatMs(ms));
  }

  function verify() {
    const signatureText = signatureInput!.value;
    if (!signatureText.trim()) {
      clearResult();
      show(errorBox, file ? s.ErrorNoSignature : s.ErrorNoFile);
      return;
    }
    void run(async (signal) => {
      const t0 = performance.now();
      const verdict = await verifyFileSignature(
        file!,
        new TextEncoder().encode(signatureText),
        publicKeyInput!.value,
        verifyNamespace!.value,
        signal,
        onProgress,
      );
      renderVerdict(verdict, performance.now() - t0);
    });
  }

  function sign() {
    if (!privateKeyInput!.value.trim()) {
      clearResult();
      show(errorBox, file ? s.ErrorPrivateKeyMissing : s.ErrorNoFile);
      return;
    }
    const options: SignOptions = {
      format: formatSel!.value === "raw" ? "raw" : "sshsig",
      namespace: signNamespace!.value,
      hash: hashSel!.value as SignOptions["hash"],
      padding: paddingSel!.value === "pss" ? "pss" : "pkcs1",
      encoding: encodingSel!.value === "p1363" ? "p1363" : "der",
    };
    void run(async (signal) => {
      const t0 = performance.now();
      const out = await signFile(file!, privateKeyInput!.value, passphraseInput!.value, options, signal, onProgress);
      renderSigned(out, options, performance.now() - t0);
    });
  }

  for (const btn of modeButtons) btn.addEventListener("click", () => setMode(btn.dataset.fsMode === "sign" ? "sign" : "verify"));
  bindDropzone(zone, fileInput, (files) => {
    if (busy || !files[0]) return;
    file = files[0];
    clearResult();
    syncControls();
  });
  // Editing the text by hand detaches it from the loaded file name.
  const clearName = (el: HTMLElement | null) => () => { if (el) el.textContent = ""; };
  signatureInput.addEventListener("input", syncSignatureKind);
  signatureInput.addEventListener("input", clearName(signatureName));
  publicKeyInput.addEventListener("input", clearName(publicKeyName));
  privateKeyInput.addEventListener("input", clearName(privateKeyName));
  signatureFile?.addEventListener("change", () => void loadText(signatureFile, signatureInput, signatureName, true));
  publicKeyFile?.addEventListener("change", () => void loadText(publicKeyFile, publicKeyInput, publicKeyName, false));
  privateKeyFile?.addEventListener("change", () => void loadText(privateKeyFile, privateKeyInput, privateKeyName, false));
  passphraseToggle?.addEventListener("click", () => {
    const visible = passphraseInput.type === "password";
    passphraseInput.type = visible ? "text" : "password";
    passphraseToggle.setAttribute("aria-pressed", String(visible));
    passphraseToggle.textContent = visible ? s.HidePassphrase : s.ShowPassphrase;
  });
  formatSel.addEventListener("change", syncSignFormat);
  verifyBtn.addEventListener("click", verify);
  signBtn.addEventListener("click", sign);
  cancelBtn?.addEventListener("click", () => job?.abort());
  downloadBtn?.addEventListener("click", () => {
    if (!signed) return;
    const blob = signed.bytes
      ? new Blob([signed.bytes as BlobPart], { type: "application/octet-stream" })
      : new Blob([signed.text], { type: "text/plain" });
    saveBlob(blob, signed.name);
  });
  copySignatureBtn?.addEventListener("click", () =>
    void copyWithFeedback(copySignatureBtn, signatureOut.value, s.Copied, undefined, { failedLabel: s.CopyFailed }));

  syncSignatureKind();
  syncSignFormat();
  syncControls();
  clearResult();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
