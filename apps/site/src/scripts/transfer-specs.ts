/**
 * Result hand-off adapters shared by tool pages and the desktop shell: which
 * output each tool can send (and as what media type), which inputs accept it,
 * and which tools may receive each type. Used by "Open in…", live window links
 * and dragging a result between desktop windows.
 */

export type TransferMediaType = "text/plain" | "text/html" | "application/json" | "application/xml" | "application/yaml" | "application/jwt" | "application/cron";

export interface SourceSpec {
  panel: string;
  actions?: string;
  value: string;
  read: "value" | "text" | "html" | "codemirror" | "data-copy-lines";
  mediaType: TransferMediaType;
}

export interface TargetSpec {
  root: string;
  input: string;
  write: "value" | "codemirror";
  action?: string;
}

export const TEXT_TARGETS = ["base64-encoder", "hash-calculator", "url-encoder", "text-case-converter"] as const;
export const STRUCTURED_TARGETS: Record<TransferMediaType, readonly string[]> = {
  "text/plain": TEXT_TARGETS,
  "text/html": ["html-entity-encoder", "base64-encoder", "hash-calculator"],
  "application/json": ["json-beautifier", "json-to-typescript", "base64-encoder", "hash-calculator"],
  "application/xml": ["xml-beautifier", "base64-encoder", "hash-calculator"],
  "application/yaml": ["yaml-beautifier-validator", "base64-encoder", "hash-calculator"],
  "application/jwt": ["jwt-decoder", "hash-calculator", "base64-encoder"],
  "application/cron": ["cron-parser", "hash-calculator", "base64-encoder"],
};

/** Exact result adapters: no positional textarea guessing. */
export const SOURCES: Record<string, SourceSpec> = {
  "base64-encoder": { panel: "[data-b64-output-panel]", value: "[data-b64-output]", read: "value", mediaType: "text/plain" },
  "base32-encoder": { panel: "[data-b32-output-panel]", value: "[data-b32-output]", read: "value", mediaType: "text/plain" },
  "base58-encoder": { panel: "[data-b58-output-panel]", value: "[data-b58-output]", read: "value", mediaType: "text/plain" },
  "hex-encoder": { panel: "[data-hex-output-panel]", value: "[data-hex-output]", read: "value", mediaType: "text/plain" },
  "url-encoder": { panel: "[data-url-output-panel]", value: "[data-url-output]", read: "value", mediaType: "text/plain" },
  "html-entity-encoder": { panel: "[data-ent-output-panel]", value: "[data-ent-output]", read: "value", mediaType: "text/plain" },
  "date-converter": { panel: "[data-date-output-panel]", value: "[data-date-output]", read: "value", mediaType: "text/plain" },
  "hmac-calculator": { panel: "[data-hmac-output-panel]", value: "[data-hmac-output]", read: "value", mediaType: "text/plain" },
  "lorem-ipsum-generator": { panel: "[data-lorem-tool] .ds-output", value: "[data-li-output]", read: "value", mediaType: "text/plain" },
  "password-generator": { panel: "[data-pw-result-panel]", value: "[data-pw-result]", read: "text", mediaType: "text/plain" },
  "qr-scanner": { panel: "[data-qrs-result]", value: "[data-qrs-output]", read: "value", mediaType: "text/plain" },
  "uuid-generator": { panel: "[data-uuid-output]", value: "[data-uuid-list]", read: "data-copy-lines", mediaType: "text/plain" },
  "jwt-encoder": { panel: "[data-jwte-output-panel]", value: "[data-jwte-output]", read: "value", mediaType: "application/jwt" },
  "jwt-decoder": { panel: "[data-jwtd-output]", value: "[data-jwtd-payload]", read: "value", mediaType: "application/json" },
  "cron-generator": { panel: "[data-crong-output-panel]", value: "[data-crong-output]", read: "text", mediaType: "application/cron" },
  "json-to-typescript": { panel: "[data-jts-output-panel]", value: "[data-jts-output]", read: "codemirror", mediaType: "text/plain" },
  "yaml-beautifier-validator": { panel: "[data-yaml-output-panel]", value: "[data-yaml-output]", read: "codemirror", mediaType: "application/yaml" },
  "json-beautifier": { panel: "[data-json-tool] > .ds-card", actions: "[data-json-tool] > .ds-card > .ds-panel-head .ds-panel-actions", value: "[data-json-editor]", read: "codemirror", mediaType: "application/json" },
  "xml-beautifier": { panel: "[data-xml-tool] > .ds-card", actions: "[data-xml-tool] > .ds-card > .ds-panel-head .ds-panel-actions", value: "[data-xml-editor]", read: "codemirror", mediaType: "application/xml" },
  "text-case-converter": { panel: "[data-tcc-tool] > .ds-card", actions: "[data-tcc-tool] > .ds-card > .ds-panel-head .ds-panel-actions", value: "[data-tcc-textarea]", read: "value", mediaType: "text/plain" },
  "markdown-preview": { panel: "[data-md-output-panel]", value: "[data-md-output]", read: "html", mediaType: "text/html" },
  "pdf-to-text": { panel: "[data-pdft-result]", value: "[data-pdft-preview]", read: "value", mediaType: "text/plain" },
};

/** Exact input adapters and their useful default action. */
export const TARGETS: Record<string, TargetSpec> = {
  "base64-encoder": { root: "[data-b64-tool]", input: "[data-b64-input]", write: "value", action: "[data-b64-encode]" },
  "hash-calculator": { root: "[data-hash-tool]", input: "[data-hash-textarea]", write: "value", action: "[data-hash-calculate]" },
  "url-encoder": { root: "[data-url-tool]", input: "[data-url-input]", write: "value", action: "[data-url-encode]" },
  "html-entity-encoder": { root: "[data-ent-tool]", input: "[data-ent-input]", write: "value", action: "[data-ent-encode]" },
  "text-case-converter": { root: "[data-tcc-tool]", input: "[data-tcc-textarea]", write: "value" },
  "json-beautifier": { root: "[data-json-tool]", input: "[data-json-editor]", write: "codemirror", action: "[data-json-format]" },
  "json-to-typescript": { root: "[data-jts-tool]", input: "[data-jts-input]", write: "codemirror", action: "[data-jts-convert]" },
  "xml-beautifier": { root: "[data-xml-tool]", input: "[data-xml-editor]", write: "codemirror", action: "[data-xml-format]" },
  "yaml-beautifier-validator": { root: "[data-yaml-tool]", input: "[data-yaml-input]", write: "codemirror", action: "[data-yaml-format]" },
  "jwt-decoder": { root: "[data-jwtd-tool]", input: "[data-jwtd-encoded]", write: "value" },
  "cron-parser": { root: "[data-cronp-tool]", input: "[data-cronp-input]", write: "value", action: "[data-cronp-parse]" },
};

export function isTransferMediaType(value: string): value is TransferMediaType {
  return Object.hasOwn(STRUCTURED_TARGETS, value);
}

/** Tools that can receive this tool's result, in menu order. */
export function resultTargets(sourceSlug: string): readonly string[] {
  const source = SOURCES[sourceSlug];
  return source ? STRUCTURED_TARGETS[source.mediaType].filter((slug) => slug !== sourceSlug) : [];
}

/** Can `targetSlug`'s input take `sourceSlug`'s result (Open in…, live link)? */
export function canReceive(sourceSlug: string, targetSlug: string): boolean {
  return Boolean(TARGETS[targetSlug]) && resultTargets(sourceSlug).includes(targetSlug);
}
