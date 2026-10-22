import { encodeQueryComponent } from "./http-variables.ts";
import type { HttpFileRef, HttpSavedRequest } from "./http-workspace.ts";

/**
 * Request body encoders of the HTTP client Body tab: x-www-form-urlencoded,
 * multipart/form-data with files and the GraphQL JSON payload. Text fields are
 * resolved by the caller; `{{secret:…}}` stays literal for the agent.
 */
export type BodyFields = Pick<HttpSavedRequest, "body" | "bodyFormat" | "bodyMode" | "urlencoded" | "formdata" | "binary" | "graphql">;

const encoder = new TextEncoder();

/** `a=1&b=2`, percent-encoded except `{{…}}` placeholders. */
export function encodeUrlencoded(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([name, value]) => `${encodeQueryComponent(name)}=${encodeQueryComponent(value)}`).join("&");
}

export type MultipartPart =
  | { name: string; value: string }
  | { name: string; file: { name: string; type: string; bytes: Uint8Array } };

/** Quotes a name in Content-Disposition the way browsers do (WHATWG form encoding). */
function quoted(text: string): string {
  return text.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function multipartBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `----MyDevToolsBoundary${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** multipart/form-data body (RFC 7578); text parts are UTF-8 without their own Content-Type. */
export function encodeMultipart(parts: readonly MultipartPart[], boundary: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(part.name)}"`;
    if ("file" in part) {
      head += `; filename="${quoted(part.file.name)}"\r\nContent-Type: ${part.file.type || "application/octet-stream"}`;
    }
    chunks.push(encoder.encode(`${head}\r\n\r\n`), "file" in part ? part.file.bytes : encoder.encode(part.value), encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** `{"query":…,"variables":…}`; null when the variables are not a JSON object. */
export function graphqlPayload(query: string, variables: string): string | null {
  if (!variables.trim()) return JSON.stringify({ query });
  let parsed: unknown;
  try {
    parsed = JSON.parse(variables);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return JSON.stringify({ query, variables: parsed });
}

/** Texts of the active body mode that may hold `{{vars}}` (files never do). */
export function bodyTexts(fields: BodyFields): string[] {
  switch (fields.bodyMode ?? "raw") {
    case "raw": return [fields.body];
    case "urlencoded": return (fields.urlencoded ?? []).filter((row) => row.enabled).flatMap((row) => [row.name, row.value]);
    case "formdata": return (fields.formdata ?? []).filter((row) => row.enabled)
      .flatMap((row) => row.kind === "text" ? [row.name, row.value] : [row.name]);
    case "graphql": return fields.graphql ? [fields.graphql.query, fields.graphql.variables] : [];
    default: return [];
  }
}

/** True when the active mode has something to send (the Body tab mark). */
export function hasBody(fields: BodyFields): boolean {
  switch (fields.bodyMode ?? "raw") {
    case "raw": return fields.body.length > 0;
    case "urlencoded": return (fields.urlencoded ?? []).some((row) => row.enabled && row.name);
    case "formdata": return (fields.formdata ?? []).some((row) => row.enabled && row.name);
    case "binary": return !!fields.binary;
    case "graphql": return !!fields.graphql?.query.trim();
    default: return false;
  }
}

export type FileBytes = (ref: HttpFileRef) => Promise<Uint8Array | null>;
