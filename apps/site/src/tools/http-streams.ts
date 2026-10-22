import { formatBytes } from "../lib/format.ts";
import {
  base64ToBytes, bytesToBase64, type LocalAgentHeader, type LocalHttpResponse, type LocalSseLine, type LocalWebSocketLine,
} from "../scripts/local-agent.ts";

/**
 * Live responses of the HTTP client: Server-Sent Events (`sse.stream`) and
 * WebSocket connections (`websocket.connect`). Both arrive from the agent line
 * by line and are logged in their own response tab, the last entries kept.
 */
export const SSE_CAPABILITY = "sse.stream";
export const WEBSOCKET_CAPABILITY = "websocket.connect";
/** Log entries kept per connection; older ones are dropped. */
export const MAX_STREAM_ENTRIES = 1000;
/** The agent's limit for one message either way. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface StreamStrings {
  Lang: string;
  EventsLive: string;
  EventsEnded: string;
  EventsStopped: string;
  StreamTruncated: string;
  SocketOpen: string;
  SocketClosed: string;
  SocketBy_server: string;
  SocketBy_client: string;
  SocketBy_agent: string;
  SocketFailed: string;
  MessageBinaryShown: string;
  MessageInvalidBase64: string;
  MessageTooLarge: string;
}

export const isWebSocketUrl = (url: string): boolean => /^wss?:\/\//iu.test(url.trim());

/**
 * `Sec-WebSocket-Protocol` written as a header becomes the offered subprotocols:
 * the agent writes the handshake headers itself and refuses them from the page.
 */
export function splitWebSocketProtocols(headers: readonly LocalAgentHeader[]): { headers: LocalAgentHeader[]; protocols: string[] } {
  const protocols: string[] = [];
  const rest: LocalAgentHeader[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() !== "sec-websocket-protocol") {
      rest.push(header);
      continue;
    }
    for (const protocol of header.value.split(",")) {
      const name = protocol.trim();
      if (name && !protocols.includes(name)) protocols.push(name);
    }
  }
  return { headers: rest, protocols };
}

/** The handshake as a response: 101 with its headers, or the server's HTTP refusal. */
export function handshakeResponse(
  line: Extract<LocalWebSocketLine, { type: "open" | "rejected" }>, url: string, elapsedMs: number,
): LocalHttpResponse {
  if (line.type === "rejected") {
    return { status: line.status, statusText: "", url, headers: line.headers, bodyBase64: line.bodyBase64, elapsedMs };
  }
  return {
    status: line.status, statusText: "Switching Protocols", url, headers: line.headers, bodyBase64: "", elapsedMs,
    httpVersion: "HTTP/1.1", remoteAddress: line.remoteAddress, tls: line.tls,
  };
}

/** What to send: text as is, binary from Base64; null with the reason when it cannot go. */
export function outgoingMessage(kind: "text" | "binary", input: string):
  { message: { text: string } | { binaryBase64: string }; bytes: number } | { error: "base64" | "size" } {
  if (kind === "text") {
    const bytes = new TextEncoder().encode(input).byteLength;
    return bytes > MAX_MESSAGE_BYTES ? { error: "size" } : { message: { text: input }, bytes };
  }
  const compact = input.replace(/\s+/gu, "");
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(compact)) return { error: "base64" };
  const bytes = base64ToBytes(compact);
  return bytes.byteLength > MAX_MESSAGE_BYTES ? { error: "size" } : { message: { binaryBase64: bytesToBase64(bytes) }, bytes: bytes.byteLength };
}

/** `Closed by the server: code 1000 — bye.` */
export function closeText(line: Extract<LocalWebSocketLine, { type: "close" }>, strings: StreamStrings): string {
  return strings.SocketClosed
    .replace("{by}", strings[`SocketBy_${line.initiator}`])
    .replace("{code}", String(line.code))
    .replace("{reason}", line.reason ? ` — ${line.reason}` : "");
}

type Direction = "in" | "out" | "system";

/** One log: entries with time and direction, capped, following the bottom while the reader is there. */
function streamLog(list: HTMLOListElement, count: HTMLElement, truncated: HTMLElement, strings: StreamStrings) {
  const clock = new Intl.DateTimeFormat(strings.Lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false });
  let total = 0;
  return {
    reset(): void {
      total = 0;
      list.replaceChildren();
      count.textContent = "";
      truncated.hidden = true;
    },
    add(direction: Direction, meta: string, data: string | null): void {
      const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      const item = document.createElement("li");
      item.className = `http-stream-item is-${direction}`;
      const head = document.createElement("span");
      head.className = "http-stream-meta mono";
      const arrow = direction === "in" ? "↓ " : direction === "out" ? "↑ " : "";
      head.textContent = `${clock.format(new Date())} ${arrow}${meta}`.trim();
      item.append(head);
      if (data !== null) {
        const body = document.createElement("pre");
        body.className = "http-stream-data mono";
        body.textContent = data;
        item.append(body);
      }
      list.append(item);
      if (direction !== "system") count.textContent = String(++total);
      while (list.childElementCount > MAX_STREAM_ENTRIES) {
        list.firstElementChild?.remove();
        truncated.hidden = false;
      }
      if (follow) list.scrollTop = list.scrollHeight;
    },
  };
}

export interface StreamTab {
  tab: HTMLButtonElement;
  count: HTMLElement;
  list: HTMLOListElement;
  state: HTMLElement;
  truncated: HTMLElement;
}

/** Events tab: an event stream's events while it is open, then how it ended. */
export function bindEventsView(ui: StreamTab, strings: StreamStrings) {
  const log = streamLog(ui.list, ui.count, ui.truncated, strings);
  let owner: LocalHttpResponse | null = null;
  let stopped = false;
  return {
    /** Starts a log for the stream of `response` and selects the tab. */
    start(response: LocalHttpResponse): void {
      owner = response;
      stopped = false;
      log.reset();
      ui.state.textContent = strings.EventsLive;
      ui.tab.hidden = false;
      ui.tab.click();
    },
    stopping(): void {
      stopped = true;
    },
    line(line: LocalSseLine, errorText: (code: string) => string): void {
      if (line.type === "event") {
        const meta = [line.event, line.id ? `id ${line.id}` : "", line.retry === undefined ? "" : `retry ${line.retry}`].filter(Boolean).join(" · ");
        log.add("in", meta, line.data);
      } else {
        ui.state.textContent = line.type === "end" ? (stopped ? strings.EventsStopped : strings.EventsEnded) : errorText(line.code);
      }
    },
    failed(text: string): void {
      ui.state.textContent = stopped ? strings.EventsStopped : text;
    },
    /** The tab belongs to one response; another one shown hides it. */
    show(response: LocalHttpResponse | null): void {
      ui.tab.hidden = response === null || response !== owner;
    },
  };
}

export interface SocketTab extends StreamTab {
  form: HTMLFormElement;
  message: HTMLTextAreaElement;
  kind: HTMLSelectElement;
  sendButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  error: HTMLElement;
}

export interface SocketActions {
  send(message: { text: string } | { binaryBase64: string }): Promise<void>;
  close(): Promise<void>;
  errorText(error: unknown): string;
}

/** Messages tab: a WebSocket's frames both ways, a composer while it is open and how it closed. */
export function bindSocketView(ui: SocketTab, strings: StreamStrings, actions: SocketActions) {
  const log = streamLog(ui.list, ui.count, ui.truncated, strings);
  let owner: LocalHttpResponse | null = null;
  let open = false;
  const setOpen = (value: boolean): void => {
    open = value;
    ui.sendButton.disabled = !value;
    ui.closeButton.disabled = !value;
    ui.message.disabled = !value;
    ui.kind.disabled = !value;
  };
  const showError = (text: string): void => {
    ui.error.textContent = text;
    ui.error.hidden = !text;
  };
  setOpen(false);

  ui.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!open) return;
    const kind = ui.kind.value === "binary" ? "binary" : "text";
    const outgoing = outgoingMessage(kind, ui.message.value);
    if ("error" in outgoing) {
      showError(outgoing.error === "base64" ? strings.MessageInvalidBase64 : strings.MessageTooLarge);
      ui.message.focus();
      return;
    }
    showError("");
    ui.sendButton.disabled = true;
    try {
      await actions.send(outgoing.message);
      log.add("out", kind === "text" ? "" : strings.MessageBinaryShown.replace("{size}", formatBytes(outgoing.bytes, 1)),
        "text" in outgoing.message ? outgoing.message.text : outgoing.message.binaryBase64);
    } catch (error) {
      showError(actions.errorText(error));
    } finally {
      ui.sendButton.disabled = !open;
    }
  });
  ui.message.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      ui.form.requestSubmit();
    }
  });
  ui.closeButton.addEventListener("click", async () => {
    ui.closeButton.disabled = true;
    try {
      await actions.close();
    } catch (error) {
      showError(actions.errorText(error));
      ui.closeButton.disabled = !open;
    }
  });

  return {
    /** The handshake succeeded: a new log for `response`, the composer on, the tab selected. */
    start(response: LocalHttpResponse, protocol: string | null): void {
      owner = response;
      log.reset();
      showError("");
      ui.state.textContent = protocol ? `${strings.SocketOpen} · ${protocol}` : strings.SocketOpen;
      setOpen(true);
      ui.tab.hidden = false;
      ui.tab.click();
      ui.message.focus();
    },
    line(line: LocalWebSocketLine, errorText: (code: string) => string): void {
      if (line.type === "message") {
        if (line.kind === "text") log.add("in", "", line.data);
        else log.add("in", strings.MessageBinaryShown.replace("{size}", formatBytes(base64ToBytes(line.dataBase64).byteLength, 1)), line.dataBase64);
      } else if (line.type === "close") {
        const text = closeText(line, strings);
        log.add("system", text, null);
        ui.state.textContent = text;
        setOpen(false);
      } else if (line.type === "error") {
        const text = strings.SocketFailed.replace("{error}", errorText(line.code));
        log.add("system", text, null);
        ui.state.textContent = text;
        setOpen(false);
      }
    },
    /** The line stream itself broke (the agent went away). */
    failed(text: string): void {
      if (!open) return;
      ui.state.textContent = strings.SocketFailed.replace("{error}", text);
      setOpen(false);
    },
    get open(): boolean {
      return open;
    },
    show(response: LocalHttpResponse | null): void {
      ui.tab.hidden = response === null || response !== owner;
    },
  };
}
