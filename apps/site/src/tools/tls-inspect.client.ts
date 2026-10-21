/**
 * TLS inspect page. One handshake runs in the local agent (`tls.inspect`).
 * The host, the port and the chain stay on the page. The timeout is a setting.
 * A pasted PEM is not accepted here.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type LocalAgentCapability,
  type TlsCertificate,
  type TlsInspectResult,
} from "@/scripts/local-agent";
import { copyWithFeedback } from "@/scripts/tool-ui";
import {
  TLS_INSPECT_STORAGE_KEY,
  formatTlsText,
  isTlsTimeout,
  parseTlsInspectSettings,
  type TlsInspectSettings,
} from "@/tools/tls-inspect";

function readStrings(root: HTMLElement): Record<string, string> | null {
  const node = root.querySelector("[data-tls-strings]");
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

function loadSettings(): TlsInspectSettings {
  try {
    const raw = localStorage.getItem(TLS_INSPECT_STORAGE_KEY);
    if (!raw) return parseTlsInspectSettings(null);
    return parseTlsInspectSettings(JSON.parse(raw) as unknown);
  } catch {
    return parseTlsInspectSettings(null);
  }
}

function saveSettings(settings: TlsInspectSettings): boolean {
  try {
    localStorage.setItem(TLS_INSPECT_STORAGE_KEY, JSON.stringify(settings));
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
  const root = document.querySelector<HTMLElement>("[data-tls-inspect]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;

  const code = root.querySelector<HTMLInputElement>("[data-tls-code]");
  const connect = root.querySelector<HTMLButtonElement>("[data-tls-connect-agent]");
  const disconnect = root.querySelector<HTMLButtonElement>("[data-tls-disconnect]");
  const connectionState = root.querySelector<HTMLElement>("[data-tls-connection-state]");
  const agentMeta = root.querySelector<HTMLElement>("[data-tls-agent-meta]");
  const agentVersion = root.querySelector<HTMLElement>("[data-tls-agent-version]");
  const capabilitiesLabel = root.querySelector<HTMLElement>("[data-tls-capabilities]");
  const connectionStatus = root.querySelector<HTMLElement>("[data-tls-connection-status]");
  const capabilityWarning = root.querySelector<HTMLElement>("[data-tls-capability-warning]");
  const connectionError = root.querySelector<HTMLElement>("[data-tls-connection-error]");
  const storageWarning = root.querySelector<HTMLElement>("[data-tls-storage-warning]");
  const hostInput = root.querySelector<HTMLInputElement>("[data-tls-host]");
  const portInput = root.querySelector<HTMLInputElement>("[data-tls-port]");
  const timeoutInput = root.querySelector<HTMLInputElement>("[data-tls-timeout]");
  const check = root.querySelector<HTMLButtonElement>("[data-tls-check]");
  const stop = root.querySelector<HTMLButtonElement>("[data-tls-stop]");
  const resultStatus = root.querySelector<HTMLElement>("[data-tls-result]");
  const resultError = root.querySelector<HTMLElement>("[data-tls-error]");
  const empty = root.querySelector<HTMLElement>("[data-tls-empty]");
  const facts = root.querySelector<HTMLElement>("[data-tls-facts]");
  const addressOut = root.querySelector<HTMLElement>("[data-tls-address]");
  const protocolOut = root.querySelector<HTMLElement>("[data-tls-protocol]");
  const cipherOut = root.querySelector<HTMLElement>("[data-tls-cipher]");
  const trustOut = root.querySelector<HTMLElement>("[data-tls-trust]");
  const expiryOut = root.querySelector<HTMLElement>("[data-tls-expiry]");
  const timeOut = root.querySelector<HTMLElement>("[data-tls-time]");
  const chain = root.querySelector<HTMLElement>("[data-tls-chain]");
  const chainBody = root.querySelector<HTMLElement>("[data-tls-chain-body]");
  const copy = root.querySelector<HTMLButtonElement>("[data-tls-copy]");
  if (!code || !connect || !disconnect || !connectionState || !agentMeta || !agentVersion
    || !capabilitiesLabel || !connectionStatus || !capabilityWarning || !connectionError
    || !storageWarning || !hostInput || !portInput || !timeoutInput || !check || !stop
    || !resultStatus || !resultError || !empty || !facts || !addressOut || !protocolOut
    || !cipherOut || !trustOut || !expiryOut || !timeOut || !chain || !chainBody || !copy) {
    return;
  }

  const client = new LocalAgentClient();
  let settings = loadSettings();
  let answer: TlsInspectResult | null = null;
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

  const hasTlsCapability = (): boolean => client.capabilities.includes("tls.inspect");

  const persistSettings = (): void => {
    const saved = saveSettings(settings);
    storageWarning.hidden = !client.connected || (client.persisted && saved);
    if (client.connected && (!client.persisted || !saved)) storageWarning.textContent = strings.ConnectionNotSaved;
  };

  const showCapabilityWarning = (): void => {
    if (client.connected && !hasTlsCapability()) showMessage(capabilityWarning, strings.NeedTlsCapability);
    else hideMessage(capabilityWarning);
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    const canCheck = client.connected && hasTlsCapability() && !busy;
    const canUpgrade = !busy && (!client.connected || !hasTlsCapability());
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

  const fillChain = (certificates: readonly TlsCertificate[]): void => {
    chainBody.replaceChildren();
    for (const certificate of certificates) {
      const row = document.createElement("tr");
      for (const text of [
        certificate.subject,
        certificate.issuer,
        certificate.notBefore ?? "",
        certificate.notAfter ?? "",
        certificate.sha256,
      ]) {
        const cell = document.createElement("td");
        cell.className = "mono";
        cell.textContent = text;
        row.append(cell);
      }
      chainBody.append(row);
    }
  };

  const renderAnswer = (result: TlsInspectResult | null): void => {
    answer = result;
    if (!result) {
      hideMessage(resultStatus);
      empty.hidden = false;
      facts.hidden = true;
      chain.hidden = true;
      chainBody.replaceChildren();
      addressOut.textContent = "";
      protocolOut.textContent = "";
      cipherOut.textContent = "";
      trustOut.textContent = "";
      expiryOut.textContent = "";
      timeOut.textContent = "";
      copy.disabled = true;
      return;
    }
    empty.hidden = true;
    facts.hidden = false;
    addressOut.textContent = result.address;
    timeOut.textContent = fill(strings.TimeValue, { ms: result.elapsedMs });
    protocolOut.textContent = result.protocol ?? "";
    cipherOut.textContent = result.cipher ?? "";
    trustOut.textContent = result.trusted === null ? "" : result.trusted ? strings.Trusted : strings.NotTrusted;
    const expiry = result.certificates[0]?.notAfter ?? "";
    expiryOut.textContent = expiry;
    const statusText = result.status === "ok"
      ? fill(result.trusted ? strings.StatusTrusted : strings.StatusUntrusted, {
        protocol: result.protocol ?? "",
        cipher: result.cipher ?? "",
        expiry,
      })
      : result.status === "refused"
        ? strings.StatusRefused
        : result.status === "timeout"
          ? strings.StatusTimeout
          : result.status === "unreachable"
            ? strings.StatusUnreachable
            : strings.StatusHandshakeFailed;
    showMessage(resultStatus, statusText);
    fillChain(result.certificates);
    chain.hidden = result.certificates.length === 0;
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
        if (!advertised.includes("tls.inspect")) throw new LocalAgentError("unsupported_capability");
        info = await client.pairKeepingSession(pairingCode, mergeCapabilities(previous, advertised, "tls.inspect"));
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
    if (!isTlsTimeout(timeoutMs)) return;
    settings = { v: 1, timeoutMs };
    persistSettings();
  });

  const runCheck = async (): Promise<void> => {
    hideMessage(resultError);
    if (!client.connected) {
      showMessage(resultError, strings.NotConnected);
      return;
    }
    if (!hasTlsCapability()) {
      showMessage(capabilityWarning, strings.NeedTlsCapability);
      return;
    }
    const host = hostInput.value.trim();
    const port = parsePort(portInput.value);
    const timeoutMs = Number(timeoutInput.value);
    if (!hostLooksValid(host) || port === null) {
      showMessage(resultError, strings.InvalidInput);
      return;
    }
    if (!isTlsTimeout(timeoutMs)) {
      showMessage(resultError, strings.InvalidTimeout);
      return;
    }
    settings = { v: 1, timeoutMs };
    persistSettings();
    checkAbort?.abort();
    if (operation && !operationSettled) settle("cancel");
    const controller = new AbortController();
    checkAbort = controller;
    operation = startToolOperation("tls-inspect");
    operationSettled = false;
    renderAnswer(null);
    setBusy(true);
    check.textContent = strings.Checking;
    try {
      const result = await client.inspectTls({ host, port, timeoutMs }, controller.signal);
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
    void copyWithFeedback(copy, formatTlsText(answer), strings.Copied, 1500, { failedLabel: strings.CopyFailed });
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
