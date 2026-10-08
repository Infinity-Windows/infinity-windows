import { describe, expect, it } from "vitest";
import corpus from "./__fixtures__/sourceMatchedWire.json";
import { parseUnitContributorsReply, UnitContributorsUnavailableError } from "./protocol";

type Dictionary = Record<string, unknown>;
const object = (value: unknown): Dictionary => value as Dictionary;
const rows = (value: unknown): unknown[] => value as unknown[];
const ACTOR = "00000000-0000-4000-8000-000000250002";
const PROJECT = "00000000-0000-4000-8000-000000250010";
const UNIT = "00000000-0000-4000-8000-000000250030";
const expected = (index = 0) => ({ actorId: corpus.calls[index].reply.contributors?.actorId ?? ACTOR,
  projectId: corpus.calls[index].request.projectId, unitId: corpus.calls[index].request.unitId,
  unitIncarnation: corpus.calls[index].reply.contributors?.unitIncarnation });
const sqlCase = (label: string) => {
  const index = corpus.calls.findIndex(call => call.label === label);
  if (index < 0) throw Error(`Missing pinned SQL case: ${label}`);
  return parseUnitContributorsReply(corpus.calls[index].reply, expected(index));
};
function sample(index = 0): Dictionary { return object(structuredClone(corpus.calls[index].reply)); }
function view(reply: Dictionary): Dictionary { return object(reply.contributors); }
function firstPerson(reply: Dictionary): Dictionary { return object(rows(view(reply).people)[0]); }
function firstTask(reply: Dictionary): Dictionary { return object(rows(firstPerson(reply).activities)[0]); }
function reject(mutator: (reply: Dictionary) => void, index = 0) {
  const reply = sample(index); mutator(reply);
  try { parseUnitContributorsReply(reply, expected(index)); }
  catch (error) {
    expect(error).toBeInstanceOf(UnitContributorsUnavailableError);
    expect((error as Error).message).toBe("Unit contributions are unavailable. Check the current records again.");
    return;
  }
  throw Error("Expected a private report to be held");
}

describe("strict selected-unit contributor reply boundary", () => {
  it("pins the genuine SQL corpus source separately from the unchanged totals source", () => {
    expect(corpus.contributorsSha256).toBe("ae6185e4b390b7cff8f3d7aca837688fda2756792bdf055ef8c3a1f290d438c5");
    expect(corpus.totalsSha256).toBe("e0e74c2d1985d332af81f95d20d2a6625c40cb5fcf995b4aa6e267d75e092140");
    expect(corpus.calls).toHaveLength(37);
  });
  it.each(corpus.calls.map((call, index) => [index, call.label] as const))("strictly accepts SQL reply %i: %s with its own actor/job/unit/incarnation", index => {
    const reply = corpus.calls[index].reply;
    expect(parseUnitContributorsReply(reply, expected(index))).toEqual(reply);
  });
  it("keeps SQL's complete zero and zero-only tap apart from worked contributors", () => {
    const empty = parseUnitContributorsReply(corpus.calls[2].reply, expected(2));
    const zero = parseUnitContributorsReply(corpus.calls[4].reply, expected(4));
    if (empty.availability !== "available" || zero.availability !== "available") throw Error("Source evidence unavailable");
    expect(empty.contributors.people).toEqual([]);
    expect(zero.contributors.zeroOnly).toHaveLength(1);
    expect(zero.contributors.people).toHaveLength(0);
    expect(zero.contributors.participantCounts).toEqual({ timed: 0, timingUncertain: 0, untimedOnly: 0, zeroOnly: 1, total: 0 });
  });
  it("keeps SQL's open zero interval incomplete, rather than a proven zero tap", () => {
    const open = parseUnitContributorsReply(corpus.calls[3].reply, expected(3));
    if (open.availability !== "available") throw Error("Source evidence unavailable");
    expect(open.contributors.unitComplete).toBe(false);
    expect(open.contributors.completenessReasons).toContain("open_shift");
    expect(open.contributors.zeroOnly).toEqual([]);
  });
  it("never gives a proven zero-only tap a share of another worker's positive labor", () => {
    const reply = sample(), source = sample(4);
    rows(view(reply).zeroOnly).push(structuredClone(rows(view(source).zeroOnly)[0]));
    object(view(reply).participantCounts).zeroOnly = 1;
    const parsed = parseUnitContributorsReply(reply, expected());
    if (parsed.availability !== "available") throw Error("Source evidence unavailable");
    expect(parsed.contributors.zeroOnly[0].share).toEqual({ state: "unavailable", reasons: ["zero"] });
    reject(value => {
      rows(view(value).zeroOnly).push({ ...object(structuredClone(rows(view(source).zeroOnly)[0])), share: { state: "available", numeratorMicros: "0", denominatorMicros: "303000" } });
      object(view(value).participantCounts).zeroOnly = 1;
    });
  });
  it("retains each SQL worker's exact 3h/2h/1h attribution without adding payroll or area", () => {
    const multiIndex = corpus.calls.findIndex(call => call.label === "three_people_3_2_1_hours");
    const multi = parseUnitContributorsReply(corpus.calls[multiIndex].reply, expected(multiIndex));
    if (multi.availability !== "available") throw Error("Source evidence unavailable");
    expect(multi.contributors.people).toHaveLength(3);
    expect(multi.contributors.people.map(person => person.knownMicros)).toEqual(["10800000000", "7200000000", "3600000000"]);
    expect(multi.contributors.unitKnownMicros).toBe("21600000000");
  });
  it("keeps SQL's legacy zero-micro person uncertain even when they have named work", () => {
    const result = sqlCase("same_person_unproven_timer_and_named_work");
    if (result.availability !== "available") throw Error("Source evidence unavailable");
    const person = result.contributors.people.find(row => row.measurementState === "unproven");
    expect(person?.knownMicros).toBe("0");
    expect(person?.activities).toEqual([]);
    expect(person?.share).toEqual({ state: "unavailable", reasons: ["legacy_unmapped", "named_unlinked"] });
    expect(result.contributors.zeroOnly).toEqual([]);
    expect(result.contributors.untimedParticipants.some(row => row.profileId === person?.profileId)).toBe(true);
    expect(result.contributors.participantCounts).toEqual({ timed: 1, timingUncertain: 1, untimedOnly: 1, zeroOnly: 0, total: 3 });
  });
  it("keeps SQL's positive-unit zero tap out of worked people and percentages", () => {
    const result = sqlCase("positive_unit_with_zero_only_audit");
    if (result.availability !== "available") throw Error("Source evidence unavailable");
    expect(result.contributors.people.map(row => row.knownMicros)).toEqual(["3600000000", "3600000000"]);
    expect(result.contributors.unitKnownMicros).toBe("7200000000");
    expect(result.contributors.zeroOnly[0].share).toEqual({ state: "unavailable", reasons: ["zero"] });
    expect(result.contributors.participantCounts).toEqual({ timed: 2, timingUncertain: 0, untimedOnly: 0, zeroOnly: 1, total: 2 });
  });
  it("treats SQL's named worker with a validated zero timer as uncertain participation, not zero-only labor", () => {
    const result = sqlCase("positive_unit_named_validated_zero_timer");
    if (result.availability !== "available") throw Error("Source evidence unavailable");
    expect(result.contributors.unitKnownMicros).toBe("7200000000");
    expect(result.contributors.unitComplete).toBe(false);
    expect(result.contributors.completenessReasons).toEqual(["named_unlinked"]);
    expect(result.contributors.people.map(person => person.measurementState)).toEqual(["recorded", "recorded", "unproven"]);
    const uncertain = result.contributors.people[2];
    expect(uncertain.knownMicros).toBe("0");
    expect(uncertain.activities).toEqual([]);
    expect(uncertain.share).toEqual({ state: "unavailable", reasons: ["named_unlinked"] });
    expect(result.contributors.untimedParticipants.map(person => person.profileId)).toContain(uncertain.profileId);
    expect(result.contributors.zeroOnly).toEqual([]);
    expect(result.contributors.participantCounts).toEqual({ timed: 2, timingUncertain: 1, untimedOnly: 0, zeroOnly: 0, total: 3 });
  });
  it("does not add SQL's machine subset to its two-task labor total", () => {
    const result = sqlCase("two_tasks_machine_subset_not_extra_timer");
    if (result.availability !== "available") throw Error("Source evidence unavailable");
    const worker = result.contributors.people[0];
    expect(worker.activities).toHaveLength(2);
    expect(worker.knownMicros).toBe("7200000000");
    expect(worker.activities.some(activity => activity.machineSubsets.length > 0)).toBe(true);
    expect(result.contributors.unitKnownMicros).toBe(worker.knownMicros);
  });
  it("does not expose a private name or count for SQL's hidden unit", () => {
    expect(sqlCase("Hidden selected job discloses no contributor UUID/name/count"))
      .toEqual({ protocolVersion: 1, availability: "unavailable", contributors: null });
  });
  it("accepts the exact generic unavailable shape without any names or counts", () => {
    expect(parseUnitContributorsReply({ protocolVersion: 1, availability: "unavailable", contributors: null }, { actorId: ACTOR, projectId: PROJECT, unitId: UNIT }))
      .toEqual({ protocolVersion: 1, availability: "unavailable", contributors: null });
  });
  it.each(["actorId", "projectId", "unitId", "unitIncarnation"])("refuses a mismatched caller binding %s", key => {
    expect(() => parseUnitContributorsReply(corpus.calls[0].reply,
      { ...expected(0), [key]: key === "unitIncarnation" ? "1" : "00000000-0000-4000-8000-000000999999" })).toThrow(UnitContributorsUnavailableError);
  });
  it("accepts canonical PostgreSQL UUID syntax for a caller-bound legacy ID", () => {
    const legacy = "00000000-0000-0000-0000-000000000001", reply = sample();
    view(reply).actorId = legacy;
    expect(parseUnitContributorsReply(reply, { ...expected(), actorId: legacy }).availability).toBe("available");
    reject(value => { view(value).actorId = "00000000-0000-0000-0000-00000000000A"; });
  });
  it("does not treat an omitted expected incarnation as proof of a later incarnation", () => {
    const result = parseUnitContributorsReply(corpus.calls[0].reply,
      { actorId: ACTOR, projectId: PROJECT, unitId: UNIT });
    expect(result.availability).toBe("available");
  });
  it.each(["protocolVersion", "availability", "contributors"])("refuses missing top-level %s", key => reject(reply => { delete reply[key]; }));
  it("refuses unknown top-level and unavailable-side fields", () => {
    reject(reply => { reply.warning = "secret"; });
    expect(() => parseUnitContributorsReply({ protocolVersion: 1, availability: "unavailable", contributors: null, people: ["secret"] }, expected()))
      .toThrow(UnitContributorsUnavailableError);
    expect(() => parseUnitContributorsReply({ protocolVersion: 1, availability: "unavailable", contributors: { displayName: "secret" } }, expected()))
      .toThrow(UnitContributorsUnavailableError);
  });
  it.each([0, 2, "1", null, undefined])("refuses non-v1 protocol version %s", value => reject(reply => { reply.protocolVersion = value; }));
  it.each(["actorId", "projectId", "unitId"])("refuses altered identity %s", key => reject(reply => { view(reply)[key] = "00000000-0000-4000-8000-000000999999"; }));
  it.each(["", "01", "-1", "1.0", "9223372036854775808", null])("refuses noncanonical/out-of-range incarnation %s", value => reject(reply => { view(reply).unitIncarnation = value; }));
  it.each(["2026-10-04T21:49:17Z", "2026-02-30T21:49:17.318000Z", "2026-10-04T21:49:17.318000+00:00", "2026-10-04T21:49:17.318000Z\n"])
    ("refuses noncanonical or impossible server timestamp %s", value => reject(reply => { view(reply).asOf = value; }));
  it("requires the window's cutoff and exact kind", () => {
    reject(reply => { object(view(reply).window).until = "2026-10-04T21:49:18.318000Z"; });
    reject(reply => { object(view(reply).window).kind = "this_week"; });
    reject(reply => { object(view(reply).window).from = "2026-10-01"; });
  });
  it.each(["", "01", "+1", "-1", "1e3", "1.0", "293000\n", "9".repeat(41), null, 293000])
    ("refuses noncanonical amount %s", value => reject(reply => { view(reply).unitKnownMicros = value; }));
  it("refuses mismatched people, task and machine sums", () => {
    reject(reply => { firstPerson(reply).knownMicros = "293001"; });
    reject(reply => { firstTask(reply).knownMicros = "293001"; });
    reject(reply => { rows(firstTask(reply).machineSubsets).push({ machineKind: "forklift", knownMicros: "303001" }); });
  });
  it("accepts a machine subset only inside its activity and refuses duplicate or unsorted kinds", () => {
    const reply = sample();
    firstTask(reply).machineSubsets = [{ machineKind: "forklift", knownMicros: "93000" }, { machineKind: "tele_handler", knownMicros: "200000" }];
    expect(parseUnitContributorsReply(reply, expected()).availability).toBe("available");
    reject(value => { firstTask(value).machineSubsets = [{ machineKind: "z", knownMicros: "1" }, { machineKind: "a", knownMicros: "1" }]; });
    reject(value => { firstTask(value).machineSubsets = [{ machineKind: "forklift", knownMicros: "1" }, { machineKind: "forklift", knownMicros: "1" }]; });
  });
  it("refuses duplicate activity identities, versions and wrong version ordering", () => {
    reject(reply => { rows(firstPerson(reply).activities).push(structuredClone(firstTask(reply))); });
    reject(reply => { const task = structuredClone(firstTask(reply)); task.definitionVersionId = "00000000-0000-4000-8000-000000000099"; rows(firstPerson(reply).activities).push(task); });
    reject(reply => { firstTask(reply).definitionVersion = 0; });
  });
  it("refuses missing/hidden names, extra profile fields and raw HTML leakage", () => {
    reject(reply => { firstPerson(reply).displayName = "   "; });
    reject(reply => { firstPerson(reply).email = "secret@example.com"; });
    reject(reply => { firstPerson(reply).displayName = "x".repeat(501); });
    reject(reply => { firstPerson(reply).nameState = "unavailable"; });
    const reply = sample(); firstPerson(reply).displayName = "<b>worker</b>";
    expect(parseUnitContributorsReply(reply, expected()).availability).toBe("available"); // Render as text later.
  });
  it("uses PostgreSQL character limits for supplementary-plane Unicode labels", () => {
    const reply = sample();
    firstTask(reply).labelEn = "🪟".repeat(500);
    expect(parseUnitContributorsReply(reply, expected()).availability).toBe("available");
    reject(value => { firstTask(value).labelEn = "🪟".repeat(501); });
  });
  it("refuses unlisted, duplicate or unsorted completeness reasons", () => {
    reject(reply => { view(reply).completenessReasons = ["source_unproven", "open_shift"]; }, 1);
    reject(reply => { view(reply).completenessReasons = ["source_unproven", "source_unproven"]; }, 1);
    reject(reply => { view(reply).completenessReasons = ["secret_reason"]; }, 1);
  });
  it("refuses fraudulent complete, unresolved and share states", () => {
    reject(reply => { view(reply).unitComplete = false; });
    reject(reply => { view(reply).completenessReasons = ["named_unlinked"]; });
    reject(reply => { object(view(reply).unresolvedAttribution).present = true; });
    reject(reply => { firstPerson(reply).complete = false; });
    reject(reply => { object(firstPerson(reply).share).numeratorMicros = "1"; });
    reject(reply => { object(firstPerson(reply).share).denominatorMicros = "1"; });
    reject(reply => { firstPerson(reply).share = { state: "unavailable", reasons: [] }; });
  });
  it("refuses an available share for the genuine partial SQL case", () => {
    reject(reply => { firstPerson(reply).share = { state: "available", numeratorMicros: "293000", denominatorMicros: "293000" }; }, 1);
    reject(reply => { object(firstPerson(reply).share).reasons = []; }, 1);
  });
  it("refuses forged live flags or another person's live minutes", () => {
    reject(reply => { view(reply).includesLive = true; });
    reject(reply => { firstPerson(reply).includesLive = true; });
  });
  it("refuses a zero-only tap represented as a worked person", () => {
    reject(reply => { view(reply).people = view(reply).zeroOnly; view(reply).zeroOnly = []; }, 4);
    reject(reply => { object(rows(view(reply).zeroOnly)[0]).includesLive = true; }, 4);
    reject(reply => { object(rows(view(reply).zeroOnly)[0]).complete = false; }, 4);
    reject(reply => { object(view(reply).participantCounts).timed = 1; }, 4);
    reject(reply => { object(view(reply).participantCounts).total = 1; }, 4);
  });
  it("refuses a named-only reviewer converted into measured time", () => {
    reject(reply => { object(view(reply).participantCounts).untimedOnly = 0; }, 1);
    reject(reply => { object(rows(view(reply).untimedParticipants)[0]).evidence = []; }, 1);
    reject(reply => { const person = object(rows(view(reply).untimedParticipants)[0]); person.profileId = "00000000-0000-4000-8000-000000250001"; }, 1);
    reject(reply => { object(rows(object(rows(view(reply).untimedParticipants)[0]).evidence)[0]).evidenceState = "timed"; }, 1);
  });
  it("holds unsorted and duplicate named evidence, and rejects unlinked crew IDs", () => {
    reject(reply => { const evidence = rows(object(rows(view(reply).untimedParticipants)[0]).evidence); evidence.push(structuredClone(evidence[0])); }, 1);
    reject(reply => { object(rows(object(rows(view(reply).untimedParticipants)[0]).evidence)[0]).sourceKind = "crew_work_record_people"; }, 1);
    reject(reply => { object(rows(object(rows(view(reply).untimedParticipants)[0]).evidence)[0]).recordedAt = "2099-10-04T21:49:21.000000Z"; }, 1);
  });
  it("rejects bad participant counts and extra hidden source details", () => {
    reject(reply => { object(view(reply).participantCounts).total = 2; });
    reject(reply => { object(view(reply).participantCounts).total = -1; });
    reject(reply => { view(reply).payRate = "$50"; });
  });
  it("holds malformed shapes and redacts sensitive names from failures", () => {
    for (const raw of [null, [], "bad", Object.create({ protocolVersion: 1 }), JSON.parse('{"protocolVersion":1,"availability":"available","contributors":{},"__proto__":{"leak":"name"}}')]) {
      expect(() => parseUnitContributorsReply(raw, expected())).toThrow(UnitContributorsUnavailableError);
    }
    reject(reply => { firstPerson(reply).displayName = "PRIVATE EMPLOYEE"; view(reply).unitKnownMicros = "1"; });
  });
  it("rejects reply bytes beyond the 1MB bound without exposing a name", () => {
    reject(reply => { firstPerson(reply).displayName = "PRIVATE".repeat(170000); });
  });
  it("does not mutate source replies", () => {
    const original = JSON.stringify(corpus.calls[0].reply);
    parseUnitContributorsReply(corpus.calls[0].reply, expected());
    expect(JSON.stringify(corpus.calls[0].reply)).toBe(original);
  });
});
