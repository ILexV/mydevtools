import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobWorker } from "../src/scripts/wasm/job-worker.ts";
import { WasmError } from "../src/scripts/wasm/worker-protocol.ts";

type WorkerEventType = "message" | "error" | "messageerror";
type WorkerListener = (event: { data?: unknown; message?: string }) => void;

class FakeWorker {
  readonly sent: unknown[] = [];
  readonly listeners: Record<WorkerEventType, Set<WorkerListener>> = {
    message: new Set(),
    error: new Set(),
    messageerror: new Set(),
  };
  terminated = false;
  postFailure: Error | null = null;

  addEventListener(type: WorkerEventType, listener: WorkerListener): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(type: WorkerEventType, listener: WorkerListener): void {
    this.listeners[type].delete(listener);
  }

  postMessage(message: unknown): void {
    if (this.postFailure) throw this.postFailure;
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    for (const listener of [...this.listeners.message]) listener({ data });
  }

  emitFailure(type: "error" | "messageerror", message = "worker crashed"): void {
    for (const listener of [...this.listeners[type]]) listener({ message });
  }

  get listenerCount(): number {
    return this.listeners.message.size + this.listeners.error.size + this.listeners.messageerror.size;
  }
}

function asWorker(worker: FakeWorker): Worker {
  return worker as unknown as Worker;
}

function requestId(message: unknown): number {
  assert.ok(message && typeof message === "object" && "id" in message && typeof message.id === "number");
  return message.id;
}

function expectCode(code: WasmError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof WasmError && error.code === code;
}

test("progress does not settle a job and successful sessions remain reusable", async () => {
  const worker = new FakeWorker();
  const jobs = createJobWorker<{ value: number }, { value: number }>(() => asWorker(worker));
  let settled = false;
  const first = jobs.run({ value: 1 });
  first.finally(() => { settled = true; }).catch(() => undefined);
  const firstId = requestId(worker.sent[0]);

  worker.emitMessage({ id: firstId, type: "progress", processed: 4, total: 10, elapsedMs: 8 });
  await Promise.resolve();
  assert.equal(settled, false);

  worker.emitMessage({ id: firstId, ok: true, value: 11 });
  await first;
  assert.equal(settled, true);
  const second = jobs.run({ value: 2 });
  const secondId = requestId(worker.sent[1]);
  worker.emitMessage({ id: secondId, ok: false, code: "input-too-large", message: "too large" });
  await assert.rejects(second, expectCode("input-too-large"));
  assert.equal(worker.terminated, false);
});

test("aborting one shared-worker job settles every pending job and a fresh run is isolated from late events", async () => {
  const workers: FakeWorker[] = [];
  const jobs = createJobWorker<{ value: number }, { value: number }>(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return asWorker(worker);
  });
  const controller = new AbortController();
  const first = jobs.run({ value: 1 }, [], controller.signal);
  const peer = jobs.run({ value: 2 });
  const oldErrorHandler = workers[0]!.listeners.error.values().next().value!;
  controller.abort();

  await Promise.all([
    assert.rejects(first, expectCode("aborted")),
    assert.rejects(peer, expectCode("aborted")),
  ]);
  assert.equal(workers[0]?.terminated, true);
  assert.equal(workers[0]?.listenerCount, 0);

  const rerun = jobs.run({ value: 3 });
  const replacement = workers[1]!;
  const rerunId = requestId(replacement.sent[0]);
  oldErrorHandler({ message: "late old failure" });
  assert.equal(replacement.terminated, false);
  replacement.emitMessage({ id: rerunId, ok: true, value: 30 });
  await rerun;
});

test("typed initialization failure drops the poisoned instance and reruns on a replacement", async () => {
  const workers: FakeWorker[] = [];
  const jobs = createJobWorker<{ value: number }, { value: number }>(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return asWorker(worker);
  });
  const first = jobs.run({ value: 1 });
  const firstWorker = workers[0]!;
  firstWorker.emitMessage({
    id: requestId(firstWorker.sent[0]),
    ok: false,
    code: "init-failed",
    message: "WASM initialization failed",
  });
  await assert.rejects(first, expectCode("init-failed"));
  assert.equal(firstWorker.terminated, true);

  const rerun = jobs.run({ value: 2 });
  const replacement = workers[1]!;
  replacement.emitMessage({ id: requestId(replacement.sent[0]), ok: true, value: 20 });
  await rerun;
  assert.equal(replacement.terminated, false);
});

test("native error and messageerror reject all affected work and permit rerun", async () => {
  const workers: FakeWorker[] = [];
  const jobs = createJobWorker<{ value: number }, { value: number }>(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return asWorker(worker);
  });
  const first = jobs.run({ value: 1 });
  const peer = jobs.run({ value: 2 });
  workers[0]!.emitFailure("error", "startup trap");
  await Promise.all([
    assert.rejects(first, expectCode("worker-failed")),
    assert.rejects(peer, expectCode("worker-failed")),
  ]);

  const rerun = jobs.run({ value: 3 });
  workers[1]!.emitFailure("messageerror");
  await assert.rejects(rerun, expectCode("worker-failed"));
  assert.equal(workers[1]?.terminated, true);
  assert.equal(workers[1]?.listenerCount, 0);
});

test("construction, postMessage, and explicit termination reject instead of leaving callers pending", async () => {
  let failConstruction = true;
  const workers: FakeWorker[] = [];
  const jobs = createJobWorker<{ value: number }, { value: number }>(() => {
    if (failConstruction) {
      failConstruction = false;
      throw new Error("worker unavailable");
    }
    const worker = new FakeWorker();
    workers.push(worker);
    return asWorker(worker);
  });

  await assert.rejects(jobs.run({ value: 1 }), expectCode("worker-failed"));
  const postingWorkers = [new FakeWorker(), new FakeWorker()];
  postingWorkers[0]!.postFailure = new Error("clone failed");
  let postingIndex = 0;
  const postJobs = createJobWorker<{ value: number }, { value: number }>(
    () => asWorker(postingWorkers[postingIndex++]!),
  );
  await assert.rejects(postJobs.run({ value: 2 }), expectCode("worker-failed"));
  assert.equal(postingWorkers[0]!.terminated, true);
  assert.equal(postingWorkers[0]!.listenerCount, 0);
  const postRerun = postJobs.run({ value: 20 });
  postingWorkers[1]!.emitMessage({
    id: requestId(postingWorkers[1]!.sent[0]),
    ok: true,
    value: 200,
  });
  await postRerun;
  assert.equal(postingWorkers[1]!.terminated, false);

  const pending = jobs.run({ value: 3 });
  jobs.terminate();
  await assert.rejects(pending, expectCode("aborted"));
  assert.equal(workers[0]?.terminated, true);
  assert.equal(workers[0]?.listenerCount, 0);
});
