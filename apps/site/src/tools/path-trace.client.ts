/**
 * Path trace page controller. ICMP probes run in the local agent (`icmp.trace`);
 * this page polls snapshots and builds text/HTML reports in the browser.
 * Hop results stay in memory. Recent targets and probe settings use `mdt.path-trace.v1`.
 */
import { startToolOperation, type ToolOperation } from "@/scripts/analytics/instrumentation";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type LocalAgentCapability,
  type PathMtuSnapshot,
  type TraceHopSnapshot,
  type TraceSnapshot,
} from "@/scripts/local-agent";
import { bindAgentPopover } from "@/scripts/agent-popover";
import { copyWithFeedback } from "@/scripts/tool-ui";
import {
  PATH_TRACE_STORAGE_KEY,
  TRACE_INTERVAL_MS,
  TRACE_MAX_HOPS,
  TRACE_PAYLOAD_BYTES,
  TRACE_TIMEOUT_MS,
  formatPathTraceHtml,
  formatPathTraceText,
  formatSpreadMs,
  hopHostname,
  hopStatusLabel,
  normalizeTarget,
  parseBoundedInteger,
  parsePathTraceSettings,
  rememberTarget,
  type PathTraceReportLabels,
  type PathTraceSettings,
} from "@/tools/path-trace";

const POLL_MS = 500;

function readStrings(root: HTMLElement): Record<string, string> | null {
  const node = root.querySelector("[data-path-trace-strings]");
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

function loadSettings(): PathTraceSettings {
  try {
    const raw = localStorage.getItem(PATH_TRACE_STORAGE_KEY);
    if (!raw) return parsePathTraceSettings(null);
    return parsePathTraceSettings(JSON.parse(raw) as unknown);
  } catch {
    return parsePathTraceSettings(null);
  }
}

function saveSettings(settings: PathTraceSettings): boolean {
  try {
    localStorage.setItem(PATH_TRACE_STORAGE_KEY, JSON.stringify(settings));
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
  const root = document.querySelector<HTMLElement>("[data-path-trace]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;

  const agentSettings = root.querySelector<HTMLDetailsElement>("[data-trace-agent-settings]");
  const code = root.querySelector<HTMLInputElement>("[data-trace-code]");
  const connect = root.querySelector<HTMLButtonElement>("[data-trace-connect]");
  const disconnect = root.querySelector<HTMLButtonElement>("[data-trace-disconnect]");
  const connectionState = root.querySelector<HTMLElement>("[data-trace-connection-state]");
  const agentMeta = root.querySelector<HTMLElement>("[data-trace-agent-meta]");
  const agentVersion = root.querySelector<HTMLElement>("[data-trace-agent-version]");
  const capabilitiesLabel = root.querySelector<HTMLElement>("[data-trace-capabilities]");
  const connectionStatus = root.querySelector<HTMLElement>("[data-trace-connection-status]");
  const capabilityWarning = root.querySelector<HTMLElement>("[data-trace-capability-warning]");
  const connectionError = root.querySelector<HTMLElement>("[data-trace-connection-error]");
  const storageWarning = root.querySelector<HTMLElement>("[data-trace-storage-warning]");
  const targetInput = root.querySelector<HTMLInputElement>("[data-trace-target]");
  const targetList = root.querySelector<HTMLDataListElement>("[data-trace-targets]");
  const clearHistory = root.querySelector<HTMLButtonElement>("[data-trace-clear-history]");
  const intervalInput = root.querySelector<HTMLInputElement>("[data-trace-interval]");
  const payloadInput = root.querySelector<HTMLInputElement>("[data-trace-payload]");
  const hopsInput = root.querySelector<HTMLInputElement>("[data-trace-hops]");
  const timeoutInput = root.querySelector<HTMLInputElement>("[data-trace-timeout]");
  const sourceSelect = root.querySelector<HTMLSelectElement>("[data-trace-source]");
  const sourceRefresh = root.querySelector<HTMLButtonElement>("[data-trace-sources]");
  const sourceLine = root.querySelector<HTMLElement>("[data-trace-source-line]");
  const resolveInput = root.querySelector<HTMLInputElement>("[data-trace-resolve]");
  const start = root.querySelector<HTMLButtonElement>("[data-trace-start]");
  const mtuButton = root.querySelector<HTMLButtonElement>("[data-trace-mtu]");
  const mtuResult = root.querySelector<HTMLElement>("[data-trace-mtu-result]");
  const stop = root.querySelector<HTMLButtonElement>("[data-trace-stop]");
  const runState = root.querySelector<HTMLElement>("[data-trace-run-state]");
  const runError = root.querySelector<HTMLElement>("[data-trace-run-error]");
  const resolvedLine = root.querySelector<HTMLElement>("[data-trace-resolved]");
  const body = root.querySelector<HTMLTableSectionElement>("[data-trace-body]");
  const detail = root.querySelector<HTMLElement>("[data-trace-detail]");
  const copyButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-trace-copy]")];
  const downloadButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-trace-download]")];
  if (!agentSettings || !code || !connect || !disconnect || !connectionState || !agentMeta || !agentVersion
    || !capabilitiesLabel || !connectionStatus || !capabilityWarning
    || !connectionError || !storageWarning || !targetInput || !targetList || !clearHistory || !intervalInput
    || !payloadInput || !hopsInput || !timeoutInput || !sourceSelect || !sourceRefresh || !sourceLine
    || !resolveInput || !start || !mtuButton
    || !mtuResult || !stop || !runState || !runError || !resolvedLine || !body || !detail) return;

  const client = new LocalAgentClient();
  const popover = bindAgentPopover(agentSettings);
  let settings = loadSettings();
  let snapshot: TraceSnapshot | null = null;
  let selectedHop: number | null = null;
  let activeId: string | null = null;
  let tracing = false;
  let searching = false;
  let mtuAbort: AbortController | null = null;
  let generation = 0;
  let pollTimer = 0;
  let operation: ToolOperation | null = null;
  let operationSettled = false;
  let probeCommitted = false;
  let sources: { name: string; address: string }[] = [];
  let sourceGeneration = 0;
  let sourceLoad: AbortController | null = null;

  const labels = (): PathTraceReportLabels => ({
    title: strings.ReportTitle,
    target: strings.TargetLabel,
    resolved: strings.ResolvedTarget,
    hostname: strings.Hostname,
    nr: strings.Nr,
    loss: strings.Loss,
    sent: strings.Sent,
    recv: strings.Recv,
    best: strings.Best,
    avg: strings.Avg,
    worst: strings.Worst,
    last: strings.Last,
    stdev: strings.StDev,
    jitter: strings.Jitter,
    status: strings.Status,
    noResponse: strings.NoResponse,
    statusText: (codeName) => strings[`Status_${codeName}`] || codeName,
  });

  const errorText = (error: unknown): string => {
    if (error instanceof LocalAgentError) return strings[`Error_${error.code}`] || strings.ErrorGeneric;
    return strings.ErrorGeneric;
  };

  const hasTraceCapability = (): boolean => client.capabilities.includes("icmp.trace");

  const fillHistory = (): void => {
    targetList.replaceChildren();
    for (const target of settings.targets) {
      const option = document.createElement("option");
      option.value = target;
      targetList.append(option);
    }
    clearHistory.hidden = settings.targets.length === 0;
  };

  const applySettings = (): void => {
    intervalInput.value = String(settings.intervalMs);
    payloadInput.value = String(settings.payloadBytes);
    hopsInput.value = String(settings.maxHops);
    timeoutInput.value = String(settings.timeoutMs);
    resolveInput.checked = settings.resolveNames;
    fillHistory();
  };

  const persistSettings = (): void => {
    if (!saveSettings(settings)) showMessage(storageWarning, strings.ConnectionNotSaved);
  };

  const readProbeSettings = (): Pick<PathTraceSettings, "intervalMs" | "payloadBytes" | "maxHops" | "timeoutMs" | "resolveNames"> | null => {
    const intervalMs = parseBoundedInteger(intervalInput.value, TRACE_INTERVAL_MS.min, TRACE_INTERVAL_MS.max);
    const payloadBytes = parseBoundedInteger(payloadInput.value, TRACE_PAYLOAD_BYTES.min, TRACE_PAYLOAD_BYTES.max);
    const maxHops = parseBoundedInteger(hopsInput.value, TRACE_MAX_HOPS.min, TRACE_MAX_HOPS.max);
    const timeoutMs = parseBoundedInteger(timeoutInput.value, TRACE_TIMEOUT_MS.min, TRACE_TIMEOUT_MS.max);
    if (intervalMs === null || payloadBytes === null || maxHops === null || timeoutMs === null) return null;
    return { intervalMs, payloadBytes, maxHops, timeoutMs, resolveNames: resolveInput.checked };
  };

  const onSettingsChanged = (): void => {
    const probe = readProbeSettings();
    if (!probe) return;
    settings = { ...settings, ...probe };
    persistSettings();
  };

  const setReportEnabled = (enabled: boolean): void => {
    for (const button of [...copyButtons, ...downloadButtons]) button.disabled = !enabled;
  };

  const renderDetail = (hop: TraceHopSnapshot | undefined): void => {
    if (!hop) {
      detail.hidden = true;
      return;
    }
    const reportLabels = labels();
    const values: Record<string, string> = {
      host: hopHostname(hop, reportLabels),
      address: hop.address ?? reportLabels.noResponse,
      status: hopStatusLabel(hop.status, reportLabels.statusText),
      sent: String(hop.sent),
      recv: String(hop.received),
      loss: String(hop.lossPercent),
      best: hop.bestMs === null ? "\u2014" : String(hop.bestMs),
      avg: hop.avgMs === null ? "\u2014" : String(hop.avgMs),
      worst: hop.worstMs === null ? "\u2014" : String(hop.worstMs),
      last: hop.lastMs === null ? "\u2014" : String(hop.lastMs),
      stdev: formatSpreadMs(hop.stdevMs),
      jitter: formatSpreadMs(hop.jitterMs),
    };
    for (const [key, text] of Object.entries(values)) {
      const node = detail.querySelector<HTMLElement>(`[data-detail="${key}"]`);
      if (node) node.textContent = text;
    }
    detail.hidden = false;
  };

  const renderSnapshot = (next: TraceSnapshot): void => {
    snapshot = next;
    resolvedLine.hidden = false;
    resolvedLine.textContent = `${strings.ResolvedTarget}: ${next.target || strings.NoResponse}`;
    body.replaceChildren();
    if (next.hops.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 12;
      td.textContent = next.state === "idle" ? strings.EmptyTable : strings.StateTracing;
      row.append(td);
      body.append(row);
      detail.hidden = true;
      setReportEnabled(next.id !== "");
      showSourceLine(next.sourceAddress, next.sourceInterface);
      return;
    }
    const reportLabels = labels();
    for (const hop of next.hops) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.dataset.hop = String(hop.hop);
      const selected = hop.hop === selectedHop;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      cell(row, hopHostname(hop, reportLabels));
      cell(row, String(hop.hop), "mono");
      cell(row, String(hop.lossPercent), "mono");
      cell(row, String(hop.sent), "mono");
      cell(row, String(hop.received), "mono");
      cell(row, hop.bestMs === null ? "\u2014" : String(hop.bestMs), "mono");
      cell(row, hop.avgMs === null ? "\u2014" : String(hop.avgMs), "mono");
      cell(row, hop.worstMs === null ? "\u2014" : String(hop.worstMs), "mono");
      cell(row, hop.lastMs === null ? "\u2014" : String(hop.lastMs), "mono");
      cell(row, formatSpreadMs(hop.stdevMs), "mono");
      cell(row, formatSpreadMs(hop.jitterMs), "mono");
      cell(row, hopStatusLabel(hop.status, reportLabels.statusText));
      body.append(row);
    }
    renderDetail(next.hops.find((hop) => hop.hop === selectedHop));
    setReportEnabled(true);
    showSourceLine(next.sourceAddress, next.sourceInterface);
    const stateLabel = next.state === "tracing"
      ? strings.StateTracing
      : next.state === "stopping"
        ? strings.StateStopping
        : strings.StateIdle;
    runState.textContent = stateLabel;
  };

  const selectHop = (hopNumber: number): void => {
    selectedHop = hopNumber;
    if (snapshot) renderSnapshot(snapshot);
  };

  const formatPair = (current: TraceSnapshot): { text: string; html: string } => {
    const report = {
      targetInput: current.targetInput || targetInput.value.trim(),
      target: current.target,
      hops: current.hops,
    };
    const reportLabels = labels();
    return {
      text: formatPathTraceText(report, reportLabels),
      html: formatPathTraceHtml(report, reportLabels),
    };
  };

  const currentReport = (): { text: string; html: string } | null => {
    if (!snapshot) return null;
    return formatPair(snapshot);
  };

  const settle = (kind: "complete" | "fail" | "cancel"): void => {
    if (operationSettled) return;
    operationSettled = true;
    if (kind === "complete") operation?.complete();
    else if (kind === "fail") operation?.fail("processing_error");
    else operation?.cancel();
    operation = null;
  };

  const noteProbe = (current: TraceSnapshot): void => {
    if (probeCommitted) return;
    if (current.hops.some((hop) => hop.sent > 0)) {
      probeCommitted = true;
      settle("complete");
    }
  };

  const stopPolling = (): void => {
    generation += 1;
    window.clearTimeout(pollTimer);
  };

  const fill = (template: string, params: Record<string, string | number>): string =>
    template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));

  const setTracing = (next: boolean): void => {
    tracing = next;
    const locked = tracing || searching;
    const canStart = client.connected && hasTraceCapability() && !locked;
    const canUpgrade = !locked && (!client.connected || !hasTraceCapability());
    start.disabled = !canStart;
    mtuButton.disabled = !canStart;
    mtuButton.ariaBusy = searching ? "true" : "false";
    stop.disabled = !tracing;
    stop.hidden = !tracing;
    targetInput.disabled = locked;
    clearHistory.disabled = locked;
    timeoutInput.disabled = locked;
    intervalInput.disabled = tracing;
    payloadInput.disabled = tracing;
    hopsInput.disabled = tracing;
    resolveInput.disabled = tracing;
    const canPickSource = canStart;
    sourceSelect.disabled = !canPickSource;
    sourceRefresh.disabled = !canPickSource;
    connect.disabled = !canUpgrade;
    code.disabled = !canUpgrade;
    disconnect.disabled = !client.connected;
    if (!tracing && !snapshot) runState.textContent = strings.StateIdle;
  };

  const showCapabilityWarning = (): void => {
    const missing = client.connected && !hasTraceCapability();
    if (missing) showMessage(capabilityWarning, strings.NeedTraceCapability);
    else hideMessage(capabilityWarning);
  };

  const setConnected = (connected: boolean): void => {
    connectionState.textContent = connected ? strings.AgentConnectedShort : strings.AgentDisconnectedShort;
    popover.sync(client);
    agentMeta.hidden = !connected;
    capabilitiesLabel.textContent = client.capabilities.join(", ");
    storageWarning.hidden = !connected || client.persisted;
    if (connected && !client.persisted) storageWarning.textContent = strings.ConnectionNotSaved;
    showCapabilityWarning();
    setTracing(tracing);
    if (connected && hasTraceCapability()) void loadSources();
    else {
      sourceGeneration += 1;
      sourceLoad?.abort();
      sources = [];
      renderSourceOptions();
      if (!connected) hideMessage(sourceLine);
    }
  };

  const selectedSource = (): { sourceAddress: string; sourceInterface: string } | null => {
    if (sourceSelect.value === "") return null;
    const index = Number(sourceSelect.value);
    const item = sources[index];
    if (!Number.isInteger(index) || !item) return null;
    return { sourceAddress: item.address, sourceInterface: item.name };
  };

  const renderSourceOptions = (): void => {
    const savedAddress = settings.sourceAddress;
    const savedInterface = settings.sourceInterface;
    sourceSelect.replaceChildren();
    const automatic = document.createElement("option");
    automatic.value = "";
    automatic.textContent = strings.Automatic;
    sourceSelect.append(automatic);
    let matched = "";
    sources.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${item.name} \u2014 ${item.address}`;
      sourceSelect.append(option);
      if (item.address === savedAddress && item.name === savedInterface) matched = String(index);
    });
    sourceSelect.value = matched;
  };

  /** Echoed agent source wins. Otherwise the selected pair. Automatic stays blank. */
  const showSourceLine = (address: string | null, interfaceName: string | null): void => {
    const chosen = selectedSource();
    const shownAddress = address || chosen?.sourceAddress || "";
    const shownInterface = interfaceName || chosen?.sourceInterface || "";
    if (!shownAddress || !shownInterface) {
      hideMessage(sourceLine);
      return;
    }
    showMessage(sourceLine, fill(strings.SourceFrom, { interface: shownInterface, address: shownAddress }));
  };

  const loadSources = async (): Promise<void> => {
    const generation = ++sourceGeneration;
    sourceLoad?.abort();
    const controller = new AbortController();
    sourceLoad = controller;
    try {
      const next = await client.listInterfaces(controller.signal);
      if (generation !== sourceGeneration) return;
      sources = next;
      renderSourceOptions();
      if (runError.textContent === strings.SourcesUnavailable) hideMessage(runError);
      if (!tracing && !searching) {
        showSourceLine(snapshot?.sourceAddress ?? null, snapshot?.sourceInterface ?? null);
      }
    } catch (error) {
      if (generation !== sourceGeneration) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      showMessage(runError, strings.SourcesUnavailable);
    }
  };

  const poll = (gen: number, id: string): void => {
    pollTimer = window.setTimeout(() => {
      void (async () => {
        if (gen !== generation || activeId !== id) return;
        try {
          const next = await client.traceSnapshot(id);
          if (gen !== generation || activeId !== id) return;
          renderSnapshot(next);
          noteProbe(next);
          if (next.state === "idle") {
            setTracing(false);
            stopPolling();
            return;
          }
          poll(gen, id);
        } catch (error) {
          if (gen !== generation || activeId !== id) return;
          showMessage(runError, errorText(error));
          if (!probeCommitted) settle("fail");
          setTracing(false);
          stopPolling();
        }
      })();
    }, POLL_MS);
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
        if (!advertised.includes("icmp.trace")) throw new LocalAgentError("unsupported_capability");
        info = await client.pairKeepingSession(pairingCode, mergeCapabilities(previous, advertised, "icmp.trace"));
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
      mtuAbort?.abort();
      const id = activeId;
      stopPolling();
      if (id) {
        try { await client.cancelTrace(id); } catch { /* session revoke stops the trace too */ }
      }
      if (tracing && !probeCommitted) settle("cancel");
      activeId = null;
      setTracing(false);
      const pending = client.disconnect();
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

  start.addEventListener("click", () => {
    void (async () => {
      hideMessage(runError);
      if (!client.connected) {
        showMessage(runError, strings.NotConnected);
        return;
      }
      if (!hasTraceCapability()) {
        showMessage(capabilityWarning, strings.NeedTraceCapability);
        return;
      }
      const target = normalizeTarget(targetInput.value);
      if (!target) {
        showMessage(runError, strings.InvalidTarget);
        return;
      }
      const probe = readProbeSettings();
      if (!probe) {
        showMessage(runError, strings.InvalidSettings);
        return;
      }
      settings = { ...settings, ...probe };
      persistSettings();
      const id = crypto.randomUUID();
      operation = startToolOperation("path-trace");
      operationSettled = false;
      probeCommitted = false;
      selectedHop = null;
      activeId = id;
      setTracing(true);
      runState.textContent = strings.StateTracing;
      try {
        const chosen = selectedSource();
        const started = await client.startTrace({
          id,
          target,
          intervalMs: probe.intervalMs,
          payloadBytes: probe.payloadBytes,
          maxHops: probe.maxHops,
          timeoutMs: probe.timeoutMs,
          resolveNames: probe.resolveNames,
          ...(chosen ?? {}),
        });
        if (activeId !== id) {
          void client.cancelTrace(id).catch(() => undefined);
          settle("cancel");
          return;
        }
        settings = { ...settings, targets: rememberTarget(settings.targets, target) };
        persistSettings();
        fillHistory();
        renderSnapshot(started);
        noteProbe(started);
        stopPolling();
        poll(generation, id);
      } catch (error) {
        if (activeId === id) activeId = null;
        if (error instanceof LocalAgentError && error.code === "cancelled") {
          settle("cancel");
          setTracing(false);
          runState.textContent = strings.StateIdle;
          return;
        }
        settle("fail");
        setTracing(false);
        runState.textContent = strings.StateIdle;
        showMessage(runError, errorText(error));
      }
    })();
  });

  const mtuSentence = (result: PathMtuSnapshot): string => {
    if (result.status === "found" && result.mtu !== null) {
      const template = result.atCeiling ? strings.MtuFoundCeiling : strings.MtuFound;
      return fill(template, { mtu: result.mtu });
    }
    if (result.status === "below_minimum" && result.minimumMtu !== null) {
      return fill(strings.MtuBelowMinimum, { mtu: result.minimumMtu });
    }
    if (result.status === "inconclusive") return strings.MtuInconclusive;
    throw new LocalAgentError("invalid_response");
  };

  /**
   * Path MTU search on the same target and timeout. DF probes, largest echo wins.
   * A lost probe is inconclusive, not a smaller MTU. Abort cancels only this search.
   */
  mtuButton.addEventListener("click", () => {
    void (async () => {
      hideMessage(runError);
      if (tracing || searching) return;
      if (!client.connected) {
        showMessage(runError, strings.NotConnected);
        return;
      }
      if (!hasTraceCapability()) {
        showMessage(capabilityWarning, strings.NeedTraceCapability);
        return;
      }
      const target = normalizeTarget(targetInput.value);
      if (!target) {
        showMessage(runError, strings.InvalidTarget);
        return;
      }
      const timeoutMs = parseBoundedInteger(timeoutInput.value, TRACE_TIMEOUT_MS.min, TRACE_TIMEOUT_MS.max);
      if (timeoutMs === null) {
        showMessage(runError, strings.InvalidSettings);
        return;
      }
      settings = { ...settings, timeoutMs };
      persistSettings();
      searching = true;
      setTracing(tracing);
      mtuAbort = new AbortController();
      if (!operation) {
        operation = startToolOperation("path-trace");
        operationSettled = false;
      }
      showMessage(mtuResult, strings.MtuSearching);
      try {
        const chosen = selectedSource();
        const result = await client.findPathMtu({
          target,
          timeoutMs,
          ...(chosen ?? {}),
        }, mtuAbort.signal);
        showMessage(mtuResult, mtuSentence(result));
        showSourceLine(result.sourceAddress, result.sourceInterface);
        settings = { ...settings, targets: rememberTarget(settings.targets, target) };
        persistSettings();
        fillHistory();
        settle("complete");
      } catch (error) {
        hideMessage(mtuResult);
        if (error instanceof DOMException && error.name === "AbortError") {
          settle("cancel");
          return;
        }
        settle("fail");
        showMessage(runError, errorText(error));
      } finally {
        searching = false;
        mtuAbort = null;
        setTracing(tracing);
      }
    })();
  });

  stop.addEventListener("click", () => {
    void (async () => {
      const id = activeId;
      if (!id) return;
      runState.textContent = strings.StateStopping;
      stop.disabled = true;
      try {
        await client.cancelTrace(id);
      } catch (error) {
        showMessage(runError, errorText(error));
      }
      if (!probeCommitted) settle("cancel");
    })();
  });

  body.addEventListener("click", (event) => {
    const row = (event.target as Element | null)?.closest<HTMLTableRowElement>("tr[data-hop]");
    if (!row?.dataset.hop) return;
    selectHop(Number(row.dataset.hop));
  });
  body.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = (event.target as Element | null)?.closest<HTMLTableRowElement>("tr[data-hop]");
    if (!row?.dataset.hop) return;
    event.preventDefault();
    selectHop(Number(row.dataset.hop));
  });

  for (const button of copyButtons) {
    button.addEventListener("click", () => {
      const report = currentReport();
      if (!report) return;
      const text = button.dataset.traceCopy === "html" ? report.html : report.text;
      void copyWithFeedback(button, text, strings.Copied, 1500, { failedLabel: strings.CopyFailed });
    });
  }
  for (const button of downloadButtons) {
    button.addEventListener("click", () => {
      const report = currentReport();
      if (!report) return;
      const html = button.dataset.traceDownload === "html";
      const blob = new Blob([html ? report.html : report.text], { type: html ? "text/html;charset=utf-8" : "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = html ? "path-trace.html" : "path-trace.txt";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    });
  }

  clearHistory.addEventListener("click", () => {
    settings = { ...settings, targets: [] };
    persistSettings();
    fillHistory();
    targetInput.focus();
  });
  targetInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    if (!start.disabled) start.click();
  });

  for (const input of [intervalInput, payloadInput, hopsInput, timeoutInput]) {
    input.addEventListener("change", onSettingsChanged);
  }
  resolveInput.addEventListener("change", onSettingsChanged);
  sourceSelect.addEventListener("change", () => {
    const chosen = selectedSource();
    settings = {
      ...settings,
      sourceAddress: chosen?.sourceAddress ?? "",
      sourceInterface: chosen?.sourceInterface ?? "",
    };
    persistSettings();
    if (!tracing && !searching) showSourceLine(null, null);
  });
  sourceRefresh.addEventListener("click", () => {
    if (!client.connected || !hasTraceCapability() || tracing || searching) return;
    void loadSources();
  });

  window.addEventListener("pagehide", () => {
    sourceLoad?.abort();
    mtuAbort?.abort();
    if (!activeId) return;
    void client.cancelTrace(activeId).catch(() => undefined);
  });

  applySettings();
  renderSnapshot({
    id: "",
    state: "idle",
    target: "",
    targetInput: "",
    sourceAddress: null,
    sourceInterface: null,
    hops: [],
  });
  setReportEnabled(false);
  resolvedLine.hidden = true;
  setConnected(false);
  void connectAgent(true);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
