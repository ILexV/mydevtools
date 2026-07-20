/**
 * UUID Generator client. Reads settings, generates via `uuid.ts`, renders the
 * list with per-row copy + copy-all + download .txt. SSR-safe.
 */
import { generateBatch, type UuidVersion, type UuidFormat, type UuidCase } from "@/tools/uuid";

interface Strings {
  copy: string;
  copied: string;
  copyAll: string;
  download: string;
  clear: string;
  outputPlaceholder: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-uuid-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-uuid-tool]");
  if (!root) return;
  const strings = readStrings();
  if (!strings) return;

  const list = root.querySelector<HTMLOListElement>("[data-uuid-list]");
  const countInput = root.querySelector<HTMLInputElement>("[data-uuid-count]");
  const countVal = root.querySelector<HTMLElement>("[data-uuid-count-val]");
  const genBtn = root.querySelector<HTMLButtonElement>("[data-uuid-generate]");
  const copyAllBtn = root.querySelector<HTMLButtonElement>("[data-uuid-copyall]");
  const downloadBtn = root.querySelector<HTMLButtonElement>("[data-uuid-download]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-uuid-clear]");

  const radio = (name: string): string =>
    (root!.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value as string) ?? "";

  function settings(): { version: UuidVersion; format: UuidFormat; casing: UuidCase; count: number } {
    return {
      version: radio("uuid-version") as UuidVersion,
      format: radio("uuid-format") as UuidFormat,
      casing: radio("uuid-case") as UuidCase,
      count: countInput ? Number(countInput.value) : 1,
    };
  }

  function toggleBulk(hasItems: boolean) {
    if (copyAllBtn) copyAllBtn.hidden = !hasItems;
    if (downloadBtn) downloadBtn.hidden = !hasItems;
    if (clearBtn) clearBtn.hidden = !hasItems;
  }

  function render(items: string[]) {
    if (!list) return;
    list.innerHTML = items
      .map(
        (u) =>
          `<li class="uuid-row"><span class="uuid-val">${u}</span>` +
          `<button type="button" class="ghost-btn copy-btn" data-copy="${u}">${strings!.copy}</button></li>`,
      )
      .join("");
    toggleBulk(items.length > 0);
  }

  list?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement)?.closest?.("[data-copy]") as HTMLButtonElement | null;
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.getAttribute("data-copy") || "");
      const orig = btn.textContent;
      btn.textContent = strings!.copied;
      setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  countInput?.addEventListener("input", () => {
    if (countVal) countVal.textContent = countInput.value;
  });

  genBtn?.addEventListener("click", () => {
    const { version, format, casing, count } = settings();
    render(generateBatch(version, format, casing, count));
  });

  copyAllBtn?.addEventListener("click", async () => {
    const vals = Array.from(root!.querySelectorAll<HTMLElement>(".uuid-val")).map((el) => el.textContent || "");
    try {
      await navigator.clipboard.writeText(vals.join("\n"));
      const orig = copyAllBtn.textContent;
      copyAllBtn.textContent = strings!.copied;
      setTimeout(() => { copyAllBtn.textContent = orig; }, 1200);
    } catch {
      /* ignore */
    }
  });

  downloadBtn?.addEventListener("click", () => {
    const vals = Array.from(root!.querySelectorAll<HTMLElement>(".uuid-val")).map((el) => el.textContent || "");
    const blob = new Blob([vals.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uuids-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  clearBtn?.addEventListener("click", () => {
    if (list) list.innerHTML = "";
    toggleBulk(false);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
