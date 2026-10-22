/**
 * WHOIS lookup page. One query line goes to TCP port 43 in the local agent
 * (`whois.lookup`). The name, the server and the reply stay on the page.
 * The timeout is the only setting. A referral inside the reply is not followed.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type WhoisLookupResult,
} from "@/scripts/local-agent";
import { bindAgentPopover, onAgentSessionSaved } from "@/scripts/agent-popover";
import { copyWithFeedback } from "@/scripts/tool-ui";
import {
  WHOIS_LOOKUP_STORAGE_KEY,
  formatWhoisText,
  whoisReferral,
  isWhoisTimeout,
  parseWhoisLookupSettings,
  type WhoisLookupSettings,
} from "@/tools/whois-lookup";

function readStrings(root: HTMLElement): Record<string, string> | null {
  const node = root.querySelector("[data-whois-strings]");
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

function loadSettings(): WhoisLookupSettings {
  try {
    const raw = localStorage.getItem(WHOIS_LOOKUP_STORAGE_KEY);
    if (!raw) return parseWhoisLookupSettings(null);
    return parseWhoisLookupSettings(JSON.parse(raw) as unknown);
  } catch {
    return parseWhoisLookupSettings(null);
  }
}

function saveSettings(settings: WhoisLookupSettings): boolean {
  try {
    localStorage.setItem(WHOIS_LOOKUP_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** One WHOIS server. A slash, a URL, a port suffix or a numeric range is not a host. */
function hostLooksValid(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s/\\@?#,*]/.test(host) || host.includes("://")) return false;
  if (/^\d+-\d+$/.test(host)) return false;
  // One colon is `host:port`. An IPv6 literal has at least two.
  const colons = host.split(":").length - 1;
  return colons !== 1;
}

/** One WHOIS line. A control character, a URL or `80-443` is not a query. */
function queryLooksValid(query: string): boolean {
  const chars = [...query];
  if (chars.length < 1 || chars.length > 255) return false;
  if (query.includes("://")) return false;
  if (chars.some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  })) return false;
  const hyphen = query.indexOf("-");
  if (hyphen > 0 && hyphen < query.length - 1 && !query.slice(hyphen + 1).includes("-")) {
    const left = query.slice(0, hyphen);
    const right = query.slice(hyphen + 1);
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) return false;
  }
  return true;
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-whois-lookup]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;

  const agentSettings = root.querySelector<HTMLDetailsElement>("[data-whois-agent-settings]");
  const code = root.querySelector<HTMLInputElement>("[data-whois-code]");
  const connect = root.querySelector<HTMLButtonElement>("[data-whois-connect-agent]");
  const disconnect = root.querySelector<HTMLButtonElement>("[data-whois-disconnect]");
  const connectionState = root.querySelector<HTMLElement>("[data-whois-connection-state]");
  const agentMeta = root.querySelector<HTMLElement>("[data-whois-agent-meta]");
  const agentVersion = root.querySelector<HTMLElement>("[data-whois-agent-version]");
  const capabilitiesLabel = root.querySelector<HTMLElement>("[data-whois-capabilities]");
  const connectionStatus = root.querySelector<HTMLElement>("[data-whois-connection-status]");
  const capabilityWarning = root.querySelector<HTMLElement>("[data-whois-capability-warning]");
  const connectionError = root.querySelector<HTMLElement>("[data-whois-connection-error]");
  const storageWarning = root.querySelector<HTMLElement>("[data-whois-storage-warning]");
  const queryInput = root.querySelector<HTMLInputElement>("[data-whois-query]");
  const serverInput = root.querySelector<HTMLInputElement>("[data-whois-server]");
  const timeoutInput = root.querySelector<HTMLInputElement>("[data-whois-timeout]");
  const check = root.querySelector<HTMLButtonElement>("[data-whois-check]");
  const stop = root.querySelector<HTMLButtonElement>("[data-whois-stop]");
  const resultStatus = root.querySelector<HTMLElement>("[data-whois-result]");
  const resultError = root.querySelector<HTMLElement>("[data-whois-error]");
  const empty = root.querySelector<HTMLElement>("[data-whois-empty]");
  const facts = root.querySelector<HTMLElement>("[data-whois-facts]");
  const addressOut = root.querySelector<HTMLElement>("[data-whois-address]");
  const timeOut = root.querySelector<HTMLElement>("[data-whois-time]");
  const truncatedNote = root.querySelector<HTMLElement>("[data-whois-truncated]");
  const reply = root.querySelector<HTMLElement>("[data-whois-text]");
  const referralRow = root.querySelector<HTMLElement>("[data-whois-referral-row]");
  const referral = root.querySelector<HTMLButtonElement>("[data-whois-referral]");
  const copy = root.querySelector<HTMLButtonElement>("[data-whois-copy]");
  if (!agentSettings || !referralRow || !referral || !code || !connect || !disconnect || !connectionState || !agentMeta || !agentVersion
    || !capabilitiesLabel || !connectionStatus || !capabilityWarning || !connectionError
    || !storageWarning || !queryInput || !serverInput || !timeoutInput || !check || !stop
    || !resultStatus || !resultError || !empty || !facts || !addressOut || !timeOut
    || !truncatedNote || !reply || !copy) {
    return;
  }

  const client = new LocalAgentClient();
  const popover = bindAgentPopover(agentSettings);
  let settings = loadSettings();
  let answer: WhoisLookupResult | null = null;
  let busy = false;
  let checkAbort: AbortController | null = null;
  let operation: ToolOperation | null = null;
  let operationSettled = false;

  timeoutInput.value = String(settings.timeoutMs);

  const errorText = (error: unknown): string => {
    if (error instanceof LocalAgentError) return strings[`Error_${error.code}`] || strings.ErrorGeneric;
    return strings.ErrorGeneric;
  };

  const fill = (template: string, params: Record<string, string | number>): string =>
    template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));

  const hasWhoisCapability = (): boolean => client.capabilities.includes("whois.lookup");

  const persistSettings = (): void => {
    const saved = saveSettings(settings);
    storageWarning.hidden = !client.connected || (client.persisted && saved);
    if (client.connected && (!client.persisted || !saved)) storageWarning.textContent = strings.ConnectionNotSaved;
  };

  const showCapabilityWarning = (): void => {
    if (client.connected && !hasWhoisCapability()) showMessage(capabilityWarning, strings.NeedWhoisCapability);
    else hideMessage(capabilityWarning);
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    const canCheck = client.connected && hasWhoisCapability() && !busy;
    const canUpgrade = !busy && (!client.connected || !hasWhoisCapability());
    check.disabled = !canCheck;
    check.ariaBusy = busy ? "true" : "false";
    stop.hidden = !busy;
    stop.disabled = !busy;
    queryInput.disabled = busy;
    serverInput.disabled = busy;
    timeoutInput.disabled = busy;
    connect.disabled = !canUpgrade;
    code.disabled = !canUpgrade;
    disconnect.disabled = !client.connected;
    copy.disabled = answer === null || busy;
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

  const renderAnswer = (result: WhoisLookupResult | null): void => {
    answer = result;
    if (!result) {
      hideMessage(resultStatus);
      empty.hidden = false;
      facts.hidden = true;
      addressOut.textContent = "";
      timeOut.textContent = "";
      truncatedNote.hidden = true;
      reply.hidden = true;
      reply.textContent = "";
      referralRow.hidden = true;
      copy.disabled = true;
      return;
    }
    empty.hidden = true;
    facts.hidden = false;
    addressOut.textContent = result.address;
    timeOut.textContent = fill(strings.TimeValue, { ms: result.elapsedMs });
    const statusText = result.status === "ok"
      ? fill(strings.StatusOk, { server: result.server })
      : result.status === "refused"
        ? strings.StatusRefused
        : result.status === "timeout"
          ? strings.StatusTimeout
          : strings.StatusUnreachable;
    showMessage(resultStatus, statusText);
    truncatedNote.hidden = !result.truncated;
    reply.hidden = result.status !== "ok";
    reply.textContent = result.status === "ok" ? result.text : "";
    const next = result.status === "ok" ? whoisReferral(result.text, result.server) : null;
    referralRow.hidden = next === null;
    referral.dataset.server = next ?? "";
    referral.textContent = next ? fill(strings.AskReferral, { server: next }) : "";
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
        const inspected = await client.inspect();
        const advertised = Array.isArray(inspected.capabilities) ? inspected.capabilities : [];
        if (!advertised.includes("whois.lookup")) throw new LocalAgentError("unsupported_capability");
        info = await client.pairKeepingSession(pairingCode, mergeCapabilities(advertised, "whois.lookup", client.capabilities));
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
      popover.sync(client);
    })();
  });

  timeoutInput.addEventListener("change", () => {
    const timeoutMs = Number(timeoutInput.value);
    if (!isWhoisTimeout(timeoutMs)) return;
    settings = { v: 1, timeoutMs };
    persistSettings();
  });

  const runCheck = async (): Promise<void> => {
    hideMessage(resultError);
    if (!client.connected) {
      showMessage(resultError, strings.NotConnected);
      return;
    }
    if (!hasWhoisCapability()) {
      showMessage(capabilityWarning, strings.NeedWhoisCapability);
      return;
    }
    const query = queryInput.value.trim();
    const server = serverInput.value.trim();
    const timeoutMs = Number(timeoutInput.value);
    if (!queryLooksValid(query)) {
      showMessage(resultError, strings.InvalidQuery);
      return;
    }
    if (!hostLooksValid(server)) {
      showMessage(resultError, strings.InvalidServer);
      return;
    }
    if (!isWhoisTimeout(timeoutMs)) {
      showMessage(resultError, strings.InvalidTimeout);
      return;
    }
    settings = { v: 1, timeoutMs };
    persistSettings();
    checkAbort?.abort();
    if (operation && !operationSettled) settle("cancel");
    const controller = new AbortController();
    checkAbort = controller;
    operation = startToolOperation("whois-lookup");
    operationSettled = false;
    renderAnswer(null);
    setBusy(true);
    check.textContent = strings.Checking;
    try {
      const result = await client.lookupWhois({ query, server, timeoutMs }, controller.signal);
      if (checkAbort !== controller) return;
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
  for (const input of [queryInput, serverInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runCheck();
      }
    });
  }
  // Follow a referral only on request: one click, one more query to the named server.
  referral.addEventListener("click", () => {
    const next = referral.dataset.server;
    if (!next || busy) return;
    serverInput.value = next;
    void runCheck();
  });
  copy.addEventListener("click", () => {
    if (!answer) return;
    void copyWithFeedback(copy, formatWhoisText(answer), strings.Copied, 1500, { failedLabel: strings.CopyFailed });
  });

  window.addEventListener("pagehide", () => {
    checkAbort?.abort();
  });

  renderAnswer(null);
  setConnected(false);
  void connectAgent(true);
  // A pairing made in another window lands here only while this one cannot work anyway.
  onAgentSessionSaved(() => {
    if (!client.connected || !client.capabilities.includes("whois.lookup")) void connectAgent(true);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
