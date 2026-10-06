/**
 * IP Subnet Calculator client. Wires the CIDR input (button click, Enter key,
 * example buttons) to the one-shot `calcIpv4` / `calcIpv6` WASM call (IPv6 when
 * the input contains a colon) and renders the matching results table. Invalid
 * input surfaces the localized Error_InvalidFormat message and hides results.
 * The IPv6 address count (up to 2^128) is formatted as BigInt in page locale.
 * Subnet split: after a successful calculation the "new prefix" field is
 * pre-filled (defaultSplitPrefix) and Split / Enter lists the first 256
 * subnets of the WASM `SplitResult` with the BigInt-formatted total count.
 */
import { calcIpv4, calcIpv6, ensureIpcalcReady, isIpv6Input, splitSubnets } from "@/scripts/wasm/ipcalc-client";
import { defaultSplitPrefix, maxPrefix, parseSplitPrefix } from "@/tools/ip-subnet";
import { copyWithFeedback, revealOutput, syncEmptyState, withPreparing } from "@/scripts/tool-ui";

interface Strings {
  lang: string;
  copied: string;
  copyFailed: string;
  errorInvalidFormat: string;
  errorLoad: string;
  scopes: Record<string, string>;
  splitPrefixHint: string;
  splitCount: string;
  splitAddressesPer: string;
  splitUsablePer: string;
  splitTruncated: string;
  splitColHostRange: string;
  splitColRange: string;
  errorSplitPrefix: string;
  /** `Common_Preparing` — first-run WASM load feedback. */
  preparing?: string;
}

/** WASM `SplitResult` JSON shape (wasm/ipcalc/src/split.rs). */
interface SplitResult {
  prefix: number;
  new_prefix: number;
  count: string;
  addresses_per_subnet: string;
  usable_per_subnet?: string;
  subnets: { cidr: string; first: string; last: string; broadcast?: string }[];
  truncated: boolean;
}

/** Replace `{name}` placeholders in a localized template. */
function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in params ? String(params[key]) : m));
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
  const splitPanel = root.querySelector<HTMLElement>("[data-ip-split]");

  /** Show results (or the compact empty placeholder); the split panel follows. */
  function setResultsVisible(visible: boolean): void {
    syncEmptyState(results, !visible);
    if (splitPanel) splitPanel.hidden = !visible;
  }

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

  const splitPrefixEl = root.querySelector<HTMLInputElement>("[data-ip-split-prefix]");
  const splitErrorEl = root.querySelector<HTMLElement>("[data-ip-split-error]");
  const splitOutEl = root.querySelector<HTMLElement>("[data-ip-split-out]");
  const splitHintEl = root.querySelector<HTMLElement>("[data-ip-split-hint]");
  /** Network last calculated successfully: the split always applies to it. */
  let current: { input: string; prefix: number; v6: boolean } | null = null;
  let lastSplitList = "";

  function showSplitError(msg: string): void {
    if (!splitErrorEl || !splitPrefixEl) return;
    splitErrorEl.textContent = msg;
    splitErrorEl.hidden = !msg;
    if (msg) splitPrefixEl.setAttribute("aria-invalid", "true");
    else splitPrefixEl.removeAttribute("aria-invalid");
  }

  /** Reset the split block for a newly calculated network. */
  function prepareSplit(prefix: number, v6: boolean): void {
    if (!splitPrefixEl) return;
    splitPrefixEl.value = String(defaultSplitPrefix(prefix, v6));
    if (splitHintEl) splitHintEl.textContent = fill(strings.splitPrefixHint, { min: prefix, max: maxPrefix(v6) });
    showSplitError("");
    if (splitOutEl) splitOutEl.hidden = true;
    lastSplitList = "";
  }

  function renderSplit(result: SplitResult, v6: boolean): void {
    if (!splitOutEl) return;
    const summary = root.querySelector<HTMLElement>("[data-ip-split-summary]");
    const truncated = root.querySelector<HTMLElement>("[data-ip-split-truncated]");
    const rows = root.querySelector<HTMLElement>("[data-ip-split-rows]");
    const rangeHead = root.querySelector<HTMLElement>("[data-ip-split-range-head]");
    const bcastHead = root.querySelector<HTMLElement>("[data-ip-split-bcast-head]");
    const count = nf.format(BigInt(result.count));

    if (summary) {
      summary.textContent = "";
      const facts: [string, string][] = [
        [strings.splitCount, count],
        [strings.splitAddressesPer, nf.format(BigInt(result.addresses_per_subnet))],
      ];
      if (result.usable_per_subnet !== undefined) facts.push([strings.splitUsablePer, nf.format(BigInt(result.usable_per_subnet))]);
      for (const [label, value] of facts) {
        const li = document.createElement("li");
        const strong = document.createElement("strong");
        strong.textContent = value;
        li.append(`${label}: `, strong);
        summary.append(li);
      }
    }
    if (truncated) {
      truncated.hidden = !result.truncated;
      truncated.textContent = result.truncated
        ? fill(strings.splitTruncated, { shown: nf.format(result.subnets.length), count })
        : "";
    }
    if (rangeHead) rangeHead.textContent = v6 ? strings.splitColRange : strings.splitColHostRange;
    if (bcastHead) bcastHead.hidden = v6;
    if (rows) {
      const frag = document.createDocumentFragment();
      result.subnets.forEach((sub, i) => {
        const tr = document.createElement("tr");
        const cells = [nf.format(i + 1), sub.cidr, sub.first === sub.last ? sub.first : `${sub.first} – ${sub.last}`];
        if (!v6) cells.push(sub.broadcast ?? "");
        for (const text of cells) {
          const td = document.createElement("td");
          td.textContent = text;
          tr.append(td);
        }
        frag.append(tr);
      });
      rows.replaceChildren(frag);
    }
    lastSplitList = result.subnets.map((sub) => sub.cidr).join("\n");
    splitOutEl.hidden = false;
  }

  async function split(): Promise<void> {
    if (!current || !splitPrefixEl) return;
    const { input: networkInput, prefix, v6 } = current;
    const newPrefix = parseSplitPrefix(splitPrefixEl.value, prefix, v6);
    if (newPrefix === null) {
      showSplitError(fill(strings.errorSplitPrefix, { min: prefix, max: maxPrefix(v6) }));
      if (splitOutEl) splitOutEl.hidden = true;
      return;
    }
    let result: SplitResult;
    try {
      result = (await splitSubnets(networkInput, newPrefix)) as SplitResult;
    } catch {
      showSplitError(fill(strings.errorSplitPrefix, { min: prefix, max: maxPrefix(v6) }));
      if (splitOutEl) splitOutEl.hidden = true;
      return;
    }
    showSplitError("");
    renderSplit(result, v6);
  }

  /** Resolves true when results were rendered (explicit callers then reveal them). */
  async function calculate(): Promise<boolean> {
    const value = input.value.trim();
    if (!value) {
      showError("");
      setResultsVisible(false);
      current = null;
      return false;
    }

    // Load failure (network/offline) is not the user's fault — separate message.
    try {
      await withPreparing("ipcalc", ensureIpcalcReady(), {
        host: root.querySelector<HTMLElement>("[data-ip-calculate]")?.closest<HTMLElement>(".ds-action-row") ?? results,
        label: strings.preparing,
      });
    } catch {
      showError(strings.errorLoad);
      setResultsVisible(false);
      return false;
    }

    const v6 = isIpv6Input(value);
    let result: unknown;
    try {
      result = v6 ? await calcIpv6(value) : await calcIpv4(value);
    } catch {
      showError(strings.errorInvalidFormat);
      setResultsVisible(false);
      return false;
    }

    if (v6) renderV6(result as Ipv6Result);
    else renderV4(result as Ipv4Result);
    const prefix = (result as { prefix: number }).prefix;
    current = { input: value, prefix, v6 };
    prepareSplit(prefix, v6);
    const v4Table = root.querySelector<HTMLElement>("[data-ip-v4]");
    const v6Table = root.querySelector<HTMLElement>("[data-ip-v6]");
    const binary = root.querySelector<HTMLElement>("[data-ip-binary]");
    if (v4Table) v4Table.hidden = v6;
    if (binary) binary.hidden = v6;
    if (v6Table) v6Table.hidden = !v6;

    showError("");
    setResultsVisible(true);
    return true;
  }

  /** Explicit Calculate / Enter / example chip: bring the results into view on phones. */
  async function calculateAndReveal(): Promise<void> {
    if (await calculate()) revealOutput(results);
  }

  root.querySelector<HTMLButtonElement>("[data-ip-calculate]")?.addEventListener("click", () => {
    void calculateAndReveal();
  });

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") void calculateAndReveal();
  });

  root.querySelector<HTMLButtonElement>("[data-ip-split-run]")?.addEventListener("click", async () => {
    await split();
    if (splitOutEl && !splitOutEl.hidden) revealOutput(splitOutEl);
  });
  splitPrefixEl?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") void split();
  });
  splitPrefixEl?.addEventListener("input", () => showSplitError(""));
  const splitCopyBtn = root.querySelector<HTMLButtonElement>("[data-ip-split-copy]");
  splitCopyBtn?.addEventListener("click", async () => {
    if (!lastSplitList) return;
    if (!(await copyWithFeedback(splitCopyBtn, lastSplitList, strings.copied))) showSplitError(strings.copyFailed);
  });

  root.querySelectorAll<HTMLButtonElement>("[data-ip-example]").forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.ipExample ?? "";
      void calculateAndReveal();
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
