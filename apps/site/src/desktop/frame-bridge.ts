/**
 * postMessage protocol between the desktop shell and tool iframes. The shell
 * accepts only messages whose slug matches the frame that sent them; result
 * transfers carry text of an allow-listed media type and never reach storage.
 */

export const TRANSFER_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/html",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/jwt",
  "application/cron",
]);

export type FrameMessage =
  | { type: "mdt:frame-interactive" }
  | { type: "mdt:transfer-ready" }
  | { type: "mdt:tool-activity"; active: false }
  | { type: "mdt:tool-activity"; active: true; value: number | null; label: string }
  | { type: "mdt:transfer-request"; requestId: string; targetSlug: string; mediaType: string; payload: string }
  /** A tool with a linkable result finished wiring; the shell (re)sends its watch state. */
  | { type: "mdt:link-source-ready" }
  /** A watched result changed; the shell forwards it to every linked window. */
  | { type: "mdt:link-update"; mediaType: string; payload: string }
  /** "Return to desk" from a window moved into its own browser window. */
  | { type: "mdt:popout-return" };

export interface TransferDelivery {
  type: "mdt:transfer-deliver";
  requestId: string;
  targetSlug: string;
  mediaType: string;
  payload: string;
  /** Live link update: the target replaces its input without taking focus. */
  live?: boolean;
}

/** Validates a message from the frame showing `sourceSlug`; anything else is null. */
export function parseFrameMessage(data: unknown, sourceSlug: string, isTool: (slug: string) => boolean): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case "mdt:frame-interactive":
      return { type: "mdt:frame-interactive" };
    case "mdt:transfer-ready":
      return message.slug === sourceSlug ? { type: "mdt:transfer-ready" } : null;
    case "mdt:tool-activity":
      if (message.slug !== sourceSlug) return null;
      if (message.active !== true) return { type: "mdt:tool-activity", active: false };
      return {
        type: "mdt:tool-activity",
        active: true,
        value: typeof message.value === "number" && Number.isFinite(message.value) ? message.value : null,
        label: typeof message.label === "string" ? message.label.slice(0, 160) : "",
      };
    case "mdt:transfer-request":
      if (
        message.sourceSlug !== sourceSlug ||
        typeof message.requestId !== "string" ||
        typeof message.targetSlug !== "string" ||
        !isTool(message.targetSlug) ||
        typeof message.payload !== "string" ||
        typeof message.mediaType !== "string" ||
        !TRANSFER_MEDIA_TYPES.has(message.mediaType)
      ) {
        return null;
      }
      return {
        type: "mdt:transfer-request",
        requestId: message.requestId,
        targetSlug: message.targetSlug,
        mediaType: message.mediaType,
        payload: message.payload,
      };
    case "mdt:link-source-ready":
      return message.slug === sourceSlug ? { type: "mdt:link-source-ready" } : null;
    case "mdt:link-update":
      if (
        message.slug !== sourceSlug ||
        typeof message.payload !== "string" ||
        typeof message.mediaType !== "string" ||
        !TRANSFER_MEDIA_TYPES.has(message.mediaType)
      ) {
        return null;
      }
      return { type: "mdt:link-update", mediaType: message.mediaType, payload: message.payload };
    case "mdt:popout-return":
      return message.slug === sourceSlug ? { type: "mdt:popout-return" } : null;
    default:
      return null;
  }
}

/** Delivery of a live link update to the window that follows `sourceSlug`'s result. */
export function linkDelivery(linkId: string, targetSlug: string, update: Extract<FrameMessage, { type: "mdt:link-update" }>): TransferDelivery {
  return { type: "mdt:transfer-deliver", requestId: linkId, targetSlug, mediaType: update.mediaType, payload: update.payload, live: true };
}

export function transferDelivery(request: Extract<FrameMessage, { type: "mdt:transfer-request" }>): TransferDelivery {
  return {
    type: "mdt:transfer-deliver",
    requestId: request.requestId,
    targetSlug: request.targetSlug,
    mediaType: request.mediaType,
    payload: request.payload,
  };
}
