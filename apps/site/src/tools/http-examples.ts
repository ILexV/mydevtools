import type { LocalHttpResponse } from "../scripts/local-agent.ts";
import { isTextContentType, textDecoderFor } from "./http-response.ts";
import { HTTP_EXAMPLE_MAX_CHARS, HTTP_EXAMPLES_PER_REQUEST, type HttpExample } from "./http-workspace.ts";

/**
 * Saved responses ("examples" in Postman) of the HTTP client: a text response
 * kept with its request so it can be looked at again without sending, and
 * carried through Postman import and export.
 */
export type ExampleError = "binary" | "size" | "limit";

const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** Builds an example from a live response; only text bodies up to 256 KiB and 20 examples per request. */
export function exampleFromResponse(
  response: LocalHttpResponse, existing: readonly HttpExample[], id: string, now = Date.now(),
): HttpExample | { error: ExampleError } {
  if (existing.length >= HTTP_EXAMPLES_PER_REQUEST) return { error: "limit" };
  const type = response.headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
  const bytes = bytesOf(response.bodyBase64);
  if (bytes.byteLength && type && !isTextContentType(type)) return { error: "binary" };
  const body = textDecoderFor(type).decode(bytes);
  if (body.length > HTTP_EXAMPLE_MAX_CHARS) return { error: "size" };
  const base = `${response.status} ${response.statusText}`.trim();
  const names = new Set(existing.map((example) => example.name));
  let name = base;
  for (let copy = 2; names.has(name); copy++) name = `${base} (${copy})`;
  return { id, name, savedAt: now, status: response.status, statusText: response.statusText,
    headers: response.headers.map(({ name: header, value }) => ({ name: header, value })), body };
}

/** An example in the shape the response viewer takes; the body is re-encoded as UTF-8. */
export function responseFromExample(example: HttpExample): LocalHttpResponse {
  const bytes = new TextEncoder().encode(example.body);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  const headers = example.headers.map((header) => header.name.toLowerCase() === "content-type"
    ? { name: header.name, value: header.value.replace(/;\s*charset=[^;]+/iu, "; charset=utf-8") } : header);
  return { status: example.status, statusText: example.statusText, url: "", headers, bodyBase64: btoa(binary), elapsedMs: 0 };
}
