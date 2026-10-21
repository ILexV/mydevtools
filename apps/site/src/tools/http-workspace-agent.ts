import { LocalAgentError, type VaultDocument, type VaultDocumentInfo } from "../scripts/local-agent.ts";
import { parseHttpWorkspace, type HttpWorkspace } from "./http-workspace.ts";

/** Vault document that holds the HTTP client workspace. */
export const HTTP_WORKSPACE_DOCUMENT = "http-workspace";
/** Fetch `keepalive` bodies are capped near 64 KiB; larger saves on pagehide are skipped. */
const KEEPALIVE_LIMIT = 60 * 1024;

export interface WorkspaceVaultClient {
  listDocuments(): Promise<VaultDocumentInfo[]>;
  readDocument(name: string): Promise<VaultDocument | null>;
  writeDocument(name: string, baseRevision: number, data: unknown, options?: { keepalive?: boolean }): Promise<number>;
}

export type WorkspaceFlushResult =
  | { kind: "idle" }
  | { kind: "saved"; revision: number }
  | { kind: "conflict"; remote: HttpWorkspace; revision: number }
  | { kind: "error"; error: unknown };

/**
 * Encrypted agent copy of the HTTP workspace. Saves are queued and sent one at
 * a time over the last known revision; a failed save stays queued for retry.
 */
export class AgentWorkspaceStore {
  #client: WorkspaceVaultClient;
  #revision = 0;
  #pending: string | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(client: WorkspaceVaultClient) {
    this.#client = client;
  }

  get revision(): number {
    return this.#revision;
  }

  get hasPending(): boolean {
    return this.#pending !== null;
  }

  /** Null workspace when the agent has none yet; invalid data is an error, never replaced. */
  async load(): Promise<{ workspace: HttpWorkspace | null; revision: number }> {
    // Listing first keeps a missing document from showing up as a 404 in the console.
    const listed = (await this.#client.listDocuments()).some((info) => info.name === HTTP_WORKSPACE_DOCUMENT);
    const document = listed ? await this.#client.readDocument(HTTP_WORKSPACE_DOCUMENT) : null;
    if (!document) {
      this.#revision = 0;
      return { workspace: null, revision: 0 };
    }
    const workspace = parseHttpWorkspace(document.data);
    if (!workspace) throw new LocalAgentError("vault_corrupt");
    this.#revision = document.revision;
    return { workspace, revision: document.revision };
  }

  /** Replaces whatever is queued: only the latest workspace matters. */
  queue(workspace: HttpWorkspace): void {
    this.#pending = JSON.stringify(workspace);
  }

  flush(options: { keepalive?: boolean } = {}): Promise<WorkspaceFlushResult> {
    const next = this.#chain.then(() => this.#flushOnce(options));
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #flushOnce(options: { keepalive?: boolean }): Promise<WorkspaceFlushResult> {
    const body = this.#pending;
    if (body === null) return { kind: "idle" };
    if (options.keepalive && body.length > KEEPALIVE_LIMIT) return { kind: "idle" };
    this.#pending = null;
    try {
      this.#revision = await this.#client.writeDocument(
        HTTP_WORKSPACE_DOCUMENT, this.#revision, JSON.parse(body), { keepalive: options.keepalive },
      );
      return { kind: "saved", revision: this.#revision };
    } catch (error) {
      // A newer queued save wins over the failed one.
      this.#pending ??= body;
      if (!(error instanceof LocalAgentError && error.code === "revision_conflict")) return { kind: "error", error };
      try {
        const remote = await this.load();
        // The other window deleted it: create it again from this window's copy.
        if (!remote.workspace) return await this.#flushOnce(options);
        this.#pending = null;
        return { kind: "conflict", remote: remote.workspace, revision: remote.revision };
      } catch (loadError) {
        return { kind: "error", error: loadError };
      }
    }
  }
}
