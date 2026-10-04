/** Wire contract for the dormant configuration RPCs. A failed parse is never an empty catalog. */
export class WorkConfigurationUnavailableError extends Error {
  constructor() { super("Work configuration is unavailable right now. Refresh and try again."); this.name = "WorkConfigurationUnavailableError"; }
}
/** A returned domain SQL error proves that this attempt's database transaction
 * was refused. Transport failures and malformed replies remain unknown. */
export class WorkConfigurationRejectedError extends WorkConfigurationUnavailableError {
  constructor() { super(); this.name = "WorkConfigurationRejectedError"; this.message = "The request was refused. Refresh the current records before trying again."; }
}
const fail = (): never => { throw new WorkConfigurationUnavailableError(); };
const CODE = /^[a-z][a-z0-9_]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UNITS = new Set(["count", "in", "ft", "mm", "cm", "sq_ft", "sq_m", "min", "h", "lb", "kg"]);
const TYPES = new Set(["text", "number", "boolean", "single_select", "multi_select"]);
export const CAPABILITIES = ["menu_select", "dimensions_edit", "final_qc"] as const;
export type Capability = typeof CAPABILITIES[number];
export type JsonObject = Record<string, unknown>;

/** Copies only bounded plain JSON; malformed graphs always fail with one safe error. */
export function cloneJson(value: unknown): unknown {
  try { return cloneJsonInner(value, new Set<object>(), { size: 0, nodes: 0 }, 0); }
  catch { return fail(); }
}
function cloneJsonInner(value: unknown, seen: Set<object>, budget: { size: number; nodes: number }, depth: number): unknown {
  if (++budget.nodes > 50000 || depth > 64) return fail();
  if (value === null || typeof value === "boolean") { budget.size += 8; return value; }
  if (typeof value === "string") { budget.size += value.length * 2; return budget.size <= 1000000 ? value : fail(); }
  if (typeof value === "number") { budget.size += 24; return Number.isFinite(value) && budget.size <= 1000000 ? value : fail(); }
  if (typeof value !== "object" || seen.has(value)) return fail();
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return fail();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 50000 || Reflect.ownKeys(value).length !== value.length + 1) return fail();
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(value, String(i));
        if (!desc || !("value" in desc) || !desc.enumerable) return fail();
        out.push(cloneJsonInner(desc.value, seen, budget, depth + 1));
      }
      return out;
    }
    const out: JsonObject = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 50000) return fail();
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") return fail();
      budget.size += key.length * 2;
      if (budget.size > 1000000) return fail();
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !("value" in desc) || !desc.enumerable) return fail();
      out[key] = cloneJsonInner(desc.value, seen, budget, depth + 1);
    }
    return out;
  } finally { seen.delete(value); }
}
function object(v: unknown, required: string[], optional: string[] = []): JsonObject {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const o = v as JsonObject;
  const allowed = new Set([...required, ...optional]);
  if (required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !allowed.has(k))) return fail();
  return o;
}
function arr(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max) return fail(); return v; }
function unique<T>(values: T[]): void { if (new Set(values).size !== values.length) fail(); }
export function uuid(v: unknown): string { if (typeof v !== "string" || !UUID.test(v)) return fail(); return v; }
export function code(v: unknown): string { if (typeof v !== "string" || !CODE.test(v)) return fail(); return v; }
function label(v: unknown): string { if (typeof v !== "string" || v.trim().length < 1 || v.trim().length > 120) return fail(); return v; }
function bool(v: unknown): boolean { if (typeof v !== "boolean") return fail(); return v; }
function integer(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) return fail(); return v; }
export function iso(v: unknown): string {
  if (typeof v !== "string") return fail();
  const m = ISO.exec(v);
  if (!m || !Number.isFinite(Date.parse(v))) return fail();
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > maxDay || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return fail();
  if (m[7] !== "Z" && (Number(m[7].slice(1, 3)) > 23 || Number(m[7].slice(4)) > 59)) return fail();
  return v;
}
/** PostgreSQL timestamptz precision is six fractional digits. Compare UTC instants exactly at that precision. */
export function postgresInstantMicros(v: unknown): bigint {
  const timestamp = iso(v);
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(timestamp)?.[1] ?? "";
  if (fraction.length > 6) return fail();
  const tailMicros = Number(fraction.padEnd(6, "0").slice(3, 6));
  return BigInt(Date.parse(timestamp)) * 1000n + BigInt(tailMicros);
}
function optionalIso(v: unknown): string | null { return v === null ? null : iso(v); }
function finite(v: unknown): number { if (typeof v !== "number" || !Number.isFinite(v)) return fail(); return v; }
function orderedDates(published: unknown, effective: unknown): void { if (postgresInstantMicros(effective) < postgresInstantMicros(published)) fail(); }
function eligible(v: unknown): boolean { return bool(v); }
function capability(v: unknown): Capability { if (!CAPABILITIES.includes(v as Capability)) return fail(); return v as Capability; }
function protocol(o: JsonObject): void { if (o.protocolVersion !== 1) fail(); }
function selection(v: unknown): CurrentSelection | null {
  if (v === null) return null;
  const o = object(v, ["revision", "menuVersionId"]);
  return { revision: integer(o.revision, 1), menuVersionId: uuid(o.menuVersionId) };
}
export interface TypedOption { id: string; label_en: string; label_es: string }
export interface TypedField { id: string; label_en: string; label_es: string; type: "text" | "number" | "boolean" | "single_select" | "multi_select"; required: boolean; unit?: string; min?: number; max?: number; options?: TypedOption[] }
export function typedFields(raw: unknown): TypedField[] {
  const fields = arr(raw, 40).map(v => {
    const o = object(v, ["id", "label_en", "label_es", "type", "required"], ["unit", "min", "max", "options"]);
    const type = o.type;
    if (!TYPES.has(type as string)) fail();
    const field: TypedField = { id: code(o.id), label_en: label(o.label_en), label_es: label(o.label_es), type: type as TypedField["type"], required: bool(o.required) };
    if (type !== "number" && ("unit" in o || "min" in o || "max" in o)) fail();
    if ("unit" in o) { if (!UNITS.has(o.unit as string)) fail(); field.unit = o.unit as string; }
    if ("min" in o) field.min = finite(o.min);
    if ("max" in o) field.max = finite(o.max);
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail();
    if (field.unit === "count" && ((field.min !== undefined && (!Number.isSafeInteger(field.min) || field.min < 0)) || (field.max !== undefined && (!Number.isSafeInteger(field.max) || field.max < 0)))) fail();
    if (type === "single_select" || type === "multi_select") {
      const options = arr(o.options, 50);
      if (!options.length) fail();
      field.options = options.map(v => { const p = object(v, ["id", "label_en", "label_es"]); return { id: code(p.id), label_en: label(p.label_en), label_es: label(p.label_es) }; });
      unique(field.options.map(x => x.id));
    } else if ("options" in o) fail();
    return field;
  });
  unique(fields.map(x => x.id));
  return fields;
}
export interface DraftMenuItem { code: string; position: number; enabled: boolean }
export interface PublishedMenuItem { definitionId: string; versionId: string; position: number; enabled: boolean }
export function draftMenuItems(raw: unknown): DraftMenuItem[] {
  const items = arr(raw, 200).map(v => { const o = object(v, ["code", "position", "enabled"]); return { code: code(o.code), position: integer(o.position, 0, 199), enabled: bool(o.enabled) }; });
  unique(items.map(x => x.code)); unique(items.map(x => x.position)); return items;
}
export function publishedMenuItems(raw: unknown): PublishedMenuItem[] {
  const items = arr(raw, 200).map(v => { const o = object(v, ["definitionId", "versionId", "position", "enabled"]); return { definitionId: uuid(o.definitionId), versionId: uuid(o.versionId), position: integer(o.position, 0, 199), enabled: bool(o.enabled) }; });
  unique(items.map(x => x.definitionId)); unique(items.map(x => x.versionId)); unique(items.map(x => x.position)); return items;
}
export interface ActivityVersion { versionId: string; version: number; scope: "general" | "specific"; labelEn: string; labelEs: string; machineSelection: boolean; typedFields: TypedField[]; publishedAt: string; effectiveFrom: string; eligibleNow: boolean }
export interface MenuVersion { versionId: string; version: number; labelEn: string; labelEs: string; items: PublishedMenuItem[]; publishedAt: string; effectiveFrom: string; eligibleNow: boolean }
export interface ActivityDefinition { code: string; definitionId: string; retiredAt: string | null; versions: ActivityVersion[] }
export interface MenuDefinition { code: string; menuId: string; retiredAt: string | null; versions: MenuVersion[] }
export interface Draft { kind: "activity" | "menu"; code: string; revision: number; draftId: string; body: JsonObject; proposedBy: string; createdAt: string }
export interface CurrentSelection { revision: number; menuVersionId: string }
export interface JobMenuChoice { menuVersionId: string; version: number; labelEn: string; labelEs: string; publishedAt: string; effectiveFrom: string }
export interface JobMenuChoices { protocolVersion: 1; projectId: string; asOf: string; currentRevision: number; currentSelection: CurrentSelection | null; choices: JobMenuChoice[] }
export function parseJobMenuChoices(raw: unknown, expectedProjectId: string): JobMenuChoices {
  const s = object(cloneJson(raw), ["protocolVersion", "projectId", "asOf", "currentRevision", "currentSelection", "choices"]);
  protocol(s);
  if (uuid(s.projectId) !== expectedProjectId) fail();
  const asOf = iso(s.asOf), currentRevision = integer(s.currentRevision, 0);
  let currentSelection: CurrentSelection | null = null;
  if (s.currentSelection !== null) {
    const c = object(s.currentSelection, ["revision", "menuVersionId"]);
    currentSelection = { revision: integer(c.revision, 1), menuVersionId: uuid(c.menuVersionId) };
    if (currentSelection.revision !== currentRevision) fail();
  } else if (currentRevision !== 0) fail();
  const choices = arr(s.choices, 500).map(value => {
    const c = object(value, ["menuVersionId", "version", "labelEn", "labelEs", "publishedAt", "effectiveFrom"]);
    orderedDates(c.publishedAt, c.effectiveFrom);
    if (postgresInstantMicros(c.effectiveFrom) > postgresInstantMicros(asOf)) fail();
    return { menuVersionId: uuid(c.menuVersionId), version: integer(c.version, 1, 2147483647), labelEn: label(c.labelEn), labelEs: label(c.labelEs), publishedAt: iso(c.publishedAt), effectiveFrom: iso(c.effectiveFrom) };
  });
  unique(choices.map(c => c.menuVersionId));
  return { protocolVersion: 1, projectId: expectedProjectId, asOf, currentRevision, currentSelection, choices };
}
export interface CompanySnapshot { protocolVersion: 1; role: "company"; asOf: string; projectId: string | null; currentSelection: CurrentSelection | null; activities: ActivityDefinition[]; menus: MenuDefinition[]; drafts: Draft[] }
export interface CrewActivity extends Omit<ActivityVersion, "version" | "eligibleNow"> { definitionId: string; position: number; enabled: boolean; retiredAt: string | null; eligibleNow: boolean }
export interface CrewMenu { revision: number; menuVersionId: string; activities: CrewActivity[] }
export interface CrewSnapshot { protocolVersion: 1; role: "crew"; asOf: string; projectId: string; menu: CrewMenu | null }
export type WorkConfigurationSnapshot = CompanySnapshot | CrewSnapshot;
function activityBody(o: JsonObject): Pick<ActivityVersion, "scope" | "labelEn" | "labelEs" | "machineSelection" | "typedFields"> {
  if (o.scope !== "general" && o.scope !== "specific") fail();
  return { scope: o.scope as "general" | "specific", labelEn: label(o.labelEn), labelEs: label(o.labelEs), machineSelection: bool(o.machineSelection), typedFields: typedFields(o.typedFields) };
}
function activityVersion(v: unknown): ActivityVersion {
  const o = object(v, ["versionId", "version", "scope", "labelEn", "labelEs", "machineSelection", "typedFields", "publishedAt", "effectiveFrom", "eligibleNow"]);
  orderedDates(o.publishedAt, o.effectiveFrom);
  return { versionId: uuid(o.versionId), version: integer(o.version, 1), ...activityBody(o), publishedAt: iso(o.publishedAt), effectiveFrom: iso(o.effectiveFrom), eligibleNow: eligible(o.eligibleNow) };
}
function menuVersion(v: unknown): MenuVersion {
  const o = object(v, ["versionId", "version", "labelEn", "labelEs", "items", "publishedAt", "effectiveFrom", "eligibleNow"]);
  orderedDates(o.publishedAt, o.effectiveFrom);
  return { versionId: uuid(o.versionId), version: integer(o.version, 1), labelEn: label(o.labelEn), labelEs: label(o.labelEs), items: publishedMenuItems(o.items), publishedAt: iso(o.publishedAt), effectiveFrom: iso(o.effectiveFrom), eligibleNow: eligible(o.eligibleNow) };
}
export function parseWorkConfiguration(raw: unknown, expectedProjectId: string | null): WorkConfigurationSnapshot {
  const copied = cloneJson(raw) as JsonObject;
  const s = object(copied, ["protocolVersion", "role", "asOf", "projectId", ...(copied?.role === "company" ? ["currentSelection", "activities", "menus", "drafts"] : ["menu"])]);
  protocol(s); const asOf = iso(s.asOf);
  if (s.role === "company") {
    const projectId = s.projectId === null ? null : uuid(s.projectId);
    if (projectId !== expectedProjectId) fail();
    const activities = arr(s.activities, 500).map(v => {
      const o = object(v, ["code", "definitionId", "retiredAt", "versions"]);
      const versions = arr(o.versions, 10000).map(activityVersion);
      unique(versions.map(x => x.version)); unique(versions.map(x => x.versionId));
      return { code: code(o.code), definitionId: uuid(o.definitionId), retiredAt: optionalIso(o.retiredAt), versions };
    });
    const menus = arr(s.menus, 500).map(v => {
      const o = object(v, ["code", "menuId", "retiredAt", "versions"]);
      const versions = arr(o.versions, 10000).map(menuVersion);
      unique(versions.map(x => x.version)); unique(versions.map(x => x.versionId));
      return { code: code(o.code), menuId: uuid(o.menuId), retiredAt: optionalIso(o.retiredAt), versions };
    });
    const drafts = arr(s.drafts, 500).map(v => {
      const o = object(v, ["kind", "code", "revision", "draftId", "body", "proposedBy", "createdAt"]);
      if (o.kind !== "activity" && o.kind !== "menu") fail();
      const body = o.kind === "activity" ? object(o.body, ["scope", "labelEn", "labelEs", "machineSelection", "typedFields"]) : object(o.body, ["labelEn", "labelEs", "items"]);
      if (o.kind === "activity") activityBody(body); else { label(body.labelEn); label(body.labelEs); draftMenuItems(body.items); }
      return { kind: o.kind as "activity" | "menu", code: code(o.code), revision: integer(o.revision, 1), draftId: uuid(o.draftId), body, proposedBy: uuid(o.proposedBy), createdAt: iso(o.createdAt) };
    });
    if (activities.reduce((n, x) => n + x.versions.length, 0) > 10000 || menus.reduce((n, x) => n + x.versions.length, 0) > 10000) fail();
    unique(activities.map(x => x.code)); unique(activities.map(x => x.definitionId));
    unique(activities.flatMap(x => x.versions.map(v => v.versionId)));
    unique(menus.map(x => x.code)); unique(menus.map(x => x.menuId));
    unique(menus.flatMap(x => x.versions.map(v => v.versionId)));
    unique(drafts.map(x => `${x.kind}:${x.code}`)); unique(drafts.map(x => x.draftId));
    const currentSelection = selection(s.currentSelection);
    if (projectId === null && currentSelection !== null) fail();
    return { protocolVersion: 1, role: "company", asOf, projectId, currentSelection, activities, menus, drafts };
  }
  if (s.role !== "crew" || expectedProjectId === null || uuid(s.projectId) !== expectedProjectId) fail();
  let menu: CrewMenu | null = null;
  if (s.menu !== null) {
    const m = object(s.menu, ["revision", "menuVersionId", "activities"]);
    const activities = arr(m.activities, 200).map(v => {
      const o = object(v, ["definitionId", "versionId", "position", "enabled", "scope", "labelEn", "labelEs", "machineSelection", "typedFields", "publishedAt", "effectiveFrom", "retiredAt", "eligibleNow"]);
      orderedDates(o.publishedAt, o.effectiveFrom);
      return { definitionId: uuid(o.definitionId), versionId: uuid(o.versionId), position: integer(o.position, 0, 199), enabled: bool(o.enabled), ...activityBody(o), publishedAt: iso(o.publishedAt), effectiveFrom: iso(o.effectiveFrom), retiredAt: optionalIso(o.retiredAt), eligibleNow: eligible(o.eligibleNow) };
    });
    unique(activities.map(x => x.definitionId)); unique(activities.map(x => x.versionId)); unique(activities.map(x => x.position));
    menu = { revision: integer(m.revision, 1), menuVersionId: uuid(m.menuVersionId), activities };
  }
  return { protocolVersion: 1, role: "crew", asOf, projectId: expectedProjectId as string, menu };
}
export interface Grant { grantId: string; profileId: string; capability: Capability; grantedAt: string; revokedAt: string | null }
export interface GrantSnapshot { protocolVersion: 1; projectId: string; grants: Grant[] }
export function parseGrantSnapshot(raw: unknown, expectedProjectId: string): GrantSnapshot {
  const s = object(cloneJson(raw), ["protocolVersion", "projectId", "grants"]); protocol(s);
  if (uuid(s.projectId) !== expectedProjectId) fail();
  const grants = arr(s.grants, 200).map(v => {
    const o = object(v, ["grantId", "profileId", "capability", "grantedAt", "revokedAt"]);
    const grantedAt = iso(o.grantedAt), revokedAt = optionalIso(o.revokedAt);
    if (revokedAt && Date.parse(revokedAt) < Date.parse(grantedAt)) fail();
    return { grantId: uuid(o.grantId), profileId: uuid(o.profileId), capability: capability(o.capability), grantedAt, revokedAt };
  });
  unique(grants.map(x => x.grantId));
  return { protocolVersion: 1, projectId: expectedProjectId, grants };
}
export function parseReceipt(raw: unknown, kind: "draft" | "publish" | "retire" | "select" | "grant" | "revoke", expected: { code?: string; projectId?: string; profileId?: string; capability?: Capability }): JsonObject {
  const fields = { draft: ["kind", "code", "revision", "draftId"], publish: ["code", "version", "versionId", "publishedAt", "effectiveFrom"], retire: ["code", "retiredAt"], select: ["projectId", "revision", "menuVersionId", "selectionId", "frozenDefinitionVersionIds"], grant: ["projectId", "profileId", "capability", "grantedAt", "grantId"], revoke: ["projectId", "profileId", "capability", "revokedAt"] }[kind];
  const o = object(cloneJson(raw), ["protocolVersion", ...fields]); protocol(o);
  if (expected.code !== undefined && o.code !== expected.code) fail();
  if (expected.projectId !== undefined && o.projectId !== expected.projectId) fail();
  if (expected.profileId !== undefined && o.profileId !== expected.profileId) fail();
  if (expected.capability !== undefined && o.capability !== expected.capability) fail();
  if (kind === "draft") { if (o.kind !== "activity" && o.kind !== "menu") fail(); code(o.code); integer(o.revision, 1); uuid(o.draftId); }
  if (kind === "publish") { code(o.code); integer(o.version, 1); uuid(o.versionId); orderedDates(o.publishedAt, o.effectiveFrom); }
  if (kind === "retire") { code(o.code); iso(o.retiredAt); }
  if (kind === "select") { uuid(o.projectId); integer(o.revision, 1); uuid(o.menuVersionId); uuid(o.selectionId); const ids = arr(o.frozenDefinitionVersionIds, 200).map(uuid); unique(ids); }
  if (kind === "grant") { uuid(o.projectId); uuid(o.profileId); capability(o.capability); iso(o.grantedAt); uuid(o.grantId); }
  if (kind === "revoke") { uuid(o.projectId); uuid(o.profileId); capability(o.capability); iso(o.revokedAt); }
  return o;
}
export const validate = { object, label, bool, integer, finite, capability };
