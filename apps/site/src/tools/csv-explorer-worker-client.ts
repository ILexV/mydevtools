import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type { CsvFilter } from "@/tools/csv-explorer";
import type {
  CsvExplorerRequest,
  CsvExplorerSuccess,
  CsvOpenOptions,
  CsvSessionSummary,
} from "@/tools/csv-explorer-protocol";

export interface CsvExportOptions {
  format: "csv" | "jsonl";
  columns: number[];
  includeHeader: boolean;
  protectFormulas: boolean;
  bom: boolean;
}

export interface CsvExplorerWorkerClient {
  open(file: File, options: CsvOpenOptions, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<CsvSessionSummary>;
  filter(sessionId: number, filter: CsvFilter | null, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<number>;
  read(sessionId: number, start: number, count: number, columns: number[]): Promise<string[][]>;
  inspect(sessionId: number, index: number): Promise<string[]>;
  exportResult(sessionId: number, options: CsvExportOptions, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<Extract<CsvExplorerSuccess, { kind: "export" }>>;
  terminate(): void;
}

function resultOfKind<K extends CsvExplorerSuccess["kind"]>(
  result: CsvExplorerSuccess,
  kind: K,
): Extract<CsvExplorerSuccess, { kind: K }> {
  if (result.kind !== kind) throw new Error(`Unexpected CSV worker response: ${result.kind}`);
  return result as Extract<CsvExplorerSuccess, { kind: K }>;
}

export function createCsvExplorerWorker(): CsvExplorerWorkerClient {
  const worker = createJobWorker<CsvExplorerRequest, CsvExplorerSuccess>(
    () => new Worker(new URL("../workers/csv-explorer.worker.ts", import.meta.url), { type: "module" }),
  );

  return {
    async open(file, options, signal, onProgress) {
      const result = resultOfKind(await worker.run({ type: "open", file, options }, [], signal, onProgress), "open");
      return result;
    },
    async filter(sessionId, filter, signal, onProgress) {
      const result = resultOfKind(await worker.run({ type: "filter", sessionId, filter }, [], signal, onProgress), "filter");
      return result.rowCount;
    },
    async read(sessionId, start, count, columns) {
      const result = resultOfKind(await worker.run({ type: "read", sessionId, start, count, columns }), "read");
      return result.rows;
    },
    async inspect(sessionId, index) {
      const result = resultOfKind(await worker.run({ type: "inspect", sessionId, index }), "inspect");
      return result.values;
    },
    async exportResult(sessionId, options, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "export", sessionId, ...options }, [], signal, onProgress), "export");
    },
    terminate() {
      worker.terminate();
    },
  };
}
