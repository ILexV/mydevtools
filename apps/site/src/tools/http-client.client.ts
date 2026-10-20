import { formatBytes } from "@/lib/format";
import { syncEmptyState } from "@/scripts/tool-ui";
import { loadEditorKit, type MdtEditor, type EditorLanguage } from "@/scripts/codemirror-loader";
import { formatResponseJson } from "@/tools/http-response";
import { sanitizeHtml } from "@/tools/markdown-sanitize";
import {
  LocalAgentClient,
  LocalAgentError,
  base64ToBytes,
  bytesToBase64,
  type LocalAgentHeader,
  type LocalHttpResponse,
} from "@/scripts/local-agent";

interface Strings {
  Lang: string;
  phrases: Record<string, string>;
  ResponseBody: string;
  EditorLoadError: string;
  BodyLabel: string;
  InvalidJson: string;
  BodyEditorError: string;
  ConnectionNotSaved: string;
  HtmlPreviewError: string;
  Connected: string;
  NotConnected: string;
  Disconnected: string;
  Connecting: string;
  Sending: string;
  Canceled: string;
  ResponseSummary: string;
  PrivateAllowed: string;
  PrivateBlocked: string;
  DownloadName: string;
  BinaryPreview: string;
  NoResponse: string;
  PreviewTruncated?: string;
  ErrorHeaders: string;
  ErrorUrl: string;
  ErrorBodyLimit: string;
  ErrorGeneric: string;
  [key: `Error_${string}`]: string;
}

const PREVIEW_LIMIT = 1024 * 1024;

function readStrings(root: HTMLElement): Strings | null {
  const island = root.parentElement?.querySelector<HTMLScriptElement>("[data-http-strings]");
  if (!island) return null;
  try {
    return JSON.parse(island.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}


function isTextContentType(value: string): boolean {
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime.startsWith("text/")
    || mime === "application/json"
    || mime.endsWith("+json")
    || mime === "application/xml"
    || mime.endsWith("+xml")
    || mime === "application/javascript"
    || mime === "application/x-javascript"
    || mime === "application/x-www-form-urlencoded"
    || mime === "image/svg+xml";
}

function textDecoderFor(value: string): TextDecoder {
  const match = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(value);
  try {
    return new TextDecoder(match?.[1] || "utf-8");
  } catch {
    return new TextDecoder();
  }
}

function safeFilename(headers: LocalAgentHeader[], fallback: string): string {
  const disposition = headers.find((header) => header.name.toLowerCase() === "content-disposition")?.value;
  const utf8 = disposition && /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  const basic = disposition && /filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(disposition);
  let candidate = fallback;
  try {
    candidate = utf8 ? decodeURIComponent(utf8) : (basic?.[1] || basic?.[2] || fallback);
  } catch {
    candidate = fallback;
  }
  const cleaned = candidate.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim();
  return cleaned.slice(0, 180) || fallback;
}

function requestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function init(): void {
  const root = document.querySelector<HTMLElement>("[data-http-client]");
  if (!root || root.dataset.bound === "true") return;
  root.dataset.bound = "true";
  const strings = readStrings(root);
  if (!strings) return;

  const code = root.querySelector<HTMLInputElement>("[data-http-code]");
  const setup = root.querySelector<HTMLElement>(".http-setup");
  const connect = root.querySelector<HTMLButtonElement>("[data-http-connect]");
  const disconnect = root.querySelector<HTMLButtonElement>("[data-http-disconnect]");
  const agentMeta = root.querySelector<HTMLElement>("[data-http-agent-meta]");
  const agentVersion = root.querySelector<HTMLElement>("[data-http-agent-version]");
  const lanPolicy = root.querySelector<HTMLElement>("[data-http-lan]");
  const connectionStatus = root.querySelector<HTMLElement>("[data-http-connection-status]");
  const connectionError = root.querySelector<HTMLElement>("[data-http-connection-error]");
  const connectionState = root.querySelector<HTMLElement>("[data-http-connection-state]");
  const method = root.querySelector<HTMLSelectElement>("[data-http-method]");
  const requestUrl = root.querySelector<HTMLInputElement>("[data-http-url]");
  const rowTemplate = root.querySelector<HTMLTemplateElement>("[data-http-row-template]");
  const requestBody = root.querySelector<HTMLTextAreaElement>("[data-http-body]");
  const bodyFormat = root.querySelector<HTMLSelectElement>("[data-http-body-format]")!;
  const formatJson = root.querySelector<HTMLButtonElement>("[data-http-format-json]")!;
  const bodyHost = root.querySelector<HTMLElement>("[data-http-body-editor]")!;
  const bodyError = root.querySelector<HTMLElement>("[data-http-body-error]")!;
  const bodyEditorError = root.querySelector<HTMLElement>("[data-http-body-editor-error]")!;
  const storageWarning = root.querySelector<HTMLElement>("[data-http-storage-warning]")!;
  const timeout = root.querySelector<HTMLInputElement>("[data-http-timeout]");
  const redirects = root.querySelector<HTMLInputElement>("[data-http-redirects]");
  const send = root.querySelector<HTMLButtonElement>("[data-http-send]");
  const cancel = root.querySelector<HTMLButtonElement>("[data-http-cancel]");
  const requestStatus = root.querySelector<HTMLElement>("[data-http-request-status]");
  const requestError = root.querySelector<HTMLElement>("[data-http-request-error]");
  const output = root.querySelector<HTMLElement>("[data-http-output]");
  const result = root.querySelector<HTMLElement>("[data-http-result]");
  const responseStatus = root.querySelector<HTMLElement>("[data-http-response-status]");
  const responseTime = root.querySelector<HTMLElement>("[data-http-response-time]");
  const responseSize = root.querySelector<HTMLElement>("[data-http-response-size]");
  const responseUrl = root.querySelector<HTMLElement>("[data-http-response-url]");
  const responseHeaders = root.querySelector<HTMLElement>("[data-http-response-headers]");
  const responsePreview = root.querySelector<HTMLElement>("[data-http-response-preview]");
  const responseMeta = root.querySelector<HTMLElement>("[data-http-response-meta]");
  const responseType = root.querySelector<HTMLElement>("[data-http-response-type]");
  const editorHost = root.querySelector<HTMLElement>("[data-http-response-editor]");
  const editorError = root.querySelector<HTMLElement>("[data-http-editor-error]");
  const prettyButton = root.querySelector<HTMLButtonElement>('[data-http-view="pretty"]');
  const rawButton = root.querySelector<HTMLButtonElement>('[data-http-view="raw"]');
  const htmlButton = root.querySelector<HTMLButtonElement>('[data-http-view="html"]')!;
  const htmlPreview = root.querySelector<HTMLElement>("[data-http-html-preview]")!;
  const htmlFrame = root.querySelector<HTMLIFrameElement>("[data-http-html-frame]")!;
  const download = root.querySelector<HTMLButtonElement>("[data-http-download]");
  if (!code || !connect || !disconnect || !agentMeta || !agentVersion || !lanPolicy || !connectionStatus
    || !connectionError || !connectionState || !method || !requestUrl || !rowTemplate || !requestBody
    || !timeout || !redirects || !send || !cancel || !requestStatus || !requestError || !output || !result
    || !responseStatus || !responseTime || !responseSize || !responseUrl || !responseHeaders
    || !responsePreview || !download || !responseMeta || !responseType || !editorHost || !editorError
    || !prettyButton || !rawButton) return;

  const client = new LocalAgentClient();
  let active: { id: string; abort: AbortController } | null = null;
  let responseBlob: Blob | null = null;
  let responseName = "response.bin";
  let responseEditor: MdtEditor | null = null;
  let editorLanguage: EditorLanguage | null = null;
  let previewRevision = 0;
  let rawPreview = "";
  let prettyPreview: string | null = null;
  let sourceLanguage: EditorLanguage = "text";
  let htmlSource: string | null = null;
  let bodyEditor: MdtEditor | null = null;
  let bodyRevision = 0;
  let mountedBodyLanguage: EditorLanguage | null = null;
  const s = strings;
  const responseUi = {
    output,
    result,
    meta: responseMeta,
    type: responseType,
    prettyButton,
    status: responseStatus,
    time: responseTime,
    size: responseSize,
    url: responseUrl,
    headers: responseHeaders,
    preview: responsePreview,
    download,
    requestStatus,
  };

  const bindTable = (kind: "params" | "headers", onChange?: () => void) => {
    const body = root.querySelector<HTMLTableSectionElement>(`[data-http-table="${kind}"] tbody`)!;
    const count = root.querySelector<HTMLElement>(`[data-http-${kind}-count]`)!;
    const add = root.querySelector<HTMLButtonElement>(`[data-http-add-row="${kind}"]`)!;
    const rows: { enabled: HTMLInputElement; key: HTMLInputElement; value: HTMLInputElement }[] = [];
    const read = (): LocalAgentHeader[] => rows
      .filter((row) => row.enabled.checked && (row.key.value !== "" || row.value.value !== ""))
      .map((row) => ({ name: row.key.value, value: row.value.value }));
    const updateCount = (): void => {
      const size = read().length;
      count.textContent = size ? String(size) : "";
    };
    const append = (name = "", value = "") => {
      const element = rowTemplate.content.firstElementChild!.cloneNode(true) as HTMLTableRowElement;
      const row = {
        enabled: element.querySelector<HTMLInputElement>("[data-row-enabled]")!,
        key: element.querySelector<HTMLInputElement>("[data-row-key]")!,
        value: element.querySelector<HTMLInputElement>("[data-row-value]")!,
      };
      row.key.value = name;
      row.value.value = value;
      rows.push(row);
      body.append(element);
      element.addEventListener("input", () => {
        if (rows.at(-1) === row && (row.key.value || row.value.value)) append();
        updateCount();
        onChange?.();
      });
      element.querySelector("[data-row-remove]")!.addEventListener("click", () => {
        const index = rows.indexOf(row);
        rows.splice(index, 1);
        element.remove();
        if (!rows.length) append();
        rows[Math.min(index, rows.length - 1)]!.key.focus();
        updateCount();
        onChange?.();
      });
      return row;
    };
    add.addEventListener("click", () => {
      const last = rows.at(-1);
      (last && !last.key.value && !last.value.value ? last : append()).key.focus();
    });
    const replace = (entries: Iterable<[string, string]>): void => {
      rows.length = 0;
      body.replaceChildren();
      for (const [name, value] of entries) append(name, value);
      append();
      updateCount();
    };
    append();
    return { read, replace };
  };
  const paramsTable = bindTable("params", () => {
    const url = requestUrl.value;
    const hashAt = url.indexOf("#");
    const fragment = hashAt < 0 ? "" : url.slice(hashAt);
    const base = (hashAt < 0 ? url : url.slice(0, hashAt)).split("?", 1)[0]!;
    const query = new URLSearchParams(paramsTable.read().map(({ name, value }) => [name, value])).toString();
    requestUrl.value = `${base}${query ? `?${query}` : ""}${fragment}`;
  });
  const headersTable = bindTable("headers");
  requestUrl.addEventListener("input", () => {
    const beforeFragment = requestUrl.value.split("#", 1)[0]!;
    const queryAt = beforeFragment.indexOf("?");
    paramsTable.replace(new URLSearchParams(queryAt < 0 ? "" : beforeFragment.slice(queryAt + 1)));
  });
  const mountBodyEditor = async (): Promise<void> => {
    const revision = ++bodyRevision;
    const language = bodyFormat.value as EditorLanguage;
    formatJson.disabled = language !== "json";
    bodyError.hidden = true;
    if (bodyEditor && mountedBodyLanguage === language && !bodyHost.hidden) {
      bodyEditor.view.requestMeasure();
      return;
    }
    // Keep the plain input live during loading, including language switches.
    if (bodyEditor && !bodyHost.hidden) requestBody.value = bodyEditor.getValue();
    bodyHost.hidden = true;
    requestBody.hidden = false;
    bodyEditorError.hidden = true;
    try {
      const kit = await loadEditorKit();
      if (revision !== bodyRevision) return;
      const mount = document.createElement("div");
      mount.style.height = "100%";
      const editor = await kit.createEditor(mount, {
        language, label: strings.BodyLabel, hintId: "http-body-hint", phrases: strings.phrases,
        onSubmit: () => { if (!send.disabled) send.click(); },
        onChange: () => {
          requestBody.value = editor.getValue();
          bodyError.hidden = true;
        },
      });
      if (revision !== bodyRevision) {
        editor.view.destroy();
        return;
      }
      editor.setValue(requestBody.value);
      bodyEditor?.view.destroy();
      bodyEditor = editor;
      mountedBodyLanguage = language;
      bodyHost.replaceChildren(mount);
      bodyHost.hidden = false;
      requestBody.hidden = true;
      editor.view.requestMeasure();
    } catch {
      if (revision !== bodyRevision) return;
      bodyEditor?.view.destroy();
      bodyEditor = null;
      mountedBodyLanguage = null;
      bodyEditorError.textContent = strings.BodyEditorError;
      bodyEditorError.hidden = false;
    }
  };
  bodyFormat.addEventListener("change", () => { void mountBodyEditor(); });
  requestBody.addEventListener("input", () => { bodyError.hidden = true; });
  formatJson.addEventListener("click", () => {
    const formatted = formatResponseJson(requestBody.value);
    bodyError.hidden = formatted !== null;
    if (formatted === null) {
      bodyError.textContent = strings.InvalidJson;
      return;
    }
    requestBody.value = formatted;
    if (bodyEditor && !bodyHost.hidden) {
      bodyEditor.setValue(formatted);
      bodyEditor.focus();
    }
  });

  const showPreview = async (mode: "pretty" | "raw" | "html"): Promise<void> => {
    const revision = ++previewRevision;
    const renderHtml = mode === "html" && htmlSource !== null;
    const formatted = mode === "pretty" && prettyPreview !== null;
    const text = formatted ? prettyPreview! : rawPreview;
    const language: EditorLanguage = formatted ? "json" : sourceLanguage;
    prettyButton.setAttribute("aria-pressed", String(formatted));
    rawButton.setAttribute("aria-pressed", String(!formatted && !renderHtml));
    htmlButton.setAttribute("aria-pressed", String(renderHtml));
    htmlPreview.hidden = !renderHtml;
    if (renderHtml) {
      editorError.hidden = true;
      editorHost.hidden = true;
      responsePreview.hidden = true;
      if (!htmlFrame.hasAttribute("srcdoc")) {
        try {
          // Reuse the inert allowlist sanitizer, then remove navigation URLs.
          // An opaque sandbox + restrictive CSP are independent backstops.
          const fragment = sanitizeHtml(htmlSource!);
          for (const element of fragment.querySelectorAll("[href], [src], [cite]")) {
            element.removeAttribute("href");
            element.removeAttribute("src");
            element.removeAttribute("cite");
          }
          const holder = document.createElement("template");
          holder.content.append(fragment);
          htmlFrame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'"><meta charset="utf-8"><style>body{font:14px/1.5 system-ui,sans-serif;padding:16px;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px}img{max-width:100%}</style>${holder.innerHTML}`;
        } catch {
          htmlPreview.hidden = true;
          htmlButton.setAttribute("aria-pressed", "false");
          rawButton.setAttribute("aria-pressed", "true");
          responsePreview.textContent = rawPreview;
          responsePreview.hidden = false;
          editorError.textContent = strings.HtmlPreviewError;
          editorError.hidden = false;
        }
      }
      return;
    }
    editorError.hidden = true;
    responsePreview.textContent = text;
    responsePreview.hidden = false;
    editorHost.hidden = true;
    try {
      if (!responseEditor || editorLanguage !== language) {
        const kit = await loadEditorKit();
        if (revision !== previewRevision) return;
        const mount = document.createElement("div");
        mount.style.height = "100%";
        const editor = await kit.createEditor(mount, {
          language,
          label: strings.ResponseBody,
          phrases: strings.phrases,
          readOnly: true,
        });
        if (revision !== previewRevision) {
          editor.view.destroy();
          return;
        }
        responseEditor?.view.destroy();
        editorHost.replaceChildren(mount);
        responseEditor = editor;
        editorLanguage = language;
      }
      responseEditor.setValue(text);
      editorHost.hidden = false;
      responsePreview.hidden = true;
      responseEditor.view.requestMeasure();
    } catch {
      if (revision !== previewRevision) return;
      responsePreview.textContent = rawPreview;
      prettyButton.setAttribute("aria-pressed", "false");
      rawButton.setAttribute("aria-pressed", "true");
      editorError.textContent = strings.EditorLoadError;
      editorError.hidden = false;
    }
  };
  prettyButton.addEventListener("click", () => { void showPreview("pretty"); });
  rawButton.addEventListener("click", () => { void showPreview("raw"); });
  htmlButton.addEventListener("click", () => { void showPreview("html"); });
  for (const tablist of root.querySelectorAll<HTMLElement>("[data-http-tabs]")) {
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>(':scope > [role="tab"]')];
    const activate = (next: HTMLButtonElement, moveFocus: boolean): void => {
      for (const tab of tabs) {
        const selected = tab === next;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        const panelId = tab.getAttribute("aria-controls");
        const panel = panelId ? document.getElementById(panelId) : null;
        if (panel && root.contains(panel)) panel.hidden = !selected;
      }
      if (moveFocus) next.focus();
      if (next.id === "http-request-body-tab") void mountBodyEditor();
    };
    tablist.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const tab = event.target.closest<HTMLButtonElement>('[role="tab"]');
      if (tab && tabs.includes(tab)) activate(tab, false);
    });
    tablist.addEventListener("keydown", (event) => {
      if (!(event.target instanceof Element)) return;
      const current = event.target.closest<HTMLButtonElement>('[role="tab"]');
      const index = current ? tabs.indexOf(current) : -1;
      if (index < 0) return;
      let next = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      const target = tabs[next];
      if (target) activate(target, true);
    });
  }

  const hideMessage = (element: HTMLElement): void => {
    element.hidden = true;
    element.textContent = "";
  };
  const showMessage = (element: HTMLElement, message: string): void => {
    element.textContent = message;
    element.hidden = false;
  };
  const errorText = (error: unknown): string => {
    if (error instanceof LocalAgentError) return strings[`Error_${error.code}`] || strings.ErrorGeneric;
    if (error instanceof Error && error.message) return error.message;
    return strings.ErrorGeneric;
  };
  const setConnected = (connected: boolean): void => {
    connect.disabled = connected;
    disconnect.disabled = !connected;
    send.disabled = !connected || active !== null;
    code.disabled = connected;
    agentMeta.hidden = !connected;
    connectionState.textContent = connected ? strings.Connected : strings.NotConnected;
    if (setup) setup.hidden = connected;
    storageWarning.hidden = !connected || client.persisted;
    storageWarning.textContent = strings.ConnectionNotSaved;
  };
  const setSending = (sending: boolean): void => {
    send.disabled = sending || !client.connected;
    cancel.disabled = !sending;
    cancel.hidden = !sending;
    if (sending) requestStatus.classList.remove("visually-hidden");
    method.disabled = sending;
    requestUrl.disabled = sending;
  };

  const connectAgent = async (automatic = false): Promise<void> => {
    hideMessage(connectionError);
    showMessage(connectionStatus, strings.Connecting);
    connectionState.textContent = strings.Connecting;
    connect.disabled = true;
    const pairingCode = automatic ? "" : code.value.trim();
    try {
      const info = pairingCode
        ? await client.pair(pairingCode, ["http.request"])
        : await client.restore();
      if (!info) {
        setConnected(false);
        hideMessage(connectionStatus);
        if (!automatic) showMessage(connectionError, strings.Error_unauthorized);
        return;
      }
      agentVersion.textContent = info.version;
      lanPolicy.textContent = info.privateNetworkAllowed ? strings.PrivateAllowed : strings.PrivateBlocked;
      setConnected(true);
      showMessage(connectionStatus, strings.Connected);
    } catch (error) {
      setConnected(false);
      hideMessage(connectionStatus);
      showMessage(connectionError, errorText(error));
    } finally {
      code.value = "";
      if (!client.connected) connect.disabled = false;
    }
  };
  connect.addEventListener("click", () => { void connectAgent(); });
  void connectAgent(true);

  disconnect.addEventListener("click", async () => {
    const pending = client.disconnect();
    if (active) {
      active.abort.abort();
      active = null;
    }
    setConnected(false);
    setSending(false);
    connect.disabled = true;
    hideMessage(connectionError);
    hideMessage(connectionStatus);
    hideMessage(requestStatus);
    try {
      await pending;
      showMessage(connectionStatus, strings.Disconnected);
    } catch (error) {
      showMessage(connectionError, errorText(error));
    } finally {
      connect.disabled = client.connected;
    }
  });

  send.addEventListener("click", async () => {
    hideMessage(requestError);
    const url = requestUrl.value.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(strings.ErrorUrl);
    } catch {
      showMessage(requestError, strings.ErrorUrl);
      requestUrl.focus();
      return;
    }

    let headers: LocalAgentHeader[];
    try {
      headers = headersTable.read().map(({ name, value }) => ({ name: name.trim(), value }));
      if (headers.some(({ name, value }) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) || /[\r\n]/u.test(value))) {
        throw new Error(strings.ErrorHeaders);
      }
    } catch (error) {
      showMessage(requestError, errorText(error));
      root.querySelector<HTMLButtonElement>("#http-request-headers-tab")?.click();
      root.querySelector<HTMLInputElement>('[data-http-table="headers"] [data-row-key]')?.focus();
      return;
    }

    const bodyBytes = new TextEncoder().encode(requestBody.value);
    if (bodyBytes.byteLength && !headers.some(({ name }) => name.toLowerCase() === "content-type")) {
      const contentTypes: Record<string, string> = {
        text: "text/plain; charset=utf-8", json: "application/json",
        html: "text/html; charset=utf-8", xml: "application/xml",
      };
      headers.push({ name: "Content-Type", value: contentTypes[bodyFormat.value]! });
    }
    const bodyLimit = client.info?.limits.maxRequestBodyBytes ?? 1024 * 1024;
    if (bodyBytes.byteLength > bodyLimit) {
      showMessage(requestError, strings.ErrorBodyLimit);
      return;
    }

    const id = requestId();
    const abort = new AbortController();
    active = { id, abort };
    setSending(true);
    showMessage(requestStatus, strings.Sending);
    responseBlob = null;
    download.disabled = true;
    result.hidden = true;
    responseMeta.hidden = true;
    previewRevision++;
    rawPreview = "";
    prettyPreview = null;
    htmlSource = null;
    htmlFrame.removeAttribute("srcdoc");
    htmlPreview.hidden = true;
    htmlButton.hidden = true;
    syncEmptyState(output, true);

    try {
      const response = await client.request({
        id,
        method: method.value,
        url,
        headers,
        bodyBase64: bytesToBase64(bodyBytes),
        timeoutMs: Math.max(100, Math.min(client.info?.limits.maxTimeoutMs ?? 120000, Number(timeout.value) || 30000)),
        followRedirects: redirects.checked,
      }, abort.signal);
      if (active?.id !== id || abort.signal.aborted) return;
      renderResponse(response);
    } catch (error) {
      if (active?.id !== id) return;
      if ((error instanceof DOMException && error.name === "AbortError")
        || (error instanceof LocalAgentError && error.code === "cancelled")) {
        showMessage(requestStatus, strings.Canceled);
      } else {
        hideMessage(requestStatus);
        showMessage(requestError, errorText(error));
        if (!client.connected) setConnected(false);
      }
    } finally {
      if (active?.id === id) {
        active = null;
        setSending(false);
      }
    }
  });

  cancel.addEventListener("click", async () => {
    if (!active) return;
    const current = active;
    cancel.disabled = true;
    try {
      await client.cancel(current.id);
    } catch (error) {
      showMessage(requestError, errorText(error));
    } finally {
      current.abort.abort();
    }
  });

  download.addEventListener("click", () => {
    if (!responseBlob) return;
    const objectUrl = URL.createObjectURL(responseBlob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = responseName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  });

  function renderResponse(response: LocalHttpResponse): void {
    const bytes = base64ToBytes(response.bodyBase64);
    const type = response.headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
    responseBlob = new Blob([bytes.slice().buffer], { type: type || "application/octet-stream" });
    responseName = safeFilename(response.headers, s.DownloadName || "response.bin");
    responseUi.status.textContent = `${response.status} ${response.statusText}`.trim();
    responseUi.status.classList.toggle("is-error", response.status >= 400);
    responseUi.meta.hidden = false;
    responseUi.time.textContent = `${response.elapsedMs} ms`;
    responseUi.size.textContent = formatBytes(bytes.byteLength, 2);
    responseUi.url.textContent = response.url;
    responseUi.headers.textContent = response.headers.map((header) => `${header.name}: ${header.value}`).join("\n");
    prettyPreview = null;
    const mime = type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    sourceLanguage = mime === "application/json" || mime.endsWith("+json") ? "json"
      : mime === "text/html" || mime === "application/xhtml+xml" ? "html"
      : mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml") ? "xml"
      : mime === "application/javascript" || mime === "text/javascript" ? "typescript" : "text";
    responseUi.type.textContent = mime;
    if (isTextContentType(type)) {
      const previewBytes = bytes.subarray(0, PREVIEW_LIMIT);
      const text = textDecoderFor(type).decode(previewBytes);
      if (bytes.byteLength <= PREVIEW_LIMIT && (mime === "text/html" || mime === "application/xhtml+xml")) {
        htmlSource = text;
      }
      rawPreview = bytes.byteLength > PREVIEW_LIMIT && s.PreviewTruncated
        ? `${text}\n\n${s.PreviewTruncated}`
        : text;
      if (bytes.byteLength <= PREVIEW_LIMIT && (mime === "application/json" || mime.endsWith("+json"))) {
        prettyPreview = formatResponseJson(text);
      }
    } else {
      rawPreview = s.BinaryPreview;
    }
    responseUi.prettyButton.disabled = prettyPreview === null;
    htmlButton.hidden = htmlSource === null;
    responseUi.result.hidden = false;
    void showPreview(prettyPreview === null ? "raw" : "pretty");
    syncEmptyState(responseUi.output, false);
    responseUi.download.disabled = false;
    showMessage(responseUi.requestStatus, s.ResponseSummary
      .replace("{status}", String(response.status))
      .replace("{time}", String(response.elapsedMs))
      .replace("{size}", formatBytes(bytes.byteLength, 2)));
    responseUi.requestStatus.classList.add("visually-hidden");
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
