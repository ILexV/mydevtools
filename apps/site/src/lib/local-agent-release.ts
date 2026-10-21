import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Astro runs from apps/site; bundled import.meta.url points inside dist/.prerender.
const DOWNLOADS_DIR = pathToFileURL(resolve("public/downloads") + sep);
const MANIFEST_URL = new URL("local-agent.json", DOWNLOADS_DIR);
const EXPECTED_PLATFORM = "windows-x64";
const EXPECTED_FILE = "mydevtools-agent-windows-x64-setup.exe";

export interface LocalAgentRelease {
  version: string;
  platform: "windows-x64";
  file: "mydevtools-agent-windows-x64-setup.exe";
  sha256: string;
  size: number;
}

let cachedRelease: LocalAgentRelease | undefined;

function releaseError(message: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? ` (${cause.message})` : "";
  return new Error(
    `[local-agent release] ${message}${detail}. Run npm run build:agent from the repository root before building site pages.`,
  );
}

function sha256File(file: URL): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(file, "r");
  try {
    let bytesRead: number;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

/** Read and verify the generated Windows release metadata before rendering download pages. */
export function getLocalAgentRelease(): LocalAgentRelease {
  if (cachedRelease) return cachedRelease;

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
  } catch (error) {
    throw releaseError("Missing or unreadable public/downloads/local-agent.json", error);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw releaseError("public/downloads/local-agent.json must contain a JSON object");
  }

  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  if (
    keys.join(",") !== "file,platform,sha256,size,version" ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(manifest.version) ||
    manifest.platform !== EXPECTED_PLATFORM ||
    manifest.file !== EXPECTED_FILE ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    typeof manifest.size !== "number" ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0
  ) {
    throw releaseError("public/downloads/local-agent.json has invalid release metadata");
  }

  const executableUrl = new URL(manifest.file, DOWNLOADS_DIR);
  let actualSize: number;
  let actualSha256: string;
  try {
    actualSize = statSync(executableUrl).size;
    actualSha256 = sha256File(executableUrl);
  } catch (error) {
    throw releaseError(`Missing or unreadable public/downloads/${manifest.file}`, error);
  }
  if (actualSize !== manifest.size || actualSha256 !== manifest.sha256) {
    throw releaseError(
      `public/downloads/${manifest.file} does not match its manifest (expected ${manifest.size} bytes / ${manifest.sha256}, got ${actualSize} bytes / ${actualSha256})`,
    );
  }

  cachedRelease = manifest as unknown as LocalAgentRelease;
  return cachedRelease;
}
