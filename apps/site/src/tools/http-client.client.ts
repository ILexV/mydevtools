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
import {
  canMoveHttpWorkspaceItem,
  loadHttpWorkspace,
  moveHttpWorkspaceItem,
  saveHttpWorkspace,
  type HttpSavedRequest,
  type HttpSavedFolder,
  type HttpSavedRow,
  type HttpWorkspace,
  type HttpWorkspaceItemKind,
} from "@/tools/http-workspace";

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
  SavedRequests: string;
  NewRequest: string;
  RequestName: string;
  UntitledRequest: string;
  RenameRequest: string;
  DeleteRequestConfirm: string;
  DeleteRequest: string;
  NewFolder: string;
  FolderName: string;
  RenameFolder: string;
  DeleteFolder: string;
  DeleteFolderConfirm: string;
  MoveItem: string;
  RootFolder: string;
  SelectFolder: string;
  ResizeSidebar: string;
  FolderNameRequired: string;
  WorkspacePrivacy: string;
  WorkspaceSaveError: string;
  WorkspaceLoadError: string;
  AgentConnectedShort: string;
  AgentDisconnectedShort: string;
  AgentSettings: string;
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

function createBlankRequest(folderId: string | null = null): HttpSavedRequest {
  return {
    id: requestId(),
    folderId,
    name: "",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: "",
    bodyFormat: "text",
    timeoutMs: 30000,
    followRedirects: false,
  };
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
  const agentSettings = root.querySelector<HTMLDetailsElement>("[data-http-agent-settings]");
  const requestName = root.querySelector<HTMLInputElement>("[data-http-request-name]");
  const savedList = root.querySelector<HTMLElement>("[data-http-saved-list]");
  const newRequest = root.querySelector<HTMLButtonElement>("[data-http-new]");
  const newFolder = root.querySelector<HTMLButtonElement>("[data-http-new-folder]");
  const treeMenuButton = root.querySelector<HTMLButtonElement>("[data-http-tree-menu-button]");
  const treeMenu = root.querySelector<HTMLElement>("[data-http-tree-menu]");
  const moveDialog = root.querySelector<HTMLDialogElement>("[data-http-move-dialog]");
  const moveDestination = root.querySelector<HTMLSelectElement>("[data-http-move-destination]");
  const moveConfirm = root.querySelector<HTMLButtonElement>("[data-http-move-confirm]");
  const sidebarResizer = root.querySelector<HTMLElement>("[data-http-sidebar-resizer]");
  const workspaceLoadError = root.querySelector<HTMLElement>("[data-http-workspace-load-error]");
  const workspaceSaveError = root.querySelector<HTMLElement>("[data-http-workspace-save-error]");
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
    || !connectionError || !connectionState || !agentSettings || !requestName || !savedList || !newRequest
    || !newFolder || !treeMenuButton || !treeMenu || !moveDialog || !moveDestination || !moveConfirm
    || !sidebarResizer || !workspaceLoadError || !workspaceSaveError || !method || !requestUrl
    || !rowTemplate || !requestBody || !timeout || !redirects || !send || !cancel || !requestStatus || !requestError
    || !output || !result || !responseStatus || !responseTime || !responseSize || !responseUrl || !responseHeaders
    || !responsePreview || !download || !responseMeta || !responseType || !editorHost || !editorError
    || !prettyButton || !rawButton) return;

  const client = new LocalAgentClient();
  let hasSavedAgentSession = false;
  try {
    hasSavedAgentSession = localStorage.getItem("mdt.local-agent.session.v1") !== null;
  } catch {
    // Blocked storage means there cannot be a restorable browser session.
  }
  agentSettings.open = !hasSavedAgentSession;
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
  const loadedWorkspace = loadHttpWorkspace();
  let workspace: HttpWorkspace = loadedWorkspace.workspace ?? {
    v: 1,
    selectedId: "",
    requests: [],
    folders: [],
    selectedFolderId: null,
    sidebarWidth: 240,
  };
  if (!workspace.requests.length) {
    const initial = createBlankRequest();
    workspace.selectedId = initial.id;
    workspace.requests.push(initial);
  }
  type TreeTarget = { kind: "root" } | { kind: HttpWorkspaceItemKind; id: string };
  type TreeAction = "new-request" | "new-folder" | "rename" | "move" | "delete";
  let workspaceDirty = false;
  let currentRequest = workspace.requests.find((request) => request.id === workspace.selectedId)!;
  let treeSelection: TreeTarget = { kind: "request", id: currentRequest.id };
  let menuTarget: TreeTarget | null = null;
  let menuReturnFocus: HTMLElement | null = null;
  let moveTarget: Exclude<TreeTarget, { kind: "root" }> | null = null;
  let moveReturnFocus: HTMLElement | null = null;
  let dragItem: Exclude<TreeTarget, { kind: "root" }> | null = null;
  let dragHoverTimer = 0;
  let dragHoverFolderId: string | null = null;
  let markedDropTarget: HTMLElement | null = null;
  let saveTimer = 0;
  const responseUi = {
    output,
    result,
    meta: responseMeta,
    type: responseType,
    prettyButton,
    rawButton,
    status: responseStatus,
    time: responseTime,
    size: responseSize,
    url: responseUrl,
    headers: responseHeaders,
    preview: responsePreview,
    editorHost,
    editorError,
    download,
    requestStatus,
    requestError,
  };
  const workspaceUi = {
    root,
    strings: s,
    requestName,
    method,
    requestUrl,
    requestBody,
    timeout,
    redirects,
    savedList,
    newRequest,
    newFolder,
    treeMenuButton,
    treeMenu,
    moveDialog,
    moveDestination,
    moveConfirm,
    sidebarResizer,
    loadError: workspaceLoadError,
    saveError: workspaceSaveError,
  };

  const bindTable = (kind: "params" | "headers", onChange?: () => void) => {
    const body = root.querySelector<HTMLTableSectionElement>(`[data-http-table="${kind}"] tbody`)!;
    const count = root.querySelector<HTMLElement>(`[data-http-${kind}-count]`)!;
    const add = root.querySelector<HTMLButtonElement>(`[data-http-add-row="${kind}"]`)!;
    const rows: {
      enabled: HTMLInputElement;
      key: HTMLInputElement;
      value: HTMLInputElement;
      element: HTMLTableRowElement;
      dirty: boolean;
    }[] = [];
    const read = (): LocalAgentHeader[] => {
      const entries: LocalAgentHeader[] = [];
      for (const row of rows) {
        if (row.enabled.checked && (row.key.value !== "" || row.value.value !== "")) {
          entries.push({ name: row.key.value, value: row.value.value });
        }
      }
      return entries;
    };
    const readAll = (): HttpSavedRow[] => {
      const entries: HttpSavedRow[] = [];
      for (const row of rows) {
        if (row.dirty || row.key.value !== "" || row.value.value !== "") {
          entries.push({ name: row.key.value, value: row.value.value, enabled: row.enabled.checked });
        }
      }
      return entries;
    };
    const updateCount = (): void => {
      let size = 0;
      for (const row of rows) {
        if (row.enabled.checked && (row.key.value !== "" || row.value.value !== "")) size++;
      }
      count.textContent = size ? String(size) : "";
    };
    const append = (entry?: HttpSavedRow) => {
      const element = rowTemplate.content.firstElementChild!.cloneNode(true) as HTMLTableRowElement;
      const row = {
        enabled: element.querySelector<HTMLInputElement>("[data-row-enabled]")!,
        key: element.querySelector<HTMLInputElement>("[data-row-key]")!,
        value: element.querySelector<HTMLInputElement>("[data-row-value]")!,
        element,
        dirty: entry !== undefined,
      };
      row.enabled.checked = entry?.enabled ?? true;
      row.key.value = entry?.name ?? "";
      row.value.value = entry?.value ?? "";
      rows.push(row);
      body.append(element);
      element.addEventListener("input", () => {
        row.dirty = true;
        if (rows.at(-1) === row && (row.key.value || row.value.value || !row.enabled.checked)) append();
        updateCount();
        onChange?.();
      });
      element.querySelector("[data-row-remove]")!.addEventListener("click", () => {
        const index = rows.indexOf(row);
        rows.splice(index, 1);
        element.remove();
        if (!rows.length || rows.at(-1)?.dirty) append();
        rows[Math.min(index, rows.length - 1)]!.key.focus();
        updateCount();
        onChange?.();
      });
      return row;
    };
    add.addEventListener("click", () => {
      const last = rows.at(-1);
      (last && !last.dirty && !last.key.value && !last.value.value ? last : append()).key.focus();
    });
    const replace = (entries: Iterable<HttpSavedRow>): void => {
      rows.length = 0;
      body.replaceChildren();
      for (const entry of entries) append(entry);
      append();
      updateCount();
    };
    append();
    return { read, readAll, replace };
  };
  const paramsTable = bindTable("params", () => {
    const url = requestUrl.value;
    const hashAt = url.indexOf("#");
    const fragment = hashAt < 0 ? "" : url.slice(hashAt);
    const base = (hashAt < 0 ? url : url.slice(0, hashAt)).split("?", 1)[0]!;
    const searchParams = new URLSearchParams();
    for (const { name, value } of paramsTable.read()) searchParams.append(name, value);
    const query = searchParams.toString();
    requestUrl.value = `${base}${query ? `?${query}` : ""}${fragment}`;
    updateSelectedListEntry();
    scheduleWorkspaceSave();
  });
  const headersTable = bindTable("headers", scheduleWorkspaceSave);
  requestUrl.addEventListener("input", () => {
    const beforeFragment = requestUrl.value.split("#", 1)[0]!;
    const queryAt = beforeFragment.indexOf("?");
    const parsed: HttpSavedRow[] = [];
    for (const [name, value] of new URLSearchParams(queryAt < 0 ? "" : beforeFragment.slice(queryAt + 1))) {
      parsed.push({ name, value, enabled: true });
    }
    const merged: HttpSavedRow[] = [];
    let parsedIndex = 0;
    for (const row of paramsTable.readAll()) {
      if (!row.enabled) merged.push(row);
      else if (parsedIndex < parsed.length) merged.push(parsed[parsedIndex++]!);
    }
    while (parsedIndex < parsed.length) merged.push(parsed[parsedIndex++]!);
    paramsTable.replace(merged);
    updateSelectedListEntry();
    scheduleWorkspaceSave();
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
      let hydrating = true;
      const editor = await kit.createEditor(mount, {
        language, label: strings.BodyLabel, hintId: "http-body-hint", phrases: strings.phrases,
        onSubmit: () => { if (!send.disabled) send.click(); },
        onChange: () => {
          requestBody.value = editor.getValue();
          bodyError.hidden = true;
          if (!hydrating) scheduleWorkspaceSave();
        },
      });
      if (revision !== bodyRevision) {
        editor.view.destroy();
        return;
      }
      editor.setValue(requestBody.value);
      hydrating = false;
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
  bodyFormat.addEventListener("change", () => {
    scheduleWorkspaceSave();
    void mountBodyEditor();
  });
  requestBody.addEventListener("input", () => {
    bodyError.hidden = true;
    scheduleWorkspaceSave();
  });
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
    scheduleWorkspaceSave();
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

  function captureCurrentRequest(): void {
    if (bodyEditor && !bodyHost.hidden) workspaceUi.requestBody.value = bodyEditor.getValue();
    const timeoutValue = Number(workspaceUi.timeout.value);
    currentRequest.name = workspaceUi.requestName.value;
    currentRequest.method = workspaceUi.method.value;
    currentRequest.url = workspaceUi.requestUrl.value;
    currentRequest.params = paramsTable.readAll();
    currentRequest.headers = headersTable.readAll();
    currentRequest.body = workspaceUi.requestBody.value;
    currentRequest.bodyFormat = bodyFormat.value as HttpSavedRequest["bodyFormat"];
    currentRequest.timeoutMs = Number.isFinite(timeoutValue) ? timeoutValue : 30000;
    currentRequest.followRedirects = workspaceUi.redirects.checked;
  }

  function saveWorkspaceNow(): boolean {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    if (!workspaceDirty) return true;
    captureCurrentRequest();
    if (!saveHttpWorkspace(workspace)) {
      showMessage(workspaceUi.saveError, workspaceUi.strings.WorkspaceSaveError);
      return false;
    }
    workspaceDirty = false;
    hideMessage(workspaceUi.saveError);
    hideMessage(workspaceUi.loadError);
    return true;
  }

  function scheduleWorkspaceSave(): void {
    workspaceDirty = true;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveWorkspaceNow, 250);
  }

  function updateSelectedListEntry(): void {
    let item: HTMLButtonElement | null = null;
    for (const candidate of workspaceUi.savedList.querySelectorAll<HTMLButtonElement>("[data-http-saved-id]")) {
      if (candidate.dataset.httpSavedId === currentRequest.id) {
        item = candidate;
        break;
      }
    }
    if (!item) return;
    item.title = workspaceUi.requestUrl.value;
    item.querySelector<HTMLElement>(".http-saved-method")!.textContent = workspaceUi.method.value;
    item.querySelector<HTMLElement>(".http-saved-name")!.textContent =
      workspaceUi.requestName.value.trim() || workspaceUi.strings.UntitledRequest;
  }

  function folderGroups(): Map<string | null, HttpSavedFolder[]> {
    const groups = new Map<string | null, HttpSavedFolder[]>();
    for (const folder of workspace.folders) {
      const siblings = groups.get(folder.parentId);
      if (siblings) siblings.push(folder);
      else groups.set(folder.parentId, [folder]);
    }
    return groups;
  }

  function expandFolderAncestors(folderId: string | null): boolean {
    let changed = false;
    let nextId = folderId;
    while (nextId !== null) {
      const folder = workspace.folders.find((candidate) => candidate.id === nextId);
      if (!folder) break;
      if (!folder.expanded) {
        folder.expanded = true;
        changed = true;
      }
      nextId = folder.parentId;
    }
    return changed;
  }

  function targetEquals(left: TreeTarget, right: TreeTarget): boolean {
    return left.kind === right.kind && (left.kind === "root" || (right.kind !== "root" && left.id === right.id));
  }

  function targetFromElement(element: Element | null): TreeTarget | null {
    const item = element?.closest<HTMLElement>("[data-http-item-kind][data-http-item-id]");
    if (item && workspaceUi.savedList.contains(item)) {
      const kind = item.dataset.httpItemKind;
      const id = item.dataset.httpItemId;
      if ((kind === "folder" || kind === "request") && id) return { kind, id };
    }
    const toggle = element?.closest<HTMLElement>("[data-http-folder-toggle]");
    const folderId = toggle?.dataset.httpFolderToggle;
    return toggle && workspaceUi.savedList.contains(toggle) && folderId
      ? { kind: "folder", id: folderId }
      : null;
  }

  function targetExists(target: TreeTarget): boolean {
    if (target.kind === "root") return true;
    return target.kind === "folder"
      ? workspace.folders.some((folder) => folder.id === target.id)
      : workspace.requests.some((request) => request.id === target.id);
  }

  function itemForTarget(target: TreeTarget): HTMLButtonElement | null {
    if (target.kind === "root") return null;
    for (const item of workspaceUi.savedList.querySelectorAll<HTMLButtonElement>("[data-http-item-kind]")) {
      if (item.dataset.httpItemKind === target.kind && item.dataset.httpItemId === target.id) return item;
    }
    return null;
  }

  function parentForTarget(target: TreeTarget): string | null {
    if (target.kind === "folder") return target.id;
    if (target.kind === "request") {
      return workspace.requests.find((request) => request.id === target.id)?.folderId ?? null;
    }
    return null;
  }

  function selectTreeItem(item: HTMLButtonElement): void {
    const target = targetFromElement(item);
    if (!target) return;
    treeSelection = target;
    for (const candidate of workspaceUi.savedList.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')) {
      const selected = candidate === item;
      candidate.tabIndex = selected ? 0 : -1;
      candidate.setAttribute("aria-selected", String(selected));
    }
    item.focus();
  }

  function createRequestTreeItem(request: HttpSavedRequest, level: number): HTMLLIElement {
    const row = document.createElement("li");
    row.setAttribute("role", "none");
    const item = document.createElement("button");
    const target: TreeTarget = { kind: "request", id: request.id };
    const selected = targetEquals(treeSelection, target);
    item.type = "button";
    item.className = "http-saved-item";
    item.dataset.httpItemKind = "request";
    item.dataset.httpItemId = request.id;
    item.dataset.httpSavedId = request.id;
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(level));
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    item.title = request.url;
    item.disabled = active !== null;
    item.draggable = active === null;
    if (dragItem && targetEquals(dragItem, target)) item.classList.add("is-dragging");
    const requestIcon = document.createElement("span");
    requestIcon.className = "http-request-icon";
    requestIcon.setAttribute("aria-hidden", "true");
    const methodLabel = document.createElement("span");
    methodLabel.className = "http-saved-method";
    methodLabel.textContent = request.method;
    const nameLabel = document.createElement("span");
    nameLabel.className = "http-saved-name";
    nameLabel.textContent = request.name.trim() || workspaceUi.strings.UntitledRequest;
    item.append(requestIcon, methodLabel, nameLabel);
    item.addEventListener("click", () => {
      if (active) return;
      const previousSelection = treeSelection;
      treeSelection = target;
      switchRequest(request.id);
      if (currentRequest.id !== request.id) {
        treeSelection = previousSelection;
        return;
      }
      workspace.selectedFolderId = null;
      renderSavedList(target);
      scheduleWorkspaceSave();
    });
    row.append(item);
    return row;
  }

  function setFolderExpanded(folder: HttpSavedFolder, expanded: boolean, focusTarget?: TreeTarget): void {
    if (active || folder.expanded === expanded || !saveWorkspaceNow()) return;
    const previous = folder.expanded;
    folder.expanded = expanded;
    workspaceDirty = true;
    renderSavedList(focusTarget);
    if (!saveWorkspaceNow()) {
      folder.expanded = previous;
      workspaceDirty = false;
      renderSavedList(focusTarget);
    }
  }
  function appendTreeChildren(
    parentId: string | null,
    container: HTMLUListElement,
    level: number,
    folderMap: ReadonlyMap<string | null, HttpSavedFolder[]>,
    requestsByFolder: ReadonlyMap<string | null, HttpSavedRequest[]>,
  ): void {
    const childFolders = folderMap.get(parentId);
    if (childFolders) {
      for (const folder of childFolders) {
        const folderTarget: TreeTarget = { kind: "folder", id: folder.id };
        const selected = targetEquals(treeSelection, folderTarget);
        const folderItem = document.createElement("li");
        folderItem.setAttribute("role", "none");
        const row = document.createElement("div");
        row.className = "http-tree-row";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "http-folder-toggle";
        toggle.dataset.httpFolderToggle = folder.id;
        toggle.setAttribute("aria-expanded", String(folder.expanded));
        toggle.setAttribute("aria-label", folder.name);
        toggle.tabIndex = -1;
        toggle.disabled = active !== null;
        toggle.addEventListener("click", () => {
          setFolderExpanded(folder, !folder.expanded, folderTarget);
        });
        const select = document.createElement("button");
        select.type = "button";
        select.className = "http-folder-select";
        select.dataset.httpItemKind = "folder";
        select.dataset.httpItemId = folder.id;
        select.dataset.httpFolderId = folder.id;
        select.setAttribute("role", "treeitem");
        select.setAttribute("aria-level", String(level));
        select.setAttribute("aria-expanded", String(folder.expanded));
        select.setAttribute("aria-selected", String(selected));
        select.setAttribute("aria-label", `${workspaceUi.strings.SelectFolder}: ${folder.name}`);
        select.tabIndex = selected ? 0 : -1;
        select.title = folder.name;
        select.disabled = active !== null;
        select.draggable = active === null;
        if (dragItem && targetEquals(dragItem, folderTarget)) select.classList.add("is-dragging");
        const folderIcon = document.createElement("span");
        folderIcon.className = "http-folder-icon";
        folderIcon.setAttribute("aria-hidden", "true");
        const name = document.createElement("span");
        name.className = "http-folder-name";
        name.textContent = folder.name;
        select.append(folderIcon, name);
        select.addEventListener("click", () => {
          if (active) return;
          treeSelection = folderTarget;
          workspace.selectedFolderId = folder.id;
          renderSavedList(folderTarget);
          scheduleWorkspaceSave();
        });
        row.append(toggle, select);
        folderItem.append(row);
        container.append(folderItem);
        if (folder.expanded) {
          const children = document.createElement("ul");
          children.className = "http-tree-group http-tree-children";
          children.setAttribute("role", "group");
          appendTreeChildren(folder.id, children, level + 1, folderMap, requestsByFolder);
          folderItem.append(children);
        }
      }
    }
    const childRequests = requestsByFolder.get(parentId);
    if (childRequests) {
      for (const request of childRequests) container.append(createRequestTreeItem(request, level));
    }
  }

  function expandFolderDuringDrag(folder: HttpSavedFolder): void {
    const target: TreeTarget = { kind: "folder", id: folder.id };
    const select = itemForTarget(target);
    const row = select?.parentElement;
    const folderItem = row?.parentElement;
    const toggle = row?.querySelector<HTMLButtonElement>("[data-http-folder-toggle]");
    if (active || folder.expanded || !select || !toggle || !(folderItem instanceof HTMLLIElement)
      || !saveWorkspaceNow()) return;
    const folderMap = folderGroups();
    const requestsByFolder = new Map<string | null, HttpSavedRequest[]>();
    for (const request of workspace.requests) {
      const siblings = requestsByFolder.get(request.folderId);
      if (siblings) siblings.push(request);
      else requestsByFolder.set(request.folderId, [request]);
    }
    const children = document.createElement("ul");
    children.className = "http-tree-group http-tree-children";
    children.setAttribute("role", "group");
    const level = Number(select.getAttribute("aria-level")) || 1;
    folder.expanded = true;
    toggle.setAttribute("aria-expanded", "true");
    select.setAttribute("aria-expanded", "true");
    appendTreeChildren(folder.id, children, level + 1, folderMap, requestsByFolder);
    folderItem.append(children);
    workspaceDirty = true;
    if (!saveWorkspaceNow()) {
      folder.expanded = false;
      toggle.setAttribute("aria-expanded", "false");
      select.setAttribute("aria-expanded", "false");
      children.remove();
      workspaceDirty = false;
    }
  }

  function renderSavedList(focusTarget?: TreeTarget): void {
    const focusedBefore = targetFromElement(document.activeElement);
    const restoreTarget = focusTarget ?? focusedBefore;
    const folderMap = folderGroups();
    const requestsByFolder = new Map<string | null, HttpSavedRequest[]>();
    for (const request of workspace.requests) {
      const siblings = requestsByFolder.get(request.folderId);
      if (siblings) siblings.push(request);
      else requestsByFolder.set(request.folderId, [request]);
    }
    if (!targetExists(treeSelection)) treeSelection = { kind: "request", id: currentRequest.id };
    const tree = document.createElement("ul");
    tree.className = "http-tree-group";
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", workspaceUi.strings.SavedRequests);
    appendTreeChildren(null, tree, 1, folderMap, requestsByFolder);
    workspaceUi.savedList.replaceChildren(tree);
    const tabStop = itemForTarget(treeSelection)
      ?? workspaceUi.savedList.querySelector<HTMLButtonElement>('[role="treeitem"]');
    if (tabStop && !workspaceUi.savedList.querySelector('[role="treeitem"][tabindex="0"]')) tabStop.tabIndex = 0;
    if (restoreTarget) (itemForTarget(restoreTarget) ?? tabStop ?? workspaceUi.savedList).focus();
  }

  function moveTreeItem(
    target: Exclude<TreeTarget, { kind: "root" }>,
    parentId: string | null,
    focusAfter = true,
  ): void {
    if (active || !saveWorkspaceNow() || !canMoveHttpWorkspaceItem(workspace, target.kind, target.id, parentId)) return;
    const source = target.kind === "folder"
      ? workspace.folders.find((folder) => folder.id === target.id)
      : workspace.requests.find((request) => request.id === target.id);
    if (!source) return;
    const previousParent = target.kind === "folder"
      ? (source as HttpSavedFolder).parentId
      : (source as HttpSavedRequest).folderId;
    const expandedBefore = new Map(workspace.folders.map((folder) => [folder.id, folder.expanded] as const));
    const previousSelection = treeSelection;
    const previousSelectedFolderId = workspace.selectedFolderId;
    if (!moveHttpWorkspaceItem(workspace, target.kind, target.id, parentId)) return;
    expandFolderAncestors(parentId);
    treeSelection = target;
    workspace.selectedFolderId = target.kind === "folder" ? target.id : null;
    workspaceDirty = true;
    renderSavedList(focusAfter ? target : undefined);
    if (!saveWorkspaceNow()) {
      if (target.kind === "folder") (source as HttpSavedFolder).parentId = previousParent;
      else (source as HttpSavedRequest).folderId = previousParent;
      for (const folder of workspace.folders) {
        const expanded = expandedBefore.get(folder.id);
        if (expanded !== undefined) folder.expanded = expanded;
      }
      treeSelection = previousSelection;
      workspace.selectedFolderId = previousSelectedFolderId;
      workspaceDirty = false;
      renderSavedList(focusAfter ? previousSelection : undefined);
    }
  }

  function clearDropMarker(): void {
    markedDropTarget?.classList.remove("is-drop-valid", "is-drop-invalid");
    markedDropTarget = null;
  }

  function clearDragHover(): void {
    window.clearTimeout(dragHoverTimer);
    dragHoverTimer = 0;
    dragHoverFolderId = null;
  }

  function finishDragging(): void {
    clearDragHover();
    clearDropMarker();
    dragItem = null;
    for (const item of workspaceUi.savedList.querySelectorAll(".is-dragging")) item.classList.remove("is-dragging");
  }

  workspaceUi.savedList.addEventListener("dragstart", (event) => {
    if (active || !(event.target instanceof Element)) {
      event.preventDefault();
      return;
    }
    const target = targetFromElement(event.target);
    if (!target || target.kind === "root") {
      event.preventDefault();
      return;
    }
    dragItem = target;
    event.dataTransfer?.setData("application/x-mdt-http-workspace-item", "internal");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    itemForTarget(target)?.classList.add("is-dragging");
  });
  workspaceUi.savedList.addEventListener("dragend", finishDragging);
  document.addEventListener("dragend", finishDragging);
  workspaceUi.savedList.addEventListener("dragover", (event) => {
    if (!dragItem || !(event.target instanceof Element)) return;
    event.preventDefault();
    const overTarget = targetFromElement(event.target);
    const acceptsDrop = overTarget?.kind !== "request";
    const parentId = overTarget?.kind === "folder" ? overTarget.id : null;
    const marker = overTarget ? itemForTarget(overTarget) : workspaceUi.savedList;
    const valid = acceptsDrop && canMoveHttpWorkspaceItem(workspace, dragItem.kind, dragItem.id, parentId);
    if (markedDropTarget !== marker) {
      clearDropMarker();
      markedDropTarget = marker;
    }
    marker?.classList.toggle("is-drop-valid", valid);
    marker?.classList.toggle("is-drop-invalid", !valid);
    if (event.dataTransfer) event.dataTransfer.dropEffect = valid ? "move" : "none";
    const hoverFolder = valid && overTarget?.kind === "folder"
      ? workspace.folders.find((folder) => folder.id === overTarget.id)
      : null;
    if (!hoverFolder || hoverFolder.expanded) {
      clearDragHover();
    } else if (dragHoverFolderId !== hoverFolder.id) {
      clearDragHover();
      dragHoverFolderId = hoverFolder.id;
      dragHoverTimer = window.setTimeout(() => {
        dragHoverTimer = 0;
        dragHoverFolderId = null;
        if (dragItem && !hoverFolder.expanded
          && canMoveHttpWorkspaceItem(workspace, dragItem.kind, dragItem.id, hoverFolder.id)) {
          expandFolderDuringDrag(hoverFolder);
        }
      }, 650);
    }
  });
  workspaceUi.savedList.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && workspaceUi.savedList.contains(event.relatedTarget)) return;
    clearDragHover();
    clearDropMarker();
  });
  workspaceUi.savedList.addEventListener("drop", (event) => {
    if (!dragItem || !(event.target instanceof Element)) return;
    event.preventDefault();
    const source = dragItem;
    const overTarget = targetFromElement(event.target);
    const acceptsDrop = overTarget?.kind !== "request";
    const parentId = overTarget?.kind === "folder" ? overTarget.id : null;
    const valid = acceptsDrop && canMoveHttpWorkspaceItem(workspace, source.kind, source.id, parentId);
    finishDragging();
    if (valid) moveTreeItem(source, parentId);
  });

  function closeTreeMenu(restoreFocus = true): void {
    if (workspaceUi.treeMenu.hidden) return;
    const target = menuTarget;
    const returnFocus = menuReturnFocus;
    workspaceUi.treeMenu.hidden = true;
    workspaceUi.treeMenuButton.setAttribute("aria-expanded", "false");
    menuTarget = null;
    menuReturnFocus = null;
    if (!restoreFocus) return;
    queueMicrotask(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else if (target) (itemForTarget(target) ?? workspaceUi.savedList).focus();
    });
  }

  function openTreeMenu(target: TreeTarget, clientX: number, clientY: number, returnFocus: HTMLElement): void {
    if (active || !targetExists(target)) return;
    closeTreeMenu(false);
    menuTarget = target;
    menuReturnFocus = returnFocus;
    const definitions: { action: TreeAction; label: string; danger?: boolean; separate?: boolean }[] =
      target.kind === "root"
        ? [
            { action: "new-request", label: workspaceUi.strings.NewRequest },
            { action: "new-folder", label: workspaceUi.strings.NewFolder },
          ]
        : target.kind === "folder"
          ? [
              { action: "new-request", label: workspaceUi.strings.NewRequest },
              { action: "new-folder", label: workspaceUi.strings.NewFolder },
              { action: "rename", label: workspaceUi.strings.RenameFolder, separate: true },
              { action: "move", label: workspaceUi.strings.MoveItem },
              { action: "delete", label: workspaceUi.strings.DeleteFolder, danger: true, separate: true },
            ]
          : [
              { action: "new-request", label: workspaceUi.strings.NewRequest },
              { action: "new-folder", label: workspaceUi.strings.NewFolder },
              { action: "rename", label: workspaceUi.strings.RenameRequest, separate: true },
              { action: "move", label: workspaceUi.strings.MoveItem },
              { action: "delete", label: workspaceUi.strings.DeleteRequest, danger: true, separate: true },
            ];
    const fragment = document.createDocumentFragment();
    let firstMenuItem = true;
    for (const definition of definitions) {
      if (definition.separate) {
        const separator = document.createElement("div");
        separator.className = "http-menu-separator";
        separator.setAttribute("role", "separator");
        fragment.append(separator);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = `http-menu-item${definition.danger ? " is-danger" : ""}`;
      button.setAttribute("role", "menuitem");
      button.textContent = definition.label;
      button.tabIndex = firstMenuItem ? 0 : -1;
      firstMenuItem = false;
      button.addEventListener("click", () => {
        const actionTarget = menuTarget;
        const actionReturnFocus = menuReturnFocus;
        closeTreeMenu(false);
        if (actionTarget) runTreeAction(definition.action, actionTarget, actionReturnFocus);
        queueMicrotask(() => {
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && focused.isConnected && !workspaceUi.treeMenu.contains(focused)) return;
          if (actionReturnFocus?.isConnected) actionReturnFocus.focus();
          else if (actionTarget) (itemForTarget(actionTarget) ?? workspaceUi.savedList).focus();
        });
      });
      fragment.append(button);
    }
    workspaceUi.treeMenu.replaceChildren(fragment);
    workspaceUi.treeMenu.style.left = "0";
    workspaceUi.treeMenu.style.top = "0";
    workspaceUi.treeMenu.hidden = false;
    workspaceUi.treeMenuButton.setAttribute("aria-expanded", "true");
    const bounds = workspaceUi.treeMenu.getBoundingClientRect();
    const margin = 8;
    workspaceUi.treeMenu.style.left = `${Math.max(margin, Math.min(clientX, window.innerWidth - bounds.width - margin))}px`;
    workspaceUi.treeMenu.style.top = `${Math.max(margin, Math.min(clientY, window.innerHeight - bounds.height - margin))}px`;
    workspaceUi.treeMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }

  workspaceUi.treeMenu.addEventListener("keydown", (event) => {
    const items = [...workspaceUi.treeMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const current = event.target instanceof HTMLButtonElement ? items.indexOf(event.target) : -1;
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1 + items.length) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      closeTreeMenu();
      return;
    } else if (event.key === "Tab") {
      closeTreeMenu(false);
      return;
    } else return;
    event.preventDefault();
    const nextItem = items[next];
    if (nextItem) {
      for (const item of items) item.tabIndex = item === nextItem ? 0 : -1;
      nextItem.focus();
    }
  });
  workspaceUi.savedList.addEventListener("click", (event) => {
    if (active || !(event.target instanceof Element) || event.target.closest("button")) return;
    treeSelection = { kind: "root" };
    for (const item of workspaceUi.savedList.querySelectorAll('[role="treeitem"][aria-selected="true"]')) {
      item.setAttribute("aria-selected", "false");
    }
    workspaceUi.savedList.focus();
  });
  workspaceUi.savedList.addEventListener("contextmenu", (event) => {
    if (!(event.target instanceof Element)) return;
    event.preventDefault();
    if (active) return;
    const target: TreeTarget = targetFromElement(event.target) ?? { kind: "root" };
    const returnFocus = target.kind === "root" ? workspaceUi.savedList : itemForTarget(target) ?? workspaceUi.savedList;
    openTreeMenu(target, event.clientX, event.clientY, returnFocus);
  });
  workspaceUi.savedList.addEventListener("keydown", (event) => {
    const item = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('[role="treeitem"]')
      : null;
    const target = targetFromElement(item);
    if (event.key === "ContextMenu" || event.key === "Apps" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = (item ?? workspaceUi.savedList).getBoundingClientRect();
      openTreeMenu(target ?? { kind: "root" }, rect.left + 20, rect.top + Math.min(rect.height, 28), item ?? workspaceUi.savedList);
      return;
    }
    if (!item || !target) return;
    const visibleItems = [...workspaceUi.savedList.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    const index = visibleItems.indexOf(item);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = visibleItems[index + 1] ?? visibleItems[0];
    else if (event.key === "ArrowUp") next = visibleItems[index - 1] ?? visibleItems.at(-1);
    else if (event.key === "Home") next = visibleItems[0];
    else if (event.key === "End") next = visibleItems.at(-1);
    else if (event.key === "ArrowRight" && target.kind === "folder") {
      const folder = workspace.folders.find((candidate) => candidate.id === target.id);
      if (folder && !folder.expanded) setFolderExpanded(folder, true, target);
      else {
        const level = Number(item.getAttribute("aria-level"));
        const candidate = visibleItems[index + 1];
        if (candidate && Number(candidate.getAttribute("aria-level")) > level) next = candidate;
      }
    } else if (event.key === "ArrowLeft") {
      if (target.kind === "folder") {
        const folder = workspace.folders.find((candidate) => candidate.id === target.id);
        if (folder?.expanded) setFolderExpanded(folder, false, target);
        else if (folder?.parentId) next = itemForTarget({ kind: "folder", id: folder.parentId }) ?? undefined;
      } else if (target.kind === "request") {
        const request = workspace.requests.find((candidate) => candidate.id === target.id);
        if (request?.folderId) next = itemForTarget({ kind: "folder", id: request.folderId }) ?? undefined;
      }
    } else return;
    event.preventDefault();
    if (next) selectTreeItem(next);
  });
  workspaceUi.treeMenuButton.addEventListener("click", () => {
    const target: TreeTarget = targetExists(treeSelection) ? treeSelection : { kind: "root" };
    const rect = workspaceUi.treeMenuButton.getBoundingClientRect();
    openTreeMenu(target, rect.right - 192, rect.bottom + 4, workspaceUi.treeMenuButton);
  });
  document.addEventListener("pointerdown", (event) => {
    if (workspaceUi.treeMenu.hidden || !(event.target instanceof Node)
      || workspaceUi.treeMenu.contains(event.target) || workspaceUi.treeMenuButton.contains(event.target)) return;
    closeTreeMenu();
  });
  window.addEventListener("resize", () => { closeTreeMenu(); });
  window.addEventListener("scroll", () => { closeTreeMenu(); }, true);

  function fillMoveDestinations(target: Exclude<TreeTarget, { kind: "root" }>): void {
    const options: HTMLOptionElement[] = [];
    const appendOption = (id: string | null, name: string): void => {
      if (!canMoveHttpWorkspaceItem(workspace, target.kind, target.id, id)) return;
      const option = document.createElement("option");
      option.value = id ?? "";
      option.textContent = name;
      options.push(option);
    };
    appendOption(null, workspaceUi.strings.RootFolder);
    const groups = folderGroups();
    const appendFolders = (parentId: string | null, depth: number): void => {
      for (const folder of groups.get(parentId) ?? []) {
        appendOption(folder.id, `${"\u00a0\u00a0".repeat(depth)}${folder.name}`);
        appendFolders(folder.id, depth + 1);
      }
    };
    appendFolders(null, 1);
    workspaceUi.moveDestination.replaceChildren(...options);
    workspaceUi.moveConfirm.disabled = options.length === 0;
  }

  function openMoveDialog(target: Exclude<TreeTarget, { kind: "root" }>, returnFocus: HTMLElement | null): void {
    if (active || !targetExists(target)) return;
    moveTarget = target;
    moveReturnFocus = returnFocus;
    fillMoveDestinations(target);
    workspaceUi.moveDialog.showModal();
    workspaceUi.moveDestination.focus();
  }

  workspaceUi.moveConfirm.addEventListener("click", () => {
    if (!moveTarget || workspaceUi.moveConfirm.disabled) return;
    const target = moveTarget;
    const parentId = workspaceUi.moveDestination.value || null;
    moveTreeItem(target, parentId);
    workspaceUi.moveDialog.close();
  });
  workspaceUi.moveDialog.addEventListener("close", () => {
    const target = moveTarget;
    const returnFocus = moveReturnFocus;
    moveTarget = null;
    moveReturnFocus = null;
    queueMicrotask(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else if (target) (itemForTarget(target) ?? workspaceUi.savedList).focus();
    });
  });

  function clearResponse(): void {
    previewRevision++;
    responseUi.status.textContent = "";
    responseUi.status.classList.remove("is-error");
    responseUi.time.textContent = "";
    responseUi.size.textContent = "";
    responseEditor?.view.destroy();
    responseEditor = null;
    editorLanguage = null;
    responseUi.editorHost.replaceChildren();
    responseUi.editorHost.hidden = true;
    responseBlob = null;
    responseName = "response.bin";
    rawPreview = "";
    prettyPreview = null;
    htmlSource = null;
    responseUi.preview.textContent = "";
    responseUi.headers.textContent = "";
    responseUi.url.textContent = "";
    responseUi.type.textContent = "";
    responseUi.meta.hidden = true;
    responseUi.result.hidden = true;
    responseUi.download.disabled = true;
    htmlFrame.removeAttribute("srcdoc");
    htmlPreview.hidden = true;
    htmlButton.hidden = true;
    responseUi.prettyButton.disabled = true;
    responseUi.prettyButton.setAttribute("aria-pressed", "true");
    responseUi.rawButton.setAttribute("aria-pressed", "false");
    htmlButton.setAttribute("aria-pressed", "false");
    hideMessage(responseUi.editorError);
    hideMessage(responseUi.requestStatus);
    hideMessage(responseUi.requestError);
    syncEmptyState(responseUi.output, true);
  }

  function applyRequest(request: HttpSavedRequest): void {
    if (expandFolderAncestors(request.folderId)) workspaceDirty = true;
    bodyRevision++;
    bodyEditor?.view.destroy();
    bodyEditor = null;
    mountedBodyLanguage = null;
    bodyHost.replaceChildren();
    bodyHost.hidden = true;
    workspaceUi.requestBody.hidden = false;
    workspaceUi.requestName.value = request.name;
    workspaceUi.method.value = request.method;
    workspaceUi.requestUrl.value = request.url;
    paramsTable.replace(request.params);
    headersTable.replace(request.headers);
    workspaceUi.requestBody.value = request.body;
    bodyFormat.value = request.bodyFormat;
    workspaceUi.timeout.value = String(request.timeoutMs);
    workspaceUi.redirects.checked = request.followRedirects;
    formatJson.disabled = request.bodyFormat !== "json";
    hideMessage(bodyError);
    hideMessage(bodyEditorError);
    clearResponse();
    renderSavedList();
    const bodyPanel = workspaceUi.root.querySelector<HTMLElement>("#http-request-body-panel");
    if (bodyPanel && !bodyPanel.hidden) void mountBodyEditor();
  }

  function switchRequest(id: string): void {
    if (active || id === currentRequest.id || !saveWorkspaceNow()) return;
    const next = workspace.requests.find((request) => request.id === id);
    if (!next) return;
    const previousId = workspace.selectedId;
    workspace.selectedId = next.id;
    workspaceDirty = true;
    if (!saveWorkspaceNow()) {
      workspace.selectedId = previousId;
      workspaceDirty = false;
      return;
    }
    currentRequest = next;
    applyRequest(next);
  }

  const sidebarMedia = window.matchMedia("(max-width: 64rem)");
  let resizePointer: number | null = null;
  let resizePreviewWidth = workspace.sidebarWidth;

  function clampSidebarWidth(value: number): number {
    return Math.max(192, Math.min(480, Math.round(value)));
  }

  function applySidebarWidth(value: number): void {
    resizePreviewWidth = clampSidebarWidth(value);
    workspaceUi.root.style.setProperty("--http-sidebar-width", `${resizePreviewWidth}px`);
    workspaceUi.sidebarResizer.setAttribute("aria-valuenow", String(resizePreviewWidth));
  }

  function commitSidebarWidth(value: number): void {
    const nextWidth = clampSidebarWidth(value);
    applySidebarWidth(nextWidth);
    if (workspace.sidebarWidth === nextWidth) return;
    workspace.sidebarWidth = nextWidth;
    workspaceDirty = true;
    saveWorkspaceNow();
  }

  function syncSidebarMode(): void {
    const stacked = sidebarMedia.matches;
    workspaceUi.sidebarResizer.tabIndex = stacked ? -1 : 0;
    workspaceUi.sidebarResizer.setAttribute("aria-disabled", String(stacked));
    if (stacked && resizePointer !== null) {
      const pointerId = resizePointer;
      resizePointer = null;
      if (workspaceUi.sidebarResizer.hasPointerCapture(pointerId)) {
        workspaceUi.sidebarResizer.releasePointerCapture(pointerId);
      }
      workspaceUi.sidebarResizer.classList.remove("is-dragging");
    }
  }

  function sidebarWidthAt(clientX: number): number {
    return clampSidebarWidth(clientX - workspaceUi.root.getBoundingClientRect().left);
  }

  function finishSidebarResize(pointerId: number): void {
    if (resizePointer !== pointerId) return;
    resizePointer = null;
    if (workspaceUi.sidebarResizer.hasPointerCapture(pointerId)) {
      workspaceUi.sidebarResizer.releasePointerCapture(pointerId);
    }
    workspaceUi.sidebarResizer.classList.remove("is-dragging");
    commitSidebarWidth(resizePreviewWidth);
  }

  applySidebarWidth(workspace.sidebarWidth);
  syncSidebarMode();
  sidebarMedia.addEventListener("change", syncSidebarMode);
  workspaceUi.sidebarResizer.addEventListener("pointerdown", (event) => {
    if (sidebarMedia.matches || event.button !== 0) return;
    resizePointer = event.pointerId;
    workspaceUi.sidebarResizer.setPointerCapture(event.pointerId);
    workspaceUi.sidebarResizer.classList.add("is-dragging");
    applySidebarWidth(sidebarWidthAt(event.clientX));
    event.preventDefault();
  });
  workspaceUi.sidebarResizer.addEventListener("pointermove", (event) => {
    if (resizePointer !== event.pointerId) return;
    applySidebarWidth(sidebarWidthAt(event.clientX));
  });
  workspaceUi.sidebarResizer.addEventListener("pointerup", (event) => {
    finishSidebarResize(event.pointerId);
  });
  workspaceUi.sidebarResizer.addEventListener("pointercancel", (event) => {
    finishSidebarResize(event.pointerId);
  });
  workspaceUi.sidebarResizer.addEventListener("lostpointercapture", (event) => {
    finishSidebarResize(event.pointerId);
  });
  workspaceUi.sidebarResizer.addEventListener("keydown", (event) => {
    if (sidebarMedia.matches) return;
    let nextWidth = workspace.sidebarWidth;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextWidth -= 16;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") nextWidth += 16;
    else if (event.key === "Home") nextWidth = 192;
    else if (event.key === "End") nextWidth = 480;
    else return;
    event.preventDefault();
    commitSidebarWidth(nextWidth);
  });

  requestName.addEventListener("input", () => {
    updateSelectedListEntry();
    scheduleWorkspaceSave();
  });
  method.addEventListener("change", () => {
    updateSelectedListEntry();
    scheduleWorkspaceSave();
  });
  timeout.addEventListener("input", scheduleWorkspaceSave);
  redirects.addEventListener("change", scheduleWorkspaceSave);
  function createRequestAt(parentId: string | null): void {
    if (active || (parentId !== null && !workspace.folders.some((folder) => folder.id === parentId))
      || !saveWorkspaceNow()) return;
    const previousSelectedId = workspace.selectedId;
    const previousSelectedFolderId = workspace.selectedFolderId;
    const expandedBefore = new Map(workspace.folders.map((folder) => [folder.id, folder.expanded] as const));
    const request = createBlankRequest(parentId);
    workspace.requests.push(request);
    workspace.selectedId = request.id;
    workspace.selectedFolderId = null;
    expandFolderAncestors(parentId);
    workspaceDirty = true;
    if (!saveWorkspaceNow()) {
      workspace.requests.pop();
      workspace.selectedId = previousSelectedId;
      workspace.selectedFolderId = previousSelectedFolderId;
      for (const folder of workspace.folders) {
        const expanded = expandedBefore.get(folder.id);
        if (expanded !== undefined) folder.expanded = expanded;
      }
      workspaceDirty = false;
      return;
    }
    currentRequest = request;
    treeSelection = { kind: "request", id: request.id };
    applyRequest(request);
    workspaceUi.requestName.select();
  }

  function createFolderAt(parentId: string | null): void {
    if (active || (parentId !== null && !workspace.folders.some((folder) => folder.id === parentId))
      || !saveWorkspaceNow()) return;
    const proposed = window.prompt(workspaceUi.strings.FolderName);
    if (proposed === null) return;
    const name = proposed.trim();
    if (!name) {
      window.alert(workspaceUi.strings.FolderNameRequired);
      return;
    }
    const previousSelectedFolderId = workspace.selectedFolderId;
    const parent = parentId === null ? null : workspace.folders.find((folder) => folder.id === parentId) ?? null;
    const parentWasExpanded = parent?.expanded;
    if (parent) parent.expanded = true;
    const folder: HttpSavedFolder = {
      id: requestId(),
      name,
      parentId,
      expanded: true,
    };
    workspace.folders.push(folder);
    workspace.selectedFolderId = folder.id;
    workspaceDirty = true;
    if (!saveWorkspaceNow()) {
      workspace.folders.pop();
      if (parent && parentWasExpanded !== undefined) parent.expanded = parentWasExpanded;
      workspace.selectedFolderId = previousSelectedFolderId;
      workspaceDirty = false;
      return;
    }
    treeSelection = { kind: "folder", id: folder.id };
    renderSavedList(treeSelection);
  }

  function renameTreeItem(target: Exclude<TreeTarget, { kind: "root" }>): void {
    if (active || !saveWorkspaceNow()) return;
    if (target.kind === "folder") {
      const folder = workspace.folders.find((candidate) => candidate.id === target.id);
      if (!folder) return;
      const proposed = window.prompt(workspaceUi.strings.FolderName, folder.name);
      if (proposed === null) return;
      const name = proposed.trim();
      if (!name) {
        window.alert(workspaceUi.strings.FolderNameRequired);
        return;
      }
      const previous = folder.name;
      folder.name = name;
      workspaceDirty = true;
      if (!saveWorkspaceNow()) {
        folder.name = previous;
        workspaceDirty = false;
        return;
      }
      renderSavedList(target);
      return;
    }
    const request = workspace.requests.find((candidate) => candidate.id === target.id);
    if (!request) return;
    const proposed = window.prompt(workspaceUi.strings.RequestName, request.name);
    if (proposed === null) return;
    const previous = request.name;
    const name = proposed.trim();
    if (request === currentRequest) workspaceUi.requestName.value = name;
    else request.name = name;
    workspaceDirty = true;
    if (!saveWorkspaceNow()) {
      request.name = previous;
      if (request === currentRequest) workspaceUi.requestName.value = previous;
      workspaceDirty = false;
      return;
    }
    renderSavedList(target);
  }

  function deleteFolderById(id: string): void {
    if (active || !saveWorkspaceNow()) return;
    const index = workspace.folders.findIndex((folder) => folder.id === id);
    if (index < 0) return;
    const deleted = workspace.folders[index]!;
    if (!window.confirm(workspaceUi.strings.DeleteFolderConfirm.replace("{name}", deleted.name))) return;
    const previousFolderId = workspace.selectedFolderId;
    const previousSelection = treeSelection;
    const deletedWasSelection = targetEquals(previousSelection, { kind: "folder", id });
    const previousFolderParents = new Map(workspace.folders.map((folder) => [folder.id, folder.parentId] as const));
    const previousFolderExpanded = new Map(workspace.folders.map((folder) => [folder.id, folder.expanded] as const));
    const previousRequestFolders = new Map(workspace.requests.map((request) => [request.id, request.folderId] as const));
    for (const folder of workspace.folders) {
      if (folder.parentId === deleted.id) folder.parentId = deleted.parentId;
    }
    for (const request of workspace.requests) {
      if (request.folderId === deleted.id) request.folderId = deleted.parentId;
    }
    workspace.folders.splice(index, 1);
    expandFolderAncestors(currentRequest.folderId);
    workspace.selectedFolderId = previousFolderId === deleted.id ? deleted.parentId : previousFolderId;
    workspaceDirty = true;
    if (!saveWorkspaceNow()) {
      workspace.folders.splice(index, 0, deleted);
      for (const folder of workspace.folders) {
        folder.parentId = previousFolderParents.get(folder.id) ?? null;
        folder.expanded = previousFolderExpanded.get(folder.id) ?? folder.expanded;
      }
      for (const request of workspace.requests) request.folderId = previousRequestFolders.get(request.id) ?? null;
      workspace.selectedFolderId = previousFolderId;
      treeSelection = previousSelection;
      workspaceDirty = false;
      return;
    }
    treeSelection = deletedWasSelection
      ? deleted.parentId && workspace.folders.some((folder) => folder.id === deleted.parentId)
        ? { kind: "folder", id: deleted.parentId }
        : { kind: "request", id: currentRequest.id }
      : previousSelection;
    renderSavedList(treeSelection);
  }

  function deleteRequestById(id: string): void {
    if (active || !saveWorkspaceNow()) return;
    const index = workspace.requests.findIndex((request) => request.id === id);
    if (index < 0) return;
    const deleted = workspace.requests[index]!;
    const label = deleted.name.trim() || workspaceUi.strings.UntitledRequest;
    if (!window.confirm(workspaceUi.strings.DeleteRequestConfirm.replace("{name}", label))) return;
    const requestsBefore = [...workspace.requests];
    const previousSelectedId = workspace.selectedId;
    const previousSelectedFolderId = workspace.selectedFolderId;
    const previousCurrentRequest = currentRequest;
    const previousSelection = treeSelection;
    const deletedWasSelection = targetEquals(previousSelection, { kind: "request", id });
    workspace.requests.splice(index, 1);
    if (!workspace.requests.length) workspace.requests.push(createBlankRequest(deleted.folderId));
    const deletedCurrent = deleted === currentRequest;
    const nextRequest = deletedCurrent
      ? workspace.requests[Math.min(index, workspace.requests.length - 1)]!
      : currentRequest;
    workspace.selectedId = nextRequest.id;
    workspace.selectedFolderId = deletedWasSelection ? null : previousSelectedFolderId;
    workspaceDirty = true;
    if (!saveWorkspaceNow()) {
      workspace.requests = requestsBefore;
      workspace.selectedId = previousSelectedId;
      workspace.selectedFolderId = previousSelectedFolderId;
      currentRequest = previousCurrentRequest;
      treeSelection = previousSelection;
      workspaceDirty = false;
      return;
    }
    treeSelection = deletedWasSelection ? { kind: "request", id: nextRequest.id } : previousSelection;
    if (deletedCurrent) {
      currentRequest = nextRequest;
      applyRequest(nextRequest);
    } else {
      renderSavedList(treeSelection);
    }
  }

  function runTreeAction(action: TreeAction, target: TreeTarget, returnFocus: HTMLElement | null): void {
    if (active || !targetExists(target)) return;
    if (action === "new-request") {
      createRequestAt(parentForTarget(target));
      return;
    }
    if (action === "new-folder") {
      createFolderAt(parentForTarget(target));
      return;
    }
    if (target.kind === "root") return;
    if (action === "rename") renameTreeItem(target);
    else if (action === "move") openMoveDialog(target, returnFocus);
    else if (target.kind === "folder") deleteFolderById(target.id);
    else deleteRequestById(target.id);
  }

  workspaceUi.newRequest.addEventListener("click", () => {
    createRequestAt(parentForTarget(targetExists(treeSelection) ? treeSelection : { kind: "root" }));
  });
  workspaceUi.newFolder.addEventListener("click", () => {
    createFolderAt(parentForTarget(targetExists(treeSelection) ? treeSelection : { kind: "root" }));
  });
  window.addEventListener("pagehide", saveWorkspaceNow);
  window.addEventListener("storage", (event) => {
    if (event.key !== "mdt.http-workspace.v1" || workspaceDirty || active) return;
    const incoming = loadHttpWorkspace();
    if (incoming.error) {
      showMessage(workspaceLoadError, strings.WorkspaceLoadError);
      return;
    }
    workspace = incoming.workspace ?? {
      v: 1,
      selectedId: "",
      requests: [],
      folders: [],
      selectedFolderId: null,
      sidebarWidth: 240,
    };
    if (!workspace.requests.length) {
      const initial = createBlankRequest();
      workspace.selectedId = initial.id;
      workspace.requests.push(initial);
    }
    closeTreeMenu(false);
    if (workspaceUi.moveDialog.open) workspaceUi.moveDialog.close();
    finishDragging();
    currentRequest = workspace.requests.find((request) => request.id === workspace.selectedId)!;
    treeSelection = { kind: "request", id: currentRequest.id };
    applySidebarWidth(workspace.sidebarWidth);
    hideMessage(workspaceLoadError);
    applyRequest(currentRequest);
    if (workspaceDirty) saveWorkspaceNow();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveWorkspaceNow();
  });
  if (loadedWorkspace.error) showMessage(workspaceLoadError, strings.WorkspaceLoadError);
  else hideMessage(workspaceLoadError);
  hideMessage(workspaceSaveError);
  applyRequest(currentRequest);
  if (workspaceDirty) saveWorkspaceNow();
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
    connectionState.textContent = connected ? strings.AgentConnectedShort : strings.AgentDisconnectedShort;
    agentSettings.classList.toggle("is-connected", connected);
    agentSettings.open = connected ? false : !hasSavedAgentSession;
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
    workspaceUi.newRequest.disabled = sending;
    workspaceUi.newFolder.disabled = sending;
    workspaceUi.treeMenuButton.disabled = sending;
    workspaceUi.moveDestination.disabled = sending;
    workspaceUi.moveConfirm.disabled = sending;
    if (sending) {
      closeTreeMenu(false);
      if (workspaceUi.moveDialog.open) workspaceUi.moveDialog.close();
      finishDragging();
    }
    for (const item of workspaceUi.savedList.querySelectorAll<HTMLButtonElement>(
      "[data-http-item-kind], [data-http-folder-toggle]",
    )) {
      item.disabled = sending;
      item.draggable = !sending && item.hasAttribute("data-http-item-kind");
    }
  };

  const connectAgent = async (automatic = false): Promise<void> => {
    hideMessage(connectionError);
    showMessage(connectionStatus, strings.Connecting);
    connectionState.textContent = strings.Connecting;
    connect.disabled = true;
    const pairingCode = automatic ? "" : code.value.trim();
    if (!automatic) hasSavedAgentSession = false;
    try {
      const info = pairingCode
        ? await client.pair(pairingCode, ["http.request"])
        : await client.restore();
      if (!info) hasSavedAgentSession = false;
      if (!info) {
        setConnected(false);
        hideMessage(connectionStatus);
        if (!automatic) showMessage(connectionError, strings.Error_unauthorized);
        return;
      }
      agentVersion.textContent = info.version;
      lanPolicy.textContent = info.privateNetworkAllowed ? strings.PrivateAllowed : strings.PrivateBlocked;
      hasSavedAgentSession = client.persisted;
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
    hasSavedAgentSession = false;
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
    if (!saveWorkspaceNow()) return;
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
        if (!client.connected) {
          hasSavedAgentSession = false;
          setConnected(false);
        }
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
