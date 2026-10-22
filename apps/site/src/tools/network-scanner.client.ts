/**
 * Network scanner page. The local agent finds hosts in one of this computer's
 * own IPv4 subnets (`network.scan`): an ICMP echo, TCP probes on a few ports
 * and the ARP table. Hosts appear as they answer; Stop cancels in the agent.
 * The network and the hosts stay on the page; the probe settings are stored.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type NetworkScanHost,
  type NetworkScanLine,
} from "@/scripts/local-agent";
import { bindAgentPopover, onAgentSessionSaved } from "@/scripts/agent-popover";
import { copyWithFeedback } from "@/scripts/tool-ui";
import {
  NETWORK_SCANNER_STORAGE_KEY,
  compareAddresses,
  formatNetworkReport,
  isNetworkTimeout,
  parseNetwork,
  parseNetworkScannerSettings,
  parseProbePorts,
  type NetworkScannerSettings,
} from "@/tools/network-scanner";

const CAPABILITY = "network.scan";
const STOP_FALLBACK_MS = 3_000;

function readStrings(root: HTMLElement): Record<string, string> | null {
  const node = root.querySelector("[data-nscan-strings]");
  if (!node?.textContent) return null;
  try {
    const value: unknown = JSON.parse(node.textContent);
    return value && typeof value === "object" ? value as Record<string, string> : null;
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

function loadSettings(): NetworkScannerSettings {
  try {
    const raw = localStorage.getItem(NETWORK_SCANNER_STORAGE_KEY);
    return parseNetworkScannerSettings(raw ? JSON.parse(raw) as unknown : null);
  } catch {
    return parseNetworkScannerSettings(null);
  }
}

function saveSettings(settings: NetworkScannerSettings): boolean {
  try {
    localStorage.setItem(NETWORK_SCANNER_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-nscan]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;
  const q = <T extends HTMLElement>(hook: string) => root.querySelector<T>(`[data-nscan-${hook}]`);

  const agentSettings = q<HTMLDetailsElement>("agent-settings");
  const code = q<HTMLInputElement>("code");
  const connect = q<HTMLButtonElement>("connect");
  const disconnect = q<HTMLButtonElement>("disconnect");
  const connectionState = q("connection-state");
  const agentMeta = q("agent-meta");
  const agentVersion = q("agent-version");
  const capabilitiesLabel = q("capabilities");
  const connectionStatus = q("connection-status");
  const capabilityWarning = q("capability-warning");
  const connectionError = q("connection-error");
  const storageWarning = q("storage-warning");
  const localSelect = q<HTMLSelectElement>("local");
  const networkInput = q<HTMLInputElement>("network");
  const portsInput = q<HTMLInputElement>("ports");
  const timeoutInput = q<HTMLInputElement>("timeout");
  const namesInput = q<HTMLInputElement>("names");
  const countHint = q("count");
  const start = q<HTMLButtonElement>("start");
  const stop = q<HTMLButtonElement>("stop");
  const progress = q("progress");
  const progressBar = q("progress-bar");
  const progressFill = q("progress-fill");
  const progressLabel = q("progress-label");
  const resultStatus = q("result");
  const resultError = q("error");
  const copy = q<HTMLButtonElement>("copy");
  const empty = q("empty");
  const tableWrap = q("table-wrap");
  const body = q("body");
  if (!agentSettings || !code || !connect || !disconnect || !connectionState || !agentMeta || !agentVersion
    || !capabilitiesLabel || !connectionStatus || !capabilityWarning || !connectionError || !storageWarning
    || !localSelect || !networkInput || !portsInput || !timeoutInput || !namesInput || !countHint || !start
    || !stop || !progress || !progressBar || !progressFill || !progressLabel || !resultStatus || !resultError
    || !copy || !empty || !tableWrap || !body) {
    return;
  }

  const client = new LocalAgentClient();
  const popover = bindAgentPopover(agentSettings);
  const number = new Intl.NumberFormat(document.documentElement.lang || undefined);
  let settings = loadSettings();
  let busy = false;
  let scanId: string | null = null;
  let abort: AbortController | null = null;
  let stopTimer = 0;
  let operation: ToolOperation | null = null;
  let operationSettled = false;
  let scannedNetwork = "";
  let hosts: NetworkScanHost[] = [];
  let done = 0;
  let total = 0;
  let renderQueued = false;

  portsInput.value = settings.ports;
  timeoutInput.value = String(settings.timeoutMs);
  namesInput.checked = settings.resolveNames;

  const fill = (template: string, params: Record<string, string | number>): string =>
    template.replace(/\{(\w+)\}/gu, (match, key: string) => (key in params ? String(params[key]) : match));

  const errorText = (error: unknown): string => {
    if (error instanceof LocalAgentError) return strings[`Error_${error.code}`] || strings.ErrorGeneric;
    return strings.ErrorGeneric;
  };

  const hasCapability = (): boolean => client.capabilities.includes(CAPABILITY);

  const persistSettings = (): void => {
    const saved = saveSettings(settings);
    storageWarning.hidden = !client.connected || (client.persisted && saved);
    if (client.connected && (!client.persisted || !saved)) storageWarning.textContent = strings.ConnectionNotSaved;
  };

  const refreshCount = (): void => {
    const parsed = parseNetwork(networkInput.value);
    countHint.textContent = parsed ? fill(strings.AddressCount, { count: number.format(parsed.prefix >= 31 ? parsed.size : parsed.size - 2) }) : "";
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    const ready = client.connected && hasCapability();
    start.disabled = !ready || busy;
    start.ariaBusy = busy ? "true" : "false";
    start.textContent = busy ? strings.Scanning : strings.Scan;
    stop.hidden = !busy;
    stop.disabled = !busy;
    for (const input of [networkInput, portsInput, timeoutInput, namesInput]) input.disabled = busy;
    localSelect.disabled = busy || localSelect.options.length < 2;
    const canPair = !busy && (!client.connected || !hasCapability());
    connect.disabled = !canPair;
    code.disabled = !canPair;
    disconnect.disabled = !client.connected;
    copy.disabled = busy || hosts.length === 0;
  };

  /** Fills the subnet list; the first one becomes the network when the field is empty. */
  const loadNetworks = async (): Promise<void> => {
    if (!client.connected || !hasCapability()) return;
    try {
      const networks = await client.listScanNetworks();
      localSelect.replaceChildren();
      const placeholder = new Option(networks.length ? "—" : strings.NoNetworks, "");
      localSelect.append(placeholder);
      for (const network of networks) {
        localSelect.append(new Option(fill(strings.NetworkOption, {
          network: network.network,
          interface: network.interface,
          address: network.address,
        }), network.network));
      }
      if (networks.length && !networkInput.value.trim()) {
        networkInput.value = networks[0]!.network;
        localSelect.value = networks[0]!.network;
      }
      refreshCount();
      setBusy(busy);
    } catch (error) {
      showMessage(resultError, errorText(error));
    }
  };

  const setConnected = (connected: boolean): void => {
    connectionState.textContent = connected ? strings.AgentConnectedShort : strings.AgentDisconnectedShort;
    popover.sync(client);
    agentMeta.hidden = !connected;
    capabilitiesLabel.textContent = client.capabilities.join(", ");
    if (connected && !hasCapability()) showMessage(capabilityWarning, strings.NeedScanCapability);
    else hideMessage(capabilityWarning);
    persistSettings();
    setBusy(busy);
  };

  const renderTable = (): void => {
    renderQueued = false;
    const fragment = document.createDocumentFragment();
    for (const host of [...hosts].sort((a, b) => compareAddresses(a.address, b.address))) {
      const row = document.createElement("tr");
      const address = document.createElement("td");
      address.textContent = host.address;
      if (host.thisComputer) {
        const badge = document.createElement("span");
        badge.className = "nscan-self";
        badge.textContent = strings.ThisComputer;
        address.append(badge);
      }
      row.append(address);
      const via = host.via.map((source) => strings[`Via_${source}`] || source).join(", ");
      const rtt = host.rttMs === undefined ? "" : fill(strings.TimeValue, { ms: host.rttMs });
      for (const text of [host.name ?? "", host.mac ?? "", rtt, host.openPorts.join(", "), via]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      fragment.append(row);
    }
    body.replaceChildren(fragment);
    tableWrap.hidden = hosts.length === 0;
    empty.hidden = hosts.length > 0;
  };

  const queueRender = (): void => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderTable);
  };

  const renderProgress = (): void => {
    const percent = total ? Math.min(100, (done / total) * 100) : 0;
    progressFill.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
    progressLabel.textContent = fill(strings.ProgressLabel, {
      done: number.format(done),
      total: number.format(total),
      found: number.format(hosts.length),
    });
  };

  const settle = (kind: "complete" | "fail" | "cancel"): void => {
    if (operationSettled) return;
    operationSettled = true;
    if (kind === "complete") operation?.complete();
    else if (kind === "fail") operation?.fail("processing_error");
    else operation?.cancel();
    operation = null;
  };

  const summary = (stopped: boolean, elapsedMs: number): string => fill(stopped ? strings.SummaryStopped : strings.Summary, {
    found: number.format(hosts.length),
    done: number.format(done),
    network: scannedNetwork,
    seconds: (elapsedMs / 1000).toFixed(1),
  });

  const onLine = (line: NetworkScanLine): void => {
    switch (line.type) {
      case "start":
        scannedNetwork = line.network;
        total = line.total;
        renderProgress();
        break;
      case "host": {
        const { type: _type, ...host } = line;
        hosts.push(host);
        queueRender();
        renderProgress();
        break;
      }
      case "progress":
        done = line.done;
        renderProgress();
        break;
      case "end":
        done = line.done;
        renderProgress();
        showMessage(resultStatus, summary(line.stopped, line.elapsedMs));
        settle(line.stopped ? "cancel" : "complete");
        break;
      case "error":
        showMessage(resultError, strings[`Error_${line.code}`] || strings.ErrorGeneric);
        settle("fail");
        break;
    }
  };

  const runScan = async (): Promise<void> => {
    hideMessage(resultError);
    hideMessage(resultStatus);
    if (!client.connected) return showMessage(resultError, strings.NotConnected);
    if (!hasCapability()) return showMessage(capabilityWarning, strings.NeedScanCapability);
    const network = parseNetwork(networkInput.value);
    const ports = parseProbePorts(portsInput.value);
    const timeoutMs = Number(timeoutInput.value);
    if (!network) return showMessage(resultError, strings.InvalidNetwork);
    if (!ports) return showMessage(resultError, strings.InvalidPorts);
    if (!isNetworkTimeout(timeoutMs)) return showMessage(resultError, strings.InvalidTimeout);
    settings = { v: 1, timeoutMs, ports: portsInput.value.trim(), resolveNames: namesInput.checked };
    persistSettings();

    const controller = new AbortController();
    abort = controller;
    const id = crypto.randomUUID();
    scanId = id;
    scannedNetwork = network.network;
    hosts = [];
    done = 0;
    total = 0;
    renderTable();
    renderProgress();
    progress.hidden = false;
    operation = startToolOperation("network-scanner");
    operationSettled = false;
    setBusy(true);
    try {
      await client.scanNetwork({ id, network: network.network, timeoutMs, ports, resolveNames: namesInput.checked }, onLine, controller.signal);
      if (!operationSettled) settle("complete");
    } catch (error) {
      if (abort !== controller) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        showMessage(resultStatus, summary(true, 0));
        settle("cancel");
      } else {
        showMessage(resultError, errorText(error));
        settle("fail");
      }
    } finally {
      if (abort === controller) {
        window.clearTimeout(stopTimer);
        abort = null;
        scanId = null;
        progress.hidden = true;
        renderTable();
        setBusy(false);
      }
    }
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
        if (!advertised.includes(CAPABILITY)) throw new LocalAgentError("unsupported_capability");
        info = await client.pairKeepingSession(pairingCode, mergeCapabilities(advertised, CAPABILITY, client.capabilities));
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
      void loadNetworks();
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

  const stopScan = (): void => {
    const controller = abort;
    if (!controller || !scanId) return;
    stop.disabled = true;
    void client.cancel(scanId).catch(() => controller.abort());
    stopTimer = window.setTimeout(() => controller.abort(), STOP_FALLBACK_MS);
  };

  connect.addEventListener("click", () => { void connectAgent(); });
  disconnect.addEventListener("click", () => {
    void (async () => {
      abort?.abort();
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
  localSelect.addEventListener("change", () => {
    if (!localSelect.value) return;
    networkInput.value = localSelect.value;
    refreshCount();
  });
  networkInput.addEventListener("input", () => {
    localSelect.value = [...localSelect.options].some((option) => option.value === networkInput.value.trim()) ? networkInput.value.trim() : "";
    refreshCount();
  });
  start.addEventListener("click", () => { void runScan(); });
  stop.addEventListener("click", stopScan);
  for (const input of [networkInput, portsInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || busy) return;
      event.preventDefault();
      void runScan();
    });
  }
  copy.addEventListener("click", () => {
    if (hosts.length === 0) return;
    void copyWithFeedback(copy, formatNetworkReport(scannedNetwork, hosts), strings.Copied, 1500, { failedLabel: strings.CopyFailed });
  });
  window.addEventListener("pagehide", () => {
    if (scanId) void client.cancel(scanId).catch(() => undefined);
    abort?.abort();
  });

  refreshCount();
  renderTable();
  setConnected(false);
  void connectAgent(true);
  onAgentSessionSaved(() => {
    if (!client.connected || !hasCapability()) void connectAgent(true);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
