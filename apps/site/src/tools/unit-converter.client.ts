/**
 * Unit Converter client. Drives category/from/to selects + value input → live
 * result, swap, copy, formula note, quick-conversion chips, and a common
 * conversions sidebar. All math via `units.ts`; matches legacy behavior.
 *
 * The category `<select>` options are rendered server-side; this controller
 * only wires behavior and populates the per-category from/to unit selects.
 */
import {
  commonConversions,
  convertValue,
  formatNumber,
  unitData,
  unitName,
  type Category,
} from "@/tools/units";

interface Strings {
  categoryLabel: string;
  catLength: string;
  catWeight: string;
  catTemperature: string;
  catVolume: string;
  fromLabel: string;
  toLabel: string;
  swap: string;
  copied: string;
  quickConversions: string;
  commonConversionsLabel: string;
  formula: string;
}

function readStrings(): Strings | null {
  const el = document.querySelector<HTMLScriptElement>("[data-unit-strings]");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "{}") as Strings;
  } catch {
    return null;
  }
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-unit-tool]");
  if (!root) return;
  const raw = readStrings();
  if (!raw) return;
  const strings: Strings = raw;

  // Required elements: query, null-guard, then alias to a non-null *declared*
  // type so closures (render/event fns) see them as non-null.
  const categorySelectEl = root.querySelector<HTMLSelectElement>("[data-unit-category]");
  const fromUnitSelectEl = root.querySelector<HTMLSelectElement>("[data-unit-from]");
  const toUnitSelectEl = root.querySelector<HTMLSelectElement>("[data-unit-to]");
  const fromValueInputEl = root.querySelector<HTMLInputElement>("[data-unit-from-value]");
  const toValueInputEl = root.querySelector<HTMLInputElement>("[data-unit-to-value]");
  if (
    !categorySelectEl ||
    !fromUnitSelectEl ||
    !toUnitSelectEl ||
    !fromValueInputEl ||
    !toValueInputEl
  ) {
    return;
  }
  const categorySelect = categorySelectEl;
  const fromUnitSelect = fromUnitSelectEl;
  const toUnitSelect = toUnitSelectEl;
  const fromValueInput = fromValueInputEl;
  const toValueInput = toValueInputEl;

  // Optional elements (guarded per-use).
  const swapBtn = root.querySelector<HTMLButtonElement>("[data-unit-swap]");
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-unit-copy]");
  const formulaEl = root.querySelector<HTMLElement>("[data-unit-formula]");
  const quickEl = root.querySelector<HTMLElement>("[data-unit-quick]");
  const commonEl = root.querySelector<HTMLElement>("[data-unit-common]");

  let currentCategory: Category =
    (categorySelect.value as Category) || "length";

  // Build the from/to unit <option>s for a category and pick the default pair
  // (first two units, mirroring the legacy defaults).
  function populateUnitSelects(category: Category) {
    const units = unitData[category].units;
    const keys = Object.keys(units);
    const html = keys
      .map((k) => `<option value="${k}">${units[k].name}</option>`)
      .join("");
    fromUnitSelect.innerHTML = html;
    toUnitSelect.innerHTML = html;
    fromUnitSelect.value = keys[0];
    toUnitSelect.value = keys[1] ?? keys[0];
  }

  function updateFormula(value: number, from: string, to: string, result: number) {
    if (!formulaEl) return;
    const fromName = unitName(currentCategory, from);
    const toName = unitName(currentCategory, to);
    let formula: string;
    if (currentCategory === "temperature") {
      if (from === to) {
        formula = `${value} ${fromName} = ${value} ${toName}`;
      } else {
        formula = `${value} ${fromName} → ${formatNumber(result)} ${toName}`;
      }
    } else {
      const units = unitData[currentCategory].units;
      const fromFactor = units[from]?.factor;
      const toFactor = units[to]?.factor;
      const ratio =
        fromFactor != null && toFactor != null ? fromFactor / toFactor : 1;
      formula = `${value} × ${formatNumber(ratio)} = ${formatNumber(result)} ${toName}`;
    }
    formulaEl.textContent = formula;
  }

  function updateQuickConversions() {
    if (!quickEl) return;
    const value = parseFloat(fromValueInput.value) || 1;
    const fromUnit = fromUnitSelect.value;
    const keys = Object.keys(unitData[currentCategory].units);
    quickEl.innerHTML = keys
      .filter((u) => u !== fromUnit)
      .map((u) => {
        const result = convertValue(value, fromUnit, u, currentCategory);
        const name = unitName(currentCategory, u);
        return `<button type="button" class="chip" data-unit-quick-pick="${u}">${formatNumber(result)} ${name}</button>`;
      })
      .join("");
  }

  function updateCommonConversions() {
    if (!commonEl) return;
    commonEl.innerHTML = commonConversions[currentCategory]
      .map((conv) => {
        const result = convertValue(conv.from, conv.fromUnit, conv.toUnit, currentCategory);
        const data = `${conv.from}|${conv.fromUnit}|${conv.toUnit}`;
        return `<button type="button" class="common-row" data-unit-common-pick="${data}"><span class="mono">${conv.from} ${conv.fromUnit} = ${formatNumber(result)} ${conv.toUnit}</span></button>`;
      })
      .join("");
  }

  function updateConversion() {
    const value = parseFloat(fromValueInput.value);
    const fromUnit = fromUnitSelect.value;
    const toUnit = toUnitSelect.value;

    if (Number.isNaN(value)) {
      toValueInput.value = "";
      if (formulaEl) formulaEl.textContent = "";
      if (quickEl) quickEl.innerHTML = "";
      return;
    }

    const result = convertValue(value, fromUnit, toUnit, currentCategory);
    toValueInput.value = formatNumber(result);
    updateFormula(value, fromUnit, toUnit, result);
    updateQuickConversions();
  }

  function applyCategory(category: Category) {
    currentCategory = category;
    populateUnitSelects(currentCategory);
    fromValueInput.value = "1";
    updateConversion();
    updateCommonConversions();
  }

  categorySelect.addEventListener("change", () => {
    applyCategory(categorySelect.value as Category);
  });
  fromUnitSelect.addEventListener("change", updateConversion);
  toUnitSelect.addEventListener("change", updateConversion);
  fromValueInput.addEventListener("input", updateConversion);

  swapBtn?.addEventListener("click", () => {
    const tmp = fromUnitSelect.value;
    fromUnitSelect.value = toUnitSelect.value;
    toUnitSelect.value = tmp;
    updateConversion();
  });

  copyBtn?.addEventListener("click", async () => {
    const value = toValueInput.value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      const original = copyBtn.innerHTML;
      copyBtn.classList.add("copied");
      copyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>';
      copyBtn.title = strings.copied;
      window.setTimeout(() => {
        copyBtn.innerHTML = original;
        copyBtn.classList.remove("copied");
      }, 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  quickEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement)?.closest?.(
      "[data-unit-quick-pick]",
    ) as HTMLButtonElement | null;
    if (!btn) return;
    toUnitSelect.value = btn.getAttribute("data-unit-quick-pick") || toUnitSelect.value;
    updateConversion();
  });

  commonEl?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement)?.closest?.(
      "[data-unit-common-pick]",
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const [val, fromUnit, toUnit] = (btn.getAttribute("data-unit-common-pick") || "").split("|");
    fromValueInput.value = val;
    fromUnitSelect.value = fromUnit;
    toUnitSelect.value = toUnit;
    updateConversion();
  });

  // Initialize (category select already has its options server-side).
  categorySelect.value = currentCategory;
  populateUnitSelects(currentCategory);
  fromValueInput.value = "1";
  updateConversion();
  updateCommonConversions();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
