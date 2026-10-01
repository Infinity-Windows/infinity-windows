import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentCandidate, ClassifyContext } from "./qcEvidence";

type Op = { name: string; args: unknown[] };
type Result = { data: unknown; error: unknown; count?: number | null };
const queries: { table: string; ops: Op[] }[] = [];
const signed: string[] = [];
let opening: unknown;
let respond: (table: string, ops: Op[]) => Result;
let signFails = false;
function builder(table: string) {
  const ops: Op[] = [];
  const query = new Proxy({}, {
    get(_target, key) {
      if (key === "then") return (resolve: (value: Result) => void) => {
        queries.push({ table, ops });
        resolve(respond(table, ops));
      };
      return (...args: unknown[]) => { ops.push({ name: String(key), args }); return query; };
    },
  });
  return query;
}
vi.mock("./install/api", () => ({ getOpening: async () => opening }));
vi.mock("./supabase", () => ({ supabase: {
  from: (table: string) => builder(table),
  storage: { from: (bucket: string) => ({ createSignedUrl: async (path: string) => {
    signed.push(`${bucket}/${path}`);
    return signFails ? { data: null, error: { message: "no access" } }
      : { data: { signedUrl: `https://fixture.invalid/${path}` }, error: null };
  } }) },
} }));
const { classifyAttachment, dedupeAttachmentCandidates, evaluateLegacyAmbiguity,
  loadQcUnitEvidence, parseAttachmentStoragePath, parsePhasePhotoPath } = await import("./qcEvidence");
const context: ClassifyContext = {
  openingId: "unit", expectedProjectId: "job", currentAssignedWindowId: "current",
  knownWindowIds: new Set(["current", "old"]),
  eventWindowById: new Map([["round", "current"], ["old-round", "old"], ["windowless", null]]),
  legacyAllowed: true,
};
function attachment(overrides: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
  return { id: "file", project_id: "job", project_opening_id: "unit", install_event_id: null,
    window_id: null, package_id: null, service_case_id: null, kind: "photo",
    storage_path: "install-media/job/photo.jpg", created_at: null, taken_at: null,
    caption: null, transcript: null, deleted_at: null, ...overrides };
}
beforeEach(() => {
  queries.length = 0; signed.length = 0; signFails = false;
  opening = { id: "unit", project_id: "job", assigned_window_id: "current",
    windows: { id: "current", project_id: "job" } };
  respond = (table, ops) => {
    if (ops.some(o => o.name === "select" && (o.args[1] as { head?: boolean })?.head)) {
      return { data: null, error: null, count: 0 };
    }
    if (table === "attachments") return { data: [attachment()], error: null, count: 1 };
    return { data: [], error: null, count: 0 };
  };
});

describe("unit evidence association", () => {
  it("preserves an older round's original window after reassignment", () => {
    expect(classifyAttachment(attachment({ install_event_id: "old-round", window_id: "old", project_id: null }), context))
      .toEqual({ source: "install", eventId: "old-round" });
    expect(classifyAttachment(attachment({ install_event_id: "old-round", window_id: "current" }), context)).toBeNull();
  });
  it.each([
    { project_id: "foreign" }, { project_opening_id: "foreign" }, { install_event_id: "foreign" },
    { window_id: "foreign" }, { package_id: "package" }, { service_case_id: "case" },
    { deleted_at: "2026-10-01" }, { kind: "video" },
  ])("rejects conflicting or out-of-scope metadata %j", bad => {
    expect(classifyAttachment(attachment(bad), context)).toBeNull();
  });
  it("does not infer evidence from project alone or a null-project legacy file", () => {
    expect(classifyAttachment(attachment({ project_opening_id: null }), context)).toBeNull();
    expect(classifyAttachment(attachment({ project_opening_id: null, window_id: "current", project_id: null }), context)).toBeNull();
    expect(classifyAttachment(attachment({ project_opening_id: null, window_id: "current" }), context))
      .toEqual({ source: "assigned_window", eventId: null });
  });
  it("accepts direct unit files without an installation round", () => {
    expect(classifyAttachment(attachment(), { ...context, eventWindowById: new Map() }))
      .toEqual({ source: "unit", eventId: null });
  });
  it("deduplicates identities but drops disagreeing reads without merging targets", () => {
    const a = attachment();
    expect(dedupeAttachmentCandidates([a, { ...a }]).rows).toHaveLength(1);
    expect(dedupeAttachmentCandidates([a, { ...a, install_event_id: "foreign" }]))
      .toEqual({ rows: [], conflictIds: ["file"] });
    expect(dedupeAttachmentCandidates([a, { ...a, id: "another-round" }]).rows).toHaveLength(2);
  });
  it.each([null, 1])("refuses legacy when the other-opening count is %s", count => {
    expect(evaluateLegacyAmbiguity({ currentAssignedWindowId: "current", expectedProjectId: "job",
      windowProjectIdKnown: true, windowProjectId: "job", otherOpeningsAssignedSameWindow: count,
      eventsNamingWindowOnDifferentOpening: 0 }).allowed).toBe(false);
  });
  it.each(["other-bucket/file", "https://host/file", "install-media/", "install-media/job/../file"])
    ("does not sign an arbitrary attachment path %s", path => expect(parseAttachmentStoragePath(path)).toBeNull());
  it("constrains submitted flashing paths to the expected job", () => {
    expect(parsePhasePhotoPath("job/unit/flashing.jpg", "job")).toBe(true);
    expect(parsePhasePhotoPath("foreign/unit/flashing.jpg", "job")).toBe(false);
  });
});

describe("reader failures and signing boundary", () => {
  it.each([null, { id: "unit", project_id: "foreign" }])("verifies the opening before reading or signing anything", async value => {
    opening = value;
    await expect(loadQcUnitEvidence("unit", "job")).rejects.toThrow(/qc_evidence_opening/);
    expect(queries).toEqual([]); expect(signed).toEqual([]);
  });
  it("deduplicates union reads and signs only eligible attachments", async () => {
    const normal = respond;
    respond = (table, ops) => table === "attachments"
      ? { data: [attachment(), attachment({ id: "bad", install_event_id: "foreign" })], error: null, count: 2 }
      : normal(table, ops);
    const record = await loadQcUnitEvidence("unit", "job");
    expect(signed).toEqual(["install-media/job/photo.jpg"]);
    expect(record.media).toHaveLength(1);
    expect(record.problems).toContainEqual({ source: "attachments", reason: "conflict" });
  });
  it("retains an unavailable recording and its transcription when signing fails", async () => {
    signFails = true;
    const normal = respond;
    respond = (table, ops) => table === "attachments"
      ? { data: [attachment({ kind: "voice_memo", transcript: "Installer's saved words" })], error: null, count: 1 }
      : normal(table, ops);
    const record = await loadQcUnitEvidence("unit", "job");
    expect(record.media[0]).toMatchObject({ kind: "voice_memo", signedUrl: null, transcript: "Installer's saved words" });
  });
  it("preserves direct unit files when an event-linked branch is unavailable", async () => {
    const normal = respond;
    respond = (table, ops) => {
      if (table === "install_events" && !ops.some(o => o.name === "select" && (o.args[1] as { head?: boolean })?.head)) {
        return { data: [{ id: "round", project_opening_id: "unit", window_id: "current" }], error: null, count: 1 };
      }
      if (table === "attachments" && ops.some(o => o.name === "in" && o.args[0] === "install_event_id")) {
        return { data: null, error: { message: "event files unavailable" } };
      }
      return normal(table, ops);
    };
    const record = await loadQcUnitEvidence("unit", "job");
    expect(record.sources.attachmentsLoaded).toBe(false);
    expect(record.media).toHaveLength(1);
    expect(record.media[0].source).toBe("unit");
    expect(record.problems).toContainEqual({ source: "attachments", reason: "unavailable" });
  });
  it("does not call a sole ambiguous legacy file an empty record", async () => {
    const normal = respond;
    respond = (table, ops) => table === "attachments"
      ? { data: [attachment({ project_opening_id: null, window_id: "current", project_id: null })], error: null, count: 1 }
      : normal(table, ops);
    const record = await loadQcUnitEvidence("unit", "job");
    expect(record.media).toEqual([]); expect(signed).toEqual([]);
    expect(record.problems).toContainEqual({ source: "attachments", reason: "ambiguous" });
  });
  it.each(["project_openings", "install_events"])("missing ambiguity count from %s excludes legacy evidence", async source => {
    const normal = respond;
    respond = (table, ops) => table === source && ops.some(o => o.name === "select" && (o.args[1] as { head?: boolean })?.head)
      ? { data: null, error: null, count: null } : normal(table, ops);
    const record = await loadQcUnitEvidence("unit", "job");
    expect(record.sources.legacyLoaded).toBe(false);
    expect(record.problems).toContainEqual({ source: "legacy", reason: "unavailable" });
    expect(record.media[0].source).toBe("unit");
  });
  it.each([
    { data: null, error: { code: "42P01", message: 'relation "opening_phases" does not exist' } },
    { data: null, error: { code: "42703", message: 'column "photo_path" does not exist' } },
    { data: [{ photo_path: null, submitted_at: "2026-10-01" }], error: null },
  ])("reports unavailable flashing records honestly", async phaseResult => {
    const normal = respond;
    respond = (table, ops) => table === "opening_phases" ? phaseResult : normal(table, ops);
    const record = await loadQcUnitEvidence("unit", "job");
    expect(record.sources.phaseLoaded).toBe(false);
    expect(record.problems).toContainEqual({ source: "phase", reason: "unavailable" });
    expect(record.media[0].source).toBe("unit");
  });
  it.each(["install_events", "attachments"])("does not turn a failed %s read into a clean empty result", async source => {
    const normal = respond;
    respond = (table, ops) => table === source ? { data: null, error: { message: "not readable" } } : normal(table, ops);
    const record = await loadQcUnitEvidence("unit", "job");
    expect(record.problems).toContainEqual({ source: source === "install_events" ? "events" : "attachments", reason: "unavailable" });
    expect(record.sources[source === "install_events" ? "eventsLoaded" : "attachmentsLoaded"]).toBe(false);
  });
});
