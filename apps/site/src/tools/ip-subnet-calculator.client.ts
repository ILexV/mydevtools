/**
 * IP Subnet Calculator client. Wires the CIDR input (button click, Enter key,
 * example buttons) to the one-shot `calcIpv4` WASM call and renders the full
 * results table + binary view. Invalid input surfaces the localized
 * Error_InvalidFormat message and hides results. Copy buttons (network,
 * broadcast) swap to the localized "Copied!" label for 1200ms.
 */
import { calcIpv4 } from "@/scripts/wasm/ipcalc-client";

interface Strings {
  copied: string;
  errorInvalidFormat: string;
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
  ip_binary: string;
  mask_binary: string;
}

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
  if (!rootEl) return;
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

  async function calculate(): Promise<void> {
    const value = input.value.trim();
    if (!value) return;

    try {
      const result = (await calcIpv4(value)) as Ipv4Result;

      setValue("ip", result.ip);
      setValue("netmask", result.netmask);
      setValue("wildcard", result.wildcard);
      setValue("network", result.network);
      setValue("prefix", `/${result.prefix}`);
      setValue("broadcast", result.broadcast);
      setValue("hostMin", result.host_min);
      setValue("hostMax", result.host_max);
      setValue("usableHosts", result.usable_hosts.toLocaleString());
      setValue("totalHosts", result.total_hosts.toLocaleString());
      setValue("class", result.class);
      setValue("ipBinary", result.ip_binary);
      setValue("maskBinary", result.mask_binary);

      const privateBadge = root.querySelector<HTMLElement>('[data-ip-badge="private"]');
      const publicBadge = root.querySelector<HTMLElement>('[data-ip-badge="public"]');
      if (privateBadge && publicBadge) {
        privateBadge.hidden = !result.is_private;
        publicBadge.hidden = result.is_private;
      }

      errorBox.hidden = true;
      results.hidden = false;
    } catch {
      errorBox.textContent = strings.errorInvalidFormat;
      errorBox.hidden = false;
      results.hidden = true;
    }
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
    btn.addEventListener("click", () => {
      const key = btn.dataset.ipCopy;
      if (!key) return;
      const target = root.querySelector<HTMLElement>(`[data-ip-value="${key}"]`);
      const text = target?.textContent ?? "";
      if (!text) return;
      navigator.clipboard
        .writeText(text)
        .then(() => {
          const original = btn.innerHTML;
          btn.innerHTML = `<span class="ip-copied">${strings.copied}</span>`;
          window.setTimeout(() => {
            btn.innerHTML = original;
          }, 1200);
        })
        .catch(() => {
          /* clipboard unavailable */
        });
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
