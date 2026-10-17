import { createJobWorker, type JobProgress } from "@/scripts/wasm/job-worker";
import type { LogFilter, LogPreset } from "@/tools/log-analyzer";
import type {
  LogAnalyzerRequest,
  LogAnalyzerSuccess,
  LogInspection,
  LogSessionSummary,
  LogTableRecord,
} from "@/tools/log-analyzer-protocol";

export interface LogAnalyzerWorkerClient {
  open(file: File, preset: LogPreset, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<LogSessionSummary>;
  filter(sessionId: number, filter: LogFilter | null, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<Extract<LogAnalyzerSuccess, { kind: "filter" }>>;
  read(sessionId: number, start: number, count: number): Promise<LogTableRecord[]>;
  inspect(sessionId: number, index: number): Promise<LogInspection>;
  exportResult(sessionId: number, stream: MessagePort, signal?: AbortSignal, onProgress?: (info: JobProgress) => void): Promise<Extract<LogAnalyzerSuccess, { kind: "export" }>>;
  terminate(): void;
}

function resultOfKind<K extends LogAnalyzerSuccess["kind"]>(
  result: LogAnalyzerSuccess,
  kind: K,
): Extract<LogAnalyzerSuccess, { kind: K }> {
  if (result.kind !== kind) throw new Error(`Unexpected log worker response: ${result.kind}`);
  return result as Extract<LogAnalyzerSuccess, { kind: K }>;
}

export function createLogAnalyzerWorker(): LogAnalyzerWorkerClient {
  const worker = createJobWorker<LogAnalyzerRequest, LogAnalyzerSuccess>(
    () => new Worker(new URL("../workers/log-analyzer.worker.ts", import.meta.url), { type: "module" }),
  );
  return {
    async open(file, preset, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "open", file, preset }, [], signal, onProgress), "open");
    },
    async filter(sessionId, filter, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "filter", sessionId, filter }, [], signal, onProgress), "filter");
    },
    async read(sessionId, start, count) {
      return resultOfKind(await worker.run({ type: "read", sessionId, start, count }), "read").records;
    },
    async inspect(sessionId, index) {
      return resultOfKind(await worker.run({ type: "inspect", sessionId, index }), "inspect").inspection;
    },
    async exportResult(sessionId, stream, signal, onProgress) {
      return resultOfKind(await worker.run({ type: "export", sessionId, stream }, [stream], signal, onProgress), "export");
    },
    terminate() {
      worker.terminate();
    },
  };
}
