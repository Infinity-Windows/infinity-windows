// Supabase-backed handlers for each outbox op. This is the ONLY file in the
// outbox that talks to Supabase, so the pure core + store stay unit-testable.
//
// Idempotency: row-creating ops (clock-in, media uploads) carry the entry's
// stable client id. When the additive `client_id` migration is applied the
// server dedupes on it; when it is NOT applied we detect the missing
// function/column and fall back to a best-effort plain write — the feature
// never crashes and never blocks the crew.

import { supabase } from "../supabase";
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
    // Preferred path: server dedupes on the stable client id.
    let res = await supabase.rpc("clock_in", { ...base, p_client_id: entry.id });
    if (res.error && isMissingFunction(res.error)) {
      // Migration not applied — best-effort punch, client-side dedupe only.
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
    // Preferred: dedupe the attachments row on client_id.
    let res = await supabase
      .from("attachments")
      .upsert({ ...row, client_id: entry.id }, { onConflict: "client_id" });
    if (res.error && isMissingColumn(res.error)) {
      // Migration not applied — plain insert; storage upsert already prevents
      // duplicate blobs, so a rare double row is the worst case.
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

  return {
    clock_in: clockIn,
    clock_out: clockOut,
    break_start: breakStart,
    break_stop: breakStop,
    photo_upload: upload,
    receipt_upload: upload,
    daily_log: dailyLog,
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
