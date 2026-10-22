/**
 * Port scanner page. The local agent connects to many ports of one host
 * (`port.scan`) and streams each result; Stop cancels the scan in the agent.
 * The host and the results stay on the page. The port list, the timeout and
 * the parallelism are settings.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type PortScanCounts,
  type PortScanLine,
} from "@/scripts/local-agent";
import { bindAgentPopover, onAgentSessionSaved } from "@/scripts/agent-popover";
import { copyWithFeedback } from "@/scripts/tool-ui";
import {
  PORT_SCANNER_STORAGE_KEY,
  SERVICES,
  formatPortReport,
  isPortParallel,
  isPortTimeout,
  parsePortScannerSettings,
  presetPorts,
  type PortPreset,
  type PortResult,
  type PortScannerSettings,
} from "@/tools/port-scanner";

const CAPABILITY = "port.scan";
/** A cancel the agent does not confirm within this time drops the stream instead. */
const STOP_FALLBACK_MS = 3_000;

function readStrings(root: HTMLElement): Record<string, string> | null {
  const node = root.querySelector("[data-pscan-strings]");
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

function loadSettings(): PortScannerSettings {
  try {
    const raw = localStorage.getItem(PORT_SCANNER_STORAGE_KEY);
    return parsePortScannerSettings(raw ? JSON.parse(raw) as unknown : null);
  } catch {
    return parsePortScannerSettings(null);
  }
}

function saveSettings(settings: PortScannerSettings): boolean {
  try {
    localStorage.setItem(PORT_SCANNER_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** One host. A slash, a comma, a URL or a numeric range is not a name. */
function hostLooksValid(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s/\\@?#,*]/u.test(host) || host.includes("://")) return false;
  if (/^\d+-\d+$/u.test(host)) return false;
  return host.split(":").length - 1 !== 1;
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-pscan]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;
  const q = <T extends HTMLElement>(hook: string) => root.querySelector<T>(`[data-pscan-${hook}]`);

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
  const hostInput = q<HTMLInputElement>("host");
  const presetSelect = q<HTMLSelectElement>("preset");
  const portsField = q("ports-field");
  const portsInput = q<HTMLInputElement>("ports");
  const timeoutInput = q<HTMLInputElement>("timeout");
  const parallelInput = q<HTMLInputElement>("parallel");
  const countHint = q("count");
  const start = q<HTMLButtonElement>("start");
  const stop = q<HTMLButtonElement>("stop");
  const progress = q("progress");
  const progressBar = q("progress-bar");
  const progressFill = q("progress-fill");
  const progressLabel = q("progress-label");
  const resultStatus = q("result");
  const resultError = q("error");
  const openOnly = q<HTMLInputElement>("open-only");
  const copy = q<HTMLButtonElement>("copy");
  const resolved = q("resolved");
  const empty = q("empty");
  const tableWrap = q("table-wrap");
  const body = q("body");
  if (!agentSettings || !code || !connect || !disconnect || !connectionState || !agentMeta || !agentVersion
    || !capabilitiesLabel || !connectionStatus || !capabilityWarning || !connectionError || !storageWarning
    || !hostInput || !presetSelect || !portsField || !portsInput || !timeoutInput || !parallelInput || !countHint
    || !start || !stop || !progress || !progressBar || !progressFill || !progressLabel || !resultStatus
    || !resultError || !openOnly || !copy || !resolved || !empty || !tableWrap || !body) {
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
  let target = { host: "", address: "" };
  let results = new Map<number, PortResult>();
  let counts: PortScanCounts = { done: 0, open: 0, closed: 0, filtered: 0, other: 0 };
  let total = 0;
  let listsEveryPort = true;
  let renderQueued = false;

  hostInput.value = "";
  presetSelect.value = settings.preset;
  portsInput.value = settings.custom;
  timeoutInput.value = String(settings.timeoutMs);
  parallelInput.value = String(settings.parallel);

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

  const selectedPorts = () => presetPorts(presetSelect.value as PortPreset, portsInput.value);

  const refreshPorts = (): void => {
    portsField.hidden = presetSelect.value !== "custom";
    const ports = selectedPorts();
    countHint.textContent = ports ? fill(strings.PortCount, { count: number.format(ports.count) }) : "";
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    const ready = client.connected && hasCapability();
    start.disabled = !ready || busy;
    start.ariaBusy = busy ? "true" : "false";
    start.textContent = busy ? strings.Scanning : strings.Scan;
    stop.hidden = !busy;
    stop.disabled = !busy;
    for (const input of [hostInput, presetSelect, portsInput, timeoutInput, parallelInput]) input.disabled = busy;
    const canPair = !busy && (!client.connected || !hasCapability());
    connect.disabled = !canPair;
    code.disabled = !canPair;
    disconnect.disabled = !client.connected;
    copy.disabled = busy || counts.done === 0;
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

  const statusText = (status: string): string => strings[`Status_${status}`] || status;

  const renderTable = (): void => {
    renderQueued = false;
    const rows = [...results.values()]
      .filter((result) => !openOnly.checked || result.status === "open")
      .sort((a, b) => a.port - b.port);
    const fragment = document.createDocumentFragment();
    for (const result of rows) {
      const row = document.createElement("tr");
      const cells = [String(result.port), SERVICES[result.port] ?? "", statusText(result.status), fill(strings.TimeValue, { ms: result.elapsedMs })];
      for (const text of cells) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      if (result.status === "open") row.cells[2]!.className = "is-open";
      fragment.append(row);
    }
    body.replaceChildren(fragment);
    tableWrap.hidden = rows.length === 0;
    empty.hidden = rows.length > 0;
  };

  const queueRender = (): void => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderTable);
  };

  const renderProgress = (): void => {
    const percent = total ? Math.min(100, (counts.done / total) * 100) : 0;
    progressFill.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", String(Math.round(percent)));
    progressLabel.textContent = fill(strings.ProgressLabel, {
      done: number.format(counts.done),
      total: number.format(total),
      open: number.format(counts.open),
    });
  };

  const summaryText = (stopped: boolean, elapsedMs: number): string =>
    fill(stopped ? strings.SummaryStopped : strings.Summary, {
      done: number.format(counts.done),
      open: number.format(counts.open),
      closed: number.format(counts.closed),
      filtered: number.format(counts.filtered),
      other: number.format(counts.other),
      seconds: (elapsedMs / 1000).toFixed(1),
    });

  const settle = (kind: "complete" | "fail" | "cancel"): void => {
    if (operationSettled) return;
    operationSettled = true;
    if (kind === "complete") operation?.complete();
    else if (kind === "fail") operation?.fail("processing_error");
    else operation?.cancel();
    operation = null;
  };

  const onLine = (line: PortScanLine): void => {
    switch (line.type) {
      case "start":
        target.address = line.address;
        total = line.total;
        resolved.textContent = fill(strings.ResolvedTo, { host: target.host, address: line.address });
        resolved.hidden = false;
        renderProgress();
        break;
      case "port":
        results.set(line.port, { port: line.port, status: line.status, elapsedMs: line.elapsedMs });
        if (line.status === "open") counts = { ...counts, open: counts.open + 1 };
        queueRender();
        break;
      case "progress":
      case "end": {
        const { done, open, closed, filtered, other } = line;
        counts = { done, open, closed, filtered, other };
        renderProgress();
        if (line.type === "end") {
          showMessage(resultStatus, summaryText(line.stopped, line.elapsedMs));
          settle(line.stopped ? "cancel" : "complete");
        }
        break;
      }
      case "error":
        showMessage(resultError, strings[`Error_${line.code}`] || strings.ErrorGeneric);
        settle("fail");
        break;
    }
  };

  const runScan = async (): Promise<void> => {
    hideMessage(resultError);
    hideMessage(resultStatus);
    if (!client.connected) {
      showMessage(resultError, strings.NotConnected);
      return;
    }
    if (!hasCapability()) {
      showMessage(capabilityWarning, strings.NeedScanCapability);
      return;
    }
    const host = hostInput.value.trim();
    const ports = selectedPorts();
    const timeoutMs = Number(timeoutInput.value);
    const parallel = Number(parallelInput.value);
    if (!hostLooksValid(host)) return showMessage(resultError, strings.InvalidHost);
    if (!ports) return showMessage(resultError, strings.InvalidPorts);
    if (!isPortTimeout(timeoutMs)) return showMessage(resultError, strings.InvalidTimeout);
    if (!isPortParallel(parallel)) return showMessage(resultError, strings.InvalidParallel);
    settings = { v: 1, preset: presetSelect.value as PortPreset, custom: portsInput.value.trim(), timeoutMs, parallel };
    persistSettings();

    const controller = new AbortController();
    abort = controller;
    const id = crypto.randomUUID();
    scanId = id;
    target = { host, address: "" };
    results = new Map();
    counts = { done: 0, open: 0, closed: 0, filtered: 0, other: 0 };
    total = ports.count;
    listsEveryPort = ports.count <= 1024;
    openOnly.closest("label")!.hidden = !listsEveryPort;
    if (!listsEveryPort) openOnly.checked = true;
    resolved.hidden = true;
    renderTable();
    renderProgress();
    progress.hidden = false;
    operation = startToolOperation("port-scanner");
    operationSettled = false;
    setBusy(true);
    try {
      await client.scanPorts({ id, host, ports: ports.ranges, timeoutMs, parallel }, onLine, controller.signal);
      if (!operationSettled) settle("complete");
    } catch (error) {
      if (abort !== controller) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        showMessage(resultStatus, summaryText(true, 0));
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
        if (!listsEveryPort && counts.done > 0 && results.size === 0) showMessage(resultStatus, `${resultStatus.textContent} ${strings.AllPortsHidden}`.trim());
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
    const id = scanId;
    // The agent ends the stream with `stopped`; if it cannot be reached, drop the stream.
    void client.cancel(id).catch(() => controller.abort());
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
  presetSelect.addEventListener("change", () => {
    refreshPorts();
    if (presetSelect.value === "custom") portsInput.focus();
  });
  portsInput.addEventListener("input", refreshPorts);
  start.addEventListener("click", () => { void runScan(); });
  stop.addEventListener("click", stopScan);
  for (const input of [hostInput, portsInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || busy) return;
      event.preventDefault();
      void runScan();
    });
  }
  openOnly.addEventListener("change", renderTable);
  copy.addEventListener("click", () => {
    if (counts.done === 0) return;
    void copyWithFeedback(copy, formatPortReport(target.host, target.address, [...results.values()], counts), strings.Copied, 1500, { failedLabel: strings.CopyFailed });
  });
  window.addEventListener("pagehide", () => {
    if (scanId) void client.cancel(scanId).catch(() => undefined);
    abort?.abort();
  });

  refreshPorts();
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
