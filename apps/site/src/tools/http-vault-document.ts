/** The agent vault document calls a revisioned page store needs. */
export interface VaultDocumentClient {
  listDocuments(): Promise<{ name: string }[]>;
  readDocument(name: string): Promise<{ revision: number; data: unknown } | null>;
  writeDocument(name: string, baseRevision: number, data: unknown): Promise<number>;
  deleteDocument(name: string, baseRevision: number): Promise<void>;
}

/**
 * One agent vault document changed by read-modify-write over its revision: a
 * write from another window is re-read and the change applied again. Changes
 * from this page run one after another.
 */
export class RevisionedVaultDocument<T> {
  #client: VaultDocumentClient;
  #name: string;
  #parse: (data: unknown) => T | null;
  #empty: () => T;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(client: VaultDocumentClient, name: string, parse: (data: unknown) => T | null, empty: () => T) {
    this.#client = client;
    this.#name = name;
    this.#parse = parse;
    this.#empty = empty;
  }

  async #read(): Promise<{ value: T; revision: number }> {
    // Listing first keeps a missing document from showing up as a 404 in the console.
    const listed = (await this.#client.listDocuments()).some((info) => info.name === this.#name);
    const document = listed ? await this.#client.readDocument(this.#name) : null;
    if (!document) return { value: this.#empty(), revision: 0 };
    const value = this.#parse(document.data);
    if (value === null) throw new Error(`${this.#name}_corrupt`);
    return { value, revision: document.revision };
  }

  async load(): Promise<T> {
    return (await this.#read()).value;
  }

  /** Deletes the document; a write from another window in between is retried. */
  remove(): Promise<void> {
    return this.#serial(async () => {
      for (let attempt = 0; ; attempt++) {
        const listed = (await this.#client.listDocuments()).some((info) => info.name === this.#name);
        const document = listed ? await this.#client.readDocument(this.#name) : null;
        if (!document) return;
        try {
          await this.#client.deleteDocument(this.#name, document.revision);
          return;
        } catch (error) {
          if (!isConflict(error) || attempt >= 2) throw error;
        }
      }
    });
  }

  #serial<R>(run: () => Promise<R>): Promise<R> {
    const next = this.#chain.then(run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** `serialize` turns the changed value into the stored document. */
  update(change: (value: T) => T, serialize: (value: T) => unknown): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        const current = await this.#read();
        const value = change(current.value);
        try {
          await this.#client.writeDocument(this.#name, current.revision, serialize(value));
          return value;
        } catch (error) {
          if (!isConflict(error) || attempt >= 2) throw error;
        }
      }
    };
    return this.#serial(run);
  }
}

const isConflict = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "revision_conflict";
