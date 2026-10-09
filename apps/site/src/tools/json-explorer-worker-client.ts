import { createJobWorker, type JobProgress, type JobWorker } from "@/scripts/wasm/job-worker";
import type { JsonExplorerDiagnostic } from "@/tools/json-explorer-core";
import type {
  ApplyJsonViewRequest,
  ApplyJsonViewResult,
  ExportJsonChunkRequest,
  ExportJsonChunkResult,
  InspectJsonRowRequest,
  InspectJsonRowResult,
  JsonExplorerRequest,
  JsonExplorerResult,
  JsonExplorerWorkerResult,
  OpenJsonRequest,
  OpenJsonResult,
  ReadJsonRowsRequest,
  ReadJsonRowsResult,
  ReadJsonTreeRequest,
  ReadJsonTreeResult,
} from "@/tools/json-explorer-protocol";

export interface JsonWorkerRunOptions {
  signal?: AbortSignal;
  onProgress?: (info: JobProgress) => void;
}

export class JsonExplorerClientError extends Error {
  constructor(public readonly diagnostic: JsonExplorerDiagnostic) {
    super(diagnostic.code);
    this.name = "JsonExplorerClientError";
  }
}

export interface JsonExplorerWorkerClient {
  open(request: Omit<OpenJsonRequest, "type">, options?: JsonWorkerRunOptions): Promise<OpenJsonResult>;
  applyView(request: Omit<ApplyJsonViewRequest, "type">, options?: JsonWorkerRunOptions): Promise<ApplyJsonViewResult>;
  readRows(request: Omit<ReadJsonRowsRequest, "type">): Promise<ReadJsonRowsResult>;
  inspectRow(request: Omit<InspectJsonRowRequest, "type">): Promise<InspectJsonRowResult>;
  readTree(request: Omit<ReadJsonTreeRequest, "type">): Promise<ReadJsonTreeResult>;
  exportChunk(request: Omit<ExportJsonChunkRequest, "type">): Promise<ExportJsonChunkResult>;
  terminate(): void;
}

export function createJsonExplorerWorkerClient(): JsonExplorerWorkerClient {
  const job: JobWorker<JsonExplorerRequest, JsonExplorerWorkerResult> = createJobWorker(
    () => new Worker(new URL("../workers/json-explorer.worker.ts", import.meta.url), { type: "module" }),
  );

  const run = async <T extends JsonExplorerResult>(request: JsonExplorerRequest, options: JsonWorkerRunOptions = {}): Promise<T> => {
    const result = await job.run(request, [], options.signal, options.onProgress);
    if ("explorerError" in result) throw new JsonExplorerClientError(result.explorerError);
    return result as T;
  };

  return {
    open: (request, options) => run<OpenJsonResult>({ type: "open", ...request }, options),
    applyView: (request, options) => run<ApplyJsonViewResult>({ type: "apply-view", ...request }, options),
    readRows: (request) => run<ReadJsonRowsResult>({ type: "read-rows", ...request }),
    inspectRow: (request) => run<InspectJsonRowResult>({ type: "inspect-row", ...request }),
    readTree: (request) => run<ReadJsonTreeResult>({ type: "read-tree", ...request }),
    exportChunk: (request) => run<ExportJsonChunkResult>({ type: "export-chunk", ...request }),
    terminate: () => job.terminate(),
  };
}
