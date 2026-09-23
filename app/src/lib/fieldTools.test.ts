import { describe, expect, it } from "vitest";
import {
  FIELD_TOOLS, buildChecklist, canonicalMaterial, completeAnswers, describeResult, fieldActivityLine, fieldCommand,
  mergeDraft, toInches, unitFacts, type Measurement, type SetupDraft, type UnitAnswers,
} from "../../../supabase/functions/_shared/fieldTools";

const JOB = "00000000-0000-4000-8000-000000000100";
const OTHER_JOB = "00000000-0000-4000-8000-000000000101";
const UNIT = "00000000-0000-4000-8000-000000000400";
const ft = (feet: number, spoken: string): Measurement => ({ feet, inches: null, metric_value: null, metric_unit: null, spoken });
const answers = (over: Partial<UnitAnswers> = {}): UnitAnswers => completeAnswers(over);

/** Walk a JSON schema and yield every object node. */
function* objects(node: unknown, path = "$"): Generator<[string, Record<string, unknown>]> {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  const types = ([] as unknown[]).concat(n.type ?? []);
  if (types.includes("object")) yield [path, n];
  for (const [k, v] of Object.entries(n.properties ?? {})) yield* objects(v, `${path}.${k}`);
  if (n.items) yield* objects(n.items, `${path}[]`);
}

describe("field tool schemas (OpenAI strict function calling)", () => {
  it("require every property and forbid extras at every level", () => {
    for (const tool of FIELD_TOOLS) {
      expect(tool.strict, tool.name).toBe(true);
      for (const [path, o] of objects(tool.input_schema)) {
        expect(o.additionalProperties, `${tool.name} ${path}`).toBe(false);
        expect([...(o.required as string[])].sort(), `${tool.name} ${path}`).toEqual(Object.keys(o.properties as object).sort());
      }
    }
  });
  it("offer no way for the model to confirm, approve or touch the job clock", () => {
    const text = JSON.stringify(FIELD_TOOLS.map((t) => [t.name, t.input_schema]));
    expect(text).not.toMatch(/"(confirm\w*|approved?|choice|preview_hash|clock_in|clock_out|end_break|injur\w*)"\s*:/);
    expect(FIELD_TOOLS.map((t) => t.name)).not.toEqual(expect.arrayContaining(["resolve", "ai_field_resolve", "clock_in", "clock_out", "start_break", "approve_qc"]));
  });
});

describe("measurements", () => {
  it("converts spoken sizes to inches, rounded to 1/16", () => {
    expect(toInches(ft(6, "six feet"))).toBe(72);
    expect(toInches({ feet: 6, inches: 4.5, metric_value: null, metric_unit: null, spoken: "6 foot 4 and a half" })).toBe(76.5);
    expect(toInches({ feet: null, inches: null, metric_value: 1830, metric_unit: "mm", spoken: "1830 mil" })).toBe(72.0625);
    expect(toInches({ feet: null, inches: null, metric_value: 2.44, metric_unit: "m", spoken: "2.44 m" })).toBe(96.0625);
    expect(toInches(null)).toBeNull();
  });
  it("refuses ambiguous or impossible sizes instead of guessing", () => {
    expect(() => toInches({ feet: 6, inches: null, metric_value: 180, metric_unit: "cm", spoken: "6 feet 180 cm" })).toThrow(/Ask which/);
    expect(() => toInches(ft(500, "five hundred feet"))).toThrow(/not a usable/);
  });
});

describe("the owner's unit-4 example", () => {
  const unit4 = answers({
    label: "4", type_label: "Bifold door", components: [{ label: "Door panel", quantity: 2 }, { label: "Frame", quantity: 1 }],
    material: "aluminium", story: "1", width: ft(6, "six feet"), height: ft(8, "eight feet"), opening_direction: "left to right",
    unknown: ["electrical"],
  });
  it("is one unit with components, inches, canonical material and the default viewpoint", () => {
    const { label, type_label, facts } = unitFacts(unit4);
    expect([label, type_label]).toEqual(["4", "Bifold door"]);
    expect(facts).toMatchObject({
      width_in: 72, height_in: 96, material: "Aluminum", story: "1", measurement_source: "width: six feet; height: eight feet",
      components: [{ label: "Door panel", quantity: 2 }, { label: "Frame", quantity: 1 }],
      opening_direction: "left to right", direction_viewpoint: "outside looking in (default)", unknown_fields: ["electrical"],
    });
  });
  it("never turns silence into an answer, and never infers how the size was obtained", () => {
    const { facts } = unitFacts(unit4);
    for (const key of ["electrical", "access", "complexity", "equipment_needed", "area_source", "weight_lb"]) expect(facts[key], key).toBeUndefined();
  });
  it("keeps size source, weight and machinery only when volunteered", () => {
    const { facts } = unitFacts(answers({ label: "4", size_source: "Measured", weight: { value: 100, unit: "kg" }, equipment_description: "Telehandler", equipment_minutes: 25 }));
    expect(facts).toMatchObject({ area_source: "Measured", weight_lb: 220, equipment: "Telehandler", equipment_minutes: 25 });
    expect(() => unitFacts(answers({ label: "4", equipment_minutes: 2.5 }))).toThrow(/whole minutes/);
    expect(() => unitFacts(answers({ label: "4", components: [{ label: "Pane", quantity: 1.5 }] }))).toThrow(/whole number/);
  });
});

describe("materials", () => {
  it("map spoken variants onto Unit details' choices and keep anything else as said", () => {
    expect(["vinyl", "UPVC", "Aluminium", "alu", "madera", "fibreglass"].map(canonicalMaterial)).toEqual(["Vinyl", "Vinyl", "Aluminum", "Aluminum", "Wood", "Fiberglass"]);
    expect(canonicalMaterial("Bronze-clad cedar")).toBe("Bronze-clad cedar");
  });
});

describe("the checklist", () => {
  it("shows captured, said-unknown, still-needed and not-needed separately", () => {
    const c = buildChecklist({ job: { name: "Pine Hollow", location: null }, unit: answers({ label: "7", type_label: "Fixed window", unknown: ["material"] }) });
    const by = Object.fromEntries([...(c.job ?? []), ...(c.unit ?? [])].map((i) => [i.key, i.status]));
    expect(by).toMatchObject({ job_name: "captured", job_location: "missing", label: "captured", type_label: "captured", material: "unknown", story: "missing", opening_direction: "not_applicable", area_source: "not_applicable" });
  });
  it("asks how a size was obtained once there is a size, and counts plan facts as answered", () => {
    const c = buildChecklist({ unit: answers({ label: "8", width: ft(5, "five feet") }), saved: { plans: { type_label: "Slider 60x48", height_in: 48 } } });
    const by = Object.fromEntries((c.unit ?? []).map((i) => [i.key, i]));
    expect(by.area_source.status).toBe("missing");
    expect([by.type_label.status, by.type_label.from_plans, by.height_in.from_plans]).toEqual(["captured", true, true]);
  });
});

describe("a long guided setup", () => {
  it("keeps early answers across more than eight messages", () => {
    let draft: SetupDraft | null = null;
    draft = mergeDraft(draft, { job: { name: "Pine Hollow", location: "12 Ridge Rd" }, unit: answers({ label: "4", material: "Aluminum", width: ft(6, "six feet") }) });
    for (let i = 0; i < 12; i++) draft = mergeDraft(draft, { unit: answers(i === 5 ? { story: "2" } : {}) });
    draft = mergeDraft(draft, { unit: answers({ label: "4", unknown: ["electrical"] }) });
    expect(draft.job).toMatchObject({ name: "Pine Hollow", location: "12 Ridge Rd" });
    expect(draft.unit).toMatchObject({ label: "4", material: "Aluminum", story: "2", unknown: ["electrical"] });
    expect(draft.unit?.width?.feet).toBe(6);
    const by = Object.fromEntries((buildChecklist(draft).unit ?? []).map((i) => [i.key, i.status]));
    expect(by).toMatchObject({ material: "captured", width_in: "captured", story: "captured", electrical: "unknown", access: "missing" });
  });
  it("never carries unit facts to the same unit number on another job", () => {
    let draft = mergeDraft(null, { job: { name: "Job A", location: "1 A St", project_id: JOB }, unit: answers({ label: "4", material: "Vinyl", width: ft(3, "three feet") }) });
    draft = mergeDraft(draft, { job: { name: "Job B", location: null, project_id: OTHER_JOB } });
    expect(draft.unit).toBeNull();
    draft = mergeDraft(draft, { unit: answers({ label: "4" }) });
    expect([draft.unit?.material, draft.unit?.width]).toEqual([null, null]);
    // Same job, different spelling of the name is not a new job once the id is the same.
    const same = mergeDraft(mergeDraft(null, { job: { name: "Job A", location: null, project_id: JOB }, unit: answers({ label: "4", material: "Vinyl" }) }), { job: { name: null, location: null, project_id: JOB } });
    expect(same.unit?.material).toBe("Vinyl");
  });
  it("a new unit number starts a fresh unit draft", () => {
    const d = mergeDraft(mergeDraft(null, { unit: answers({ label: "4", material: "Vinyl" }) }), { unit: answers({ label: "5" }) });
    expect([d.unit?.label, d.unit?.material]).toEqual(["5", null]);
  });
  it("'I don't know that after all' clears the earlier draft answer", () => {
    let d = mergeDraft(null, { unit: answers({ label: "4", material: "Vinyl", story: "2" }) });
    d = mergeDraft(d, { unit: answers({ unknown: ["material"] }) });
    expect([d.unit?.material, d.unit?.story, d.unit?.unknown]).toEqual([null, "2", ["material"]]);
    // A replacement in the same message wins over the unknown.
    d = mergeDraft(d, { unit: answers({ material: "Steel", unknown: ["material"] }) });
    expect([d.unit?.material, d.unit?.unknown]).toEqual(["Steel", []]);
  });
});

describe("database commands", () => {
  it("derive stable keys from the target, so a re-run model cannot duplicate", () => {
    const a = fieldCommand("create_field_job", { name: "Smith House", location: "12 Oak St" });
    const b = fieldCommand("create_field_job", { name: " smith house ", location: "12 oak st." });
    expect(a.key).toBe(b.key);
    const s1 = fieldCommand("start_unit_work", { project_id: JOB, unit_id: UNIT, stage: "Installing", participation: "install" });
    expect(s1).toMatchObject({ action: "start_unit", key: `start:${UNIT}:Installing:install` });
    const u1 = fieldCommand("save_field_unit", { project_id: JOB, unit_id: null, opening_id: null, unit: answers({ label: "4", material: "Aluminum" }) });
    const u2 = fieldCommand("save_field_unit", { project_id: JOB, unit_id: null, opening_id: null, unit: answers({ label: "4", material: "Aluminum" }) });
    expect(u1.key).toBe(u2.key);
    expect(u1.data.facts).toEqual({ material: "Aluminum" });
  });
  it("refuse guessed ids and missing essentials with a sentence the model can act on", () => {
    expect(() => fieldCommand("start_unit_work", { project_id: "Smith job", unit_id: UNIT, stage: "Installing", participation: "install" })).toThrow(/get_field_context/);
    expect(() => fieldCommand("create_field_job", { name: "Smith", location: "" })).toThrow(/location/);
    expect(() => fieldCommand("save_field_unit", { project_id: JOB, unit_id: null, opening_id: null, unit: answers({}) })).toThrow(/number or name/);
    expect(() => fieldCommand("record_crew_work", { project_id: JOB, unit_id: UNIT, unit_label: null, unit_type: null, people: [], work_date: "2026-09-21", stage: "Hardware", outcome: "partial", description: null })).toThrow(/who did the work/);
    expect(() => fieldCommand("clock_out", {})).toThrow(/not available/);
  });
});

describe("what the Ask page and the model are told", () => {
  it("progress lines name what was checked, never a result", () => {
    for (const name of FIELD_TOOLS.map((t) => t.name)) expect(fieldActivityLine(name) ?? "", name).not.toMatch(/\b(saved|stopped|filed|created|started|released)\b/i);
  });
  it("a waiting choice is described as not done, and the preview seal stays out of the model's view", () => {
    const text = describeResult({ status: "needs_choice", reason: "on_break", preview_hash: "abc123", options: [] });
    expect(text).toContain("NOT done yet");
    expect(text).not.toContain("abc123");
    expect(describeResult({ status: "stale", message: "x" })).toContain("Nothing was changed");
  });
});
