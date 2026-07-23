/**
 * Unit conversion data + math. Pure module — no DOM. Mirrors the legacy
 * UnitConverter behavior: multiplicative factors to a base unit for
 * length/weight/volume, and offset formulas through Celsius for temperature.
 */

export type Category = "length" | "weight" | "temperature" | "volume";

/** Categories in display order (matches the legacy category `<select>`). */
export const categoryOrder: Category[] = [
  "length",
  "weight",
  "temperature",
  "volume",
];

export interface UnitDef {
  /** Display name shown in selects / formula (e.g. "Meters", "Celsius (°C)"). */
  name: string;
  /** Factor to the category base unit. Absent for temperature (offset-based). */
  factor?: number;
}

export interface CategoryData {
  /** Base unit symbol (informational; only meaningful for factor categories). */
  base?: string;
  units: Record<string, UnitDef>;
}

/**
 * Per-category unit tables. Insertion order defines the `<option>` order and
 * the default from/to pair (first two units).
 */
export const unitData: Record<Category, CategoryData> = {
  length: {
    base: "m",
    units: {
      m: { name: "Meters", factor: 1 },
      km: { name: "Kilometers", factor: 1000 },
      cm: { name: "Centimeters", factor: 0.01 },
      mm: { name: "Millimeters", factor: 0.001 },
      mi: { name: "Miles", factor: 1609.344 },
      yd: { name: "Yards", factor: 0.9144 },
      ft: { name: "Feet", factor: 0.3048 },
      in: { name: "Inches", factor: 0.0254 },
      nm: { name: "Nanometers", factor: 1e-9 },
      um: { name: "Micrometers", factor: 1e-6 },
    },
  },
  weight: {
    base: "kg",
    units: {
      kg: { name: "Kilograms", factor: 1 },
      g: { name: "Grams", factor: 0.001 },
      mg: { name: "Milligrams", factor: 1e-6 },
      lb: { name: "Pounds", factor: 0.45359237 },
      oz: { name: "Ounces", factor: 0.02834952 },
      st: { name: "Stone", factor: 6.350293 },
      t: { name: "Metric Tonnes", factor: 1000 },
      ton: { name: "US Tons", factor: 907.185 },
    },
  },
  temperature: {
    units: {
      c: { name: "Celsius (°C)" },
      f: { name: "Fahrenheit (°F)" },
      k: { name: "Kelvin (K)" },
    },
  },
  volume: {
    base: "l",
    units: {
      l: { name: "Liters", factor: 1 },
      ml: { name: "Milliliters", factor: 0.001 },
      m3: { name: "Cubic Meters", factor: 1000 },
      gal: { name: "Gallons (US)", factor: 3.78541 },
      qt: { name: "Quarts (US)", factor: 0.946353 },
      pt: { name: "Pints (US)", factor: 0.473176 },
      cup: { name: "Cups (US)", factor: 0.236588 },
      floz: { name: "Fluid Ounces (US)", factor: 0.0295735 },
      tbsp: { name: "Tablespoons", factor: 0.0147868 },
      tsp: { name: "Teaspoons", factor: 0.00492892 },
    },
  },
};

export interface CommonConversion {
  from: number;
  fromUnit: string;
  toUnit: string;
}

/** Reference pairs shown in the "Common Conversions" sidebar per category. */
export const commonConversions: Record<Category, CommonConversion[]> = {
  length: [
    { from: 1, fromUnit: "km", toUnit: "mi" },
    { from: 1, fromUnit: "m", toUnit: "ft" },
    { from: 1, fromUnit: "in", toUnit: "cm" },
    { from: 1, fromUnit: "mi", toUnit: "km" },
  ],
  weight: [
    { from: 1, fromUnit: "kg", toUnit: "lb" },
    { from: 1, fromUnit: "lb", toUnit: "kg" },
    { from: 1, fromUnit: "oz", toUnit: "g" },
    { from: 1, fromUnit: "st", toUnit: "kg" },
  ],
  temperature: [
    { from: 0, fromUnit: "c", toUnit: "f" },
    { from: 100, fromUnit: "c", toUnit: "f" },
    { from: 32, fromUnit: "f", toUnit: "c" },
    { from: 98.6, fromUnit: "f", toUnit: "c" },
  ],
  volume: [
    { from: 1, fromUnit: "gal", toUnit: "l" },
    { from: 1, fromUnit: "l", toUnit: "gal" },
    { from: 1, fromUnit: "cup", toUnit: "ml" },
    { from: 1, fromUnit: "floz", toUnit: "ml" },
  ],
};

/** Display name for a unit id within a category (falls back to the id). */
export function unitName(category: Category, id: string): string {
  return unitData[category].units[id]?.name ?? id;
}

/**
 * Temperature conversion via a Celsius pivot. Offsets: °F = (°C × 9/5) + 32,
 * K = °C + 273.15. Unknown scales pass through unchanged.
 */
export function convertTemperature(value: number, from: string, to: string): number {
  if (from === to) return value;

  let celsius: number;
  if (from === "c") celsius = value;
  else if (from === "f") celsius = ((value - 32) * 5) / 9;
  else if (from === "k") celsius = value - 273.15;
  else return value;

  if (to === "c") return celsius;
  if (to === "f") return (celsius * 9) / 5 + 32;
  if (to === "k") return celsius + 273.15;
  return celsius;
}

/**
 * Convert `value` from one unit to another within a category. Factor
 * categories go through the base unit (value × fromFactor / toFactor);
 * temperature uses offset formulas.
 */
export function convertValue(
  value: number,
  from: string,
  to: string,
  category: Category,
): number {
  if (category === "temperature") return convertTemperature(value, from, to);

  const units = unitData[category].units;
  const fromFactor = units[from]?.factor;
  const toFactor = units[to]?.factor;
  if (fromFactor == null || toFactor == null) return value;
  return (value * fromFactor) / toFactor;
}

/**
 * Format a number for display. Uses exponential notation for very small or
 * very large magnitudes, otherwise trims trailing zeros via toPrecision(10).
 * Matches the legacy formatter exactly.
 */
export function formatNumber(num: number): string {
  if (Math.abs(num) < 0.000001 || Math.abs(num) > 1000000) {
    return num.toExponential(6);
  }
  const formatted = parseFloat(num.toPrecision(10));
  return formatted.toString();
}
