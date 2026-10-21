/**
 * Local agent connection popover (`components/tool/AgentConnection.astro`), shared by
 * every network tool so pairing looks and behaves the same everywhere.
 * Opens on its own only when the user has to act: no saved session, a connection error,
 * or a missing capability. Closes once connected. Escape closes it. LAN policy comes from agent info.
 */
import type { LocalAgentClient } from "@/scripts/local-agent";

const SESSION_STORAGE_KEY = "mdt.local-agent.session.v1";

export interface AgentPopover {
  /** Re-reads the client state after a connect, restore or disconnect. */
  sync(client: LocalAgentClient): void;
}

function hasSavedSession(): boolean {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) !== null;
  } catch {
    // Blocked storage means there cannot be a restorable browser session.
    return false;
  }
}

export function bindAgentPopover(details: HTMLDetailsElement): AgentPopover {
  const setup = details.querySelector<HTMLDetailsElement>("[data-agent-setup]");
  const lan = details.querySelector<HTMLElement>("[data-agent-lan]");
  const attention = [...details.querySelectorAll<HTMLElement>("[data-agent-attention]")];
  details.open = !hasSavedSession();
  details.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !details.open) return;
    details.open = false;
    details.querySelector<HTMLElement>("summary")?.focus();
  });
  return {
    sync(client) {
      const connected = client.connected;
      details.classList.toggle("is-connected", connected);
      if (setup) setup.hidden = connected;
      if (lan) {
        const allowed = client.info?.privateNetworkAllowed === true;
        lan.textContent = connected ? (allowed ? lan.dataset.allowed ?? "" : lan.dataset.blocked ?? "") : "";
      }
      const needsAttention = attention.some((node) => !node.hidden && node.textContent !== "");
      details.open = needsAttention || (!connected && !hasSavedSession());
    },
  };
}

/**
 * Calls back when another tab or desktop tool frame saves a new agent session, so a
 * window opened earlier picks up a pairing made elsewhere without a second code.
 */
export function onAgentSessionSaved(callback: () => void): void {
  window.addEventListener("storage", (event) => {
    if (event.key === SESSION_STORAGE_KEY && event.newValue !== null) callback();
  });
}
