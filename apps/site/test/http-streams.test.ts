import { test } from "node:test";
import assert from "node:assert/strict";
import { readNdjson, LocalAgentError } from "../src/scripts/local-agent.ts";
import {
  closeText, handshakeResponse, isWebSocketUrl, MAX_MESSAGE_BYTES, outgoingMessage, splitWebSocketProtocols, type StreamStrings,
} from "../src/tools/http-streams.ts";
import { certificateFor } from "../src/tools/http-transport-options.ts";

const strings = {
  SocketClosed: "Closed {by}: code {code}{reason}.", SocketBy_server: "by the server", SocketBy_client: "by you", SocketBy_agent: "by the agent",
} as StreamStrings;

const chunked = (...parts: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
};

test("ndjson: lines split across chunks, blank lines skipped, a broken line is invalid_response", async () => {
  const lines: unknown[] = [];
  await readNdjson(chunked("{\"type\":\"event\",\"da", "ta\":\"é\"}\n\n{\"type\":\"end\"}", "\n"), (line) => lines.push(line));
  assert.deepEqual(lines, [{ type: "event", data: "é" }, { type: "end" }]);
  // A multi-byte character split between chunks stays whole.
  const bytes = new TextEncoder().encode("{\"type\":\"message\",\"data\":\"ж\"}\n");
  const split = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 27));
      controller.enqueue(bytes.subarray(27));
      controller.close();
    },
  });
  const messages: unknown[] = [];
  await readNdjson(split, (line) => messages.push(line));
  assert.deepEqual(messages, [{ type: "message", data: "ж" }]);
  await assert.rejects(readNdjson(chunked("{oops}\n"), () => undefined), (error) => error instanceof LocalAgentError && error.code === "invalid_response");
});

test("websocket: URL scheme, subprotocols from the header and the handshake as a response", () => {
  assert.equal(isWebSocketUrl(" WSS://a.example/x"), true);
  assert.equal(isWebSocketUrl("https://a.example/x"), false);
  assert.deepEqual(splitWebSocketProtocols([
    { name: "X-Token", value: "1" },
    { name: "sec-websocket-protocol", value: "chat.v2, chat.v1 ,," },
    { name: "Sec-WebSocket-Protocol", value: "chat.v1" },
  ]), { headers: [{ name: "X-Token", value: "1" }], protocols: ["chat.v2", "chat.v1"] });

  const open = handshakeResponse({
    type: "open", status: 101, headers: [{ name: "upgrade", value: "websocket" }], protocol: "chat.v1", remoteAddress: "127.0.0.1:80", tls: null,
  }, "ws://a.example/", 12);
  assert.equal(open.status, 101);
  assert.equal(open.bodyBase64, "");
  assert.equal(open.remoteAddress, "127.0.0.1:80");
  const rejected = handshakeResponse({ type: "rejected", status: 401, headers: [], bodyBase64: "bm8=" }, "ws://a.example/", 5);
  assert.deepEqual([rejected.status, rejected.bodyBase64, rejected.elapsedMs], [401, "bm8=", 5]);
  assert.equal(certificateFor("wss://api.example.com/", [{ name: "c", hosts: ["api.example.com"] }]), "c");
});

test("websocket: outgoing text and Base64 binary within the agent limit", () => {
  assert.deepEqual(outgoingMessage("text", "ping"), { message: { text: "ping" }, bytes: 4 });
  assert.deepEqual(outgoingMessage("binary", "AA EC\n"), { message: { binaryBase64: "AAEC" }, bytes: 3 });
  assert.deepEqual(outgoingMessage("binary", ""), { message: { binaryBase64: "" }, bytes: 0 });
  assert.deepEqual(outgoingMessage("binary", "not base64!"), { error: "base64" });
  assert.deepEqual(outgoingMessage("binary", "AAE"), { error: "base64" });
  assert.deepEqual(outgoingMessage("text", "x".repeat(MAX_MESSAGE_BYTES + 1)), { error: "size" });
});

test("websocket: close lines read as who closed, the code and the reason", () => {
  assert.equal(closeText({ type: "close", code: 1000, reason: "bye", initiator: "server" }, strings), "Closed by the server: code 1000 — bye.");
  assert.equal(closeText({ type: "close", code: 1001, reason: "", initiator: "agent" }, strings), "Closed by the agent: code 1001.");
});
