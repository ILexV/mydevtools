import { copyWithFeedback, prepareCopyButton } from "@/scripts/tool-ui";
import type { VaultSecretInfo } from "@/scripts/local-agent";
import { isSecretName, isSecretValue, parseSecretHosts, secretPlaceholder, suggestedSecretHost } from "@/tools/http-secrets";

export interface SecretsDialogStrings {
  Cancel: string;
  SecretAddTitle: string;
  SecretEditTitle: string;
  SecretValueKeep: string;
  SecretEdit: string;
  SecretDelete: string;
  SecretDeleteConfirm: string;
  SecretCopy: string;
  SecretCopyPlaceholder: string;
  SecretCopied: string;
  SecretSaved: string;
  SecretDeleted: string;
  SecretNameInvalid: string;
  SecretNameTaken: string;
  SecretValueInvalid: string;
  SecretHostsInvalid: string;
}

export interface SecretsClient {
  listSecrets(): Promise<VaultSecretInfo[]>;
  writeSecret(name: string, hosts: readonly string[], value?: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
}

interface SecretsDialogOptions {
  client: SecretsClient;
  strings: SecretsDialogStrings;
  errorText(error: unknown): string;
  /** URL of the open request: its host is the default for a new secret. */
  requestUrl(): string;
}

/**
 * HTTP client «Secrets» window over the agent vault: lists names and allowed
 * hosts, adds a secret, replaces its value or hosts, deletes it and copies the
 * `{{secret:name}}` placeholder. Values are write-only and never shown.
 */
export function bindSecretsDialog(dialog: HTMLDialogElement, options: SecretsDialogOptions): { open(returnFocus: HTMLElement): void } {
  const { client, strings: s } = options;
  const list = dialog.querySelector<HTMLUListElement>("[data-http-secrets-list]")!;
  const empty = dialog.querySelector<HTMLElement>("[data-http-secrets-empty]")!;
  const form = dialog.querySelector<HTMLFormElement>("[data-http-secrets-form]")!;
  const formTitle = dialog.querySelector<HTMLElement>("[data-http-secrets-form-title]")!;
  const nameInput = dialog.querySelector<HTMLInputElement>("[data-http-secret-name]")!;
  const valueInput = dialog.querySelector<HTMLInputElement>("[data-http-secret-value]")!;
  const valueHint = dialog.querySelector<HTMLElement>("[data-http-secret-value-hint]")!;
  const hostsInput = dialog.querySelector<HTMLInputElement>("[data-http-secret-hosts]")!;
  const save = dialog.querySelector<HTMLButtonElement>("[data-http-secret-save]")!;
  const cancelEdit = dialog.querySelector<HTMLButtonElement>("[data-http-secret-cancel-edit]")!;
  const closeButton = dialog.querySelector<HTMLButtonElement>("[data-http-secrets-close]")!;
  const error = dialog.querySelector<HTMLElement>("[data-http-secrets-error]")!;
  const status = dialog.querySelector<HTMLElement>("[data-http-secrets-status]")!;

  let secrets: VaultSecretInfo[] = [];
  let editing: string | null = null;
  let busy = false;
  let returnFocus: HTMLElement | null = null;
  let loadRevision = 0;

  const show = (element: HTMLElement, text: string): void => {
    element.textContent = text;
    element.hidden = false;
  };
  const hide = (element: HTMLElement): void => {
    element.hidden = true;
    element.textContent = "";
  };
  const setBusy = (value: boolean): void => {
    busy = value;
    save.disabled = value;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button[data-secret-action]")) button.disabled = value;
  };

  function resetForm(): void {
    editing = null;
    form.reset();
    nameInput.readOnly = false;
    formTitle.textContent = s.SecretAddTitle;
    valueInput.required = true;
    valueHint.hidden = true;
    cancelEdit.hidden = true;
    hostsInput.value = suggestedSecretHost(options.requestUrl());
  }

  function startEdit(secret: VaultSecretInfo): void {
    editing = secret.name;
    hide(error);
    hide(status);
    nameInput.value = secret.name;
    nameInput.readOnly = true;
    valueInput.value = "";
    valueInput.required = false;
    valueHint.hidden = false;
    hostsInput.value = secret.hosts.join(", ");
    formTitle.textContent = s.SecretEditTitle.replace("{name}", secret.name);
    cancelEdit.hidden = false;
    valueInput.focus();
  }

  function render(): void {
    const items = secrets.map((secret) => {
      const item = document.createElement("li");
      item.className = "http-secret-item";
      const text = document.createElement("div");
      text.className = "http-secret-text";
      const name = document.createElement("code");
      name.className = "http-secret-name mono";
      name.textContent = secretPlaceholder(secret.name);
      const hosts = document.createElement("span");
      hosts.className = "http-secret-hosts ds-hint mono";
      hosts.textContent = secret.hosts.join(", ");
      text.append(name, hosts);
      const actions = document.createElement("div");
      actions.className = "http-secret-actions";
      const copy = button("ds-btn ds-btn-small ds-btn-ghost", "copy", s.SecretCopy);
      copy.setAttribute("aria-label", `${s.SecretCopyPlaceholder}: ${secret.name}`);
      copy.title = s.SecretCopyPlaceholder;
      // Reserve the "copied" width up front so the row does not reflow on click.
      prepareCopyButton(copy, s.SecretCopied, null);
      copy.addEventListener("click", () => { void copyWithFeedback(copy, secretPlaceholder(secret.name), s.SecretCopied); });
      const edit = button("ds-btn ds-btn-small ds-btn-ghost", "edit", s.SecretEdit);
      edit.setAttribute("aria-label", `${s.SecretEdit}: ${secret.name}`);
      edit.addEventListener("click", () => startEdit(secret));
      const remove = button("ds-btn ds-btn-small ds-btn-ghost http-secret-delete", "delete", s.SecretDelete);
      remove.setAttribute("aria-label", `${s.SecretDelete}: ${secret.name}`);
      remove.addEventListener("click", () => { void deleteSecret(secret.name, remove); });
      actions.append(copy, edit, remove);
      item.append(text, actions);
      return item;
    });
    list.replaceChildren(...items);
    list.hidden = secrets.length === 0;
    empty.hidden = secrets.length !== 0;
  }

  function button(className: string, action: string, label: string): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.dataset.secretAction = action;
    element.textContent = label;
    element.disabled = busy;
    return element;
  }

  async function reload(): Promise<void> {
    const revision = ++loadRevision;
    try {
      const next = await client.listSecrets();
      if (revision !== loadRevision) return;
      secrets = next.sort((left, right) => left.name.localeCompare(right.name));
      render();
    } catch (reason) {
      if (revision === loadRevision) show(error, options.errorText(reason));
    }
  }

  async function deleteSecret(name: string, trigger: HTMLButtonElement): Promise<void> {
    if (busy || !window.confirm(s.SecretDeleteConfirm.replace("{name}", name))) return;
    hide(error);
    hide(status);
    setBusy(true);
    try {
      await client.deleteSecret(name);
      if (editing === name) resetForm();
      show(status, s.SecretDeleted.replace("{name}", name));
    } catch (reason) {
      show(error, options.errorText(reason));
    } finally {
      setBusy(false);
      await reload();
      (trigger.isConnected ? trigger : nameInput).focus();
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    hide(error);
    hide(status);
    const name = nameInput.value.trim();
    const value = valueInput.value;
    const hosts = parseSecretHosts(hostsInput.value);
    // An empty value while editing keeps the stored one.
    const invalid: [HTMLInputElement, string] | null = !isSecretName(name) ? [nameInput, s.SecretNameInvalid]
      : !editing && secrets.some((secret) => secret.name === name) ? [nameInput, s.SecretNameTaken]
        : (value || !editing) && !isSecretValue(value) ? [valueInput, s.SecretValueInvalid]
          : !hosts ? [hostsInput, s.SecretHostsInvalid]
            : null;
    for (const input of [nameInput, valueInput, hostsInput]) input.removeAttribute("aria-invalid");
    if (invalid || !hosts) {
      const [field, message] = invalid ?? [hostsInput, s.SecretHostsInvalid];
      field.setAttribute("aria-invalid", "true");
      show(error, message);
      field.focus();
      return;
    }
    setBusy(true);
    try {
      await client.writeSecret(name, hosts, value || undefined);
      // The value leaves the page as soon as the agent has it.
      valueInput.value = "";
      resetForm();
      show(status, s.SecretSaved.replace("{name}", name));
    } catch (reason) {
      show(error, options.errorText(reason));
    } finally {
      setBusy(false);
      await reload();
    }
  });
  cancelEdit.addEventListener("click", () => {
    hide(error);
    resetForm();
    nameInput.focus();
  });
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    // Never leave a typed value sitting in a closed dialog.
    valueInput.value = "";
    const target = returnFocus;
    returnFocus = null;
    queueMicrotask(() => { if (target?.isConnected) target.focus(); });
  });

  return {
    open(trigger: HTMLElement): void {
      if (dialog.open) return;
      returnFocus = trigger;
      hide(error);
      hide(status);
      resetForm();
      render();
      dialog.showModal();
      nameInput.focus();
      void reload();
    },
  };
}
