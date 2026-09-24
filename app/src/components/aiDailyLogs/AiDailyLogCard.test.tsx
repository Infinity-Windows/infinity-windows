import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { LanguageContext } from "../../lib/i18n/context";
import { CATALOG } from "../../lib/i18n/catalog";
import { translate } from "../../lib/i18n/translate";

vi.mock("../../lib/supabase", () => ({ supabase: {}, supabaseConfigured: true }));
vi.mock("../../lib/offline/outbox", () => ({ MAX_BLOB_BYTES: 1, subscribe: () => () => undefined, subscribeSynced: () => () => undefined }));
const { AiDailyLogCard } = await import("./AiDailyLogCard");
const { AI_DAILY_LOG_CATALOG } = await import("./dailyLogCatalog");
const D = await import("../../lib/aiDailyLogs/draft");

const ANA = { userId: "00000000-0000-4000-8000-000000000001", email: "ana@example.test", displayName: "Ana" };
const SMITH = { projectId: "00000000-0000-4000-8000-000000000090", label: "SMITH · Smith Residence" };
const SMYTHE = { projectId: "00000000-0000-4000-8000-000000000091", label: "SMYTHE · Smythe Ranch" };
const photo = (id: string) => ({ id, caption: null, takenAt: "", lat: null, lng: null, accuracyM: null, bytes: 1 });

function html(draft: ReturnType<typeof D.newDraft>, lang: "en" | "es" = "en", over: Record<string, unknown> = {}) {
  const controller = {
    actor: ANA, draft, snapshot: () => draft, loading: false, durable: true, storageError: null, saving: false,
    preparingPhotos: 0, blockedByAccount: false, checkingLog: false, logError: null,
    photoViews: draft.photos.map((p) => ({ photo: p, state: p.queuedAt ? "uploading" : "on_phone" })),
    rejectedPhotos: [], queueFailures: [], photoBlob: async () => null, ...over,
  } as never;
  const value = { lang, t: (k: never, v?: never) => translate(CATALOG, lang, k, v), setLang: () => {}, needsChoice: false };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <LanguageContext.Provider value={value as never}>
          <AiDailyLogCard controller={controller} jobs={[SMITH, SMYTHE]} />
        </LanguageContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the daily log card", () => {
  it("names the job and date up front and asks the person to choose between real jobs", () => {
    const out = text(html(D.offerJobs(D.newDraft(ANA.userId, "2026-09-22"), [SMITH, SMYTHE])));
    expect(out).toContain("Today's daily log");
    expect(out).toContain("Sep 22, 2026");
    expect(out).toContain("More than one job matches. Which one?");
    expect(out).toContain("Use SMITH · Smith Residence");
    expect(out).toContain("Use SMYTHE · Smythe Ranch");
    expect(html(D.newDraft(ANA.userId, "2026-09-22"))).toMatch(/<button[^>]*disabled[^>]*>Save daily log/);
  });

  it("shows the existing log, the exact addition, each photo's job, and an enabled Save", () => {
    let d = D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH);
    d = D.setBase(d, { id: "l", revision: 2, notes: "Added by Ben with Forge AI:\nFlashing", headline: null, day_flow: null, weather: null, reflection: null, filed_by: "b", filed_by_name: "Ben", updated_at: null });
    d = D.editAnswer(d, "work_completed", "Set 6 frames");
    d = D.editAnswer(d, "people", { unknown: true });
    d = D.addPhoto(d, photo("p1"), D.destinationNow(d));
    const raw = html(d);
    const out = text(raw);
    expect(out).toContain("Started by Ben");
    expect(out).toContain("Added by Ben with Forge AI: Flashing");
    expect(out).toContain("Added by Ana with Forge AI: Work completed: Set 6 frames People: unknown Photos: 1 attached");
    expect(out).toContain("Goes to SMITH · Smith Residence");
    expect(out).toContain("Waiting on this phone");
    expect(out).toContain("Said unknown");
    expect(raw).not.toMatch(/<button[^>]*disabled[^>]*>Save daily log/);
  });

  it("a photo left on another job blocks Save and offers the move", () => {
    let d = D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH);
    d = D.addPhoto(d, photo("p1"), D.destinationNow(d));
    d = D.setBase(D.editAnswer(D.chooseJob(d, SMYTHE), "work_completed", "x"), null);
    const raw = html(d);
    expect(text(raw)).toContain("This photo goes to SMITH · Smith Residence, not this log's job.");
    expect(text(raw)).toContain("Move to SMYTHE · Smythe Ranch");
    expect(raw).toMatch(/<button[^>]*disabled[^>]*>Save daily log/);
  });

  it("an unanswered save says so and keeps the words; the receipt is the real one and photos report separately", () => {
    let d = D.setBase(D.editAnswer(D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH), "work_completed", "x"), null);
    d = D.addPhoto(d, photo("p1"), D.destinationNow(d));
    const begun = D.beginSave(d, "2026-09-23");
    if (!("payload" in begun)) throw new Error("expected payload");
    const uncertain = D.applySaveOutcome(begun.draft, begun.draft.id, { kind: "uncertain" });
    const out = text(html(uncertain));
    expect(out).toContain("It may or may not have saved");
    expect(out).toContain("Try saving again");
    expect(out).not.toContain("Saved to the");

    const saved = D.markQueued(D.applySaveOutcome(uncertain, uncertain.id, { kind: "receipt", receipt: {
      status: "already_saved", contribution_id: uncertain.id, log_id: "l", project_id: SMITH.projectId, log_date: "2026-09-22",
      actor_id: ANA.userId, actor_name: "Ana", base_revision: 0, saved_revision: 1, created_log: true, saved_at: "2026-09-22T20:00:00Z", photo_ids: ["p1"], log: null,
    } }), "p1");
    const raw = html(saved);
    const done = text(raw);
    expect(done).toContain("Saved to the SMITH · Smith Residence log for Sep 22, 2026.");
    expect(done).toContain("Not added twice");
    expect(done).toContain("Each photo below shows its own status");
    expect(done).toContain("Uploading");
    expect(raw).toContain(`href="/projects/${SMITH.projectId}?tab=logs"`);
  });

  it("the work date is editable before Save, never after today", () => {
    const raw = html(D.chooseJob(D.newDraft(ANA.userId, "2026-09-20"), SMITH));
    expect(raw).toMatch(/<input[^>]*type="date"[^>]*>/);
    expect(raw).toContain('value="2026-09-20"');
    expect(raw).toMatch(/type="date"[^>]*max="\d{4}-\d{2}-\d{2}"/);
  });

  it("says when the phone could not keep changes, when photos are still being prepared, and when a sign-in changed", () => {
    const d = D.setBase(D.editAnswer(D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH), "work_completed", "x"), null);
    const raw = html(d, "en", { storageError: "QuotaExceededError", preparingPhotos: 2, blockedByAccount: true });
    const out = text(raw);
    expect(out).toContain("this phone could not keep them");
    expect(out).toContain("Preparing 2 photo(s)");
    expect(out).toContain("signed in as someone else now");
    expect(raw).toMatch(/<button[^>]*disabled[^>]*>Save daily log/);
  });

  it("a long entry is shown whole with its length problem, never cut", () => {
    const long = "y".repeat(8100);
    const d = D.setBase(D.editAnswer(D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH), "work_completed", long), null);
    const raw = html(d);
    expect(raw).toContain(long);
    expect(text(raw)).toContain("This entry is 8116 characters; the log takes up to 8000.");
    expect(raw).toMatch(/<button[^>]*disabled[^>]*>Save daily log/);
  });

  it("a saved entry's photo still on this phone offers Retry; one the queue lost offers Send again — neither claims it uploaded", () => {
    let d = D.setBase(D.editAnswer(D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH), "work_completed", "x"), null);
    d = D.addPhoto(d, photo("p1"), D.destinationNow(d));
    d = D.addPhoto(d, photo("p2"), D.destinationNow(d));
    const begun = D.beginSave(d, "2026-09-23");
    if (!("payload" in begun)) throw new Error("expected payload");
    const saved = D.markQueued(D.applySaveOutcome(begun.draft, begun.draft.id, { kind: "receipt", receipt: {
      status: "saved", contribution_id: begun.draft.id, log_id: "l", project_id: SMITH.projectId, log_date: "2026-09-22",
      actor_id: ANA.userId, actor_name: "Ana", base_revision: 0, saved_revision: 1, created_log: true, saved_at: "2026-09-22T20:00:00Z", photo_ids: ["p1", "p2"], log: null,
    } }), "p2");
    const raw = html(saved, "en", {
      photoViews: [{ photo: saved.photos[0], state: "on_phone" }, { photo: saved.photos[1], state: "checking" }],
      queueFailures: [{ photoId: "p1", message: "Couldn't save this offline (storage may be full)" }],
    });
    const out = text(raw);
    expect(out).toContain("Waiting on this phone Try again");
    expect(out).toContain("Checking with the server… Not on the server — send again from this phone");
    expect(out).not.toMatch(/Saved to the job/);
    expect(out).toContain("Couldn't save this offline");
  });

  it("at the message limit the held words are not lost: the card says so and offers to keep them", () => {
    const d = { ...D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH),
      notice: { kind: "source_limit" as const, held: { people: { status: "captured" as const, value: "Ana and Ben", source: "said" as const } } } };
    const out = text(html(d));
    expect(out).toContain("the last answer was NOT added");
    expect(out).toContain("Keep those words as my typed text");
  });

  it("a storage error offers to try keeping the draft again", () => {
    const d = D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH);
    expect(text(html(d, "en", { storageError: "QuotaExceededError" }))).toContain("Try keeping it on this phone again");
  });

  it("reads in Spanish", () => {
    const out = text(html(D.chooseJob(D.newDraft(ANA.userId, "2026-09-22"), SMITH), "es"));
    expect(out).toContain("Registro del día");
    expect(out).toContain("Trabajo terminado");
    expect(out).toContain("Guardar registro");
  });

  it("every card string has English and Spanish", () => {
    for (const [key, entry] of Object.entries(AI_DAILY_LOG_CATALOG)) {
      expect(entry.en, key).toBeTruthy();
      expect(entry.es, key).toBeTruthy();
      expect([...entry.es.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), key).toEqual([...entry.en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());
    }
  });
});
