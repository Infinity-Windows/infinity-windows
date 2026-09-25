// The capability registry is the one list (crew redesign K2.1). These tests
// pin the two directions that make it one list: every tool the registry
// names is a real definition, and every definition is claimed by a
// capability — so a tool nobody registered can never reach the model, and a
// card can never name a tool that does not exist. Then the per-role cards,
// the honest All-actions rows and the boundary.
import { describe, expect, it } from "vitest";
import {
  AI_BOUNDARY, ASK_CAPABILITIES, allActionsForRank, askToolNames, capabilityPromptBlock, cardLabel, cardsForRank,
  registeredToolNames, ROLE_CARDS, toolDefsFor,
} from "../../../supabase/functions/_shared/askCapabilities";
import { FIELD_TOOLS } from "../../../supabase/functions/_shared/fieldTools";
import { LEARNING_TOOLS } from "../../../supabase/functions/_shared/learningTools";
import { SCHEDULING_TOOLS } from "../../../supabase/functions/_shared/schedulingTools";
import { REPORTING_TOOLS } from "../../../supabase/functions/_shared/askReporting";
import { DAILY_LOG_TOOLS } from "../../../supabase/functions/_shared/aiDailyLog";
import { OFFER_CLOCK_BUTTON_TOOL } from "../../../supabase/functions/_shared/clockButtons";

const ALL_DEFS = [...SCHEDULING_TOOLS, ...REPORTING_TOOLS, ...FIELD_TOOLS, ...LEARNING_TOOLS, ...DAILY_LOG_TOOLS, OFFER_CLOCK_BUTTON_TOOL];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("the capability registry is the one list", () => {
  it("names only tools that exist, and every existing tool is claimed by a live capability", () => {
    const defined = new Set(ALL_DEFS.map((d) => d.name));
    for (const c of ASK_CAPABILITIES) for (const name of c.tools) expect(defined.has(name), `${c.id} names ${name}`).toBe(true);
    expect([...registeredToolNames()].sort()).toEqual([...defined].sort());
    expect(() => toolDefsFor(registeredToolNames(), ALL_DEFS)).not.toThrow();
    expect(() => toolDefsFor(["not_a_tool"], ALL_DEFS)).toThrow(/not_a_tool/);
  });

  it("gives every entry both languages, a receipt and a screen it belongs to", () => {
    for (const c of ASK_CAPABILITIES) {
      expect(c.label.en.trim()).not.toBe("");
      expect(c.label.es.trim()).not.toBe("");
      expect(c.prompt.en.trim()).not.toBe("");
      expect(c.prompt.es.trim()).not.toBe("");
      expect(c.changes.es.trim()).not.toBe("");
      expect(c.screen, `${c.id} has no screen`).not.toBeNull();
      if (!c.live) expect(c.tools, `${c.id} is not live but claims tools`).toEqual([]);
      if (!c.live) expect(c.release, `${c.id} is not live and names no release`).not.toBeNull();
    }
    for (const b of AI_BOUNDARY) { expect(b.en).not.toBe(""); expect(b.es).not.toBe(""); }
  });

  it("no tool can change a clock, a break, a toolbox talk, an approval or a publish", () => {
    for (const name of registeredToolNames()) {
      if (name === "offer_clock_button") continue;
      // Whole words between underscores: "draft_assignments" is not "sign".
      expect(name).not.toMatch(/(^|_)(clock|break|toolbox|approve|publish|sign|lunch)(_|$)/);
    }
    // The one clock-shaped tool is a button the person taps; the registry says so.
    expect(ASK_CAPABILITIES.find((c) => c.tools.includes("offer_clock_button"))?.receipt).toBe("one_tap_button");
  });
});

describe("action cards per role (K2.2)", () => {
  it("installer: Build a unit · Daily log · My hours — Take supplies is absent until Release 4", () => {
    expect(ROLE_CARDS[0]).toEqual(["build_unit", "daily_log", "take_supplies", "my_hours"]);
    expect(ids(cardsForRank(0))).toEqual(["build_unit", "daily_log", "my_hours"]);
  });
  it("foreman: Build a unit · Daily log — Crew status and Units completed are absent until Release 3", () => {
    expect(ROLE_CARDS[1]).toEqual(["crew_status", "build_unit", "daily_log", "units_completed"]);
    expect(ids(cardsForRank(1))).toEqual(["build_unit", "daily_log"]);
  });
  it("supervisor and owner: Plan the schedule · Job summary · Hours report — Crew status absent until Release 3", () => {
    expect(ids(cardsForRank(2))).toEqual(["plan_schedule", "job_summary", "hours_report"]);
    expect(ids(cardsForRank(3))).toEqual(["plan_schedule", "job_summary", "hours_report"]);
    expect(ids(cardsForRank(9))).toEqual(ids(cardsForRank(3)));
  });
  it("a running unit puts Finish unit N first, for every role", () => {
    for (const rank of [0, 1, 2, 3]) {
      const cards = cardsForRank(rank, { unitLabel: "4" });
      expect(cards[0].id).toBe("finish_unit");
      expect(cardLabel(cards[0], "en", { unitLabel: "4" })).toBe("Finish unit 4");
      expect(cardLabel(cards[0], "es", { unitLabel: "4" })).toBe("Terminar unidad 4");
    }
    expect(ids(cardsForRank(0, null))).not.toContain("finish_unit");
  });
});

describe("All actions (K2.1)", () => {
  it("lists an unbuilt action honestly, with the screen to use instead", () => {
    const rows = allActionsForRank(0);
    const supplies = rows.find((r) => r.capability.id === "take_supplies")!;
    expect(supplies.live).toBe(false);
    expect(supplies.useScreen).toEqual({ path: "/supplies", label: { en: "Supplies", es: "Materiales" } });
    expect(rows.find((r) => r.capability.id === "build_unit")!.useScreen).toBeNull();
    // Live first, then the honest rest.
    const firstUnbuilt = rows.findIndex((r) => !r.live);
    expect(rows.slice(firstUnbuilt).every((r) => !r.live)).toBe(true);
  });
  it("never lists an action above the person's role", () => {
    expect(ids(allActionsForRank(0).map((r) => r.capability))).not.toContain("plan_schedule");
    expect(ids(allActionsForRank(0).map((r) => r.capability))).not.toContain("record_crew_work");
    expect(ids(allActionsForRank(1).map((r) => r.capability))).toContain("crew_status");
    expect(ids(allActionsForRank(2).map((r) => r.capability))).toContain("plan_schedule");
  });
});

describe("the model's tool list derives from the registry", () => {
  it("offers scheduling, reporting and the clock button on every call, field tools only inside a field request, the daily-log tool only with a draft", () => {
    const plain = askToolNames({ field: false, dailyLog: false });
    expect(plain).toEqual(expect.arrayContaining(["get_scheduling_picture", "draft_assignments", "get_hours_report", "get_job_summary", "offer_clock_button"]));
    expect(plain).not.toContain("save_field_unit");
    expect(plain).not.toContain("record_daily_log_answers");
    const field = askToolNames({ field: true, dailyLog: false });
    expect(field).toEqual(expect.arrayContaining(["get_field_context", "save_field_unit", "stop_my_work", "prepare_learning_draft", "record_crew_work"]));
    expect(field).not.toContain("record_daily_log_answers");
    expect(askToolNames({ field: true, dailyLog: true })).toContain("record_daily_log_answers");
    // A draft with no field request has no evidence row: no tool.
    expect(askToolNames({ field: false, dailyLog: true })).not.toContain("record_daily_log_answers");
    expect(new Set(field).size).toBe(field.length);
  });
  it("tells the model what the person can do, what is not in Ask yet, and what it never does", () => {
    const installer = capabilityPromptBlock(0);
    expect(installer).toContain("(installer)");
    expect(installer).toContain("Take supplies → the Supplies screen");
    expect(installer).toContain("Plan the schedule — supervisor and above");
    expect(installer).toContain("NEVER, whatever is asked");
    expect(installer).toContain("Only a tool result proves a change");
    expect(installer).toContain("Answer in the language of THIS message");
    const owner = capabilityPromptBlock(3);
    expect(owner).not.toContain("NOT FOR THIS ROLE");
    expect(owner).toContain("Crew status → the Team timecards screen");
  });
});

// The boundary as source: no Ask-side module ever calls the RPCs that move a
// clock, sign a talk, approve or publish — the tap on the phone does those.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
describe("the AI boundary, read from the Ask function's own source (K2.4)", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(HERE, "../../..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
  it("names no clock, break, toolbox, approval or publish RPC anywhere the model's tools run", () => {
    const sources = [
      ...files(join(ROOT, "supabase/functions/ask")),
      ...["askCapabilities", "clockButtons", "fieldTools", "learningTools", "schedulingTools", "askReporting", "aiDailyLog"].map((n) => join(ROOT, `supabase/functions/_shared/${n}.ts`)),
    ];
    expect(sources.length).toBeGreaterThan(8);
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\.rpc\(\s*["'](start_break|end_break|clock_in|clock_out|queued_clock_in|complete_toolbox|toolbox_sign|approve_[a-z_]+|publish_[a-z_]+|set_shift_status)["']/);
      expect(text, file).not.toMatch(/from\(\s*["']time_shifts["']\s*\)\s*\.(insert|upsert|update|delete)/);
      expect(text, file).not.toMatch(/from\(\s*["']schedule_assignments["']\s*\)\s*\.update\([^)]*status:\s*["']published["']/);
    }
  });
});
