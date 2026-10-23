import { SOURCES, STRUCTURED_TARGETS, TARGETS, type SourceSpec, type TargetSpec, type TransferMediaType } from "@/scripts/transfer-specs";

interface TransferTarget {
  slug: string;
  title: string;
  href: string;
}

interface TransferStrings {
  slug: string;
  openIn: string;
  dragResult?: string;
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
  /** Live window link: replace the input quietly, without focus or an announcement. */
  live?: boolean;
}

/** Live links push a result again only when it changes, and never above this size. */
const LINK_MAX_PAYLOAD = 8_000_000;
const LINK_DEBOUNCE_MS = 250;
/** Tools set result fields through `.value`, which no DOM event reports: a followed result is also re-read this often. */
const LINK_POLL_MS = 400;

interface EditorReadDetail {
  value?: string;
  length?: number;
  includeValue?: boolean;
}

interface EditorWriteDetail {
  value: string;
  accepted?: boolean;
}

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
  const params = new URLSearchParams(window.location.search);
  const embedded = window.parent !== window && params.get("embed") === "1";
  // A desktop window moved into its own browser window keeps talking to the desk that opened it.
  const popout = !embedded && params.get("embed") === "1" && params.get("popout") === "1" && sameOriginOpener();
  const shell: Window | null = embedded ? window.parent : popout ? window.opener as Window : null;
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
    if (event.data.type === "mdt:link-watch") {
      if (shell && event.source === shell) linkWatch?.(event.data.watching === true);
      return;
    }
    if (event.data.type !== "mdt:transfer-deliver") return;
    const delivery = parseDelivery(event.data, strings.slug);
    if (!delivery || !target) return;
    const trustedDesktop = Boolean(shell) && event.source === shell;
    const trustedPopup = Boolean(transferToken && event.source === window.opener && delivery.requestId === transferToken);
    if (!trustedDesktop && !trustedPopup) return;
    const live = trustedDesktop && delivery.live === true;
    if (applyTransfer(target, delivery.payload, live) && !live) announce(strings.received);
  };
  window.addEventListener("message", onMessage);

  if (target) {
    whenTargetReady(target, () => {
      const postReady = () => {
        const ready = { type: "mdt:transfer-ready", slug: strings.slug, requestId: transferToken ?? undefined };
        if (shell) shell.postMessage(ready, exactOrigin);
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

  /** Set while a desktop window links this tool's result to another window's input. */
  let linkWatch: ((watching: boolean) => void) | null = null;
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

    // Desktop windows: drag the result onto another window's field or onto the desk.
    let grip: HTMLButtonElement | null = null;
    if (shell && strings.dragResult) {
      grip = document.createElement("button");
      grip.type = "button";
      grip.className = "ds-btn ds-btn-small ds-btn-ghost mdt-transfer-drag";
      grip.draggable = true;
      grip.textContent = "⠿";
      grip.title = strings.dragResult;
      grip.setAttribute("aria-label", strings.dragResult);
      grip.addEventListener("dragstart", (event) => {
        const payload = readSource(spec, valueNode);
        if (!payload || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("text/plain", payload);
        event.dataTransfer.setData("application/x-mdt-transfer", JSON.stringify({ sourceSlug: strings.slug, mediaType: spec.mediaType }));
      });
      actions.append(grip);
    }

    if (shell) {
      let watching = false;
      let lastSent: string | null = null;
      let timer = 0;
      const push = () => {
        timer = 0;
        if (!watching) return;
        // An empty result (cleared or not computed yet) never wipes the follower's input.
        const payload = hasSourceValue(spec, valueNode) ? readSource(spec, valueNode) : "";
        if (!payload || payload === lastSent || payload.length > LINK_MAX_PAYLOAD) return;
        lastSent = payload;
        shell.postMessage({ type: "mdt:link-update", slug: strings.slug, mediaType: spec.mediaType, payload }, exactOrigin);
      };
      const schedulePush = () => {
        if (!watching) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(push, LINK_DEBOUNCE_MS);
      };
      let poll = 0;
      linkWatch = (next) => {
        watching = next;
        lastSent = null;
        window.clearInterval(poll);
        poll = next ? window.setInterval(push, LINK_POLL_MS) : 0;
        if (next) schedulePush();
      };
      const linkObserver = new MutationObserver(schedulePush);
      linkObserver.observe(valueNode, { attributes: true, childList: true, characterData: true, subtree: true });
      valueNode.addEventListener("input", schedulePush);
      panel.addEventListener("input", schedulePush);
      shell.postMessage({ type: "mdt:link-source-ready", slug: strings.slug }, exactOrigin);
    }

    let syncScheduled = false;
    const sync = () => {
      syncScheduled = false;
      const disabled = !hasSourceValue(spec, valueNode);
      if (summary.getAttribute("aria-disabled") !== String(disabled)) {
        summary.setAttribute("aria-disabled", String(disabled));
      }
      if (details.classList.contains("is-disabled") !== disabled) details.classList.toggle("is-disabled", disabled);
      if (grip && grip.draggable === disabled) {
        grip.draggable = !disabled;
        grip.disabled = disabled;
      }
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
    if (shell) {
      shell.postMessage(request, exactOrigin);
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

function applyTransfer(spec: TargetSpec, payload: string, live = false): boolean {
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
    if (!live) input.focus({ preventScroll: true });
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
  return { type: "mdt:transfer-deliver", requestId, targetSlug: slug, mediaType, payload, live: value.live === true };
}

function sameOriginOpener(): boolean {
  try {
    return Boolean(window.opener) && (window.opener as Window).location.origin === window.location.origin;
  } catch {
    return false;
  }
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
