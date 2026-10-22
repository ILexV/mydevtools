import { bindDialogClose } from "@/tools/http-scope-dialogs";
import {
  cookieError, cookieExpired, groupCookiesByDomain, normalizeCookieDomain, nowSeconds, removeCookie, removeCookieDomain, saveCookie,
  type CookieError, type HttpCookie,
} from "@/tools/http-cookies";

export interface CookiesDialogStrings {
  Lang: string;
  CookieAddTitle: string;
  CookieEditTitle: string;
  CookieSaved: string;
  CookieDeleted: string;
  CookieSession: string;
  CookieExpiresAt: string;
  CookieRemoved: string;
  CookiesNoMatch: string;
  CookiesClearConfirm: string;
  CookiesDeleteDomain: string;
  CookiesPersistBrowser: string;
  CookiesPersistAgent: string;
  CookiesPersistUnavailable: string;
  CookiesNeedAgent: string;
  CookiesAgentOutdated: string;
  CookieError_name: string;
  CookieError_value: string;
  CookieError_domain: string;
  CookieError_path: string;
  CookieError_size: string;
  SecretEdit: string;
  SecretDelete: string;
}

/** The jar as the page holds it; `change` updates memory and, when kept, storage. */
export interface CookieJarView {
  cookies(): readonly HttpCookie[];
  change(update: (jar: HttpCookie[]) => HttpCookie[]): Promise<void>;
  /** Where kept cookies go, or null while that place is out of reach (the agent is not connected). */
  persistTarget(): "browser" | "agent" | null;
  persisted(): boolean;
  setPersisted(on: boolean): Promise<void>;
  agentState(): "ok" | "disconnected" | "outdated";
}

const VALUE_PREVIEW = 160;

const pad = (value: number): string => String(value).padStart(2, "0");

/** `datetime-local` text in the viewer's time zone. */
function localInputValue(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Path, expiry and flags of a cookie, plus its domain when `withDomain`. */
export function cookieMeta(cookie: HttpCookie, strings: Pick<CookiesDialogStrings, "Lang" | "CookieSession" | "CookieExpiresAt">, withDomain: boolean): string {
  const expiry = cookie.expires === undefined ? strings.CookieSession
    : strings.CookieExpiresAt.replace("{date}", new Date(cookie.expires * 1000).toLocaleString(strings.Lang, { dateStyle: "medium", timeStyle: "short" }));
  return [
    withDomain ? `${cookie.hostOnly ? "" : "."}${cookie.domain}` : "",
    cookie.path,
    expiry,
    cookie.secure ? "Secure" : "",
    cookie.httpOnly ? "HttpOnly" : "",
    cookie.sameSite ? `SameSite=${cookie.sameSite}` : "",
  ].filter(Boolean).join(" · ");
}

/** One cookie as a list item: name, a value preview and the meta line. */
export function cookieItem(cookie: HttpCookie, strings: Pick<CookiesDialogStrings, "Lang" | "CookieSession" | "CookieExpiresAt" | "CookieRemoved">,
  options: { withDomain: boolean; removed?: boolean }): HTMLLIElement {
  const item = document.createElement("li");
  item.className = options.removed ? "http-secret-item is-removed" : "http-secret-item";
  const text = document.createElement("div");
  text.className = "http-secret-text";
  const name = document.createElement("code");
  name.className = "http-secret-name mono";
  name.textContent = cookie.name;
  const value = document.createElement("span");
  value.className = "http-cookie-value mono";
  value.textContent = cookie.value.length > VALUE_PREVIEW ? `${cookie.value.slice(0, VALUE_PREVIEW)}…` : cookie.value;
  if (cookie.value.length > VALUE_PREVIEW) value.title = cookie.value;
  const meta = document.createElement("span");
  meta.className = "http-secret-hosts ds-hint mono";
  meta.textContent = options.removed ? `${strings.CookieRemoved} · ${cookie.domain}${cookie.path}` : cookieMeta(cookie, strings, options.withDomain);
  text.append(name, ...(options.removed ? [] : [value]), meta);
  item.append(text);
  return item;
}

/**
 * «Cookies» window: the jar by domain with a filter, add/edit/delete, delete a
 * domain or everything, and the «Keep cookies» switch.
 */
export function bindCookiesDialog(dialog: HTMLDialogElement, options: {
  strings: CookiesDialogStrings;
  jar: CookieJarView;
  errorText(error: unknown): string;
  /** Prefills the domain of a new cookie. */
  requestUrl(): string;
}): { open(trigger: HTMLElement, filter?: string): void; refresh(): void } {
  const s = options.strings;
  const q = <T extends HTMLElement>(selector: string): T => dialog.querySelector<T>(selector)!;
  const agentNote = q<HTMLElement>("[data-http-cookies-agent]");
  const persist = q<HTMLInputElement>("[data-http-cookies-persist]");
  const persistHint = q<HTMLElement>("[data-http-cookies-persist-hint]");
  const filter = q<HTMLInputElement>("[data-http-cookies-filter]");
  const clear = q<HTMLButtonElement>("[data-http-cookies-clear]");
  const list = q<HTMLUListElement>("[data-http-cookies-list]");
  const empty = q<HTMLElement>("[data-http-cookies-empty]");
  const emptyText = empty.textContent ?? "";
  const form = q<HTMLFormElement>("[data-http-cookies-form]");
  const formTitle = q<HTMLElement>("[data-http-cookies-form-title]");
  const fields = {
    name: q<HTMLInputElement>("[data-http-cookie-name]"),
    value: q<HTMLInputElement>("[data-http-cookie-value]"),
    domain: q<HTMLInputElement>("[data-http-cookie-domain]"),
    path: q<HTMLInputElement>("[data-http-cookie-path]"),
    expires: q<HTMLInputElement>("[data-http-cookie-expires]"),
    subdomains: q<HTMLInputElement>("[data-http-cookie-subdomains]"),
    secure: q<HTMLInputElement>("[data-http-cookie-secure]"),
    httpOnly: q<HTMLInputElement>("[data-http-cookie-http-only]"),
  };
  const cancel = q<HTMLButtonElement>("[data-http-cookie-cancel]");
  const error = q<HTMLElement>("[data-http-cookies-error]");
  const status = q<HTMLElement>("[data-http-cookies-status]");
  const remember = bindDialogClose(dialog, q<HTMLButtonElement>("[data-http-cookies-close]"));
  let editing: HttpCookie | null = null;
  let busy = false;

  const show = (element: HTMLElement, text: string): void => {
    element.textContent = text;
    element.hidden = false;
  };
  const hide = (element: HTMLElement): void => {
    element.hidden = true;
    element.textContent = "";
  };
  const fieldFor: Record<CookieError, HTMLInputElement> = {
    name: fields.name, value: fields.value, domain: fields.domain, path: fields.path, size: fields.value,
  };

  function suggestedDomain(): string {
    try {
      return new URL(options.requestUrl()).hostname.replace(/^\[|\]$/gu, "");
    } catch {
      return "";
    }
  }

  function resetForm(): void {
    editing = null;
    form.reset();
    fields.path.value = "/";
    fields.domain.value = suggestedDomain();
    fields.name.readOnly = false;
    formTitle.textContent = s.CookieAddTitle;
    cancel.hidden = true;
    for (const input of Object.values(fieldFor)) input.removeAttribute("aria-invalid");
  }

  function startEdit(cookie: HttpCookie): void {
    resetForm();
    hide(error);
    hide(status);
    editing = cookie;
    fields.name.value = cookie.name;
    fields.value.value = cookie.value;
    fields.domain.value = cookie.domain;
    fields.path.value = cookie.path;
    fields.expires.value = cookie.expires === undefined ? "" : localInputValue(cookie.expires);
    fields.subdomains.checked = !cookie.hostOnly;
    fields.secure.checked = !!cookie.secure;
    fields.httpOnly.checked = !!cookie.httpOnly;
    formTitle.textContent = s.CookieEditTitle.replace("{name}", cookie.name);
    cancel.hidden = false;
    fields.value.focus();
  }

  const setBusy = (value: boolean): void => {
    busy = value;
    for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) {
      if (!control.matches("[data-http-cookies-close]")) control.disabled = value;
    }
    if (!value) render();
  };

  async function change(update: (jar: HttpCookie[]) => HttpCookie[], done: string): Promise<boolean> {
    setBusy(true);
    try {
      await options.jar.change(update);
      if (done) show(status, done);
      return true;
    } catch (failure) {
      show(error, options.errorText(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function render(): void {
    const state = options.jar.agentState();
    if (state === "ok") hide(agentNote);
    else show(agentNote, state === "outdated" ? s.CookiesAgentOutdated : s.CookiesNeedAgent);
    const target = options.jar.persistTarget();
    persist.checked = options.jar.persisted();
    persist.disabled = busy || target === null;
    persistHint.textContent = target === "agent" ? s.CookiesPersistAgent : target === "browser" ? s.CookiesPersistBrowser : s.CookiesPersistUnavailable;

    const now = nowSeconds();
    const all = options.jar.cookies().filter((cookie) => !cookieExpired(cookie, now));
    const needle = filter.value.trim().toLowerCase();
    // A host also finds the parent-domain cookies it would be sent.
    const shown = needle ? all.filter((cookie) => cookie.domain.includes(needle) || needle.endsWith(`.${cookie.domain}`)
      || cookie.name.toLowerCase().includes(needle)) : all;
    clear.disabled = busy || all.length === 0;
    const items: HTMLLIElement[] = [];
    for (const group of groupCookiesByDomain(shown)) {
      const head = document.createElement("li");
      head.className = "http-cookie-domain";
      const domain = document.createElement("span");
      domain.className = "mono";
      domain.textContent = `${group.domain} (${group.cookies.length})`;
      const removeDomain = button(s.CookiesDeleteDomain, `${s.CookiesDeleteDomain}: ${group.domain}`, "ds-btn ds-btn-small ds-btn-ghost http-secret-delete");
      removeDomain.addEventListener("click", () => {
        if (busy) return;
        hide(error);
        hide(status);
        void change((jar) => removeCookieDomain(jar, group.domain), "");
      });
      head.append(domain, removeDomain);
      items.push(head);
      for (const cookie of group.cookies) {
        const item = cookieItem(cookie, s, { withDomain: false });
        const actions = document.createElement("div");
        actions.className = "http-secret-actions";
        const edit = button(s.SecretEdit, `${s.SecretEdit}: ${cookie.name}`, "ds-btn ds-btn-small ds-btn-ghost");
        edit.addEventListener("click", () => startEdit(cookie));
        const remove = button(s.SecretDelete, `${s.SecretDelete}: ${cookie.name}`, "ds-btn ds-btn-small ds-btn-ghost http-secret-delete");
        remove.addEventListener("click", () => {
          if (busy) return;
          hide(error);
          hide(status);
          void change((jar) => removeCookie(jar, cookie), s.CookieDeleted.replace("{name}", cookie.name)).then((done) => {
            if (done && editing && editing.name === cookie.name && editing.domain === cookie.domain && editing.path === cookie.path) resetForm();
          });
        });
        actions.append(edit, remove);
        item.append(actions);
        items.push(item);
      }
    }
    list.replaceChildren(...items);
    list.hidden = items.length === 0;
    empty.hidden = items.length !== 0;
    empty.textContent = all.length && !shown.length ? s.CookiesNoMatch : emptyText;
  }

  function button(label: string, aria: string, className: string): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.setAttribute("aria-label", aria);
    element.disabled = busy;
    return element;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    hide(error);
    hide(status);
    const expires = fields.expires.value ? Math.floor(new Date(fields.expires.value).getTime() / 1000) : undefined;
    const cookie: HttpCookie = {
      name: fields.name.value.trim(),
      value: fields.value.value,
      domain: normalizeCookieDomain(fields.domain.value),
      path: fields.path.value.trim() || "/",
      ...(fields.subdomains.checked ? {} : { hostOnly: true }),
      ...(fields.secure.checked ? { secure: true } : {}),
      ...(fields.httpOnly.checked ? { httpOnly: true } : {}),
      ...(editing?.sameSite ? { sameSite: editing.sameSite } : {}),
      ...(expires !== undefined && Number.isFinite(expires) ? { expires } : {}),
    };
    for (const input of Object.values(fieldFor)) input.removeAttribute("aria-invalid");
    const problem = cookieError(cookie);
    if (problem) {
      fieldFor[problem].setAttribute("aria-invalid", "true");
      show(error, s[`CookieError_${problem}`]);
      fieldFor[problem].focus();
      return;
    }
    const replacing = editing;
    void change((jar) => saveCookie(jar, cookie, replacing, nowSeconds()), s.CookieSaved.replace("{name}", cookie.name)).then((done) => {
      if (done) resetForm();
    });
  });
  cancel.addEventListener("click", () => {
    resetForm();
    hide(error);
    hide(status);
  });
  filter.addEventListener("input", render);
  clear.addEventListener("click", () => {
    if (busy || !window.confirm(s.CookiesClearConfirm)) return;
    hide(error);
    hide(status);
    void change(() => [], "");
  });
  persist.addEventListener("change", () => {
    const on = persist.checked;
    hide(error);
    hide(status);
    setBusy(true);
    options.jar.setPersisted(on).catch((failure: unknown) => show(error, options.errorText(failure))).finally(() => setBusy(false));
  });
  // Field edits must not leave a stale invalid mark.
  for (const input of Object.values(fieldFor)) input.addEventListener("input", () => input.removeAttribute("aria-invalid"));

  return {
    open(trigger, filterText = "") {
      resetForm();
      hide(error);
      hide(status);
      filter.value = filterText;
      render();
      remember(trigger);
      dialog.showModal();
    },
    refresh() {
      if (dialog.open && !busy) render();
    },
  };
}
