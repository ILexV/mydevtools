import { LocalAgentError, type VaultCertificateInfo } from "@/scripts/local-agent";
import { isSecretName, parseSecretHosts, suggestedSecretHost } from "@/tools/http-secrets";

export interface CertificatesStrings {
  Cancel: string;
  SecretNameInvalid: string;
  SecretNameTaken: string;
  SecretHostsInvalid: string;
  CertificateAddTitle: string;
  CertificateEditTitle: string;
  CertificateEdit: string;
  CertificateDelete: string;
  CertificateDeleteConfirm: string;
  CertificateSaved: string;
  CertificateDeleted: string;
  CertificateFilesRequired: string;
  CertificateExpires: string;
  Lang: string;
}

export interface CertificatesClient {
  listCertificates(): Promise<VaultCertificateInfo[]>;
  writeCertificate(name: string, hosts: readonly string[], pems?: { certificatePem: string; keyPem: string }): Promise<void>;
  deleteCertificate(name: string): Promise<void>;
}

/** Same limit as `MAX_CERTIFICATE_PEM_BYTES` in the agent vault. */
const MAX_PEM_BYTES = 64 * 1024;

/**
 * Client certificates (mTLS) in the «Client settings» window: PEM chain and key
 * go to the agent vault, the page lists names, hosts, subject and expiry only.
 * Editing keeps the stored pair unless both files are picked again.
 */
export function bindCertificatesSection(dialog: HTMLDialogElement, options: {
  client: CertificatesClient;
  strings: CertificatesStrings;
  errorText(error: unknown): string;
  requestUrl(): string;
  /** The vault list changed: the page keeps it to pick a certificate per request. */
  changed(certificates: VaultCertificateInfo[]): void;
}): { refresh(available: boolean): Promise<void> } {
  const s = options.strings;
  const section = dialog.querySelector<HTMLElement>("[data-http-certs]")!;
  const unavailable = dialog.querySelector<HTMLElement>("[data-http-certs-unavailable]")!;
  const list = dialog.querySelector<HTMLUListElement>("[data-http-certs-list]")!;
  const empty = dialog.querySelector<HTMLElement>("[data-http-certs-empty]")!;
  const form = dialog.querySelector<HTMLFormElement>("[data-http-certs-form]")!;
  const formTitle = dialog.querySelector<HTMLElement>("[data-http-certs-form-title]")!;
  const nameInput = dialog.querySelector<HTMLInputElement>("[data-http-cert-name]")!;
  const hostsInput = dialog.querySelector<HTMLInputElement>("[data-http-cert-hosts]")!;
  const certInput = dialog.querySelector<HTMLInputElement>("[data-http-cert-file]")!;
  const keyInput = dialog.querySelector<HTMLInputElement>("[data-http-cert-key]")!;
  const certName = dialog.querySelector<HTMLElement>("[data-http-cert-file-name]")!;
  const keyName = dialog.querySelector<HTMLElement>("[data-http-cert-key-name]")!;
  const keep = dialog.querySelector<HTMLElement>("[data-http-cert-keep]")!;
  const save = dialog.querySelector<HTMLButtonElement>("[data-http-cert-save]")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("[data-http-cert-cancel]")!;
  const error = dialog.querySelector<HTMLElement>("[data-http-certs-error]")!;
  const status = dialog.querySelector<HTMLElement>("[data-http-certs-status]")!;
  let certificates: VaultCertificateInfo[] = [];
  let editing: string | null = null;
  let busy = false;

  const show = (element: HTMLElement, text: string): void => {
    element.textContent = text;
    element.hidden = false;
  };
  const hide = (element: HTMLElement): void => {
    element.hidden = true;
    element.textContent = "";
  };
  const date = (iso: string | null): string => {
    if (!iso) return "";
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString(s.Lang, { dateStyle: "medium" });
  };
  for (const [input, label] of [[certInput, certName], [keyInput, keyName]] as const) {
    input.addEventListener("change", () => { label.textContent = input.files?.[0]?.name ?? ""; });
  }

  function resetForm(): void {
    editing = null;
    form.reset();
    certName.textContent = "";
    keyName.textContent = "";
    nameInput.readOnly = false;
    formTitle.textContent = s.CertificateAddTitle;
    keep.hidden = true;
    cancel.hidden = true;
    hostsInput.value = suggestedSecretHost(options.requestUrl());
  }

  function startEdit(certificate: VaultCertificateInfo): void {
    resetForm();
    editing = certificate.name;
    hide(error);
    hide(status);
    nameInput.value = certificate.name;
    nameInput.readOnly = true;
    hostsInput.value = certificate.hosts.join(", ");
    formTitle.textContent = s.CertificateEditTitle.replace("{name}", certificate.name);
    keep.hidden = false;
    cancel.hidden = false;
    hostsInput.focus();
  }

  function render(): void {
    list.replaceChildren(...certificates.map((certificate) => {
      const item = document.createElement("li");
      item.className = "http-secret-item";
      const text = document.createElement("div");
      text.className = "http-secret-text";
      const name = document.createElement("code");
      name.className = "http-secret-name mono";
      name.textContent = certificate.name;
      const subject = document.createElement("span");
      subject.className = "http-secret-hosts ds-hint mono";
      subject.textContent = [certificate.subject, certificate.notAfter ? s.CertificateExpires.replace("{date}", date(certificate.notAfter)) : ""]
        .filter(Boolean).join(" · ");
      const hosts = document.createElement("span");
      hosts.className = "http-secret-hosts ds-hint mono";
      hosts.textContent = certificate.hosts.join(", ");
      text.append(name, subject, hosts);
      const actions = document.createElement("div");
      actions.className = "http-secret-actions";
      const edit = button("ds-btn ds-btn-small ds-btn-ghost", s.CertificateEdit, `${s.CertificateEdit}: ${certificate.name}`);
      edit.addEventListener("click", () => startEdit(certificate));
      const remove = button("ds-btn ds-btn-small ds-btn-ghost http-secret-delete", s.CertificateDelete, `${s.CertificateDelete}: ${certificate.name}`);
      remove.addEventListener("click", () => { void removeCertificate(certificate.name); });
      actions.append(edit, remove);
      item.append(text, actions);
      return item;
    }));
    list.hidden = certificates.length === 0;
    empty.hidden = certificates.length !== 0;
  }

  function button(className: string, label: string, aria: string): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.setAttribute("aria-label", aria);
    element.disabled = busy;
    return element;
  }

  const setBusy = (value: boolean): void => {
    busy = value;
    save.disabled = value;
    for (const control of list.querySelectorAll<HTMLButtonElement>("button")) control.disabled = value;
  };

  async function reload(): Promise<void> {
    try {
      certificates = (await options.client.listCertificates()).sort((left, right) => left.name.localeCompare(right.name));
      options.changed(certificates);
      render();
    } catch (reason) {
      show(error, options.errorText(reason));
    }
  }

  async function removeCertificate(name: string): Promise<void> {
    if (busy || !window.confirm(s.CertificateDeleteConfirm.replace("{name}", name))) return;
    hide(error);
    hide(status);
    setBusy(true);
    try {
      await options.client.deleteCertificate(name);
      if (editing === name) resetForm();
      show(status, s.CertificateDeleted.replace("{name}", name));
    } catch (reason) {
      show(error, options.errorText(reason));
    } finally {
      setBusy(false);
      await reload();
      nameInput.focus();
    }
  }

  async function readPem(input: HTMLInputElement): Promise<string | null> {
    const file = input.files?.[0];
    if (!file) return null;
    if (file.size > MAX_PEM_BYTES) throw new RangeError("size");
    return await file.text();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    hide(error);
    hide(status);
    const name = nameInput.value.trim();
    const hosts = parseSecretHosts(hostsInput.value);
    const picked = Number(!!certInput.files?.length) + Number(!!keyInput.files?.length);
    const invalid: [HTMLElement, string] | null = !isSecretName(name) ? [nameInput, s.SecretNameInvalid]
      : !editing && certificates.some((entry) => entry.name === name) ? [nameInput, s.SecretNameTaken]
        : !hosts ? [hostsInput, s.SecretHostsInvalid]
          : (editing ? picked === 1 : picked !== 2) ? [certInput, s.CertificateFilesRequired]
            : null;
    for (const input of [nameInput, hostsInput]) input.removeAttribute("aria-invalid");
    if (invalid || !hosts) {
      const [field, message] = invalid ?? [hostsInput, s.SecretHostsInvalid];
      if (field instanceof HTMLInputElement && field.type !== "file") field.setAttribute("aria-invalid", "true");
      show(error, message);
      field.focus();
      return;
    }
    setBusy(true);
    try {
      const certificatePem = await readPem(certInput);
      const keyPem = await readPem(keyInput);
      await options.client.writeCertificate(name, hosts, certificatePem && keyPem ? { certificatePem, keyPem } : undefined);
      resetForm();
      show(status, s.CertificateSaved.replace("{name}", name));
    } catch (reason) {
      show(error, options.errorText(reason instanceof RangeError ? new LocalAgentError("request_too_large") : reason));
    } finally {
      // The key leaves page memory with the form.
      certInput.value = "";
      keyInput.value = "";
      setBusy(false);
      await reload();
    }
  });
  cancel.addEventListener("click", () => {
    hide(error);
    resetForm();
    nameInput.focus();
  });

  return {
    async refresh(available) {
      unavailable.hidden = available;
      section.hidden = !available;
      if (!available) return;
      hide(error);
      hide(status);
      resetForm();
      await reload();
    },
  };
}
