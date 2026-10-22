import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type { SqliteExplorerRequest, SqliteExplorerSuccess } from "@/tools/sqlite-explorer-protocol";
import type { SqliteExportFormat } from "@/tools/sqlite-explorer-engine";

type Success<K extends SqliteExplorerSuccess["kind"]> = Extract<SqliteExplorerSuccess, { kind: K }>;

export interface SqliteExplorerWorkerClient {
  open(file: File, writable: boolean, signal?: AbortSignal): Promise<Success<"open">>;
  detail(name: string): Promise<Success<"detail">["detail"]>;
  browse(name: string, signal?: AbortSignal): Promise<Success<"result">>;
  run(sql: string, signal?: AbortSignal): Promise<Success<"result">>;
  read(start: number, count: number): Promise<string[][]>;
  exportResult(format: SqliteExportFormat, stream: MessagePort, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<number>;
  download(signal?: AbortSignal): Promise<Uint8Array>;
  /** Stop the worker; its database copy and any unsaved changes are gone. */
  terminate(): void;
}

function resultOfKind<K extends SqliteExplorerSuccess["kind"]>(result: SqliteExplorerSuccess, kind: K): Success<K> {
  if (result.kind !== kind) throw new Error(`Unexpected SQLite worker response: ${result.kind}`);
  return result as Success<K>;
}

/** The SQLite database lives in one dedicated worker; cancellation terminates it. */
export function createSqliteExplorerWorker(): SqliteExplorerWorkerClient {
  const worker = createJobWorker<SqliteExplorerRequest, SqliteExplorerSuccess>(
    () => new Worker(new URL("../workers/sqlite-explorer.worker.ts", import.meta.url), { type: "module" }),
  );
  return {
    async open(file, writable, signal) {
      return resultOfKind(await worker.run({ type: "open", file, writable }, [], signal), "open");
    },
    async detail(name) {
      return resultOfKind(await worker.run({ type: "detail", name }), "detail").detail;
    },
    async browse(name, signal) {
      return resultOfKind(await worker.run({ type: "browse", name }, [], signal), "result");
    },
    async run(sql, signal) {
      return resultOfKind(await worker.run({ type: "run", sql }, [], signal), "result");
    },
    async read(start, count) {
      return resultOfKind(await worker.run({ type: "read", start, count }), "read").rows;
    },
    async exportResult(format, stream, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "export", format, stream }, [stream], signal, onProgress), "export").rowCount;
    },
    async download(signal) {
      return resultOfKind(await worker.run({ type: "download" }, [], signal), "download").bytes;
    },
    terminate() {
      worker.terminate();
    },
  };
}
