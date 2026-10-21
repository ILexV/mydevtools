/**
 * ASN lookup page. One address goes to the local prefix table (`asn.lookup`).
 * The address and the result stay on the page. Nothing is written for this tool.
 * The lookup does not call a geo-IP API and is not part of path trace.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type AsnLookupResult,
  type LocalAgentCapability,
} from "@/scripts/local-agent";
import { copyWithFeedback } from "@/scripts/tool-ui";
import { asnQueryLooksValid, formatAsnText } from "@/tools/asn-lookup";

function readStrings(root: HTMLElement): Record<string, string> | null {
  const node = root.querySelector("[data-asn-strings]");
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

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-asn-lookup]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;

  const code = root.querySelector<HTMLInputElement>("[data-asn-code]");
  const connect = root.querySelector<HTMLButtonElement>("[data-asn-connect-agent]");
  const disconnect = root.querySelector<HTMLButtonElement>("[data-asn-disconnect]");
  const connectionState = root.querySelector<HTMLElement>("[data-asn-connection-state]");
  const agentMeta = root.querySelector<HTMLElement>("[data-asn-agent-meta]");
  const agentVersion = root.querySelector<HTMLElement>("[data-asn-agent-version]");
  const capabilitiesLabel = root.querySelector<HTMLElement>("[data-asn-capabilities]");
  const connectionStatus = root.querySelector<HTMLElement>("[data-asn-connection-status]");
  const capabilityWarning = root.querySelector<HTMLElement>("[data-asn-capability-warning]");
  const connectionError = root.querySelector<HTMLElement>("[data-asn-connection-error]");
  const storageWarning = root.querySelector<HTMLElement>("[data-asn-storage-warning]");
  const queryInput = root.querySelector<HTMLInputElement>("[data-asn-query]");
  const check = root.querySelector<HTMLButtonElement>("[data-asn-check]");
  const stop = root.querySelector<HTMLButtonElement>("[data-asn-stop]");
  const resultStatus = root.querySelector<HTMLElement>("[data-asn-result]");
  const resultError = root.querySelector<HTMLElement>("[data-asn-error]");
  const empty = root.querySelector<HTMLElement>("[data-asn-empty]");
  const facts = root.querySelector<HTMLElement>("[data-asn-facts]");
  const addressOut = root.querySelector<HTMLElement>("[data-asn-address]");
  const prefixOut = root.querySelector<HTMLElement>("[data-asn-prefix]");
  const asnOut = root.querySelector<HTMLElement>("[data-asn-asn]");
  const nameOut = root.querySelector<HTMLElement>("[data-asn-name]");
  const coversOut = root.querySelector<HTMLElement>("[data-asn-covers]");
  const copy = root.querySelector<HTMLButtonElement>("[data-asn-copy]");
  if (!code || !connect || !disconnect || !connectionState || !agentMeta || !agentVersion
    || !capabilitiesLabel || !connectionStatus || !capabilityWarning || !connectionError
    || !storageWarning || !queryInput || !check || !stop || !resultStatus || !resultError
    || !empty || !facts || !addressOut || !prefixOut || !asnOut || !nameOut || !coversOut || !copy) {
    return;
  }

  const client = new LocalAgentClient();
  let answer: AsnLookupResult | null = null;
  let busy = false;
  let checkAbort: AbortController | null = null;
  let operation: ToolOperation | null = null;
  let operationSettled = false;

  const errorText = (error: unknown): string => {
    if (error instanceof LocalAgentError) return strings[`Error_${error.code}`] || strings.ErrorGeneric;
    return strings.ErrorGeneric;
  };

  const fill = (template: string, params: Record<string, string | number>): string =>
    template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));

  const hasAsnCapability = (): boolean => client.capabilities.includes("asn.lookup");

  const showStoredConnection = (): void => {
    storageWarning.hidden = !client.connected || client.persisted;
    if (client.connected && !client.persisted) storageWarning.textContent = strings.ConnectionNotSaved;
  };

  const showCapabilityWarning = (): void => {
    if (client.connected && !hasAsnCapability()) showMessage(capabilityWarning, strings.NeedAsnCapability);
    else hideMessage(capabilityWarning);
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    const canCheck = client.connected && hasAsnCapability() && !busy;
    const canUpgrade = !busy && (!client.connected || !hasAsnCapability());
    check.disabled = !canCheck;
    check.ariaBusy = busy ? "true" : "false";
    stop.hidden = !busy;
    stop.disabled = !busy;
    queryInput.disabled = busy;
    connect.disabled = !canUpgrade;
    code.disabled = !canUpgrade;
    disconnect.disabled = !client.connected;
    copy.disabled = answer === null || busy;
  };

  const setConnected = (connected: boolean): void => {
    connectionState.textContent = connected ? strings.AgentConnectedShort : strings.AgentDisconnectedShort;
    root.classList.toggle("is-connected", connected);
    agentMeta.hidden = !connected;
    capabilitiesLabel.textContent = client.capabilities.join(", ");
    showCapabilityWarning();
    showStoredConnection();
    setBusy(busy);
  };

  const blank = (value: string | null): string => value && value.length > 0 ? value : strings.EmptyValue;

  const renderAnswer = (result: AsnLookupResult | null): void => {
    answer = result;
    if (!result) {
      hideMessage(resultStatus);
      empty.hidden = false;
      facts.hidden = true;
      addressOut.textContent = "";
      prefixOut.textContent = "";
      asnOut.textContent = "";
      nameOut.textContent = "";
      coversOut.textContent = "";
      copy.disabled = true;
      return;
    }
    empty.hidden = true;
    facts.hidden = false;
    addressOut.textContent = result.address;
    prefixOut.textContent = blank(result.prefix);
    asnOut.textContent = result.asn === null ? strings.EmptyValue : `AS${result.asn}`;
    nameOut.textContent = blank(result.name);
    coversOut.textContent = result.covers ? strings.CoversYes : strings.CoversNo;
    const statusText = result.status === "found"
      ? fill(result.covers ? strings.StatusFound : strings.StatusFoundPartial, {
        asn: result.asn ?? "",
        name: result.name,
        prefix: result.prefix ?? "",
      }).replace(/[ \t]{2,}/g, " ")
      : result.status === "reserved"
        ? strings.StatusReserved
        : strings.StatusNotFound;
    showMessage(resultStatus, statusText);
    copy.disabled = false;
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
        const previous: readonly LocalAgentCapability[] = client.capabilities;
        const inspected = await client.inspect();
        const advertised = Array.isArray(inspected.capabilities) ? inspected.capabilities : [];
        if (!advertised.includes("asn.lookup")) throw new LocalAgentError("unsupported_capability");
        info = await client.pairKeepingSession(pairingCode, mergeCapabilities(previous, advertised, "asn.lookup"));
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
      if (!client.connected) connect.disabled = false;
    }
  };

  connect.addEventListener("click", () => { void connectAgent(); });
  disconnect.addEventListener("click", () => {
    void (async () => {
      checkAbort?.abort();
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
    })();
  });

  const runCheck = async (): Promise<void> => {
    hideMessage(resultError);
    if (!client.connected) {
      showMessage(resultError, strings.NotConnected);
      return;
    }
    if (!hasAsnCapability()) {
      showMessage(capabilityWarning, strings.NeedAsnCapability);
      return;
    }
    const query = queryInput.value.trim();
    if (!asnQueryLooksValid(query)) {
      showMessage(resultError, strings.InvalidQuery);
      return;
    }
    checkAbort?.abort();
    if (operation && !operationSettled) settle("cancel");
    const controller = new AbortController();
    checkAbort = controller;
    operation = startToolOperation("asn-lookup");
    operationSettled = false;
    renderAnswer(null);
    setBusy(true);
    check.textContent = strings.Checking;
    try {
      const result = await client.lookupAsn({ query }, controller.signal);
      if (checkAbort !== controller || operationSettled) return;
      renderAnswer(result);
      settle("complete");
    } catch (error) {
      if (checkAbort !== controller) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        settle("cancel");
        return;
      }
      settle("fail");
      showMessage(resultError, errorText(error));
    } finally {
      if (checkAbort === controller) {
        check.textContent = strings.Check;
        setBusy(false);
      }
    }
  };

  check.addEventListener("click", () => { void runCheck(); });
  stop.addEventListener("click", () => {
    checkAbort?.abort();
    if (busy && !operationSettled) settle("cancel");
    check.textContent = strings.Check;
    setBusy(false);
  });
  queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runCheck();
    }
  });
  copy.addEventListener("click", () => {
    if (!answer) return;
    void copyWithFeedback(copy, formatAsnText(answer), strings.Copied, 1500, { failedLabel: strings.CopyFailed });
  });

  window.addEventListener("pagehide", () => {
    checkAbort?.abort();
    if (busy && !operationSettled) settle("cancel");
  });

  renderAnswer(null);
  setConnected(false);
  void connectAgent(true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
