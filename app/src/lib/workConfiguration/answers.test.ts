import { describe, expect, it } from "vitest";
import type { TypedField } from "./model";
import { validateActivityAnswers } from "./answers";

const fields: TypedField[] = [
  { id: "note", label_en: "Note", label_es: "Nota", type: "text", required: true },
  { id: "length", label_en: "Length", label_es: "Largo", type: "number", required: true, unit: "in", min: -5, max: 5 },
  { id: "pieces", label_en: "Pieces", label_es: "Piezas", type: "number", required: false, unit: "count", min: 0, max: 10 },
  { id: "ready", label_en: "Ready", label_es: "Listo", type: "boolean", required: true },
  { id: "side", label_en: "Side", label_es: "Lado", type: "single_select", required: true, options: [
    { id: "left", label_en: "Left", label_es: "Izquierda" }, { id: "right", label_en: "Right", label_es: "Derecha" },
  ] },
  { id: "tools", label_en: "Tools", label_es: "Herramientas", type: "multi_select", required: true, options: [
    { id: "hammer", label_en: "Hammer", label_es: "Martillo" }, { id: "drill", label_en: "Drill", label_es: "Taladro" },
  ] },
];
const good = { note: "🔨".repeat(500), length: "-0.5", pieces: "0", ready: false, side: "left", tools: ["hammer"] };
function errors(draft: unknown) {
  const result = validateActivityAnswers(fields, draft);
  expect(result.ok).toBe(false);
  return result.ok ? {} : result.errors;
}

describe("published activity answer validation", () => {
  it("preserves exact IDs, false, zero, negative decimals, and 500 Unicode codepoints", () => {
    const result = validateActivityAnswers(fields, good);
    expect(result).toEqual({ ok: true, values: { ...good, length: -0.5, pieces: 0 } });
    if (result.ok) expect(result.values.tools).not.toBe(good.tools);
  });
  it("requires explicit answers and bounds text by codepoints", () => {
    expect(errors({ ...good, ready: null, tools: [] })).toMatchObject({ ready: "required", tools: "required" });
    expect(errors({ ...good, note: "🔨".repeat(501) })).toMatchObject({ note: "too_long" });
    expect(errors({ ...good, note: "   " })).toMatchObject({ note: "required" });
  });
  it("refuses coercion, exponent/hex/nonfinite, count fractions, and limits", () => {
    for (const length of ["1e2", "0x10", "Infinity", "NaN", "-.", 2, `0.${"0".repeat(400)}1`]) {
      expect(errors({ ...good, length })).toHaveProperty("length");
    }
    expect(errors({ ...good, length: "5.1" })).toMatchObject({ length: "out_of_range" });
    expect(errors({ ...good, length: "-5.1" })).toMatchObject({ length: "out_of_range" });
    expect(errors({ ...good, pieces: "1.5" })).toMatchObject({ pieces: "out_of_range" });
    expect(errors({ ...good, pieces: "11" })).toMatchObject({ pieces: "out_of_range" });
  });
  it("refuses labels, unknown IDs, duplicate selections and unknown field keys", () => {
    expect(errors({ ...good, side: "Left", tools: ["hammer", "hammer"], extra: "x" }))
      .toMatchObject({ side: "invalid", tools: "invalid", extra: "unknown_field" });
    expect(errors({ ...good, tools: ["unknown"] })).toMatchObject({ tools: "invalid" });
    expect(errors({ ...good, ready: "false" })).toMatchObject({ ready: "invalid" });
  });
  it("refuses malformed inputs and duplicate published schema IDs", () => {
    expect(errors(Object.assign(Object.create({ inherited: true }), good))).toMatchObject({ _form: "invalid_schema" });
    expect(validateActivityAnswers([...fields, fields[0]], good)).toMatchObject({ ok: false, errors: { _form: "invalid_schema" } });
  });
});
