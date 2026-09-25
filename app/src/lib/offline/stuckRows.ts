// What the /stuck screen lists, built from every queue on the phone. Pure,
// so the page exports only a component and the list has a test.
//
// Three states per item, in the words a crew member sees (K0.6):
//   "Saved on this phone" — queued, waiting for signal or for its turn;
//   "Sending…"            — a drain is attempting it right now;
//   "Saved in Forge"      — it reached the server this session.
// Plus the one this screen was first built for: "Couldn't send — needs you",
// a write that gave up after its retries and waits for a person.
//
// Until K0.6 the screen listed only that last state. A photo that was merely
// WAITING — for a week, on a phone that said "All synced" — was on no screen
// at all; the age on the row is the fact that turns "it's syncing" into "it
// has been trying since Tuesday".

import type { TFn, TKey } from "../i18n";
import type { OutboxEntry, OutboxOp } from "./outbox-core";
import { uploadKind } from "./outbox-core";
import { isPhotoConflictIndexError } from "./recoverPhotoUploads";
import type { SentWrite } from "./outbox";
import type { InstallOutboxRecord, SentInstall } from "../install/installOutbox";
import type { WorkCommand } from "../customWork/model";
import type { ServiceCommand } from "../servicing/model";

/**
 * Plain words for what a write WAS, not the op code it's stored under. Typed
 * as Record<OutboxOp, TKey> on purpose: adding a new op to OutboxOp without
 * adding it here is a compile error, so this screen can never show a foreman
 * a raw code word like "checkout_packages".
 */
export const OP_LABEL_KEY: Record<OutboxOp, TKey> = {
  clock_in: "stuck.op.clockIn",
  clock_out: "stuck.op.clockOut",
  break_start: "stuck.op.breakStart",
  break_stop: "stuck.op.breakStop",
  // Reachable for real since 2026-09-05: fileDailyLog queues on no signal.
  // Before that this op had no callers at all, so this label was a placeholder
  // for a row that could never appear.
  daily_log: "stuck.op.dailyLog",
  // A unit's memo and video ride this op too; labelled by kind below.
  photo_upload: "stuck.op.photoUpload",
  receipt_upload: "stuck.op.receiptUpload",
  // All three pin ops read the same to a foreman — a mark got moved back —
  // the difference (one mark vs. the whole job) doesn't change what to do
  // about it here.
  pin_undo: "stuck.op.pinChange",
  pin_reset_project: "stuck.op.pinChange",
  pin_reset_opening: "stuck.op.pinChange",
  store_packages: "stuck.op.storePackages",
  checkout_packages: "stuck.op.checkoutPackages",
  take_supply: "stuck.op.takeSupply",
  bind_package: "stuck.op.bindPackage",
  stage_packages: "stuck.op.stagePackages",
  move_container: "stuck.op.moveContainer",
  set_package_area: "stuck.op.setPackageArea",
  set_package_note: "stuck.op.setPackageNote",
  receive_minted: "stuck.op.receiveMinted",
  pickup_takeoff: "stuck.op.pickupTakeoff",
  issue_photo_upload: "stuck.op.issuePhotoUpload",
  receipt_capture: "stuck.op.receiptCapture",
  receipt_answer: "stuck.op.receiptAnswer",
  // The original PDF, not the receipt itself — the receipt (page one, plus its
  // amount and job) may already have landed, so this must not read as "Receipt"
  // or a foreman would go looking for a receipt that is sitting on the table.
  receipt_document_upload: "stuck.op.receiptDocumentUpload",
  video_quiz_submit: "stuck.op.videoQuizSubmit",
  save_build_facts: "stuck.op.saveBuildFacts",
  hex_portal_case: "stuck.op.hexPortalCase",
  hex_portal_outcome: "stuck.op.hexPortalOutcome",
  hex_learning_draft: "stuck.op.hexLearningDraft",
  toolbox_sign: "stuck.op.toolboxSign",
};

/** The words for one outbox entry: its op, or for media its kind. */
export function writeLabel(entry: OutboxEntry, t: TFn): string {
  if (entry.op === "photo_upload") {
    const kind = uploadKind(entry);
    if (kind === "voice_memo") return t("stuck.op.voiceMemo");
    if (kind === "video") return t("stuck.op.video");
  }
  return t(OP_LABEL_KEY[entry.op]);
}

export type StuckState = "waiting" | "sending" | "failed" | "sent";

/** Which store owns a row, so retry/discard reach the right one. */
export type StuckSource = "write" | "install" | "work" | "service" | "serviceMedia" | "legacy";

export interface StuckRow {
  id: string;
  label: string;
  /** When it was made (ms epoch); 0 when the store did not record one. */
  when: number;
  detail: string | null;
  source: StuckSource;
  state: StuckState;
  /** For a sent row: when it reached the server. */
  sentAt: number | null;
  /** Try again is offered: a write or install that gave up, or a refused
   * custom-work / servicing command (retried as a set by its own queue). */
  canRetry: boolean;
  /** Throw away is offered: only for the two stores whose rows are this
   * phone's alone. Custom work and servicing keep their own review screens,
   * where a refused command is exported before it is ever removed. */
  canDiscard: boolean;
  /** The screen that owns this row's review, when it is not this one. */
  reviewTo: "/current-work" | "/servicing" | null;
}

export interface StuckInputs {
  writes: OutboxEntry[];
  installs: InstallOutboxRecord[];
  isInstallSending: (id: string) => boolean;
  work: WorkCommand[];
  service: ServiceCommand[];
  serviceMedia: Array<{ id: string; filename: string; error?: string }>;
  /** Items still in the retired upload store, not moved into the outbox yet. */
  legacy: number;
  sentWrites: readonly SentWrite[];
  sentInstalls: readonly SentInstall[];
}

export interface StuckSections {
  needsYou: StuckRow[];
  waiting: StuckRow[];
  sent: StuckRow[];
}

/** Newest first; rows with no time last, in the order they came. */
function newestFirst(rows: StuckRow[]): StuckRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      if (a.row.when === 0 && b.row.when === 0) return a.i - b.i;
      if (a.row.when === 0) return 1;
      if (b.row.when === 0) return -1;
      return b.row.when - a.row.when;
    })
    .map(({ row }) => row);
}

export function buildStuckRows(inputs: StuckInputs, t: TFn): StuckSections {
  const needsYou: StuckRow[] = [];
  const waiting: StuckRow[] = [];
  // Toolbox talk signatures Forge refused. What waits on one was never sent
  // and never failed on its own (cascadeFailure holds it), so it is not
  // "waiting for signal" either: it is waiting for that signature, which is
  // listed under Needs you (offline toolbox signing, 2026-09-25).
  const refusedSignatures = new Set(
    inputs.writes.filter((e) => e.op === "toolbox_sign" && e.status === "failed").map((e) => e.id),
  );

  for (const e of inputs.writes) {
    const failed = e.status === "failed";
    const row: StuckRow = {
      id: e.id,
      label: writeLabel(e, t),
      when: e.createdAt,
      detail: failed
        ? isPhotoConflictIndexError(e.lastError)
          ? t("photo.databaseRetry")
          : e.lastError
        : e.dependsOn && refusedSignatures.has(e.dependsOn)
          ? t("stuck.heldForSignature")
          : null,
      source: "write",
      state: failed ? "failed" : e.status === "sending" ? "sending" : "waiting",
      sentAt: null,
      canRetry: failed,
      canDiscard: failed,
      reviewTo: null,
    };
    (failed ? needsYou : waiting).push(row);
  }

  for (const r of inputs.installs) {
    const failed = r.status === "failed";
    const row: StuckRow = {
      id: r.id,
      // Name the window, not the record: "Window W1 finished" is what the
      // person actually did.
      label: r.payload.openingCode
        ? t("stuck.windowFinished", { code: r.payload.openingCode })
        : t("stuck.windowFinishedNoCode"),
      when: Date.parse(r.payload.createdAt ?? "") || 0,
      detail: failed ? r.lastError : null,
      source: "install",
      state: failed ? "failed" : inputs.isInstallSending(r.id) ? "sending" : "waiting",
      sentAt: null,
      canRetry: failed,
      canDiscard: failed,
      reviewTo: null,
    };
    (failed ? needsYou : waiting).push(row);
  }

  for (const c of inputs.work) {
    const row: StuckRow = {
      id: `work:${c.id}`,
      label: t("stuck.customWork"),
      // The command queues record no time — said so, never guessed.
      when: 0,
      detail: c.error ?? null,
      source: "work",
      state: c.error ? "failed" : "waiting",
      sentAt: null,
      canRetry: Boolean(c.error),
      canDiscard: false,
      reviewTo: "/current-work",
    };
    (c.error ? needsYou : waiting).push(row);
  }

  for (const c of inputs.service) {
    const row: StuckRow = {
      id: `service:${c.id}`,
      label: t("stuck.serviceChange"),
      when: 0,
      detail: c.error ?? null,
      source: "service",
      state: c.error ? "failed" : "waiting",
      sentAt: null,
      canRetry: Boolean(c.error),
      canDiscard: false,
      reviewTo: "/servicing",
    };
    (c.error ? needsYou : waiting).push(row);
  }

  for (const m of inputs.serviceMedia) {
    const row: StuckRow = {
      id: `serviceMedia:${m.id}`,
      label: t("stuck.serviceEvidence"),
      when: 0,
      detail: m.error ?? m.filename ?? null,
      source: "serviceMedia",
      state: m.error ? "failed" : "waiting",
      sentAt: null,
      canRetry: Boolean(m.error),
      canDiscard: false,
      reviewTo: "/servicing",
    };
    (m.error ? needsYou : waiting).push(row);
  }

  if (inputs.legacy > 0) {
    waiting.push({
      id: "legacy",
      label: t("stuck.oldUploads", { n: inputs.legacy }),
      when: 0,
      detail: t("stuck.oldUploadsHint"),
      source: "legacy",
      state: "waiting",
      sentAt: null,
      canRetry: false,
      canDiscard: false,
      reviewTo: null,
    });
  }

  const sent: StuckRow[] = [
    ...inputs.sentWrites.map(({ entry, sentAt }) => ({
      id: `sent:${entry.id}`,
      label: writeLabel(entry, t),
      when: entry.createdAt,
      detail: null,
      source: "write" as const,
      state: "sent" as const,
      sentAt,
      canRetry: false,
      canDiscard: false,
      reviewTo: null,
    })),
    ...inputs.sentInstalls.map((i) => ({
      id: `sent:${i.id}`,
      label: i.openingCode
        ? t("stuck.windowFinished", { code: i.openingCode })
        : t("stuck.windowFinishedNoCode"),
      when: Date.parse(i.createdAt ?? "") || 0,
      detail: null,
      source: "install" as const,
      state: "sent" as const,
      sentAt: i.sentAt,
      canRetry: false,
      canDiscard: false,
      reviewTo: null,
    })),
  ].sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0));

  return { needsYou: newestFirst(needsYou), waiting: newestFirst(waiting), sent };
}

/** The words for a row's state. */
export function stateLabel(state: StuckState, t: TFn): string {
  switch (state) {
    case "waiting":
      return t("stuck.state.waiting");
    case "sending":
      return t("stuck.state.sending");
    case "failed":
      return t("stuck.state.failed");
    case "sent":
      return t("stuck.state.sent");
  }
}

/**
 * How long a write has been sitting here, in words rather than a timestamp.
 *
 * "Try again" replays a write exactly as it was written — the same packages,
 * the same job, the same numbers, decided whenever it was made. A stamp like
 * "8/14/2026, 4:12 PM" makes a person do that subtraction in their head while
 * standing in a warehouse, and most won't. Saying "queued 3 days ago" is the
 * one fact that changes the answer, so it goes on the row.
 *
 * This screen only ever REPORTS the age. It does not refuse an old write —
 * the check for whether a write still matches the world belongs on the
 * server, where the world actually is. Here, the person decides.
 *
 * Wording matches the rest of the app's "last seen" copy (vehicles, pin
 * history): just now / N min / N hr / N days.
 */
export function queuedAgoLabel(when: number, nowMs: number, t: TFn): string {
  // Install rows carry a text timestamp that can be missing, and 0 would draw
  // a confident "1/1/1970" — worse than admitting we don't know.
  if (!Number.isFinite(when) || when <= 0) return t("stuck.queuedNoTime");
  const min = Math.floor(Math.max(0, nowMs - when) / 60_000);
  if (min < 1) return t("stuck.queuedJustNow");
  if (min < 60) return t("stuck.queuedMinAgo", { min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("stuck.queuedHrAgo", { hr });
  const days = Math.floor(hr / 24);
  return days === 1 ? t("stuck.queuedDayAgo") : t("stuck.queuedDaysAgo", { days });
}
