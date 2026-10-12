import {
  ANALYTICS_ENDPOINT,
  ANALYTICS_VOTE_ENDPOINT,
  type ToolEvent,
  type ToolVote,
  type VoteChoice,
} from "./events.ts";

const REQUEST_TIMEOUT_MS = 3000;

function privacyDisabled(): boolean {
  if (typeof navigator === "undefined") return false;
  const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
  return navigator.onLine === false || privacy.doNotTrack === "1" || privacy.globalPrivacyControl === true;
}

function post(endpoint: string, payload: ToolEvent | ToolVote): Promise<Response> | null {
  try {
    if (privacyDisabled()) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify(payload),
      }).finally(() => clearTimeout(timeout));
    } catch {
      clearTimeout(timeout);
      return Promise.reject();
    }
  } catch {
    return null;
  }
}

/** Internal best-effort transport. Rebuild the closed union so excess runtime fields are never serialized. */
export function sendToolEvent(event: ToolEvent): void {
  let payload: ToolEvent;
  switch (event.event) {
    case "tool_completed":
      payload = { tool: event.tool, event: event.event, duration: event.duration };
      break;
    case "tool_failed":
      payload = { tool: event.tool, event: event.event, reason: event.reason };
      break;
    default:
      payload = { tool: event.tool, event: event.event };
  }
  void post(ANALYTICS_ENDPOINT, payload)?.catch(() => undefined);
}

/** Submit one anonymous fixed-choice vote. */
export async function sendVote(choice: VoteChoice): Promise<"accepted" | "disabled" | "failed"> {
  if (import.meta.env?.ANALYTICS_ENABLED !== true || privacyDisabled()) return "disabled";
  const request = post(ANALYTICS_VOTE_ENDPOINT, { choice });
  if (!request) return "disabled";
  try {
    const response = await request;
    return response.ok ? "accepted" : "failed";
  } catch {
    return "failed";
  }
}
