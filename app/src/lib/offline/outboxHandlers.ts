// Supabase-backed handlers for each outbox op. This is the ONLY file in the
// outbox that talks to Supabase, so the pure core + store stay unit-testable.
//
// Idempotency: row-creating ops (clock-in, media uploads) carry the entry's
// stable client id. When the additive `client_id` migration is applied the
// server dedupes on it; when it is NOT applied we detect the missing
// function/column and fall back to a best-effort plain write — the feature
// never crashes and never blocks the crew.
//
// take_supply carries a key too, and it is the ONE op with no such fallback
// tier (warehouse audit F1). Two reasons. First, its key is minted by the
// caller in lib/warehouse/offlineWrites.ts and rides in the payload, not in
// entry.id — that write tries the server before it ever queues, so the key
// has to exist before the entry does. Second, degrading gracefully here would
// mean sending an unguarded take, which is exactly the bug: subtracting twice
// is worse than failing loudly. A take with no key is a bug in whatever built
// the entry, so it dead-letters where a foreman can see it.

import { supabase } from "../supabase";
import { isMissingStagingBayError } from "../staging";
import {
  errorMessage,
  type OpHandler,
  type OpHandlers,
  type OutboxEntry,
} from "./outbox-core";

/** Resolves an offline clock-in entry id to the real server shift id. */
export interface ShiftResolver {
  record(clockInEntryId: string, shiftId: string): void;
  resolve(ref: string): string | null;
}

const PENDING_PREFIX = "pending:";

/** Build a clock-out/break shiftRef that points at a not-yet-synced clock-in. */
export function pendingShiftRef(clockInEntryId: string): string {
  return `${PENDING_PREFIX}${clockInEntryId}`;
}

export function isPendingRef(ref: string): boolean {
  return ref.startsWith(PENDING_PREFIX);
}

/**
 * Some errors mean the additive migration hasn't been applied yet (unknown
 * function overload or unknown column). We detect those to fall back, rather
 * than treating them as real failures.
 */
/**
 * The app arriving somewhere its database has not.
 *
 * Both stale-belief guards call a NEW overload of an existing function. If the
 * app bundle reaches a phone before the migration lands, PostgREST answers
 * "could not find the function", which is not a network error and not one this
 * queue treats as permanent — so every queued check-in and set-aside would burn
 * all eight retries and then dead-letter with raw PostgREST text nobody can act
 * on. Deploying the backend has silently failed on this project before, so this
 * is the likelier direction, not the theoretical one.
 *
 * It fails on the FIRST try instead of the eighth, and says something true. The
 * one thing it must never do is fall back to the old two-argument call — that
 * would send the write with no note at all, which is the bug all this exists to
 * close.
 */
function missingGuard(err: unknown, what: string): unknown {
  if (!isMissingFunction(err)) return err;
  return tagPermanent(
    new Error(
      `This ${what} needs an app update that has not reached the server yet. ` +
        "Nothing was lost and nothing was changed — tell whoever manages the " +
        "app, then press Try again.",
    ),
  );
}

function isMissingFunction(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "PGRST202") return true;
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("could not find the function") ||
    msg.includes("does not exist") && msg.includes("function")
  );
}

function isMissingColumn(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code === "PGRST204" || code === "42703") return true;
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("client_id") && msg.includes("column");
}

/** The server's refusal when a sticker has already been bound to a package. */
function isAlreadyAssigned(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes("already assigned");
}

/**
 * What a tag carries that ends up ON the package row — everything except the
 * marks, which live in their own table.
 *
 * Normalized the way bind_package stores it (note trimmed, maker's mark
 * uppercased) so a resend of the very same tag compares equal instead of
 * looking like a different one.
 */
interface TagDetails {
  category: string | null;
  note: string | null;
  partIndex: number | null;
  partTotal: number | null;
  partType: string | null;
  mfrMark: string | null;
  deliveryId: string | null;
}

function trimmed(v: unknown): string | null {
  const s = str(v)?.trim() ?? "";
  return s === "" ? null : s;
}

function upperTrimmed(v: unknown): string | null {
  return trimmed(v)?.toUpperCase() ?? null;
}

/** What the sticker actually holds right now. */
interface TaggedNow {
  /** The job it is on; `null` when it is still blank, so a bind can be retried. */
  projectId: string | null;
  /** What a person reads off the sticker. Null when the row carried none. */
  serial: string | null;
  /** The marks actually on the row, so ours can be weighed against them. */
  marks: string[];
  /** The details on the row, to weigh against the ones this entry carried. */
  details: TagDetails;
}

/**
 * Read a sticker back — asked only when the server has refused a second bind,
 * to tell "the tag we are holding already landed" from "somebody else used
 * that sticker".
 *
 * `undefined` means COULD NOT ASK, and that is the answer that matters most.
 * Guessing on a failed read either throws away a tag that never landed or
 * calls a wrong one done, and both are silent.
 *
 * It reads the details as well as the job because a refusal has to be able to
 * say what did NOT make it (see the bind handler): the row's own fields are
 * the fingerprint of which tag won this sticker.
 */
async function taggedNow(packageId: string): Promise<TaggedNow | undefined> {
  const { data, error } = await supabase
    .from("packages")
    .select(
      "status, project_id, serial, category, note, part_index, part_total, part_type, mfr_mark, delivery_id, package_marks(mark_code)",
    )
    .eq("id", packageId)
    .maybeSingle();
  if (error || !data) return undefined;
  const row = data as Record<string, unknown>;
  const joined = Array.isArray(row.package_marks) ? row.package_marks : [];
  return {
    projectId: row.status === "blank" ? null : str(row.project_id),
    serial: str(row.serial),
    marks: joined
      .map((m) => str((m as Record<string, unknown>)?.mark_code))
      .filter((m): m is string => Boolean(m)),
    details: {
      category: str(row.category),
      note: trimmed(row.note),
      partIndex: num(row.part_index),
      partTotal: num(row.part_total),
      partType: str(row.part_type),
      mfrMark: upperTrimmed(row.mfr_mark),
      deliveryId: str(row.delivery_id),
    },
  };
}

/**
 * A job's short code, for a message a person has to act on.
 *
 * A uuid on the stuck-writes screen is worth nothing — there is no screen that
 * takes one — so a failed read degrades to a phrase rather than to an id.
 */
async function jobCode(projectId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("job_code")
    .eq("id", projectId)
    .maybeSingle();
  if (error || !data) return null;
  return str((data as { job_code?: unknown }).job_code);
}

function jobPhrase(code: string | null, unknown = "this job"): string {
  return code ? `job ${code}` : unknown;
}

/** "#16 2/3" the way it is printed on the package, or null when there is none. */
function partNumber(d: TagDetails): string | null {
  if (d.partIndex != null && d.partTotal != null) {
    return d.mfrMark
      ? `#${d.mfrMark} ${d.partIndex}/${d.partTotal}`
      : `${d.partIndex} of ${d.partTotal}`;
  }
  return d.mfrMark ? `#${d.mfrMark}` : null;
}

/**
 * Everything this tag carried that the sticker does NOT have, in plain words.
 *
 * Only what was actually sent is checked, so a bare tag reports nothing and a
 * plain resend stays silent.
 *
 * Marks ARE read back, in the same select, and compared one by one. The first
 * version of this skipped them on the theory that the row's other fields
 * already said which tag won the sticker — but two people working the same
 * delivery label send identical fields, so a mark only one of them ticked
 * vanished with nothing reported anywhere.
 */
function detailsThatDidNotLand(
  sent: TagDetails,
  marks: string[],
  row: TagDetails,
  have: string[] = [],
): string[] {
  const out: string[] = [];
  const part = partNumber(sent);
  if (part && part !== partNumber(row)) out.push(`the part number ${part}`);
  if (sent.partType && sent.partType !== row.partType) {
    out.push(`which piece it is (${sent.partType})`);
  }
  if (sent.category && sent.category !== row.category) {
    out.push(`what is inside (${sent.category})`);
  }
  if (sent.note && sent.note !== row.note) out.push("the note");
  if (sent.deliveryId && sent.deliveryId !== row.deliveryId) {
    out.push("the delivery it came on");
  }
  // Whichever of OUR marks are not on the row, named individually. This used
  // to fire only when some other field already differed, on the theory that
  // matching fields proved the same tag — but two phones working the same
  // delivery label send identical fields, so the one person who also ticked
  // mark A1 lost it with no error anywhere. Identical fields do not prove the
  // same origin; only the marks themselves do.
  const lost = marks.filter((m) => !have.includes(m));
  if (lost.length > 0) out.push(`mark${lost.length === 1 ? "" : "s"} ${lost.join(", ")}`);
  return out;
}

/** True when a container is already sitting exactly where a queued move was sending it. */
async function containerIsAlreadyAt(
  containerId: string,
  parent: string | null,
  location: string | null,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("storage_containers")
    .select("parent_container_id, location_id")
    .eq("id", containerId)
    .maybeSingle();
  if (error || !data) return false; // can't tell → send it and let the server decide
  const row = data as { parent_container_id?: unknown; location_id?: unknown };
  return (
    (row.parent_container_id ?? null) === parent &&
    (row.location_id ?? null) === location
  );
}

/** A network/permanent error tagged so the core's classifier can route it. */
function tagPermanent(err: unknown): unknown {
  if (err && typeof err === "object") {
    try {
      (err as { permanent?: boolean }).permanent = true;
    } catch {
      /* frozen error object — message-based classification still applies */
    }
  }
  return err;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function createSupabaseHandlers(resolver: ShiftResolver): OpHandlers {
  const clockIn: OpHandler = async (entry) => {
    const p = entry.payload;
    const base = {
      p_project_id: str(p.projectId),
      p_cost_code_id: str(p.costCodeId),
      p_photo: null,
      p_lat: num(p.lat),
      p_lng: num(p.lng),
    };
    const note = str(p.note);
    // Tier 1: dedupe on client id AND persist the worker note (fully-migrated).
    let res = await supabase.rpc("clock_in", {
      ...base,
      p_client_id: entry.id,
      p_note: note,
    });
    if (res.error && isMissingFunction(res.error)) {
      // Tier 2: note overload absent — dedupe on client id, drop the note.
      res = await supabase.rpc("clock_in", { ...base, p_client_id: entry.id });
    }
    if (res.error && isMissingFunction(res.error)) {
      // Tier 3: idempotency migration absent too — best-effort plain punch.
      res = await supabase.rpc("clock_in", base);
    }
    if (res.error) throw res.error;
    const shiftId = (res.data as { id?: string } | null)?.id;
    if (shiftId) resolver.record(entry.id, shiftId);
  };

  const resolveShift = (ref: string | null): string => {
    if (!ref) throw tagPermanent(new Error("Missing shift reference"));
    if (!isPendingRef(ref)) return ref;
    const real = resolver.resolve(ref);
    if (!real) {
      // The offline clock-in hasn't synced yet; retry after it does.
      throw new Error("Waiting for clock-in to sync before this punch");
    }
    return real;
  };

  const clockOut: OpHandler = async (entry) => {
    const p = entry.payload;
    const shiftId = resolveShift(str(p.shiftRef));
    const { error } = await supabase.rpc("clock_out", {
      p_shift_id: shiftId,
      p_photo: null,
      p_injured: p.injured === true,
      p_time_confirmed: p.timeConfirmed !== false,
      p_break_seconds: num(p.breakSeconds),
      p_lat: num(p.lat),
      p_lng: num(p.lng),
    });
    if (error) throw error;
  };

  const breakStart: OpHandler = async (entry) => {
    const p = entry.payload;
    const shiftId = resolveShift(str(p.shiftRef));
    const { error } = await supabase.rpc("start_break", {
      p_shift_id: shiftId,
      p_break_type: str(p.breakType) ?? "other",
    });
    if (error) throw error;
  };

  const breakStop: OpHandler = async (entry) => {
    const p = entry.payload;
    const shiftId = resolveShift(str(p.shiftRef));
    const { error } = await supabase.rpc("end_break", { p_shift_id: shiftId });
    if (error) throw error;
  };

  const upload: OpHandler = async (entry, ctx) => {
    const p = entry.payload;
    const bucket = str(p.bucket) ?? "install-media";
    const path = str(p.path);
    const contentType = str(p.contentType) ?? "application/octet-stream";
    if (!path) throw tagPermanent(new Error("Upload is missing a storage path"));
    const blob = await ctx.getBlob();
    if (!blob) throw tagPermanent(new Error("Upload is missing its file"));

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(path, blob, { contentType, upsert: true });
    if (upErr) throw upErr;

    const row = {
      window_id: str(p.windowId),
      install_event_id: str(p.installEventId),
      kind: str(p.kind) ?? "photo",
      storage_path: `${bucket}/${path}`,
      created_by: str(p.createdBy),
    };
    // Additive geo/feed columns (20260721002000). Applied opportunistically —
    // any of these can be absent pre-migration, so we peel them back in tiers.
    const geoRow = {
      ...row,
      project_id: str(p.projectId),
      lat: num(p.lat),
      lng: num(p.lng),
      accuracy_m: num(p.accuracyM),
      taken_at: str(p.takenAt),
      caption: str(p.caption),
    };
    // Tier 1: dedupe on client_id AND persist geo (fully-migrated DB).
    let res = await supabase
      .from("attachments")
      .upsert({ ...geoRow, client_id: entry.id }, { onConflict: "client_id" });
    if (res.error && isMissingColumn(res.error)) {
      // Tier 2: geo present but client_id column absent — plain insert with geo.
      res = await supabase.from("attachments").insert(geoRow);
    }
    if (res.error && isMissingColumn(res.error)) {
      // Tier 3: geo columns absent too — base insert. Storage upsert already
      // prevents duplicate blobs, so a rare double row is the worst case.
      res = await supabase.from("attachments").insert(row);
    }
    if (res.error) throw res.error;
  };

  const dailyLog: OpHandler = async (entry) => {
    const p = entry.payload;
    const row = {
      project_id: str(p.projectId),
      profile_id: str(p.profileId),
      log_date: str(p.logDate),
      notes: str(p.notes),
      created_by: str(p.createdBy),
    };
    let res = await supabase
      .from("daily_logs")
      .upsert({ ...row, client_id: entry.id }, { onConflict: "client_id" });
    if (res.error && isMissingColumn(res.error)) {
      res = await supabase.from("daily_logs").insert(row);
    }
    if (res.error) throw res.error;
  };

  // Undoing a mark move names the exact move to walk back, so a press made in
  // a dead zone undoes what the person was looking at rather than whatever is
  // newest when the phone finds signal. The database function is a no-op on a
  // move that is already undone, so a replay cannot eat someone else's work.
  const pinUndo: OpHandler = async (entry) => {
    const moveId = str(entry.payload.moveId);
    if (!moveId) throw tagPermanent(new Error("Undo is missing which move to undo"));
    const { error } = await supabase.rpc("undo_opening_pin_move", {
      p_move_id: moveId,
    });
    if (error) throw error;
  };

  const pinResetProject: OpHandler = async (entry) => {
    const projectId = str(entry.payload.projectId);
    if (!projectId) throw tagPermanent(new Error("Reset is missing its job"));
    const { error } = await supabase.rpc("reset_project_pins_to_extracted", {
      p_project_id: projectId,
    });
    if (error) throw error;
  };

  const pinResetOpening: OpHandler = async (entry) => {
    const openingId = str(entry.payload.openingId);
    if (!openingId) throw tagPermanent(new Error("Reset is missing its mark"));
    const { error } = await supabase.rpc("reset_opening_pin_to_extracted", {
      p_opening_id: openingId,
    });
    if (error) throw error;
  };

  // --- warehouse writes from inside a conex (ticket 10) ------------------
  //
  // TWO of these three are safe to send twice on their own, and this comment
  // used to claim all three were. It was wrong about take_supply, and being
  // wrong in a comment is how the bug shipped (warehouse audit F1) — so read
  // the difference rather than the shape:
  //
  //   store_packages — safe, and it no longer skips in silence. It compares
  //   the note the phone wrote down against the row as it stands and applies
  //   only what still matches (warehouse audit F2); a package already sitting
  //   exactly where this write was sending it is counted and NOT logged again,
  //   so the second send moves nothing and writes no history.
  //
  //   checkout_packages — safe. It names an explicit list and skips any
  //   package that is no longer in a movable state, so checking a package out
  //   twice checks it out once. (It has the same overwrite shape store_packages
  //   had, and has NOT been given the same guard — see the audit.)
  //
  //   take_supply — NOT safe on its own. There is no "already taken" state to
  //   skip against; a count only goes down. Sending it twice subtracted twice
  //   and nobody could see it, because both movement rows looked like real
  //   takes. It is safe now only because every take carries a client id the
  //   database recognizes on a repeat
  //   (20260830000000_take_supply_idempotent.sql) — the guard is that key,
  //   not the shape of the call.
  //
  // Each of these writes its own movement row when it really moves something,
  // so the history stays honest about when a write reached the server — with
  // one deliberate exception, stated eight lines up: a check-in for a package
  // already sitting exactly where it was being sent counts and logs NOTHING,
  // because a resend is not a second move. Saying "all of them always" here
  // would contradict that, and a comment contradicting the code is how the
  // double-subtract shipped.

  function ids(entry: OutboxEntry): string[] {
    const raw = entry.payload.packageIds;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  }

  /**
   * One refused package, said the way a foreman would say it.
   *
   * The database hands back what is actually true of the package now, so the
   * sentence names the thing that beat this write rather than just refusing
   * (warehouse audit F2). "It moved" with no more detail sends somebody
   * hunting; "it was checked out to BLACK22" ends the question.
   *
   * `destination` is a phrase and not a name — "into Conex 7" for a check-in,
   * "on BLACK22's shelf" for a set-aside — because the two writes end the same
   * sentence differently and a package does not go "into" a shelf.
   */
  function refusedLine(r: Record<string, unknown>, destination: string): string {
    const serial = typeof r.serial === "string" ? r.serial : "A package";
    const status = typeof r.status === "string" ? r.status : null;
    const where = typeof r.container === "string" ? r.container : null;
    const shelf = typeof r.location === "string" ? r.location : null;
    const job = typeof r.job === "string" ? r.job : null;
    const head = `${serial} did not go ${destination}`;
    if (status === "checked_out") {
      return job ? `${head} — it was checked out to ${job} first.` : `${head} — it was checked out first.`;
    }
    if (status === "stored" && where) return `${head} — it is in ${where} now.`;
    // A package already set aside on ANOTHER job's bay: same status, same
    // empty container, different shelf. Naming the shelf address names the
    // job too, because a bay's address carries its job code.
    if (status === "stored" && shelf) return `${head} — it is on shelf ${shelf} now.`;
    if (status === null) return `${head} — that sticker is not on a package any more.`;
    return `${head} — it moved before this went up.`;
  }

  /**
   * Turn a refusal list into one thing a human reads, and stop.
   *
   * Shared by check-in and set-aside on purpose. Resolving a partly-applied
   * batch is the old bug wearing a different coat — the write "succeeded" and
   * nobody learns that two of the five packages are somewhere else — and that
   * judgement should not be written twice and drift apart. Permanent because
   * re-sending cannot change the answer: the packages that went in are already
   * in (the database no-ops those), and the ones that moved are not coming
   * back on their own.
   */
  function stopForRefusals(refused: unknown[], destination: string): never {
    const lines = refused
      .slice(0, 3)
      .map((r) => refusedLine((r ?? {}) as Record<string, unknown>, destination));
    const rest = refused.length - lines.length;
    throw tagPermanent(
      new Error(lines.join(" ") + (rest > 0 ? ` And ${rest} more like it.` : "")),
    );
  }

  const storePackages: OpHandler = async (entry) => {
    const containerId = str(entry.payload.containerId);
    const packageIds = ids(entry);
    if (!containerId || packageIds.length === 0) {
      throw tagPermanent(new Error("Check-in is missing its container or its packages"));
    }
    // The note the phone wrote down when somebody ticked these packages. An
    // entry queued by an older bundle has none; the database refuses those
    // rather than guessing, which is the correct end of that story — it says
    // so out loud instead of overwriting whatever is there now.
    const expected = entry.payload.expected;
    const { data, error } = await supabase.rpc("store_packages", {
      p_packages: packageIds,
      p_container: containerId,
      p_expected: expected && typeof expected === "object" ? expected : {},
    });
    if (error) throw missingGuard(error, "check-in");

    const result = (data ?? {}) as { container?: unknown; refused?: unknown };
    const refused = Array.isArray(result.refused) ? result.refused : [];
    if (refused.length === 0) return;

    const container = typeof result.container === "string" ? result.container : "that container";
    stopForRefusals(refused, `into ${container}`);
  };

  const checkoutPackages: OpHandler = async (entry) => {
    const reason = str(entry.payload.reason);
    const projectId = str(entry.payload.projectId);
    const packageIds = ids(entry);
    if (!reason || !projectId || packageIds.length === 0) {
      throw tagPermanent(new Error("Check-out is missing its reason, job or packages"));
    }
    const { error } = await supabase.rpc("checkout_packages", {
      p_packages: packageIds,
      p_reason: reason,
      p_project: projectId,
    });
    if (error) throw error;
  };

  const takeSupply: OpHandler = async (entry) => {
    const supplyId = str(entry.payload.supplyId);
    const projectId = str(entry.payload.projectId);
    const qty = num(entry.payload.qty);
    // The payload's key, NOT entry.id. The take is tried against the server
    // before it is ever queued, so the key that has to survive from the first
    // try through every retry is the one minted in offlineWrites.ts. entry.id
    // is only born at queue time — too late to cover the first attempt.
    const clientId = str(entry.payload.clientId);
    if (!supplyId || !projectId || qty == null || qty <= 0) {
      throw tagPermanent(new Error("Supply take is missing what, how many, or for which job"));
    }
    if (!clientId) {
      // Never send an unkeyed take instead. That would be the old behavior —
      // subtract again, silently — and this entry cannot be sent safely.
      //
      // The wording matters. The only way to get here is a take queued by a
      // build from before the key existed, and that take may ALREADY have
      // landed — a lost answer is why it queued at all. So it cannot say
      // "take it again": that is the double-subtract this whole fix exists to
      // stop, just done by hand. Count the shelf first, which is the one
      // action that settles it either way.
      throw tagPermanent(
        new Error(
          "Supply take is missing the id that keeps it from counting twice. " +
            "It may already have gone through — count the shelf before taking it again.",
        ),
      );
    }
    const { error } = await supabase.rpc("take_supply", {
      p_supply: supplyId,
      p_project: projectId,
      p_qty: qty,
      p_client_id: clientId,
    });
    if (error) throw error;
  };

  // --- and the three writes F3 added to the same queue -------------------
  //
  // Read the note above before adding a fourth: what makes a queued write
  // safe is never the shape of the call, it is what the SERVER does with a
  // second copy. These three each answer that differently.

  /**
   * Tag a package: bind a blank sticker to a job, forever.
   *
   * bind_package is the one warehouse write that REFUSES a second send. It
   * updates `where status = 'blank'` and raises when that matches nothing, so
   * the ordinary lost-answer case — the bind landed, the reply never made it
   * back through the conex wall, the write queued — comes back around as an
   * error for work that already succeeded. Left alone that error is not even
   * classified as permanent, so it burns eight retries over ten minutes and
   * then sits on the stuck-writes screen as a failure retrying can never fix.
   *
   * So when the server says the sticker is taken, look at the sticker. If it
   * already names this job, this tag is done and the entry can go. If it
   * names a different one, somebody used that sticker on another package and
   * no amount of waiting changes it — that goes to a human on the first try.
   *
   * Both of those messages NAME the sticker and the job. They are the only
   * thing a foreman gets: the stuck-writes screen shows the label ("Package
   * tagged"), the time, and the error text, and nothing else on that screen
   * identifies which package this was. "Put a fresh sticker on the package and
   * tag it again" is not an instruction until it says which package.
   */
  const bindPackage: OpHandler = async (entry) => {
    const p = entry.payload;
    const packageId = str(p.packageId);
    const projectId = str(p.projectId);
    const boneyard = p.boneyard === true;
    // Boneyard tags have no job ON PURPOSE (ticket 17); only a tag that is
    // neither is missing something.
    if (!packageId || (!projectId && !boneyard)) {
      throw tagPermanent(new Error("This tag is missing its sticker or its job"));
    }
    const marks = Array.isArray(p.marks)
      ? p.marks.filter((v): v is string => typeof v === "string")
      : [];
    const base = {
      p_package: packageId,
      p_project: boneyard ? null : projectId,
      p_boneyard: boneyard,
      p_category: str(p.category),
      p_note: str(p.note),
      p_marks: marks,
      p_delivery: str(p.deliveryId),
    };
    const parts = {
      p_part_index: num(p.partIndex),
      p_part_total: num(p.partTotal),
      p_part_type: str(p.partType),
      p_mfr_mark: str(p.mfrMark),
    };
    // The same fields again, but as the DATABASE would store them, so a
    // refusal can weigh what this tag carried against what the sticker holds.
    // Built here and not from `base`/`parts` on purpose: those go on the wire
    // raw and the server does the trimming, so reusing them would compare an
    // untrimmed note against a trimmed one and call a plain resend a loss.
    const sent: TagDetails = {
      category: str(p.category),
      note: trimmed(p.note),
      partIndex: num(p.partIndex),
      partTotal: num(p.partTotal),
      partType: str(p.partType),
      mfrMark: upperTrimmed(p.mfrMark),
      deliveryId: str(p.deliveryId),
    };
    // Same deploy-window tiers as lib/storage.ts, and the same rule about
    // them: dropping the part fields is only safe when there are none to
    // lose. A tag WITH "#16 2/3" on it fails loudly rather than landing
    // without the number that says what is still missing.
    const hasParts =
      parts.p_part_index != null ||
      parts.p_part_total != null ||
      parts.p_part_type != null ||
      Boolean(parts.p_mfr_mark);
    let res = await supabase.rpc("bind_package", { ...base, ...parts });
    if (res.error && isMissingFunction(res.error) && !hasParts && !boneyard) {
      // The pre-boneyard signature. Dropping p_boneyard is only safe when it
      // is false — an old database cannot express a job-less package, and
      // falling back would send one with the flag silently gone.
      const { p_boneyard: _drop, ...legacy } = base;
      res = await supabase.rpc("bind_package", legacy);
    }
    if (!res.error) return;
    if (isAlreadyAssigned(res.error)) {
      const now = await taggedNow(packageId);
      if (now === undefined) throw res.error; // could not ask → try again later
      if (now.projectId == null) throw res.error; // still blank → try again
      const sticker = now.serial ? `Sticker ${now.serial}` : "That sticker";

      if (boneyard ? now.projectId == null : now.projectId === projectId) {
        // The tag landed on the job this entry meant. Usually that is this
        // very entry arriving twice — the first answer was lost in the conex —
        // and the sticker already carries everything it was carrying.
        //
        // Not always. Two phones can pick the same blank sticker for the same
        // job, and the one that won may have been the one WITHOUT the part
        // number read off the label, or without the marks or the note. This
        // used to resolve the entry flat, so that work vanished with no error
        // anywhere — "#16 2/3" is the number that says what is still missing
        // off a delivery, and losing it quietly is the whole reason it is
        // tracked.
        //
        // There is no RPC that can put those fields on an already-bound
        // package, so they cannot be applied from here; they are REPORTED
        // instead, named one by one, to the one screen a human reads. The
        // write itself is not a failure and does not retry — the sticker is
        // bound and re-sending can never bind it again — but the entry stays
        // on the stuck-writes screen until somebody deals with it.
        //
        // The last line has to be an instruction a foreman can actually
        // follow, which is the whole lesson of the message below it. There is
        // no screen anywhere that edits a tagged package: bind_package is the
        // only writer of these fields and it is `where status = 'blank'`, the
        // tag screen only offers blank stickers, and the package sheet is
        // read-only apart from Reprint. So it must not say "open the package
        // and add them" — that names a screen the app does not have. It says
        // what is left: put the detail on the physical package. (If an edit
        // path is ever built, the handler already clears itself — Try again
        // re-reads the row, finds nothing missing, and resolves.)
        const missing = detailsThatDidNotLand(sent, marks, now.details, now.marks);
        if (missing.length === 0) return;
        const mine = boneyard
          ? "the Boneyard"
          : jobPhrase(await jobCode(projectId ?? ""));
        const it = missing.length === 1 ? "it" : "them";
        throw tagPermanent(
          new Error(
            `${sticker} is already tagged to ${mine}, so the tag itself went ` +
              `through. What this one carried did not: ${missing.join(", ")}. ` +
              `Nothing in the app can add ${it} to a sticker that is already ` +
              `tagged, so write ${it} on the package by hand.`,
          ),
        );
      }

      const [other, mine] = await Promise.all([
        jobCode(now.projectId),
        projectId ? jobCode(projectId) : Promise.resolve(null),
      ]);
      const forMine = boneyard ? "the Boneyard" : jobPhrase(mine);
      throw tagPermanent(
        new Error(
          `${sticker} is already tagged to ${jobPhrase(other, "a different job")}, ` +
            `so this tag for ${forMine} cannot go through. Put a fresh sticker ` +
            `on the package and tag it for ${forMine} again.`,
        ),
      );
    }
    throw res.error;
  };

  /**
   * Set packages aside on a job's own staging bay.
   *
   * This comment used to say "safe to send twice", which was true about the
   * SHELF and beside the point. Staging is a destination, so a repeat puts the
   * package where the first one put it — but a queued set-aside is not a
   * repeat, it is a stale belief, and putting a package where a ten-minute-old
   * tap wanted it is how the record says BLACK22's bay while the crate is on a
   * truck to PECAN14. Queueing this write (F3) opened the same race F2 had
   * just closed for check-in, so it is closed the same way and not a second
   * way: the phone's note travels with the write, the database compares it per
   * package, and anything that moved in the meantime is refused by name.
   *
   * The other refusal worth catching is a job with no staging bay. The server
   * refuses rather than dropping a job's material on a shared stock shelf, and
   * waiting fixes nothing — only a person adding the bay does. So it goes to
   * the stuck-writes screen on the first try, where a foreman can add the bay
   * and press Retry, instead of eight quiet failures first.
   */
  const stagePackages: OpHandler = async (entry) => {
    const projectId = str(entry.payload.projectId);
    const packageIds = ids(entry);
    if (!projectId || packageIds.length === 0) {
      throw tagPermanent(
        new Error("Set-aside is missing its job or its packages"),
      );
    }
    // The note the phone wrote down when somebody ticked these packages. An
    // entry queued by an older bundle has none; the database refuses those
    // rather than guessing, which is the correct end of that story — it says
    // so out loud instead of overwriting whatever is there now.
    const expected = entry.payload.expected;
    const { data, error } = await supabase.rpc("stage_packages", {
      p_packages: packageIds,
      p_project: projectId,
      p_expected: expected && typeof expected === "object" ? expected : {},
    });
    if (error) {
      if (isMissingStagingBayError(error)) {
        throw tagPermanent(
          new Error(
            "This job has no staging bay yet, so there was nowhere to set these " +
              "aside. A foreman can add one from the job page, then try this again.",
          ),
        );
      }
      throw missingGuard(error, "set-aside");
    }

    const result = (data ?? {}) as { job?: unknown; refused?: unknown };
    const refused = Array.isArray(result.refused) ? result.refused : [];
    if (refused.length === 0) return;

    // "BLACK22's shelf" and not the bay address: the job code is what a
    // foreman calls that shelf, and the address is on the label for anyone who
    // has to walk to it.
    const job = typeof result.job === "string" ? `${result.job}'s shelf` : "that job's shelf";
    stopForRefusals(refused, `on ${job}`);
  };

  /**
   * Move a container, and everything inside it with it.
   *
   * move_container has NO guard of its own: it writes a fresh "rode along"
   * line for every package inside, every time it is called, with no state to
   * skip against. A resend after a lost answer would say each package moved
   * twice when it moved once — not a wrong location, but a history that lies,
   * which is the thing this warehouse is tracked for in the first place.
   *
   * There is no client id to dedupe on, so the check is the destination
   * itself: if the container is already sitting where this entry was sending
   * it, the move happened and there is nothing left to do. If that check
   * cannot be made, send it — a duplicated history line is the lesser loss
   * against a move that never happens.
   */
  const pickupTakeoff: OpHandler = async (entry) => {
    const takeoffId = str(entry.payload.takeoffId);
    if (!takeoffId) {
      throw tagPermanent(new Error("This pickup names no takeoff"));
    }
    const { error } = await supabase.rpc("pickup_takeoff", { p_takeoff: takeoffId });
    if (error) {
      const msg = String((error as { message?: unknown }).message ?? "");
      // "not ready yet" / "for somebody else": no resend changes either —
      // stop once, in words, instead of burning retries.
      if (/not ready yet|for somebody else|takeoff not found/.test(msg)) {
        throw tagPermanent(error as Error);
      }
      throw missingGuard(error, "takeoff pickup");
    }
  };

  const receiveMinted: OpHandler = async (entry) => {
    const packageIds = ids(entry);
    if (packageIds.length === 0) {
      throw tagPermanent(new Error("This delivery confirmation names no packages"));
    }
    const { error } = await supabase.rpc("receive_minted_packages", {
      p_packages: packageIds,
    });
    if (error) throw missingGuard(error, "delivery confirmation");
  };

  const setPackageArea: OpHandler = async (entry) => {
    const packageId = str(entry.payload.packageId);
    // null is a legal value here — it clears the pointer — so only a missing
    // package id makes the entry unsendable.
    if (!packageId) {
      throw tagPermanent(new Error("This area note is missing its package"));
    }
    const area = str(entry.payload.area);
    const { error } = await supabase.rpc("set_package_area", {
      p_package: packageId,
      p_area: area,
    });
    if (error) {
      // "that area does not fit this kind of box" / "put it in a box first":
      // the package moved between queueing and sending, and no resend changes
      // that. Say so once instead of burning eight retries — the pointer is
      // stale by definition, and whoever is there next just points again.
      const msg = String((error as { message?: unknown }).message ?? "");
      if (/does not fit this kind of box|put it in a box first|package not found/.test(msg)) {
        throw tagPermanent(
          new Error(
            "This 'where in the box' note didn't stick — the package moved " +
              "before it went up. If it still matters, point at it again.",
          ),
        );
      }
      throw missingGuard(error, "area note");
    }
  };

  const moveContainer: OpHandler = async (entry) => {
    const containerId = str(entry.payload.containerId);
    if (!containerId) {
      throw tagPermanent(new Error("This move is missing the container it was for"));
    }
    const parent = str(entry.payload.parentContainerId);
    const location = str(entry.payload.locationId);
    if (await containerIsAlreadyAt(containerId, parent, location)) return;
    const { error } = await supabase.rpc("move_container", {
      p_container: containerId,
      p_parent: parent,
      p_location: location,
    });
    if (error) throw error;
  };

  return {
    clock_in: clockIn,
    clock_out: clockOut,
    break_start: breakStart,
    break_stop: breakStop,
    photo_upload: upload,
    receipt_upload: upload,
    daily_log: dailyLog,
    pin_undo: pinUndo,
    pin_reset_project: pinResetProject,
    pin_reset_opening: pinResetOpening,
    store_packages: storePackages,
    checkout_packages: checkoutPackages,
    take_supply: takeSupply,
    bind_package: bindPackage,
    set_package_area: setPackageArea,
    receive_minted: receiveMinted,
    pickup_takeoff: pickupTakeoff,
    stage_packages: stagePackages,
    move_container: moveContainer,
  } satisfies OpHandlers;
}

/** Persisted resolver so an offline clock-in → clock-out chain survives reload. */
export function createShiftResolver(): ShiftResolver {
  const KEY = "wops-outbox-shift-map";
  const mem = new Map<string, string>();

  const load = (): Record<string, string> => {
    if (typeof localStorage === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  };
  const save = (map: Record<string, string>) => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
      /* quota — in-memory copy still works this session */
    }
  };

  return {
    record(clockInEntryId, shiftId) {
      mem.set(clockInEntryId, shiftId);
      const map = load();
      map[clockInEntryId] = shiftId;
      save(map);
    },
    resolve(ref) {
      const id = ref.startsWith(PENDING_PREFIX) ? ref.slice(PENDING_PREFIX.length) : ref;
      return mem.get(id) ?? load()[id] ?? null;
    },
  };
}

export type { OutboxEntry };
