import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type {
  ParquetExplorerRequest,
  ParquetExplorerSuccess,
  ParquetSessionSummary,
} from "@/tools/parquet-explorer-protocol";

export interface ParquetExportOptions {
  format: "csv" | "jsonl";
  columns: number[];
  includeHeader: boolean;
  protectFormulas: boolean;
  bom: boolean;
}

export interface ParquetExplorerWorkerClient {
  open(file: File, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<ParquetSessionSummary>;
  read(sessionId: number, start: number, count: number, columns: number[], maxChars: number): Promise<string[][]>;
  exportResult(sessionId: number, options: ParquetExportOptions, stream: MessagePort, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<Extract<ParquetExplorerSuccess, { kind: "export" }>>;
  terminate(): void;
}

function resultOfKind<K extends ParquetExplorerSuccess["kind"]>(
  result: ParquetExplorerSuccess,
  kind: K,
): Extract<ParquetExplorerSuccess, { kind: K }> {
  if (result.kind !== kind) throw new Error(`Unexpected Parquet worker response: ${result.kind}`);
  return result as Extract<ParquetExplorerSuccess, { kind: K }>;
}

/** One long-lived worker. `terminate` drops its file session after cancel or a new file. */
export function createParquetExplorerWorker(): ParquetExplorerWorkerClient {
  const worker = createJobWorker<ParquetExplorerRequest, ParquetExplorerSuccess>(
    () => new Worker(new URL("../workers/parquet-explorer.worker.ts", import.meta.url), { type: "module" }),
  );

  return {
    async open(file, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "open", file }, [], signal, onProgress), "open");
    },
    async read(sessionId, start, count, columns, maxChars) {
      const result = resultOfKind(
        await worker.run({ type: "read", sessionId, start, count, columns, maxChars }),
        "read",
      );
      return result.rows;
    },
    async exportResult(sessionId, options, stream, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "export", sessionId, ...options, stream }, [stream], signal, onProgress), "export");
    },
    terminate() {
      worker.terminate();
    },
  };
}
