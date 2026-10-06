import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categoryOrder,
  unitData,
  commonConversions,
  convertValue,
  convertTemperature,
  formatNumber,
  formatNumberLocale,
  isBelowAbsoluteZero,
  allUnitIds,
  unitName,
} from "../src/tools/units.ts";

const close = (a: number, b: number, rel = 1e-9) =>
  assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-12, `${a} ≈ ${b}`);

test("unit tables: every factor category has its base unit = 1 and positive factors", () => {
  for (const c of categoryOrder) {
    const { base, units } = unitData[c];
    if (c === "temperature") {
      assert.deepEqual(Object.keys(units), ["c", "f", "k"]);
      continue;
    }
    assert.equal(units[base!].factor, 1, c);
    for (const [id, u] of Object.entries(units)) assert.ok(u.factor! > 0, `${c}/${id}`);
  }
});

test("unit ids are unique across categories (used as localization keys)", () => {
  const ids = allUnitIds();
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 31);
});

test("length/weight/volume: exact reference vectors", () => {
  const table: [number, string, string, string, number][] = [
    [1, "km", "mi", "length", 0.621371192237334],
    [1, "mi", "km", "length", 1.609344],
    [1, "in", "cm", "length", 2.54],
    [1, "ft", "m", "length", 0.3048],
    [3, "ft", "yd", "length", 1],
    [12, "in", "ft", "length", 1],
    [1, "m", "nm", "length", 1e9],
    [1, "mm", "um", "length", 1000],
    [1, "kg", "lb", "weight", 2.204622621848776],
    [1, "lb", "oz", "weight", 16.000000564],
    [1, "st", "lb", "weight", 13.99999],
    [1, "t", "kg", "weight", 1000],
    [1, "g", "mg", "weight", 1000],
    [1, "gal", "l", "volume", 3.78541],
    [1, "m3", "l", "volume", 1000],
    [1000, "ml", "l", "volume", 1],
    [1, "tbsp", "tsp", "volume", 3.0000081],
  ];
  for (const [v, from, to, cat, expected] of table) {
    close(convertValue(v, from, to, cat as never), expected, 1e-6);
  }
});

test("round-trip a→b→a is identity for every unit pair", () => {
  for (const c of categoryOrder) {
    const ids = Object.keys(unitData[c].units);
    for (const a of ids) for (const b of ids) {
      const there = convertValue(123.456, a, b, c);
      close(convertValue(there, b, a, c), 123.456, 1e-9);
    }
  }
});

test("temperature: reference points and identity", () => {
  assert.equal(convertTemperature(0, "c", "f"), 32);
  assert.equal(convertTemperature(100, "c", "f"), 212);
  assert.equal(convertTemperature(-40, "c", "f"), -40);
  close(convertTemperature(98.6, "f", "c"), 37);
  assert.equal(convertTemperature(0, "k", "c"), -273.15);
  close(convertTemperature(0, "k", "f"), -459.67);
  assert.equal(convertTemperature(25, "c", "c"), 25);
  assert.equal(convertTemperature(25, "x", "c"), 25, "unknown scale passes through");
});

test("unknown units pass the value through unchanged", () => {
  assert.equal(convertValue(5, "zz", "m", "length"), 5);
});

test("commonConversions reference only existing units", () => {
  for (const c of categoryOrder) for (const conv of commonConversions[c]) {
    assert.ok(unitData[c].units[conv.fromUnit] && unitData[c].units[conv.toUnit], `${c} ${conv.fromUnit}->${conv.toUnit}`);
  }
  assert.equal(unitName("length", "m"), "Meters");
  assert.equal(unitName("length", "zz"), "zz");
});

test("formatNumber: legacy thresholds, zero fix, non-finite", () => {
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(-0), "0");
  assert.equal(formatNumber(1.609344), "1.609344");
  assert.equal(formatNumber(0.1 + 0.2), "0.3");
  assert.equal(formatNumber(1000000), "1000000");
  assert.equal(formatNumber(1000001), "1.000001e+6");
  assert.equal(formatNumber(1e9), "1.000000e+9");
  assert.equal(formatNumber(0.0000001), "1.000000e-7");
  assert.equal(formatNumber(-2.5), "-2.5");
  assert.equal(formatNumber(Infinity), "Infinity");
  assert.equal(formatNumber(NaN), "NaN");
});

test("formatNumberLocale: decimal separator per locale, no grouping, scientific extremes", () => {
  assert.equal(formatNumberLocale(1.609344, "en"), "1.609344");
  assert.equal(formatNumberLocale(1.609344, "ru"), "1,609344");
  assert.equal(formatNumberLocale(1.609344, "de"), "1,609344");
  assert.equal(formatNumberLocale(1.609344, "ja"), "1.609344");
  assert.equal(formatNumberLocale(123456.5, "de"), "123456,5");
  assert.equal(formatNumberLocale(0, "ru"), "0");
  assert.equal(formatNumberLocale(1e9, "en"), "1E9");
  assert.equal(formatNumberLocale(1.5e-9, "ru"), "1,5E-9");
  assert.equal(formatNumberLocale(0.1 + 0.2, "en"), "0.3");
});

test("isBelowAbsoluteZero per scale", () => {
  assert.equal(isBelowAbsoluteZero(-273.15, "c"), false);
  assert.equal(isBelowAbsoluteZero(-273.16, "c"), true);
  assert.equal(isBelowAbsoluteZero(-459.68, "f"), true);
  assert.equal(isBelowAbsoluteZero(-1, "k"), true);
  assert.equal(isBelowAbsoluteZero(-1e9, "m"), false);
});
