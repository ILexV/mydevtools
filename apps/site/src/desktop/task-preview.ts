import "./task-preview.css";

const HOVER_DELAY = 180;
const HIDE_DELAY = 140;
const VIEWPORT_GAP = 8;
const POPUP_GAP = 8;

export function createTaskPreview(
  host: HTMLElement,
  options: {
    strings: Record<string, string>;
    describe: (id: string) => { title: string; state: "active" | "minimized" | "open"; dirty: boolean } | null;
    activate: (id: string) => void;
    close: (id: string) => Promise<void>;
  },
): { bind(button: HTMLButtonElement, id: string): void; hide(): void } {
  const popup = document.createElement("section");
  popup.id = "desk-task-preview";
  popup.className = "desk-task-preview";
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-labelledby", "desk-task-preview-title");
  popup.setAttribute("aria-describedby", "desk-task-preview-state");

  const title = document.createElement("h2");
  title.id = "desk-task-preview-title";
  title.className = "desk-task-preview-title";

  const details = document.createElement("div");
  details.className = "desk-task-preview-details";

  const state = document.createElement("span");
  state.id = "desk-task-preview-state";
  state.className = "desk-task-preview-state";

  const dirty = document.createElement("span");
  dirty.className = "desk-task-preview-dirty";
  dirty.textContent = options.strings.UnsavedInput || "UnsavedInput";
  dirty.hidden = true;
  details.append(state, dirty);

  const actions = document.createElement("div");
  actions.className = "desk-task-preview-actions";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "desk-task-preview-action ds-btn ds-btn-small ds-btn-primary";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "desk-task-preview-action ds-btn ds-btn-small";
  closeButton.textContent = options.strings.Close || "Close";
  actions.append(openButton, closeButton);
  popup.append(title, details, actions);
  document.body.append(popup);

  const ids = new WeakMap<HTMLButtonElement, string>();
  let activeTrigger: HTMLButtonElement | null = null;
  let activeId: string | null = null;
  let pointerTrigger: HTMLButtonElement | null = null;
  let pointerInPopup = false;
  let suppressedFocus: HTMLButtonElement | null = null;
  let openTimer = 0;
  let hideTimer = 0;

  function boundButton(target: EventTarget | null): HTMLButtonElement | null {
    if (!(target instanceof Element)) return null;
    const button = target.closest<HTMLButtonElement>("button");
    return button && host.contains(button) && ids.has(button) ? button : null;
  }

  function clearOpenTimer(): void {
    if (!openTimer) return;
    window.clearTimeout(openTimer);
    openTimer = 0;
  }

  function clearHideTimer(): void {
    if (!hideTimer) return;
    window.clearTimeout(hideTimer);
    hideTimer = 0;
  }

  function place(trigger: HTMLButtonElement): void {
    if (popup.hidden) return;
    const triggerBox = trigger.getBoundingClientRect();
    const popupBox = popup.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const maxLeft = Math.max(VIEWPORT_GAP, viewportWidth - popupBox.width - VIEWPORT_GAP);
    const maxTop = Math.max(VIEWPORT_GAP, viewportHeight - popupBox.height - VIEWPORT_GAP);
    const centered = triggerBox.left + triggerBox.width / 2 - popupBox.width / 2;
    const above = triggerBox.top - popupBox.height - POPUP_GAP;
    popup.style.left = `${Math.min(maxLeft, Math.max(VIEWPORT_GAP, centered))}px`;
    popup.style.top = `${Math.min(maxTop, Math.max(VIEWPORT_GAP, above))}px`;
  }

  function dismiss(restoreFocus: boolean): void {
    clearOpenTimer();
    clearHideTimer();
    const trigger = activeTrigger;
    const focusWasInside = popup.contains(document.activeElement);
    trigger?.setAttribute("aria-expanded", "false");
    popup.hidden = true;
    activeTrigger = null;
    activeId = null;
    pointerInPopup = false;
    pointerTrigger = null;
    if (!restoreFocus || !focusWasInside || !trigger?.isConnected) return;
    suppressedFocus = trigger;
    trigger.focus({ preventScroll: true });
    queueMicrotask(() => {
      if (suppressedFocus === trigger) suppressedFocus = null;
    });
  }

  function hide(): void {
    dismiss(true);
  }

  function show(trigger: HTMLButtonElement, id: string, focusAction: boolean): void {
    clearOpenTimer();
    clearHideTimer();
    if (!trigger.isConnected || !host.contains(trigger)) {
      dismiss(false);
      return;
    }
    const description = options.describe(id);
    if (!description) {
      dismiss(false);
      return;
    }
    if (activeTrigger !== trigger) activeTrigger?.setAttribute("aria-expanded", "false");
    activeTrigger = trigger;
    activeId = id;
    trigger.setAttribute("aria-expanded", "true");
    title.textContent = description.title;
    state.textContent =
      options.strings[
        description.state === "active" ? "ActiveWindow" : description.state === "minimized" ? "Minimized" : "WindowOpen"
      ] || description.state;
    dirty.hidden = !description.dirty;
    openButton.textContent = options.strings[description.state === "minimized" ? "Restore" : "Open"] ||
      (description.state === "minimized" ? "Restore" : "Open");
    popup.hidden = false;
    place(trigger);
    if (!focusAction) return;
    queueMicrotask(() => {
      if (!popup.hidden && activeTrigger === trigger && activeId === id) openButton.focus({ preventScroll: true });
    });
  }

  function scheduleShow(trigger: HTMLButtonElement): void {
    clearOpenTimer();
    clearHideTimer();
    const id = ids.get(trigger);
    if (!id) return;
    openTimer = window.setTimeout(() => {
      openTimer = 0;
      if (pointerTrigger === trigger) show(trigger, id, false);
    }, HOVER_DELAY);
  }

  function scheduleHide(): void {
    clearHideTimer();
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      const focus = document.activeElement;
      if (
        pointerTrigger === activeTrigger ||
        pointerInPopup ||
        focus === activeTrigger ||
        (focus instanceof Node && popup.contains(focus))
      ) {
        return;
      }
      dismiss(false);
    }, HIDE_DELAY);
  }

  host.addEventListener("pointerover", (event) => {
    const trigger = boundButton(event.target);
    if (!trigger) return;
    if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
    pointerTrigger = trigger;
    scheduleShow(trigger);
  });

  host.addEventListener("pointerout", (event) => {
    const trigger = boundButton(event.target);
    if (!trigger) return;
    if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
    if (pointerTrigger === trigger) pointerTrigger = null;
    clearOpenTimer();
    scheduleHide();
  });

  host.addEventListener("focusin", (event) => {
    const trigger = boundButton(event.target);
    if (!trigger) return;
    if (suppressedFocus === trigger) return;
    const id = ids.get(trigger);
    if (id) show(trigger, id, false);
  });

  host.addEventListener("focusout", (event) => {
    const trigger = boundButton(event.target);
    if (!trigger) return;
    if (event.relatedTarget instanceof Node && popup.contains(event.relatedTarget)) return;
    scheduleHide();
  });

  host.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp") return;
    const trigger = boundButton(event.target);
    if (!trigger) return;
    const id = ids.get(trigger);
    if (!id) return;
    event.preventDefault();
    show(trigger, id, true);
  });

  popup.addEventListener("pointerenter", () => {
    pointerInPopup = true;
    clearHideTimer();
  });

  popup.addEventListener("pointerleave", () => {
    pointerInPopup = false;
    scheduleHide();
  });

  popup.addEventListener("focusin", clearHideTimer);
  popup.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && popup.contains(event.relatedTarget)) return;
    scheduleHide();
  });

  popup.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || (event.key === "Tab" && event.shiftKey && document.activeElement === openButton)) {
      event.preventDefault();
      dismiss(true);
    }
  });

  openButton.addEventListener("click", () => {
    const id = activeId;
    if (!id || !options.describe(id)) {
      dismiss(false);
      return;
    }
    dismiss(true);
    options.activate(id);
  });

  closeButton.addEventListener("click", () => {
    const id = activeId;
    if (!id || !options.describe(id)) {
      dismiss(false);
      return;
    }
    dismiss(true);
    void options.close(id);
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (popup.hidden || !(event.target instanceof Node)) return;
      if (popup.contains(event.target) || activeTrigger?.contains(event.target)) return;
      dismiss(false);
    },
    true,
  );

  document.addEventListener("focusin", (event) => {
    if (popup.hidden || !(event.target instanceof Node)) return;
    if (popup.contains(event.target) || activeTrigger?.contains(event.target)) return;
    dismiss(false);
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (popup.hidden || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    },
    true,
  );

  return {
    bind(button, id) {
      ids.set(button, id);
      if (button.title && !button.hasAttribute("aria-label")) button.setAttribute("aria-label", button.title);
      button.removeAttribute("title");
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-controls", popup.id);
      button.setAttribute("aria-expanded", "false");
    },
    hide,
  };
}
