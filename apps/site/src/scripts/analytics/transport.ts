import { ANALYTICS_ENDPOINT, type ToolEventType, type ToolId } from "./events.ts";

const REQUEST_TIMEOUT_MS = 3000;

/** Internal transport. Never accepts user input, identifiers, or operation metadata. */
export function sendToolEvent(tool: ToolId, event: ToolEventType): void {
  try {
    if (typeof navigator !== "undefined") {
      const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
      if (navigator.onLine === false || privacy.doNotTrack === "1" || privacy.globalPrivacyControl === true) return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      void fetch(ANALYTICS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({ tool, event }),
      }).then(
        () => clearTimeout(timeout),
        () => clearTimeout(timeout),
      );
    } catch {
      clearTimeout(timeout);
    }
  } catch {
    // Telemetry is best effort: unavailable networking must not affect a tool.
  }
}
