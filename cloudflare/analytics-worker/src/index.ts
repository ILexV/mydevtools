import { ANALYTICS_ENDPOINT } from "../../../apps/site/src/scripts/analytics/events.ts";
import { validateToolEvent } from "./validation.ts";

const MAX_BODY_BYTES = 512;

export interface Env {
  ALLOWED_BROWSER_ORIGIN: string;
  TOOL_ANALYTICS: AnalyticsEngineDataset;
}

type BodyResult =
  | { status: "ok"; text: string }
  | { status: "invalid" }
  | { status: "too-large" };

function response(status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

function acceptsJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const parts = contentType.split(";");
  if (parts[0]?.trim().toLowerCase() !== "application/json") return false;
  if (parts.length === 1) return true;
  if (parts.length !== 2) return false;
  return /^charset\s*=\s*(?:utf-8|"utf-8")$/i.test(parts[1]!.trim());
}

function hasAllowedBrowserSource(headers: Headers, allowedOrigin: string): boolean {
  const origin = headers.get("Origin");
  if (origin !== null && origin !== allowedOrigin) return false;

  const fetchSite = headers.get("Sec-Fetch-Site");
  return fetchSite === null || fetchSite.toLowerCase() === "same-origin";
}

async function readBoundedBody(request: Request): Promise<BodyResult> {
  const contentLength = request.headers.get("Content-Length");
  let declaredLength: number | undefined;
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) return { status: "invalid" };
    if (contentLength.length > 3 || Number(contentLength) > MAX_BODY_BYTES) {
      return { status: "too-large" };
    }
    declaredLength = Number(contentLength);
  }

  if (request.body === null) return { status: "invalid" };

  const bytes = new Uint8Array(MAX_BODY_BYTES);
  const reader = request.body.getReader();
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The body is already rejected; cancellation is best effort.
        }
        return { status: "too-large" };
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch {
    return { status: "invalid" };
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && declaredLength !== length) {
    return { status: "invalid" };
  }

  try {
    return {
      status: "ok",
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)),
    };
  } catch {
    return { status: "invalid" };
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== ANALYTICS_ENDPOINT || url.search !== "") return response(404);
  if (request.method !== "POST") return response(405, { Allow: "POST" });
  const allowedOrigin =
    env.ALLOWED_BROWSER_ORIGIN === "self" ? url.origin : env.ALLOWED_BROWSER_ORIGIN;
  if (!hasAllowedBrowserSource(request.headers, allowedOrigin)) {
    return response(403);
  }
  if (!acceptsJson(request.headers.get("Content-Type"))) return response(400);
  if (request.headers.has("Content-Encoding")) return response(400);

  const body = await readBoundedBody(request);
  if (body.status === "too-large") return response(413);
  if (body.status === "invalid") return response(400);

  const event = validateToolEvent(body.text);
  if (event === null) return response(400);

  try {
    env.TOOL_ANALYTICS.writeDataPoint({
      blobs: [event.tool, event.event],
      doubles: [1],
      indexes: [event.tool],
    });
  } catch {
    return response(500);
  }

  return response(204);
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
