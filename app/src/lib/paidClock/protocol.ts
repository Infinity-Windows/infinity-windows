import { cloneJson, postgresInstantMicros, uuid } from "../workConfiguration/model";

export class ClockProtocolError extends Error {
  constructor() { super("Clock information is unavailable. Review the saved request before trying again."); this.name = "ClockProtocolError"; }
}
const fail = (): never => { throw new ClockProtocolError(); };
type ShiftRef = { kind: "shift" | "clock_command"; id: string };
type Evidence = { clientId: string; tappedAt: string; clockCheckedAt: string | null; clockSkewMs: number | null };
export type ClockIntent = Evidence & (
  { action: "clock_in"; projectId: string | null; costCodeId: string | null; photo: string | null;
    lat: number | null; lng: number | null; note: string | null; mode: "data" | "tracking" | null; setupVersion: 1 } |
  { action: "break_start"; shiftRef: ShiftRef; breakType: "lunch" | "rest" | "other" } |
  { action: "break_end"; shiftRef: ShiftRef } |
  { action: "clock_out"; shiftRef: ShiftRef; photo: string | null; injured: boolean;
    timeConfirmed: boolean; breakSeconds: number | null; lat: number | null; lng: number | null; injuryNote: string | null }
);
export type ClockReceipt = {
  clientId: string; action: ClockIntent["action"];
  outcome: "clocked_in" | "clocked_out" | "started" | "already_on_break" | "ended" | "no_break_running" | "shift_closed" | "requires_review";
  shiftId: string; tappedAt: string | null; arrivedAt: string; clockCheckedAt: string | null;
  clockSkewMs: number | null; usedTapTime: boolean; reviewReason: string | null;
  receiptProtocol: "legacy" | "setup_v1"; retention: "retained" | "legacy"; sourcePresent: boolean;
  activityTransition: null | { id: string; beforeRevision: number; afterRevision: number };
};
export type ClockReceiptRead = { protocolVersion: 1; availability: "unavailable"; receipt: null } |
  { protocolVersion: 1; availability: "available"; receipt: ClockReceipt };

function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o,k))) return fail();
  return o;
}
const oneOf = <T extends string>(v: unknown, options: readonly T[]): T => typeof v === "string" && options.includes(v as T) ? v as T : fail();
const nullable = <T>(v: unknown, parse: (value: unknown) => T): T | null => v === null ? null : parse(v);
const boolean = (v: unknown): boolean => typeof v === "boolean" ? v : fail();
const integer = (v: unknown, min: number, max: number): number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fail();
const finite = (v: unknown, min: number, max: number): number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fail();
const string = (v: unknown): string => {
  if (typeof v !== "string" || v.includes("\0") || Array.from(v).some(c => { const cp=c.codePointAt(0)!; return cp>=0xd800 && cp<=0xdfff; })) return fail();
  return v;
};
const timestamp = (v: unknown): string => { postgresInstantMicros(v); return v as string; };
const id = (v: unknown): string => uuid(v);
function shiftRef(v: unknown): ShiftRef { const o=object(v,["kind","id"]); return {kind:oneOf(o.kind,["shift","clock_command"]),id:id(o.id)}; }
function frozen<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) frozen(child); Object.freeze(v); }
  return v;
}
const common = ["action","clientId","tappedAt","clockCheckedAt","clockSkewMs"];

/** Validate and freeze one original local intent before any storage or network await. */
export function parseClockIntent(raw: unknown): ClockIntent {
  try {
    const c = cloneJson(raw) as Record<string, unknown>;
    const action = oneOf(c.action,["clock_in","break_start","break_end","clock_out"]);
    const keys = action === "clock_in" ? [...common,"projectId","costCodeId","photo","lat","lng","note","mode","setupVersion"] :
      action === "break_start" ? [...common,"shiftRef","breakType"] : action === "break_end" ? [...common,"shiftRef"] :
      [...common,"shiftRef","photo","injured","timeConfirmed","breakSeconds","lat","lng","injuryNote"];
    const o=object(c,keys);
    const e: Evidence={clientId:id(o.clientId),tappedAt:timestamp(o.tappedAt),clockCheckedAt:nullable(o.clockCheckedAt,timestamp),clockSkewMs:nullable(o.clockSkewMs,v=>integer(v,-2147483648,2147483647))};
    if (action === "clock_in") {
      if (o.setupVersion !== 1) return fail();
      return frozen({action,...e,projectId:nullable(o.projectId,id),costCodeId:nullable(o.costCodeId,id),photo:nullable(o.photo,string),
        lat:nullable(o.lat,v=>finite(v,-90,90)),lng:nullable(o.lng,v=>finite(v,-180,180)),note:nullable(o.note,string),
        mode:nullable(o.mode,v=>oneOf(v,["data","tracking"])),setupVersion:1});
    }
    const ref=shiftRef(o.shiftRef);
    if (action === "break_start") return frozen({action,...e,shiftRef:ref,breakType:oneOf(o.breakType,["lunch","rest","other"])});
    if (action === "break_end") return frozen({action,...e,shiftRef:ref});
    return frozen({action,...e,shiftRef:ref,photo:nullable(o.photo,string),injured:boolean(o.injured),timeConfirmed:boolean(o.timeConfirmed),
      breakSeconds:nullable(o.breakSeconds,v=>integer(v,0,2147483647)),lat:nullable(o.lat,v=>finite(v,-90,90)),
      lng:nullable(o.lng,v=>finite(v,-180,180)),injuryNote:nullable(o.injuryNote,string)});
  } catch { return fail(); }
}

/** Exact keyed SQL signature. Caller supplies resolution evidence for clock_command refs. */
export function clockSqlCall(raw: ClockIntent, resolvedShiftId?: string): { rpc: "clock_in" | "start_break" | "end_break" | "clock_out"; args: Readonly<Record<string, unknown>> } {
  try {
    const intent=parseClockIntent(raw);
    const e={p_client_id:intent.clientId,p_tapped_at:intent.tappedAt,p_clock_checked_at:intent.clockCheckedAt,p_clock_skew_ms:intent.clockSkewMs};
    if(intent.action==="clock_in") return frozen({rpc:"clock_in" as const,args:{p_project_id:intent.projectId,p_cost_code_id:intent.costCodeId,p_photo:intent.photo,p_lat:intent.lat,p_lng:intent.lng,p_note:intent.note,p_mode:intent.mode,...e,p_setup_version:1}});
    const shiftId=intent.shiftRef.kind==="shift" ? intent.shiftRef.id : id(resolvedShiftId);
    if(resolvedShiftId!==undefined && id(resolvedShiftId)!==shiftId) return fail();
    if(intent.action==="break_start") return frozen({rpc:"start_break" as const,args:{p_shift_id:shiftId,p_break_type:intent.breakType,...e}});
    if(intent.action==="break_end") return frozen({rpc:"end_break" as const,args:{p_shift_id:shiftId,...e}});
    return frozen({rpc:"clock_out" as const,args:{p_shift_id:shiftId,p_photo:intent.photo,p_injured:intent.injured,p_time_confirmed:intent.timeConfirmed,
      p_break_seconds:intent.breakSeconds,p_lat:intent.lat,p_lng:intent.lng,p_injury_note:intent.injuryNote,...e}});
  } catch { return fail(); }
}

const receiptKeys=["clientId","action","outcome","shiftId","tappedAt","arrivedAt","clockCheckedAt","clockSkewMs","usedTapTime","reviewReason","receiptProtocol","retention","sourcePresent","activityTransition"];
const outcomes: Record<ClockIntent["action"], readonly ClockReceipt["outcome"][]>={
  clock_in:["clocked_in"],clock_out:["clocked_out","requires_review"],
  break_start:["started","already_on_break","requires_review"],
  break_end:["ended","no_break_running","shift_closed","requires_review"],
};
const sameInstant=(a:string,b:string)=>postgresInstantMicros(a)===postgresInstantMicros(b);

/** Exact self-owned receipt match; unavailable is uncertainty, never a failed punch. */
export function parseClockReceiptRead(raw: unknown, expected: ClockIntent, resolvedShiftId?: string): ClockReceiptRead {
  try {
    const intent=parseClockIntent(expected);
    const envelope=object(cloneJson(raw),["protocolVersion","availability","receipt"]);
    if(envelope.protocolVersion!==1) return fail();
    if(envelope.availability==="unavailable") { if(envelope.receipt!==null) return fail(); return frozen({protocolVersion:1,availability:"unavailable",receipt:null}); }
    if(envelope.availability!=="available") return fail();
    const r=object(envelope.receipt,receiptKeys);
    const action=oneOf(r.action,["clock_in","clock_out","break_start","break_end"]);
    const outcome=oneOf(r.outcome,outcomes[action]);
    const receipt:ClockReceipt={clientId:id(r.clientId),action,outcome,shiftId:id(r.shiftId),tappedAt:nullable(r.tappedAt,timestamp),arrivedAt:timestamp(r.arrivedAt),
      clockCheckedAt:nullable(r.clockCheckedAt,timestamp),clockSkewMs:nullable(r.clockSkewMs,v=>integer(v,-2147483648,2147483647)),
      usedTapTime:boolean(r.usedTapTime),reviewReason:nullable(r.reviewReason,v=>{const s=string(v);return s.length?s:fail();}),
      receiptProtocol:oneOf(r.receiptProtocol,["legacy","setup_v1"]),retention:oneOf(r.retention,["retained","legacy"]),
      sourcePresent:boolean(r.sourcePresent),activityTransition:nullable(r.activityTransition,v=>{
        const t=object(v,["id","beforeRevision","afterRevision"]);
        const beforeRevision=integer(t.beforeRevision,0,Number.MAX_SAFE_INTEGER-1);
        const afterRevision=integer(t.afterRevision,1,Number.MAX_SAFE_INTEGER);
        if(afterRevision!==beforeRevision+1) return fail();
        return {id:id(t.id),beforeRevision,afterRevision};
      })};
    if(receipt.clientId!==intent.clientId || action!==intent.action || !sameInstant(receipt.tappedAt ?? fail(),intent.tappedAt) ||
      receipt.clockSkewMs!==intent.clockSkewMs || (receipt.clockCheckedAt===null)!==(intent.clockCheckedAt===null) ||
      (receipt.clockCheckedAt!==null && !sameInstant(receipt.clockCheckedAt,intent.clockCheckedAt!))) return fail();
    if(intent.action==="clock_in") { if(receipt.receiptProtocol!=="setup_v1") return fail(); }
    else {
      const exact=intent.shiftRef.kind==="shift" ? intent.shiftRef.id : id(resolvedShiftId);
      if(resolvedShiftId!==undefined && id(resolvedShiftId)!==exact) return fail();
      if(receipt.shiftId!==exact) return fail();
    }
    return frozen({protocolVersion:1,availability:"available",receipt});
  } catch { return fail(); }
}
