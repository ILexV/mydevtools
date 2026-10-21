/**
 * TCP connect page. One handshake runs in the local agent (`tcp.connect`).
 * The host, the port and the result stay on the page. The timeout is a setting.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type LocalAgentCapability,
  type TcpConnectResult,
} from "@/scripts/local-agent";
import { copyWithFeedback } from "@/scripts/tool-ui";
import {
  TCP_CONNECT_STORAGE_KEY,
  formatTcpText,
  isTcpTimeout,
  parseTcpConnectSettings,
  type TcpConnectSettings,
} from "@/tools/tcp-connect";

function readStrings(root: HTMLElement): Record<string, string> | null {
  const node = root.querySelector("[data-tcp-strings]");
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

function loadSettings(): TcpConnectSettings {
  try {
    const raw = localStorage.getItem(TCP_CONNECT_STORAGE_KEY);
    if (!raw) return parseTcpConnectSettings(null);
    return parseTcpConnectSettings(JSON.parse(raw) as unknown);
  } catch {
    return parseTcpConnectSettings(null);
  }
}

function saveSettings(settings: TcpConnectSettings): boolean {
  try {
    localStorage.setItem(TCP_CONNECT_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

function parsePort(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/** One host. A slash, a comma, a URL or a numeric range is not a name. */
function hostLooksValid(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s/\\@?#,*]/.test(host) || host.includes("://")) return false;
  if (/^\d+-\d+$/.test(host)) return false;
  // One colon is `host:port`. An IPv6 literal has at least two.
  const colons = host.split(":").length - 1;
  return colons !== 1;
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-tcp-connect]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;

  const code = root.querySelector<HTMLInputElement>("[data-tcp-code]");
  const connect = root.querySelector<HTMLButtonElement>("[data-tcp-connect-agent]");
  const disconnect = root.querySelector<HTMLButtonElement>("[data-tcp-disconnect]");
  const connectionState = root.querySelector<HTMLElement>("[data-tcp-connection-state]");
  const agentMeta = root.querySelector<HTMLElement>("[data-tcp-agent-meta]");
  const agentVersion = root.querySelector<HTMLElement>("[data-tcp-agent-version]");
  const capabilitiesLabel = root.querySelector<HTMLElement>("[data-tcp-capabilities]");
  const connectionStatus = root.querySelector<HTMLElement>("[data-tcp-connection-status]");
  const capabilityWarning = root.querySelector<HTMLElement>("[data-tcp-capability-warning]");
  const connectionError = root.querySelector<HTMLElement>("[data-tcp-connection-error]");
  const storageWarning = root.querySelector<HTMLElement>("[data-tcp-storage-warning]");
  const hostInput = root.querySelector<HTMLInputElement>("[data-tcp-host]");
  const portInput = root.querySelector<HTMLInputElement>("[data-tcp-port]");
  const timeoutInput = root.querySelector<HTMLInputElement>("[data-tcp-timeout]");
  const check = root.querySelector<HTMLButtonElement>("[data-tcp-check]");
  const stop = root.querySelector<HTMLButtonElement>("[data-tcp-stop]");
  const resultStatus = root.querySelector<HTMLElement>("[data-tcp-result]");
  const resultError = root.querySelector<HTMLElement>("[data-tcp-error]");
  const empty = root.querySelector<HTMLElement>("[data-tcp-empty]");
  const facts = root.querySelector<HTMLElement>("[data-tcp-facts]");
  const addressOut = root.querySelector<HTMLElement>("[data-tcp-address]");
  const timeOut = root.querySelector<HTMLElement>("[data-tcp-time]");
  const copy = root.querySelector<HTMLButtonElement>("[data-tcp-copy]");
  if (!code || !connect || !disconnect || !connectionState || !agentMeta || !agentVersion
    || !capabilitiesLabel || !connectionStatus || !capabilityWarning || !connectionError
    || !storageWarning || !hostInput || !portInput || !timeoutInput || !check || !stop
    || !resultStatus || !resultError || !empty || !facts || !addressOut || !timeOut || !copy) {
    return;
  }

  const client = new LocalAgentClient();
  let settings = loadSettings();
  let answer: TcpConnectResult | null = null;
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

  const hasTcpCapability = (): boolean => client.capabilities.includes("tcp.connect");

  const persistSettings = (): void => {
    const saved = saveSettings(settings);
    storageWarning.hidden = !client.connected || (client.persisted && saved);
    if (client.connected && (!client.persisted || !saved)) storageWarning.textContent = strings.ConnectionNotSaved;
  };

  const showCapabilityWarning = (): void => {
    if (client.connected && !hasTcpCapability()) showMessage(capabilityWarning, strings.NeedTcpCapability);
    else hideMessage(capabilityWarning);
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    const canCheck = client.connected && hasTcpCapability() && !busy;
    const canUpgrade = !busy && (!client.connected || !hasTcpCapability());
    check.disabled = !canCheck;
    check.ariaBusy = busy ? "true" : "false";
    stop.hidden = !busy;
    stop.disabled = !busy;
    hostInput.disabled = busy;
    portInput.disabled = busy;
    timeoutInput.disabled = busy;
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
    persistSettings();
    setBusy(busy);
  };

  const renderAnswer = (result: TcpConnectResult | null): void => {
    answer = result;
    if (!result) {
      hideMessage(resultStatus);
      empty.hidden = false;
      facts.hidden = true;
      addressOut.textContent = "";
      timeOut.textContent = "";
      copy.disabled = true;
      return;
    }
    empty.hidden = true;
    facts.hidden = false;
    addressOut.textContent = result.address;
    timeOut.textContent = fill(strings.TimeValue, { ms: result.elapsedMs });
    const statusText = result.status === "open"
      ? fill(strings.StatusOpen, { ms: result.elapsedMs })
      : result.status === "refused"
        ? strings.StatusRefused
        : result.status === "timeout"
          ? strings.StatusTimeout
          : strings.StatusUnreachable;
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
        if (!advertised.includes("tcp.connect")) throw new LocalAgentError("unsupported_capability");
        info = await client.pairKeepingSession(pairingCode, mergeCapabilities(previous, advertised, "tcp.connect"));
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

  timeoutInput.addEventListener("change", () => {
    const timeoutMs = Number(timeoutInput.value);
    if (!isTcpTimeout(timeoutMs)) return;
    settings = { v: 1, timeoutMs };
    persistSettings();
  });

  const runCheck = async (): Promise<void> => {
    hideMessage(resultError);
    if (!client.connected) {
      showMessage(resultError, strings.NotConnected);
      return;
    }
    if (!hasTcpCapability()) {
      showMessage(capabilityWarning, strings.NeedTcpCapability);
      return;
    }
    const host = hostInput.value.trim();
    const port = parsePort(portInput.value);
    const timeoutMs = Number(timeoutInput.value);
    if (!hostLooksValid(host) || port === null) {
      showMessage(resultError, strings.InvalidInput);
      return;
    }
    if (!isTcpTimeout(timeoutMs)) {
      showMessage(resultError, strings.InvalidTimeout);
      return;
    }
    settings = { v: 1, timeoutMs };
    persistSettings();
    checkAbort?.abort();
    if (operation && !operationSettled) settle("cancel");
    const controller = new AbortController();
    checkAbort = controller;
    operation = startToolOperation("tcp-connect");
    operationSettled = false;
    renderAnswer(null);
    setBusy(true);
    check.textContent = strings.Checking;
    try {
      const result = await client.connectTcp({ host, port, timeoutMs }, controller.signal);
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
  hostInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runCheck();
    }
  });
  portInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runCheck();
    }
  });
  copy.addEventListener("click", () => {
    if (!answer) return;
    void copyWithFeedback(copy, formatTcpText(answer), strings.Copied, 1500, { failedLabel: strings.CopyFailed });
  });

  window.addEventListener("pagehide", () => {
    checkAbort?.abort();
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
