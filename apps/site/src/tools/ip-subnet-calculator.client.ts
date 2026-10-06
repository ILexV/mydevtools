/**
 * IP Subnet Calculator client. Wires the CIDR input (button click, Enter key,
 * example buttons) to the one-shot `calcIpv4` / `calcIpv6` WASM call (IPv6 when
 * the input contains a colon) and renders the matching results table. Invalid
 * input surfaces the localized Error_InvalidFormat message and hides results.
 * The IPv6 address count (up to 2^128) is formatted as BigInt in page locale.
 */
import { calcIpv4, calcIpv6, ensureIpcalcReady, isIpv6Input } from "@/scripts/wasm/ipcalc-client";
import { copyWithFeedback } from "@/scripts/tool-ui";

interface Strings {
  lang: string;
  copied: string;
  copyFailed: string;
  errorInvalidFormat: string;
  errorLoad: string;
  scopes: Record<string, string>;
}

/** WASM `CalculationResult` JSON shape (wasm/ipcalc/src/ipv4.rs). */
interface Ipv4Result {
  input: string;
  ip: string;
  prefix: number;
  netmask: string;
  wildcard: string;
  network: string;
  broadcast: string;
  host_min: string;
  host_max: string;
  total_hosts: number;
  usable_hosts: number;
  class: string;
  is_private: boolean;
  scope: string;
  ip_binary: string;
  mask_binary: string;
}

/** WASM `Ipv6Result` JSON shape (wasm/ipcalc/src/ipv6.rs). */
interface Ipv6Result {
  ip: string;
  ip_expanded: string;
  prefix: number;
  netmask: string;
  network: string;
  first: string;
  last: string;
  address_count: string;
  scope: string;
}

/** Badge colour per address type: routable → success, private-ish → warning, special → neutral. */
const SCOPE_BADGE: Record<string, string> = {
  public: "ds-badge-success",
  global: "ds-badge-success",
  private: "ds-badge-warning",
  shared: "ds-badge-warning",
  "unique-local": "ds-badge-warning",
};

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-ip-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init(): void {
  const rootEl = document.querySelector<HTMLElement>("[data-ip-tool]");
  if (!rootEl || rootEl.dataset.initialized) return;
  rootEl.dataset.initialized = "1";
  const root: HTMLElement = rootEl;

  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const inputEl = root.querySelector<HTMLInputElement>("[data-ip-input]");
  const resultsEl = root.querySelector<HTMLElement>("[data-ip-results]");
  const errorEl = root.querySelector<HTMLElement>("[data-ip-error]");
  if (!inputEl || !resultsEl || !errorEl) return;
  const input: HTMLInputElement = inputEl;
  const results: HTMLElement = resultsEl;
  const errorBox: HTMLElement = errorEl;

  function setValue(key: string, text: string): void {
    const el = root.querySelector<HTMLElement>(`[data-ip-value="${key}"]`);
    if (el) el.textContent = text;
  }

  const nf = new Intl.NumberFormat(strings.lang);

  function showError(msg: string): void {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
    if (msg) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function setScope(selector: string, scope: string): void {
    const badge = root.querySelector<HTMLElement>(selector);
    if (!badge) return;
    badge.className = `ds-badge ${SCOPE_BADGE[scope] ?? ""}`.trim();
    badge.textContent = strings.scopes[scope] ?? scope;
  }

  function renderV4(result: Ipv4Result): void {
    setValue("ip", result.ip);
    setValue("netmask", result.netmask);
    setValue("wildcard", result.wildcard);
    setValue("network", result.network);
    setValue("prefix", `/${result.prefix}`);
    setValue("broadcast", result.broadcast);
    setValue("hostMin", result.host_min);
    setValue("hostMax", result.host_max);
    setValue("usableHosts", nf.format(result.usable_hosts));
    setValue("totalHosts", nf.format(result.total_hosts));
    setValue("class", result.class);
    setValue("ipBinary", result.ip_binary);
    setValue("maskBinary", result.mask_binary);
    setScope("[data-ip-scope]", result.scope);
  }

  function renderV6(result: Ipv6Result): void {
    setValue("v6ip", result.ip);
    setValue("v6expanded", result.ip_expanded);
    setValue("v6network", result.network);
    setValue("v6prefix", `/${result.prefix}`);
    setValue("v6netmask", result.netmask);
    setValue("v6first", result.first);
    setValue("v6last", result.last);
    // Up to 2^128 — beyond Number precision, so format the decimal string as BigInt.
    setValue("v6count", nf.format(BigInt(result.address_count)));
    setValue("v6pow", String(128 - result.prefix));
    setScope("[data-ip-scope-v6]", result.scope);
  }

  async function calculate(): Promise<void> {
    const value = input.value.trim();
    if (!value) {
      showError("");
      results.hidden = true;
      return;
    }

    // Load failure (network/offline) is not the user's fault — separate message.
    try {
      await ensureIpcalcReady();
    } catch {
      showError(strings.errorLoad);
      results.hidden = true;
      return;
    }

    const v6 = isIpv6Input(value);
    let result: unknown;
    try {
      result = v6 ? await calcIpv6(value) : await calcIpv4(value);
    } catch {
      showError(strings.errorInvalidFormat);
      results.hidden = true;
      return;
    }

    if (v6) renderV6(result as Ipv6Result);
    else renderV4(result as Ipv4Result);
    const v4Table = root.querySelector<HTMLElement>("[data-ip-v4]");
    const v6Table = root.querySelector<HTMLElement>("[data-ip-v6]");
    const binary = root.querySelector<HTMLElement>("[data-ip-binary]");
    if (v4Table) v4Table.hidden = v6;
    if (binary) binary.hidden = v6;
    if (v6Table) v6Table.hidden = !v6;

    showError("");
    results.hidden = false;
  }

  root.querySelector<HTMLButtonElement>("[data-ip-calculate]")?.addEventListener("click", () => {
    void calculate();
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") void calculate();
  });

  root.querySelectorAll<HTMLButtonElement>("[data-ip-example]").forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.ipExample ?? "";
      void calculate();
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-ip-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.ipCopy;
      if (!key) return;
      const text = root.querySelector<HTMLElement>(`[data-ip-value="${key}"]`)?.textContent ?? "";
      if (!text) return;
      if (!(await copyWithFeedback(btn, text, strings.copied))) showError(strings.copyFailed);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
