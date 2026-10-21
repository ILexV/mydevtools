import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LocalAgentClient,
  LocalAgentError,
  mergeCapabilities,
  type LocalAgentInfo,
} from "../src/scripts/local-agent.ts";

const SESSION_KEY = "mdt.local-agent.session.v1";
const TOKEN = "A".repeat(43);
const PAIRING_CODE = "0123456789abcdef0123456789abcdef";
const INFO: LocalAgentInfo = {
  protocolVersion: 1,
  version: "1.0.0",
  capabilities: ["http.request"],
  privateNetworkAllowed: false,
  limits: {
    maxRequestBodyBytes: 1024,
    maxResponseBodyBytes: 4096,
    maxTimeoutMs: 120_000,
  },
};

function createStorage(initial: Record<string, string> = {}): { storage: Storage; values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Storage;
  return { storage, values };
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function futureExpiry(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

test("LocalAgentClient persistent session lifecycle", async (t) => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalFetch = globalThis.fetch;

  try {
    await t.test("restores a paired token in a new client without persisting the pairing code", async () => {
      const { storage, values } = createStorage();
      installStorage(storage);
      const expiresAt = futureExpiry();
      const authorizations: string[] = [];
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/info") return jsonResponse(INFO);
        if (path === "/v1/pair") {
          assert.deepEqual(JSON.parse(String(init?.body)), {
            code: PAIRING_CODE,
            capabilities: ["http.request"],
          });
          return jsonResponse({ token: TOKEN, capabilities: ["http.request"], expiresAt });
        }
        if (path === "/v1/http/cancel") {
          authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${path}`);
      };

      const paired = new LocalAgentClient();
      await paired.pair(PAIRING_CODE, ["http.request"]);
      assert.equal(paired.persisted, true);
      assert.equal(paired.storageState, "available");
      assert.equal(values.get(SESSION_KEY)?.includes(PAIRING_CODE), false);

      const reopened = new LocalAgentClient();
      assert.deepEqual(await reopened.restore(), INFO);
      assert.equal(reopened.connected, true);
      assert.equal(reopened.persisted, true);
      assert.equal(reopened.expiresAt, expiresAt);
      await reopened.cancel("80a6dd3a-0825-4a96-8bf1-ddb8e657f96d");
      assert.deepEqual(authorizations, [`Bearer ${TOKEN}`]);
    });

    await t.test("drops an expired saved token without contacting the agent", async () => {
      const expired = JSON.stringify({ v: 1, token: TOKEN, expiresAt: "2000-01-01T00:00:00.000Z" });
      const { storage, values } = createStorage({ [SESSION_KEY]: expired });
      installStorage(storage);
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        return jsonResponse(INFO);
      };

      const client = new LocalAgentClient();
      assert.equal(await client.restore(), null);
      assert.equal(fetched, false);
      assert.equal(values.has(SESSION_KEY), false);
      assert.equal(client.connected, false);
      assert.equal(client.persisted, false);
    });

    await t.test("disconnect removes persistence even when the agent is unavailable", async () => {
      const { storage, values } = createStorage();
      installStorage(storage);
      const expiresAt = futureExpiry();
      let disconnectAuthorization = "";
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/info") return jsonResponse(INFO);
        if (path === "/v1/pair") {
          return jsonResponse({ token: TOKEN, capabilities: ["http.request"], expiresAt });
        }
        if (path === "/v1/session") {
          disconnectAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
          throw new TypeError("agent stopped");
        }
        throw new Error(`Unexpected request: ${path}`);
      };

      const client = new LocalAgentClient();
      await client.pair(PAIRING_CODE, ["http.request"]);
      await assert.rejects(client.disconnect(), (error) => (
        error instanceof LocalAgentError && error.code === "agent_unavailable"
      ));
      assert.equal(disconnectAuthorization, `Bearer ${TOKEN}`);
      assert.equal(values.has(SESSION_KEY), false);
      assert.equal(client.connected, false);
      assert.equal(client.persisted, false);
    });

    await t.test("keeps a saved token when restore inspection cannot reach the agent", async () => {
      const saved = JSON.stringify({ v: 1, token: TOKEN, expiresAt: futureExpiry() });
      const { storage, values } = createStorage({ [SESSION_KEY]: saved });
      installStorage(storage);
      globalThis.fetch = async () => {
        throw new TypeError("agent stopped");
      };

      const client = new LocalAgentClient();
      await assert.rejects(client.restore(), (error) => (
        error instanceof LocalAgentError && error.code === "agent_unavailable"
      ));
      assert.equal(values.get(SESSION_KEY), saved);
      assert.equal(client.connected, false);
      assert.equal(client.persisted, false);
      assert.equal(client.storageState, "available");
    });

    await t.test("clears a restored token when an authorized route rejects it", async () => {
      const saved = JSON.stringify({ v: 1, token: TOKEN, expiresAt: futureExpiry() });
      const { storage, values } = createStorage({ [SESSION_KEY]: saved });
      installStorage(storage);
      globalThis.fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/info") return jsonResponse(INFO);
        if (path === "/v1/http/cancel") {
          return jsonResponse({ error: { code: "unauthorized" } }, 401);
        }
        throw new Error(`Unexpected request: ${path}`);
      };

      const client = new LocalAgentClient();
      await client.restore();
      assert.equal(client.persisted, true);
      await assert.rejects(client.cancel("80a6dd3a-0825-4a96-8bf1-ddb8e657f96d"), (error) => (
        error instanceof LocalAgentError && error.code === "unauthorized"
      ));
      assert.equal(values.has(SESSION_KEY), false);
      assert.equal(client.connected, false);
      assert.equal(client.persisted, false);
    });

    await t.test("keeps a successful pair in memory when browser storage is blocked", async () => {
      const blocked = new DOMException("Access denied", "SecurityError");
      const storage = {
        get length(): number {
          throw blocked;
        },
        clear(): void {
          throw blocked;
        },
        getItem(): string | null {
          throw blocked;
        },
        key(): string | null {
          throw blocked;
        },
        removeItem(): void {
          throw blocked;
        },
        setItem(): void {
          throw blocked;
        },
      } satisfies Storage;
      installStorage(storage);
      const expiresAt = futureExpiry();
      globalThis.fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/info") return jsonResponse(INFO);
        if (path === "/v1/pair") {
          return jsonResponse({ token: TOKEN, capabilities: ["http.request"], expiresAt });
        }
        throw new Error(`Unexpected request: ${path}`);
      };

      const paired = new LocalAgentClient();
      await paired.pair(PAIRING_CODE, ["http.request"]);
      assert.equal(paired.connected, true);
      assert.equal(paired.persisted, false);
      assert.equal(paired.storageState, "unavailable");

      const reopened = new LocalAgentClient();
      assert.equal(await reopened.restore(), null);
      assert.equal(reopened.connected, false);
      assert.equal(reopened.persisted, false);
      assert.equal(reopened.storageState, "unavailable");
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});

test("mergeCapabilities asks for every advertised capability so one pairing serves all network tools", () => {
  const all = ["http.request", "icmp.trace", "dns.lookup", "tcp.connect", "tls.inspect", "whois.lookup", "asn.lookup"];
  assert.deepEqual(mergeCapabilities([...all].reverse(), "http.request"), all);
  assert.deepEqual(mergeCapabilities(["http.request"], "http.request"), ["http.request"]);
  assert.deepEqual(mergeCapabilities(["http.request", "icmp.trace"], "dns.lookup"), ["http.request", "icmp.trace", "dns.lookup"]);
  assert.deepEqual(mergeCapabilities([], "icmp.trace"), ["icmp.trace"]);
  assert.deepEqual(mergeCapabilities(["http.request", "port.scan"], "http.request"), ["http.request"], "unknown capabilities are never requested");
});

test("stored sessions without a capabilities field stay HTTP-only", () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    const expiresAt = futureExpiry();
    const { storage } = createStorage({
      [SESSION_KEY]: JSON.stringify({ v: 1, token: TOKEN, expiresAt }),
    });
    installStorage(storage);
    assert.deepEqual(new LocalAgentClient().capabilities, ["http.request"]);

    const icmpOnly = createStorage({
      [SESSION_KEY]: JSON.stringify({ v: 1, token: TOKEN, expiresAt, capabilities: ["icmp.trace", "network.scan"] }),
    });
    installStorage(icmpOnly.storage);
    assert.deepEqual(new LocalAgentClient().capabilities, ["icmp.trace"]);

    const empty = createStorage({
      [SESSION_KEY]: JSON.stringify({ v: 1, token: TOKEN, expiresAt, capabilities: [] }),
    });
    installStorage(empty.storage);
    assert.deepEqual(new LocalAgentClient().capabilities, []);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("trace snapshots are parsed and a forbidden trace keeps the saved token", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalFetch = globalThis.fetch;
  try {
    const { storage, values } = createStorage();
    installStorage(storage);
    const expiresAt = futureExpiry();
    const snapshot = {
      id: "80a6dd3a-0825-4a96-8bf1-ddb8e657f96d",
      state: "tracing",
      target: "127.0.0.1",
      targetInput: "localhost",
      hops: [{
        hop: 1,
        address: "127.0.0.1",
        name: null,
        sent: 1,
        received: 1,
        lossPercent: 0,
        lastMs: 1,
        bestMs: 1,
        avgMs: 1,
        worstMs: 1,
        status: "echo_reply",
      }],
    };
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/info") return jsonResponse({ ...INFO, capabilities: ["http.request", "icmp.trace"] });
      if (path === "/v1/pair") {
        return jsonResponse({ token: TOKEN, capabilities: ["http.request", "icmp.trace"], expiresAt });
      }
      if (path === "/v1/icmp/trace") return jsonResponse(snapshot);
      if (path === "/v1/icmp/snapshot") return jsonResponse({ error: { code: "forbidden" } }, 403);
      throw new Error(`Unexpected request: ${path}`);
    };

    const client = new LocalAgentClient();
    await client.pair(PAIRING_CODE, ["http.request", "icmp.trace"]);
    assert.deepEqual(client.capabilities, ["http.request", "icmp.trace"]);
    const started = await client.startTrace({
      id: snapshot.id,
      target: "127.0.0.1",
      intervalMs: 1000,
      payloadBytes: 64,
      maxHops: 30,
      timeoutMs: 5000,
      resolveNames: false,
    });
    assert.equal(started.hops[0]?.address, "127.0.0.1");
    assert.equal(started.hops[0]?.lastMs, 1);
    assert.equal(started.hops[0]?.stdevMs, null);
    assert.equal(started.hops[0]?.jitterMs, null);
    assert.equal(started.sourceAddress, null);
    assert.equal(started.sourceInterface, null);
    await assert.rejects(client.traceSnapshot(snapshot.id), (error) => (
      error instanceof LocalAgentError && error.code === "forbidden"
    ));
    assert.equal(values.has(SESSION_KEY), true);
    assert.equal(client.connected, true);

    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/icmp/trace") return jsonResponse({ id: 1, state: "nope", hops: [] });
      throw new Error(`Unexpected request: ${path}`);
    };
    await assert.rejects(client.startTrace({
      id: snapshot.id,
      target: "127.0.0.1",
      intervalMs: 1000,
      payloadBytes: 64,
      maxHops: 30,
      timeoutMs: 5000,
      resolveNames: true,
    }), (error) => error instanceof LocalAgentError && error.code === "invalid_response");

    const saved = values.get(SESSION_KEY);
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/info") return jsonResponse({ ...INFO, capabilities: ["http.request", "icmp.trace"] });
      if (path === "/v1/pair") return jsonResponse({ error: { code: "pairing_invalid" } }, 401);
      throw new Error(`Unexpected request: ${path}`);
    };
    await assert.rejects(
      client.pairKeepingSession("ffffffffffffffffffffffffffffffff", ["http.request", "icmp.trace"]),
      (error) => error instanceof LocalAgentError && error.code === "pairing_invalid",
    );
    assert.equal(values.get(SESSION_KEY), saved);
    assert.equal(client.connected, true);
    assert.deepEqual(client.capabilities, ["http.request", "icmp.trace"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
