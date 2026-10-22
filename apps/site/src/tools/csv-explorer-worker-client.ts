import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type { CsvFilter } from "@/tools/csv-explorer";
import type {
  CsvAggregateSummary,
  CsvExplorerRequest,
  CsvExplorerSuccess,
  CsvExportFormat,
  CsvExportSource,
  CsvOpenOptions,
  CsvSessionSummary,
  CsvSort,
} from "@/tools/csv-explorer-protocol";
import type { CsvAggregateRequest, CsvColumnType, CsvInvalidPolicy } from "@/tools/csv-explorer-types";

export interface CsvExportOptions {
  format: CsvExportFormat;
  source: CsvExportSource;
  columns: number[];
  includeHeader: boolean;
  protectFormulas: boolean;
  bom: boolean;
}

export interface CsvExplorerWorkerClient {
  open(file: File, options: CsvOpenOptions, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<CsvSessionSummary>;
  filter(sessionId: number, filter: CsvFilter | null, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<number>;
  setTypes(sessionId: number, types: CsvColumnType[], invalid: CsvInvalidPolicy): Promise<void>;
  detectTypes(sessionId: number): Promise<CsvColumnType[]>;
  sort(sessionId: number, sort: CsvSort | null, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<boolean>;
  aggregate(sessionId: number, request: CsvAggregateRequest, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<CsvAggregateSummary>;
  readGroups(sessionId: number, start: number, count: number): Promise<(string | null)[][]>;
  read(sessionId: number, start: number, count: number, columns: number[]): Promise<string[][]>;
  inspect(sessionId: number, index: number): Promise<string[]>;
  exportResult(sessionId: number, options: CsvExportOptions, stream: MessagePort, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<Extract<CsvExplorerSuccess, { kind: "export" }>>;
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
    async setTypes(sessionId, types, invalid) {
      resultOfKind(await worker.run({ type: "types", sessionId, types, invalid }), "types");
    },
    async detectTypes(sessionId) {
      return resultOfKind(await worker.run({ type: "detect", sessionId }), "detect").types;
    },
    async sort(sessionId, sort, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "sort", sessionId, sort }, [], signal, onProgress), "sort").sorted;
    },
    async aggregate(sessionId, request, signal, onProgress) {
      const { columns, groupCount, inputRows } = resultOfKind(await worker.run({ type: "aggregate", sessionId, request }, [], signal, onProgress), "aggregate");
      return { columns, groupCount, inputRows };
    },
    async readGroups(sessionId, start, count) {
      return resultOfKind(await worker.run({ type: "read-groups", sessionId, start, count }), "read-groups").rows;
    },
    async read(sessionId, start, count, columns) {
      const result = resultOfKind(await worker.run({ type: "read", sessionId, start, count, columns }), "read");
      return result.rows;
    },
    async inspect(sessionId, index) {
      const result = resultOfKind(await worker.run({ type: "inspect", sessionId, index }), "inspect");
      return result.values;
    },
    async exportResult(sessionId, options, stream, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "export", sessionId, ...options, stream }, [stream], signal, onProgress), "export");
    },
    terminate() {
      worker.terminate();
    },
  };
}
