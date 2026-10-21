/**
 * DNS lookup page. One query runs in the local agent (`dns.lookup`) against
 * this computer's resolver. The name and the answer stay on the page.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type DnsLookupResult,
} from "@/scripts/local-agent";
import { bindAgentPopover, onAgentSessionSaved } from "@/scripts/agent-popover";
import { copyWithFeedback } from "@/scripts/tool-ui";
import {
  DNS_LOOKUP_STORAGE_KEY,
  formatDnsText,
  isDnsRecordType,
  parseDnsLookupSettings,
  type DnsLookupSettings,
} from "@/tools/dns-lookup";

function readStrings(root: HTMLElement): Record<string, string> | null {
  const node = root.querySelector("[data-dns-strings]");
  if (!node?.textContent) return null;
  try {
    const value: unknown = JSON.parse(node.textContent);
    if (!value || typeof value !== "object") return null;
    return value as Record<string, string>;
  } catch {
    return null;
  }
}

function showMessage(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.hidden = false;
}

function hideMessage(el: HTMLElement): void {
  el.hidden = true;
  el.textContent = "";
}

function loadSettings(): DnsLookupSettings {
  try {
    const raw = localStorage.getItem(DNS_LOOKUP_STORAGE_KEY);
    if (!raw) return parseDnsLookupSettings(null);
    return parseDnsLookupSettings(JSON.parse(raw) as unknown);
  } catch {
    return parseDnsLookupSettings(null);
  }
}

function saveSettings(settings: DnsLookupSettings): boolean {
  try {
    localStorage.setItem(DNS_LOOKUP_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

function cell(row: HTMLTableRowElement, text: string, className?: string): void {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  row.append(td);
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-dns-lookup]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;

  const agentSettings = root.querySelector<HTMLDetailsElement>("[data-dns-agent-settings]");
  const code = root.querySelector<HTMLInputElement>("[data-dns-code]");
  const connect = root.querySelector<HTMLButtonElement>("[data-dns-connect]");
  const disconnect = root.querySelector<HTMLButtonElement>("[data-dns-disconnect]");
  const connectionState = root.querySelector<HTMLElement>("[data-dns-connection-state]");
  const agentMeta = root.querySelector<HTMLElement>("[data-dns-agent-meta]");
  const agentVersion = root.querySelector<HTMLElement>("[data-dns-agent-version]");
  const capabilitiesLabel = root.querySelector<HTMLElement>("[data-dns-capabilities]");
  const connectionStatus = root.querySelector<HTMLElement>("[data-dns-connection-status]");
  const capabilityWarning = root.querySelector<HTMLElement>("[data-dns-capability-warning]");
  const connectionError = root.querySelector<HTMLElement>("[data-dns-connection-error]");
  const storageWarning = root.querySelector<HTMLElement>("[data-dns-storage-warning]");
  const nameInput = root.querySelector<HTMLInputElement>("[data-dns-name]");
  const typeSelect = root.querySelector<HTMLSelectElement>("[data-dns-type]");
  const lookup = root.querySelector<HTMLButtonElement>("[data-dns-lookup-button]");
  const resultStatus = root.querySelector<HTMLElement>("[data-dns-result]");
  const resultError = root.querySelector<HTMLElement>("[data-dns-error]");
  const empty = root.querySelector<HTMLElement>("[data-dns-empty]");
  const body = root.querySelector<HTMLElement>("[data-dns-body]");
  const copy = root.querySelector<HTMLButtonElement>("[data-dns-copy]");
  if (!agentSettings || !code || !connect || !disconnect || !connectionState || !agentMeta || !agentVersion
    || !capabilitiesLabel || !connectionStatus || !capabilityWarning || !connectionError
    || !storageWarning || !nameInput || !typeSelect || !lookup || !resultStatus || !resultError
    || !empty || !body || !copy) {
    return;
  }

  const client = new LocalAgentClient();
  const popover = bindAgentPopover(agentSettings);
  let settings = loadSettings();
  let answer: DnsLookupResult | null = null;
  let busy = false;
  let lookupAbort: AbortController | null = null;
  let operation: ToolOperation | null = null;
  let operationSettled = false;

  if (isDnsRecordType(settings.recordType)) typeSelect.value = settings.recordType;

  const errorText = (error: unknown): string => {
    if (error instanceof LocalAgentError) return strings[`Error_${error.code}`] || strings.ErrorGeneric;
    return strings.ErrorGeneric;
  };

  const fill = (template: string, params: Record<string, string | number>): string =>
    template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));

  const hasDnsCapability = (): boolean => client.capabilities.includes("dns.lookup");

  const persistSettings = (): void => {
    const saved = saveSettings(settings);
    storageWarning.hidden = !client.connected || (client.persisted && saved);
    if (client.connected && (!client.persisted || !saved)) storageWarning.textContent = strings.ConnectionNotSaved;
  };

  const showCapabilityWarning = (): void => {
    if (client.connected && !hasDnsCapability()) showMessage(capabilityWarning, strings.NeedDnsCapability);
    else hideMessage(capabilityWarning);
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    const canLookup = client.connected && hasDnsCapability() && !busy;
    const canUpgrade = !busy && (!client.connected || !hasDnsCapability());
    lookup.disabled = !canLookup;
    lookup.ariaBusy = busy ? "true" : "false";
    nameInput.disabled = busy;
    typeSelect.disabled = busy;
    connect.disabled = !canUpgrade;
    code.disabled = !canUpgrade;
    disconnect.disabled = !client.connected;
    copy.disabled = answer === null || answer.records.length === 0 || busy;
  };

  const setConnected = (connected: boolean): void => {
    connectionState.textContent = connected ? strings.AgentConnectedShort : strings.AgentDisconnectedShort;
    popover.sync(client);
    agentMeta.hidden = !connected;
    capabilitiesLabel.textContent = client.capabilities.join(", ");
    showCapabilityWarning();
    persistSettings();
    setBusy(busy);
  };

  const renderAnswer = (result: DnsLookupResult | null): void => {
    answer = result;
    body.replaceChildren();
    if (!result) {
      hideMessage(resultStatus);
      empty.hidden = false;
      copy.disabled = true;
      return;
    }
    empty.hidden = true;
    const statusText = result.status === "nxdomain"
      ? strings.StatusNxdomain
      : result.status === "nodata"
        ? strings.StatusNodata
        : fill(strings.StatusNoerror, { count: result.records.length });
    showMessage(resultStatus, statusText);
    for (const record of result.records) {
      const row = document.createElement("tr");
      cell(row, record.name);
      cell(row, record.type, "mono");
      cell(row, String(record.ttl), "mono");
      cell(row, record.preference === null ? "\u2014" : String(record.preference), "mono");
      cell(row, record.data);
      body.append(row);
    }
    copy.disabled = result.records.length === 0;
  };

  const settle = (kind: "complete" | "fail" | "cancel"): void => {
    if (operationSettled) return;
    operationSettled = true;
    if (kind === "complete") operation?.complete();
    else if (kind === "fail") operation?.fail("processing_error");
    else operation?.cancel();
    operation = null;
  };

  const connectAgent = async (automatic = false): Promise<void> => {
    hideMessage(connectionError);
    showMessage(connectionStatus, strings.Connecting);
    connectionState.textContent = strings.Connecting;
    connect.disabled = true;
    const pairingCode = automatic ? "" : code.value.trim();
    try {
      let info;
      if (pairingCode) {
        const inspected = await client.inspect();
        const advertised = Array.isArray(inspected.capabilities) ? inspected.capabilities : [];
        if (!advertised.includes("dns.lookup")) throw new LocalAgentError("unsupported_capability");
        info = await client.pairKeepingSession(pairingCode, mergeCapabilities(advertised, "dns.lookup"));
      } else {
        info = await client.restore();
      }
      if (!info) {
        setConnected(false);
        hideMessage(connectionStatus);
        if (!automatic) showMessage(connectionError, strings.Error_unauthorized);
        return;
      }
      agentVersion.textContent = info.version;
      setConnected(true);
      showMessage(connectionStatus, strings.Connected);
    } catch (error) {
      setConnected(client.connected);
      hideMessage(connectionStatus);
      showMessage(connectionError, errorText(error));
    } finally {
      code.value = "";
      popover.sync(client);
      if (!client.connected) connect.disabled = false;
    }
  };

  connect.addEventListener("click", () => { void connectAgent(); });
  disconnect.addEventListener("click", () => {
    void (async () => {
      lookupAbort?.abort();
      if (busy && !operationSettled) settle("cancel");
      const pending = client.disconnect();
      setBusy(false);
      setConnected(false);
      hideMessage(connectionError);
      hideMessage(connectionStatus);
      try {
        await pending;
        showMessage(connectionStatus, strings.Disconnected);
      } catch (error) {
        showMessage(connectionError, errorText(error));
      }
      popover.sync(client);
    })();
  });

  typeSelect.addEventListener("change", () => {
    if (!isDnsRecordType(typeSelect.value)) return;
    settings = { ...settings, recordType: typeSelect.value };
    persistSettings();
  });

  const runLookup = async (): Promise<void> => {
    hideMessage(resultError);
    if (!client.connected) {
      showMessage(resultError, strings.NotConnected);
      return;
    }
    if (!hasDnsCapability()) {
      showMessage(capabilityWarning, strings.NeedDnsCapability);
      return;
    }
    const name = nameInput.value.trim();
    if (!name || !isDnsRecordType(typeSelect.value)) {
      showMessage(resultError, strings.InvalidName);
      return;
    }
    settings = { ...settings, recordType: typeSelect.value };
    persistSettings();
    lookupAbort?.abort();
    if (operation && !operationSettled) settle("cancel");
    const controller = new AbortController();
    lookupAbort = controller;
    operation = startToolOperation("dns-lookup");
    operationSettled = false;
    setBusy(true);
    lookup.textContent = strings.LookingUp;
    try {
      const result = await client.lookupDns({ name, type: typeSelect.value }, controller.signal);
      if (lookupAbort !== controller) return;
      renderAnswer(result);
      settle("complete");
    } catch (error) {
      if (lookupAbort !== controller) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        settle("cancel");
        return;
      }
      settle("fail");
      showMessage(resultError, errorText(error));
    } finally {
      if (lookupAbort === controller) {
        lookup.textContent = strings.Lookup;
        setBusy(false);
      }
    }
  };

  lookup.addEventListener("click", () => { void runLookup(); });
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runLookup();
    }
  });
  copy.addEventListener("click", () => {
    if (!answer || answer.records.length === 0) return;
    void copyWithFeedback(copy, formatDnsText(answer), strings.Copied, 1500, { failedLabel: strings.CopyFailed });
  });

  window.addEventListener("pagehide", () => {
    lookupAbort?.abort();
  });

  renderAnswer(null);
  setConnected(false);
  void connectAgent(true);
  // A pairing made in another window lands here only while this one cannot work anyway.
  onAgentSessionSaved(() => {
    if (!client.connected || !client.capabilities.includes("dns.lookup")) void connectAgent(true);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
