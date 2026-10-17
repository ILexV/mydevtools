import initParquetWasm, {
  Compression,
  readParquet,
  Table,
  writeParquet,
  WriterPropertiesBuilder,
} from "parquet-wasm/esm";
import parquetWasmUrl from "parquet-wasm/esm/parquet_wasm_bg.wasm?url";

interface CodecRequest {
  id: number;
  operation: "decode" | "encode";
  bytes: Uint8Array;
}

let initialization: Promise<unknown> | null = null;

function initialize(): Promise<unknown> {
  initialization ??= initParquetWasm(parquetWasmUrl);
  return initialization;
}

self.addEventListener("message", (event: MessageEvent<CodecRequest>) => {
  const { id, operation, bytes } = event.data;
  self.postMessage({ id, loading: { loaded: 0, total: 0 } });
  void (async () => {
    try {
      await initialize();
      self.postMessage({ id, loading: { loaded: 1, total: 1 } });
      let output: Uint8Array;
      if (operation === "decode") {
        output = readParquet(bytes).intoIPCStream();
      } else {
        const table = Table.fromIPCStream(bytes);
        const properties = new WriterPropertiesBuilder()
          .setCompression(Compression.ZSTD)
          .build();
        output = writeParquet(table, properties);
      }
      self.postMessage({ id, bytes: output }, { transfer: [output.buffer] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      self.postMessage({ id, error: message });
    }
  })();
});
