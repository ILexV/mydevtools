/**
 * HTML Entity Encoder/Decoder client. Wires input/output, mode + format
 * selects, and encode/decode/swap/clear/copy actions. All transforms via
 * `entities.ts`; pure JS, no network.
 */
import {
  encodeHtml,
  decodeHtml,
  type EntityMode,
  type EntityFormat,
} from "@/tools/entities";

interface Strings {
  copy: string;
  copied: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-ent-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-ent-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  const input = root.querySelector<HTMLTextAreaElement>("[data-ent-input]");
  const output = root.querySelector<HTMLTextAreaElement>("[data-ent-output]");
  const modeSel = root.querySelector<HTMLSelectElement>("[data-ent-mode]");
  const formatSel = root.querySelector<HTMLSelectElement>("[data-ent-format]");
  if (!input || !output) return;

  root.querySelector<HTMLButtonElement>("[data-ent-encode]")?.addEventListener("click", () => {
    const mode = (modeSel?.value ?? "specialchars") as EntityMode;
    const format = (formatSel?.value ?? "named") as EntityFormat;
    output.value = encodeHtml(input.value, mode, format);
  });

  root.querySelector<HTMLButtonElement>("[data-ent-decode]")?.addEventListener("click", () => {
    output.value = decodeHtml(input.value);
  });

  root.querySelector<HTMLButtonElement>("[data-ent-swap]")?.addEventListener("click", () => {
    const prev = input.value;
    input.value = output.value;
    output.value = prev;
  });

  root.querySelector<HTMLButtonElement>("[data-ent-clear]")?.addEventListener("click", () => {
    input.value = "";
    output.value = "";
  });

  root.querySelector<HTMLButtonElement>("[data-ent-copy]")?.addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(output.value);
      const btn = e.currentTarget as HTMLButtonElement;
      const orig = btn.textContent;
      btn.textContent = strings.copied;
      setTimeout(() => {
        btn.textContent = orig;
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
