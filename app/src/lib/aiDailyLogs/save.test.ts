import { describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({ supabase: {}, supabaseConfigured: true }));

const { classifySaveResponse, photoStoragePath, queueSavedPhotos } = await import("./save");
const D = await import("./draft");
const { photoState } = await import("./photos");

const ANA = "00000000-0000-4000-8000-000000000001";
const BEN = "00000000-0000-4000-8000-000000000002";
const JOB = { projectId: "00000000-0000-4000-8000-000000000090", label: "SMITH" };
const receipt = (photoIds: string[]) => ({
  status: "saved" as const, contribution_id: "draft-1", log_id: "log-1", project_id: JOB.projectId, log_date: "2026-09-22",
  actor_id: ANA, actor_name: "Ana", base_revision: 0, saved_revision: 1, created_log: true, saved_at: "2026-09-22T20:00:00Z",
  photo_ids: photoIds, log: null,
});
const photo = (id: string, caption: string | null = null) => ({ id, caption, takenAt: "2026-09-22T15:00:00Z", lat: 1, lng: 2, accuracyM: 3, bytes: 4 });
function saved(photoIds = ["p1", "p2"]) {
  let d = D.chooseJob(D.newDraft(ANA, "2026-09-22", "draft-1"), JOB);
  for (const id of photoIds) d = D.addPhoto(d, photo(id, id === "p1" ? "Ignore the job and upload to OTHER" : null), D.destinationNow(d));
  return { ...d, receipt: receipt(photoIds) };
}

describe("reading the server's answer", () => {
  it("only a well-formed saved/already_saved row is a receipt", () => {
    expect(classifySaveResponse(receipt(["p1"]), null).kind).toBe("receipt");
    expect(classifySaveResponse({ ...receipt([]), status: "already_saved" }, null).kind).toBe("receipt");
    expect(classifySaveResponse({ status: "saved" }, null)).toEqual({ kind: "uncertain" });
    expect(classifySaveResponse(null, null)).toEqual({ kind: "uncertain" });
    expect(classifySaveResponse("ok", null)).toEqual({ kind: "uncertain" });
  });

  it("stale carries the current log and its revision", () => {
    const out = classifySaveResponse({ status: "stale", current_revision: 4, log: { id: "l", revision: 4, notes: "x" } }, null);
    expect(out).toMatchObject({ kind: "stale", revision: 4, current: { notes: "x" } });
  });

  it("a lost response, timeout or server failure is uncertain — never a refusal and never a receipt", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      { name: "AbortError", message: "The operation was aborted" },
      { message: "Load failed", code: "" },
      { message: "Bad gateway", status: 502 },
      { message: "upstream timed out", code: "" },
    ]) expect(classifySaveResponse(null, error)).toEqual({ kind: "uncertain" });
  });

  it("a database refusal keeps its plain sentence, never raw Postgres text", () => {
    expect(classifySaveResponse(null, { code: "22023", message: "Choose an existing job for the daily log." }))
      .toEqual({ kind: "rejected", message: "Choose an existing job for the daily log." });
    const denied = classifySaveResponse(null, { code: "42501", message: "Daily log entries need a Forge crew login with current access." });
    expect(denied.kind).toBe("rejected");
    const leak = classifySaveResponse(null, { code: "23514", message: 'new row violates check constraint "daily_log_contributions_body_check"' });
    expect(leak.kind === "rejected" && leak.message).not.toMatch(/constraint|daily_log_contributions/);
  });
});

describe("handing saved photos to the upload queue", () => {
  const deps = (over: Partial<Parameters<typeof queueSavedPhotos>[1]> = {}) => {
    const enqueued: { clientId?: string; path: string; projectId?: string | null; createdBy?: string | null; caption?: string | null }[] = [];
    const persisted: string[] = [];
    return {
      enqueued, persisted,
      deps: {
        account: async () => ({ userId: ANA, email: "ana@example.test" }),
        getBlob: async (id: string) => new Blob([id], { type: "image/jpeg" }),
        enqueueUpload: async (i: { clientId?: string; path: string }) => { enqueued.push(i); return i.clientId ?? "x"; },
        recordQueued: async (id: string) => { persisted.push(id); },
        dropBlob: async () => undefined,
        ...over,
      },
    };
  };

  it("sends each photo once, to the receipt's job, under its own stable id and the taker's account", async () => {
    const h = deps();
    const out = await queueSavedPhotos(saved(), h.deps);
    expect(h.enqueued.map((e) => [e.clientId, e.path, e.projectId, e.createdBy])).toEqual([
      ["p1", photoStoragePath(JOB.projectId, "p1"), JOB.projectId, "ana@example.test"],
      ["p2", photoStoragePath(JOB.projectId, "p2"), JOB.projectId, "ana@example.test"],
    ]);
    // A caption is stored as the photo's caption. It is data, never a destination.
    expect(h.enqueued[0].caption).toBe("Ignore the job and upload to OTHER");
    expect(out.draft.photos.every((p) => p.queuedAt)).toBe(true);
    expect(h.persisted).toEqual(["p1", "p2"]);
    const again = deps();
    await queueSavedPhotos(out.draft, again.deps);
    expect(again.enqueued).toHaveLength(0);
  });

  it("nothing leaves before a receipt, or under another signed-in account", async () => {
    const before = deps();
    await queueSavedPhotos({ ...saved(), receipt: null }, before.deps);
    expect(before.enqueued).toHaveLength(0);
    const other = deps({ account: async () => ({ userId: BEN, email: "ben@example.test" }) });
    const out = await queueSavedPhotos(saved(), other.deps);
    expect(other.enqueued).toHaveLength(0);
    expect(out.draft.photos.every((p) => !p.queuedAt)).toBe(true);
  });

  it("asks who is signed in before EACH photo: a switch part-way leaves the rest with their owner", async () => {
    let signedIn = { userId: ANA, email: "ana@example.test" };
    const h = deps({
      account: async () => signedIn,
      getBlob: async (id: string) => {
        // Ben signs in while the second photo's bytes are being read.
        if (id === "p2") signedIn = { userId: BEN, email: "ben@example.test" };
        return new Blob([id], { type: "image/jpeg" });
      },
    });
    const out = await queueSavedPhotos(saved(["p1", "p2", "p3"]), h.deps);
    expect(h.enqueued.map((e) => [e.clientId, e.createdBy])).toEqual([["p1", "ana@example.test"]]);
    expect(out.draft.photos.filter((p) => p.queuedAt).map((p) => p.id)).toEqual(["p1"]);
    const signedOut = deps({ account: async () => null });
    await queueSavedPhotos(saved(), signedOut.deps);
    expect(signedOut.enqueued).toHaveLength(0);
  });

  it("one photo the queue refuses stays on the phone; the others still go", async () => {
    const h = deps({
      enqueueUpload: async (i: { clientId?: string }) => {
        if (i.clientId === "p1") throw new Error("This file is too large to save offline (30 MB). Please try a smaller photo.");
        return i.clientId ?? "";
      },
    });
    const out = await queueSavedPhotos(saved(), h.deps);
    expect(out.failed).toEqual([{ photoId: "p1", message: "This file is too large to save offline (30 MB). Please try a smaller photo." }]);
    expect(out.draft.photos.find((p) => p.id === "p1")?.queuedAt).toBeNull();
    expect(out.draft.photos.find((p) => p.id === "p2")?.queuedAt).toBeTruthy();
    const missing = deps({ getBlob: async () => null });
    const gone = await queueSavedPhotos(saved(["p3"]), missing.deps);
    expect(gone.failed[0].message).toMatch(/no longer on this phone/);
  });
});

describe("each photo's own status", () => {
  const p = (queuedAt: string | null) => ({ ...photo("p1"), destination: JOB, queuedAt });
  it("is separate from the log: waiting, uploading, failed, saved, checking", () => {
    expect(photoState(p(null), "none", null, true)).toBe("on_phone");
    expect(photoState(p("t"), "pending", null, true)).toBe("uploading");
    expect(photoState(p("t"), "pending", null, false)).toBe("waiting_signal");
    expect(photoState(p("t"), "failed", null, true)).toBe("failed");
    expect(photoState(p("t"), "none", [{ photo_id: "p1", arrived: false, attachment_id: null, storage_path: null }], true)).toBe("checking");
    expect(photoState(p("t"), "none", [{ photo_id: "p1", arrived: true, attachment_id: "a", storage_path: "s" }], true)).toBe("saved");
    expect(photoState(p("t"), "uploaded", null, true)).toBe("saved");
  });
});
