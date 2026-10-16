type TransferMediaType = "text/plain" | "text/html" | "application/json" | "application/xml" | "application/yaml" | "application/jwt" | "application/cron";

interface TransferTarget {
  slug: string;
  title: string;
  href: string;
}

interface TransferStrings {
  slug: string;
  openIn: string;
  received: string;
  popupBlocked: string;
  targets: TransferTarget[];
}

interface TransferRequest {
  type: "mdt:transfer-request";
  requestId: string;
  sourceSlug: string;
  targetSlug: string;
  mediaType: TransferMediaType;
  payload: string;
}

interface TransferDelivery {
  type: "mdt:transfer-deliver";
  requestId: string;
  targetSlug: string;
  mediaType: TransferMediaType;
  payload: string;
}

interface SourceSpec {
  panel: string;
  actions?: string;
  value: string;
  read: "value" | "text" | "html" | "codemirror" | "data-copy-lines";
  mediaType: TransferMediaType;
}

interface TargetSpec {
  root: string;
  input: string;
  write: "value" | "codemirror";
  action?: string;
}

interface EditorReadDetail {
  value?: string;
  length?: number;
  includeValue?: boolean;
}

interface EditorWriteDetail {
  value: string;
  accepted?: boolean;
}

const TEXT_TARGETS = ["base64-encoder", "hash-calculator", "url-encoder", "text-case-converter"] as const;
const STRUCTURED_TARGETS: Record<TransferMediaType, readonly string[]> = {
  "text/plain": TEXT_TARGETS,
  "text/html": ["html-entity-encoder", "base64-encoder", "hash-calculator"],
  "application/json": ["json-beautifier", "json-to-typescript", "base64-encoder", "hash-calculator"],
  "application/xml": ["xml-beautifier", "base64-encoder", "hash-calculator"],
  "application/yaml": ["yaml-beautifier-validator", "base64-encoder", "hash-calculator"],
  "application/jwt": ["jwt-decoder", "hash-calculator", "base64-encoder"],
  "application/cron": ["cron-parser", "hash-calculator", "base64-encoder"],
};

/** Exact result adapters: no positional textarea guessing. */
const SOURCES: Record<string, SourceSpec> = {
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
const TARGETS: Record<string, TargetSpec> = {
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

const island = document.querySelector<HTMLScriptElement>("[data-transfer-strings]");
if (island) {
  try {
    init(JSON.parse(island.textContent || "{}") as TransferStrings);
  } catch {
    // A malformed build-time island disables this enhancement without affecting the tool.
  }
}

function init(strings: TransferStrings): void {
  if (!strings.slug || !Array.isArray(strings.targets)) return;
  const exactOrigin = window.location.origin;
  const embedded = window.parent !== window && new URLSearchParams(window.location.search).get("embed") === "1";
  const targetBySlug: Record<string, TransferTarget> = Object.fromEntries(strings.targets.map((target) => [target.slug, target]));
  const source = SOURCES[strings.slug];
  const target = TARGETS[strings.slug];
  const transferToken = new URLSearchParams(window.location.search).get("transfer");
  const pendingWindows = new Map<string, { window: Window; request: TransferRequest }>();
  const live = document.createElement("p");
  live.className = "visually-hidden";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  document.body.append(live);

  if (transferToken) {
    const url = new URL(window.location.href);
    url.searchParams.delete("transfer");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  const announce = (message: string) => {
    live.textContent = "";
    window.setTimeout(() => { live.textContent = message; }, 0);
  };

  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.origin !== exactOrigin || !isObject(event.data)) return;
    if (event.data.type === "mdt:transfer-ready") {
      const requestId = stringField(event.data, "requestId");
      const pending = requestId ? pendingWindows.get(requestId) : undefined;
      if (!pending || event.source !== pending.window || stringField(event.data, "slug") !== pending.request.targetSlug) return;
      pending.window.postMessage({
        type: "mdt:transfer-deliver",
        requestId: pending.request.requestId,
        targetSlug: pending.request.targetSlug,
        mediaType: pending.request.mediaType,
        payload: pending.request.payload,
      } satisfies TransferDelivery, exactOrigin);
      pendingWindows.delete(pending.request.requestId);
      return;
    }
    if (event.data.type !== "mdt:transfer-deliver") return;
    const delivery = parseDelivery(event.data, strings.slug);
    if (!delivery || !target) return;
    const trustedDesktop = embedded && event.source === window.parent;
    const trustedPopup = Boolean(transferToken && event.source === window.opener && delivery.requestId === transferToken);
    if (!trustedDesktop && !trustedPopup) return;
    if (applyTransfer(target, delivery.payload)) announce(strings.received);
  };
  window.addEventListener("message", onMessage);

  if (target) {
    whenTargetReady(target, () => {
      const postReady = () => {
        const ready = { type: "mdt:transfer-ready", slug: strings.slug, requestId: transferToken ?? undefined };
        if (embedded) window.parent.postMessage(ready, exactOrigin);
        else if (transferToken && window.opener) window.opener.postMessage(ready, exactOrigin);
      };
      if (document.readyState === "complete") {
        postReady();
      } else {
        // Wait one task beyond load: the shell's iframe load handler installs
        // dirty tracking before queued transfer payloads can be delivered.
        window.addEventListener("load", () => window.setTimeout(postReady, 0), { once: true });
      }
    });
  }

  if (source) installSourceAction(source);
  if (embedded) observeProgress(strings.slug, exactOrigin);

  function installSourceAction(spec: SourceSpec): void {
    const panel = document.querySelector<HTMLElement>(spec.panel);
    const valueNode = document.querySelector<HTMLElement>(spec.value);
    if (!panel || !valueNode) return;
    let actions = spec.actions ? document.querySelector<HTMLElement>(spec.actions) : panel.querySelector<HTMLElement>(".ds-panel-actions, .ds-actions");
    if (!actions) {
      const head = panel.querySelector<HTMLElement>(".ds-panel-head, .ds-output-head");
      if (!head) return;
      actions = document.createElement("div");
      actions.className = head.classList.contains("ds-panel-head") ? "ds-panel-actions" : "ds-actions";
      head.append(actions);
    }

    const slugs = STRUCTURED_TARGETS[spec.mediaType];
    const options = slugs
      .filter((slug) => slug !== strings.slug)
      .map((slug) => targetBySlug[slug])
      .filter((item): item is TransferTarget => Boolean(item));
    if (options.length === 0) return;

    const details = document.createElement("details");
    details.className = "mdt-transfer";
    const summary = document.createElement("summary");
    summary.className = "ds-btn ds-btn-small ds-btn-ghost";
    summary.textContent = strings.openIn;
    const menu = document.createElement("div");
    menu.className = "mdt-transfer-menu";
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mdt-transfer-option";
      button.textContent = option.title;
      button.addEventListener("click", () => {
        const payload = readSource(spec, valueNode);
        if (!payload) return;
        details.open = false;
        send(option, spec.mediaType, payload);
      });
      menu.append(button);
    }
    details.append(summary, menu);
    actions.append(details);

    let syncScheduled = false;
    const sync = () => {
      syncScheduled = false;
      const disabled = !hasSourceValue(spec, valueNode);
      if (summary.getAttribute("aria-disabled") !== String(disabled)) {
        summary.setAttribute("aria-disabled", String(disabled));
      }
      if (details.classList.contains("is-disabled") !== disabled) details.classList.toggle("is-disabled", disabled);
      if (disabled && details.open) details.open = false;
    };
    const scheduleSync = () => {
      if (syncScheduled) return;
      syncScheduled = true;
      requestAnimationFrame(sync);
    };
    summary.addEventListener("click", (event) => {
      sync();
      if (summary.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
    panel.addEventListener("input", scheduleSync);
    panel.addEventListener("click", scheduleSync);
    const observer = new MutationObserver(scheduleSync);
    observer.observe(panel, { attributes: true, attributeFilter: ["class", "hidden"] });
    observer.observe(valueNode, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }

  function send(option: TransferTarget, mediaType: TransferMediaType, payload: string): void {
    const request: TransferRequest = {
      type: "mdt:transfer-request",
      requestId: crypto.randomUUID(),
      sourceSlug: strings.slug,
      targetSlug: option.slug,
      mediaType,
      payload,
    };
    if (embedded) {
      window.parent.postMessage(request, exactOrigin);
      return;
    }
    const url = new URL(option.href, window.location.href);
    url.searchParams.set("transfer", request.requestId);
    const opened = window.open(url.href, "_blank");
    if (!opened) {
      announce(strings.popupBlocked);
      return;
    }
    pendingWindows.set(request.requestId, { window: opened, request });
  }
}

function hasSourceValue(spec: SourceSpec, node: HTMLElement): boolean {
  if (spec.read === "value") {
    return (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.value.length > 0;
  }
  if (spec.read === "data-copy-lines") return node.querySelector("[data-copy]") !== null;
  if (spec.read === "html") return node.childNodes.length > 0;
  if (spec.read === "text") return (node.textContent?.length ?? 0) > 0;
  const detail: EditorReadDetail = {};
  node.dispatchEvent(new CustomEvent<EditorReadDetail>("mdt:transfer-read", { detail }));
  return (detail.length ?? 0) > 0;
}

function readSource(spec: SourceSpec, node: HTMLElement): string {
  if (spec.read === "value") return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : "";
  if (spec.read === "text") return node.textContent ?? "";
  if (spec.read === "html") return node.innerHTML;
  if (spec.read === "data-copy-lines") {
    return [...node.querySelectorAll<HTMLElement>("[data-copy]")]
      .map((item) => item.dataset.copy ?? "")
      .filter(Boolean)
      .join("\n");
  }
  const detail: EditorReadDetail = { includeValue: true };
  node.dispatchEvent(new CustomEvent<EditorReadDetail>("mdt:transfer-read", { detail }));
  return detail.value ?? "";
}

function applyTransfer(spec: TargetSpec, payload: string): boolean {
  const input = document.querySelector<HTMLElement>(spec.input);
  if (!input) return false;
  if (spec.write === "codemirror") {
    if (input.dataset.transferEditorReady !== "true") return false;
    document.dispatchEvent(new Event("mdt:transferred-input"));
    const detail: EditorWriteDetail = { value: payload };
    input.dispatchEvent(new CustomEvent<EditorWriteDetail>("mdt:transfer-write", { detail }));
    if (!detail.accepted) return false;
  } else {
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
    document.dispatchEvent(new Event("mdt:transferred-input"));
    input.value = payload;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus({ preventScroll: true });
  }
  const action = spec.action ? document.querySelector<HTMLButtonElement>(spec.action) : null;
  if (action && !action.disabled) action.click();
  return true;
}

function whenTargetReady(spec: TargetSpec, apply: () => void): void {
  const ready = () => {
    const root = document.querySelector<HTMLElement>(spec.root);
    const input = document.querySelector<HTMLElement>(spec.input);
    if (!root || !input) return false;
    if (spec.write === "value") return true;
    const editors = [...root.querySelectorAll<HTMLElement>(".mdt-cm")];
    return editors.length > 0 && editors.every((editor) => editor.dataset.transferEditorReady === "true");
  };
  // Controllers bind their action listeners immediately after constructing
  // their editors. A task boundary lets that async continuation complete.
  const finish = () => window.setTimeout(apply, 0);
  if (ready()) {
    finish();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!ready()) return;
    observer.disconnect();
    finish();
  });
  observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
}

function parseDelivery(value: Record<string, unknown>, targetSlug: string): TransferDelivery | null {
  const requestId = stringField(value, "requestId");
  const slug = stringField(value, "targetSlug");
  const mediaType = stringField(value, "mediaType") as TransferMediaType | null;
  const payload = stringField(value, "payload");
  if (!requestId || slug !== targetSlug || !mediaType || payload === null) return null;
  if (!(mediaType in STRUCTURED_TARGETS)) return null;
  if (!STRUCTURED_TARGETS[mediaType].includes(targetSlug)) return null;
  return { type: "mdt:transfer-deliver", requestId, targetSlug: slug, mediaType, payload };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function observeProgress(slug: string, exactOrigin: string): void {
  const blocks = [...document.querySelectorAll<HTMLElement>(".ds-progress-block")];
  if (blocks.length === 0) return;
  let scheduled = false;
  let previous = "";
  const publish = () => {
    scheduled = false;
    const block = blocks.find((item) => {
      if (item.hidden) return false;
      const progressbar = item.querySelector<HTMLElement>("[role='progressbar']");
      return !progressbar || !progressbar.hidden;
    });
    const bar = block?.querySelector<HTMLElement>("[role='progressbar']");
    const raw = bar?.getAttribute("aria-valuenow") ?? block?.querySelector<HTMLElement>(".ds-progress > i")?.style.width ?? "";
    const parsed = Number.parseFloat(raw);
    const value = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
    const label = block?.querySelector<HTMLElement>(".ds-progress-title")?.textContent?.trim() ?? "";
    const message = { type: "mdt:tool-activity", slug, active: Boolean(block), value, label };
    const serialized = JSON.stringify(message);
    if (serialized === previous) return;
    previous = serialized;
    window.parent.postMessage(message, exactOrigin);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(publish);
  };
  const observer = new MutationObserver(schedule);
  for (const block of blocks) observer.observe(block, { attributes: true, attributeFilter: ["hidden", "aria-valuenow", "style"], childList: true, characterData: true, subtree: true });
  window.addEventListener("pagehide", () => {
    window.parent.postMessage({ type: "mdt:tool-activity", slug, active: false, value: null, label: "" }, exactOrigin);
  }, { once: true });
  schedule();
}
