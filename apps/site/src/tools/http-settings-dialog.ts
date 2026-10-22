import { bindDialogClose } from "@/tools/http-scope-dialogs";
import { proxyUrlError } from "@/tools/http-transport-options";
import type { HttpProxySettings, HttpWorkspace } from "@/tools/http-workspace";

/**
 * «Client settings» window of the HTTP client (Postman's Settings → Proxy):
 * the workspace proxy the agent connects through. Edits are saved as typed.
 */
export function bindClientSettingsDialog(dialog: HTMLDialogElement, options: {
  strings: { ProxyUrlInvalid: string };
  workspace(): HttpWorkspace;
  changed(): void;
}): { open(trigger: HTMLElement): void } {
  const enabled = dialog.querySelector<HTMLInputElement>("[data-http-proxy-enabled]")!;
  const url = dialog.querySelector<HTMLInputElement>("[data-http-proxy-url]")!;
  const username = dialog.querySelector<HTMLInputElement>("[data-http-proxy-username]")!;
  const password = dialog.querySelector<HTMLInputElement>("[data-http-proxy-password]")!;
  const bypass = dialog.querySelector<HTMLInputElement>("[data-http-proxy-bypass]")!;
  const error = dialog.querySelector<HTMLElement>("[data-http-proxy-error]")!;
  const remember = bindDialogClose(dialog, dialog.querySelector<HTMLButtonElement>("[data-http-settings-close]")!);

  const validate = (): void => {
    const invalid = enabled.checked && (!url.value.trim() || proxyUrlError(url.value) !== null);
    error.textContent = invalid ? options.strings.ProxyUrlInvalid : "";
    error.hidden = !invalid;
    url.setAttribute("aria-invalid", String(invalid));
  };
  const save = (): void => {
    const proxy: HttpProxySettings = {
      enabled: enabled.checked, url: url.value.trim(), username: username.value, password: password.value, bypass: bypass.value,
    };
    const workspace = options.workspace();
    if (!proxy.enabled && !proxy.url && !proxy.username && !proxy.password && !proxy.bypass) delete workspace.proxy;
    else workspace.proxy = proxy;
    validate();
    options.changed();
  };
  for (const input of [enabled, url, username, password, bypass]) input.addEventListener(input === enabled ? "change" : "input", save);

  return {
    open(trigger) {
      const proxy = options.workspace().proxy;
      enabled.checked = proxy?.enabled ?? false;
      url.value = proxy?.url ?? "";
      username.value = proxy?.username ?? "";
      password.value = proxy?.password ?? "";
      bypass.value = proxy?.bypass ?? "";
      validate();
      remember(trigger);
      dialog.showModal();
    },
  };
}
