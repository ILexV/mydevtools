export interface BlobChunk {
  bytes: Uint8Array;
  offset: number;
  end: number;
}

export interface BlobChunkOptions {
  chunkBytes: number;
  start?: number;
  end?: number;
  signal?: AbortSignal;
}

/**
 * Read a Blob sequentially with one slice in flight. Consumers control
 * backpressure by awaiting each iteration; abort is checked around every read.
 */
export async function* readBlobChunks(blob: Blob, options: BlobChunkOptions): AsyncGenerator<BlobChunk> {
  if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes <= 0) {
    throw new RangeError("chunkBytes must be a positive safe integer");
  }
  const start = options.start ?? 0;
  const end = options.end ?? blob.size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > blob.size) {
    throw new RangeError("Blob chunk range is invalid");
  }

  for (let offset = start; offset < end;) {
    options.signal?.throwIfAborted();
    const chunkEnd = Math.min(offset + options.chunkBytes, end);
    const bytes = new Uint8Array(await blob.slice(offset, chunkEnd).arrayBuffer());
    options.signal?.throwIfAborted();
    yield { bytes, offset, end: chunkEnd };
    offset = chunkEnd;
  }
}
