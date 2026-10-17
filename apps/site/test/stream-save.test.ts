import { test } from "node:test";
import assert from "node:assert/strict";
import { saveStreamedFile, saveWorkerStreamedFile, StreamSaveError } from "../src/scripts/stream-save.ts";

test("Blob fallback snapshots chunks before a producer reuses its buffer", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const capture: { downloaded: Blob | null } = { downloaded: null };
  const fakeWindow: Record<string, unknown> = {};
  Object.defineProperty(fakeWindow, `set${"Timeout"}`, {
    value(callback: () => void) { callback(); return 0; },
  });
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => ({ href: "", download: "", click() {} }) },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value(blob: Blob) { capture.downloaded = blob; return "blob:test"; },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value() {} });

    const reusable = new Uint8Array(1);
    const result = await saveStreamedFile({
      suggestedName: "reuse.txt",
      mimeType: "text/plain;charset=utf-8",
      extensions: ["txt"],
      fallbackMaxBytes: 2,
    }, async (sink) => {
      reusable[0] = 0x61;
      await sink.write(reusable);
      reusable[0] = 0x62;
      await sink.write(reusable);
    });

    assert.equal(result.mode, "blob");
    assert.equal(result.bytesWritten, 2);
    assert.ok(capture.downloaded);
    assert.equal(await capture.downloaded.text(), "ab");
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
    if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

test("native picker receives a MIME type without parameters", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const capture: { pickerOptions: { types?: Array<{ accept: Record<string, string[]> }> } | null } = { pickerOptions: null };
  const chunks: Uint8Array[] = [];
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        async showSaveFilePicker(options: { types?: Array<{ accept: Record<string, string[]> }> }) {
          capture.pickerOptions = options;
          return {
            async createWritable() {
              return {
                async write(bytes: Uint8Array) { chunks.push(bytes.slice()); },
                async close() {},
                async abort() {},
              };
            },
          };
        },
      },
    });

    await saveStreamedFile({
      suggestedName: "rows.csv",
      mimeType: "text/csv;charset=utf-8",
      extensions: ["csv"],
      fallbackMaxBytes: 16,
    }, async (sink) => sink.write(new TextEncoder().encode("a\r\n")));

    assert.ok(capture.pickerOptions);
    assert.deepEqual(Object.keys(capture.pickerOptions.types?.[0]?.accept ?? {}), ["text/csv"]);
    assert.equal(new TextDecoder().decode(chunks[0]), "a\r\n");
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("abort rolls back a partially written picker destination", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const controller = new AbortController();
  let writes = 0;
  let closes = 0;
  let aborts = 0;
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        async showSaveFilePicker() {
          return {
            async createWritable() {
              return {
                async write() { writes++; },
                async close() { closes++; },
                async abort() { aborts++; },
              };
            },
          };
        },
      },
    });

    const saving = saveStreamedFile({
      suggestedName: "partial.csv",
      mimeType: "text/csv",
      extensions: [".csv"],
      fallbackMaxBytes: 16,
      signal: controller.signal,
    }, async (sink) => {
      await sink.write(new Uint8Array([0x61]));
      controller.abort();
      await Promise.resolve();
    });

    await assert.rejects(saving, (error: unknown) => error instanceof StreamSaveError && error.code === "aborted");
    assert.equal(writes, 1);
    assert.equal(closes, 0);
    assert.equal(aborts, 1);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Blob fallback rejects before retaining bytes beyond its explicit limit", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    await assert.rejects(
      saveStreamedFile({
        suggestedName: "bounded.bin",
        mimeType: "application/octet-stream",
        fallbackMaxBytes: 1,
      }, async (sink) => sink.write(new Uint8Array([0, 1]))),
      (error: unknown) => error instanceof StreamSaveError && error.code === "fallback-too-large",
    );
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("worker destination failure aborts the partial file and releases the stream without canceling the session signal", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let destinationAborts = 0;
  let workerSawAbort = false;
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        async showSaveFilePicker() {
          return {
            async createWritable() {
              return {
                async write() { throw new Error("disk full"); },
                async close() {},
                async abort() { destinationAborts++; },
              };
            },
          };
        },
      },
    });

    await assert.rejects(
      saveWorkerStreamedFile({
        suggestedName: "worker.csv",
        mimeType: "text/csv",
        fallbackMaxBytes: 16,
      }, (port, signal) => new Promise<void>((_resolve, reject) => {
        port.onmessage = (event: MessageEvent<{ type?: string }>) => {
          if (event.data?.type !== "abort") return;
          workerSawAbort = true;
          assert.equal(signal.aborted, false);
          port.close();
          reject(new DOMException("Aborted", "AbortError"));
        };
        port.start();
        const bytes = new Uint8Array([0x61]).buffer as ArrayBuffer;
        port.postMessage({ type: "chunk", bytes }, [bytes]);
      })),
      (error: unknown) => error instanceof StreamSaveError && error.code === "storage-failed",
    );
    assert.equal(workerSawAbort, true);
    assert.equal(destinationAborts, 1);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
