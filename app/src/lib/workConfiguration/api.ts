import type { Session } from "@supabase/supabase-js";
import { clientWithToken, supabase } from "../supabase";
import { signInMark, stillSignedInAs } from "../signedIn";
import {
  WorkConfigurationUnavailableError, cloneJson, code, uuid, postgresInstantMicros, typedFields,
  draftMenuItems, publishedMenuItems, parseWorkConfiguration, parseGrantSnapshot,
  parseReceipt, validate, type Capability, type WorkConfigurationSnapshot,
  type GrantSnapshot, type JsonObject,
} from "./model";

export { WorkConfigurationUnavailableError } from "./model";
const changed = () => new WorkConfigurationUnavailableError();
function online(): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw changed();
}
async function invoke(name: string, args: JsonObject): Promise<unknown> {
  online();
  const mark = signInMark();
  const who = mark.userId;
  if (!who) throw changed();
  let session: Session | null;
  try {
    const result = await supabase.auth.getSession();
    if (result.error) throw result.error;
    session = result.data.session;
  } catch { throw changed(); }
  if (!session || !stillSignedInAs(mark, who) || session.user?.id !== who || !session.access_token) throw changed();
  // The client is frozen to this checked token; the ambient client follows later auth changes.
  let result: { data: unknown; error: unknown };
  try { result = await clientWithToken(session.access_token).rpc(name, args); }
  catch { throw changed(); }
  if (!stillSignedInAs(mark, who)) throw changed();
  if (result.error || result.data === null || result.data === undefined) throw changed();
  return result.data;
}
function commandId(v: unknown): string { return uuid(v); }
function nonnegative(v: unknown, max = Number.MAX_SAFE_INTEGER - 1): number { return validate.integer(v, 0, max); }
function activityPayload(v: unknown): JsonObject {
  const o = validate.object(cloneJson(v), ["commandId", "code", "expectedRevision", "scope", "labelEn", "labelEs", "machineSelection", "typedFields"]);
  commandId(o.commandId); code(o.code); nonnegative(o.expectedRevision);
  if (o.scope !== "general" && o.scope !== "specific") throw changed();
  validate.label(o.labelEn); validate.label(o.labelEs); validate.bool(o.machineSelection); typedFields(o.typedFields);
  return o;
}
function publishActivityPayload(v: unknown): JsonObject {
  const o = validate.object(cloneJson(v), ["commandId", "code", "expectedLatestVersion", "scope", "labelEn", "labelEs", "machineSelection", "typedFields", "effectiveFrom"]);
  activityPayload({ commandId: o.commandId, code: o.code, expectedRevision: o.expectedLatestVersion, scope: o.scope, labelEn: o.labelEn, labelEs: o.labelEs, machineSelection: o.machineSelection, typedFields: o.typedFields });
  nonnegative(o.expectedLatestVersion, 2147483646);
  if (o.effectiveFrom !== null) postgresInstantMicros(o.effectiveFrom);
  return o;
}
function menuPayload(v: unknown, published: boolean): JsonObject {
  const o = validate.object(cloneJson(v), published ? ["commandId", "code", "expectedLatestVersion", "labelEn", "labelEs", "items", "effectiveFrom"] : ["commandId", "code", "expectedRevision", "labelEn", "labelEs", "items"]);
  commandId(o.commandId); code(o.code); validate.label(o.labelEn); validate.label(o.labelEs);
  if (published) { nonnegative(o.expectedLatestVersion, 2147483646); publishedMenuItems(o.items); if (o.effectiveFrom !== null) postgresInstantMicros(o.effectiveFrom); }
  else { nonnegative(o.expectedRevision); draftMenuItems(o.items); }
  return o;
}
function retirePayload(v: unknown): JsonObject {
  const o = validate.object(cloneJson(v), ["commandId", "code", "expectedLatestVersion"]);
  commandId(o.commandId); code(o.code); validate.integer(o.expectedLatestVersion, 1, 2147483647); return o;
}
function selectPayload(v: unknown): JsonObject {
  const o = validate.object(cloneJson(v), ["commandId", "projectId", "menuVersionId", "expectedCurrentRevision"]);
  commandId(o.commandId); uuid(o.projectId); uuid(o.menuVersionId); nonnegative(o.expectedCurrentRevision); return o;
}
function grantPayload(v: unknown, revoke: boolean): JsonObject {
  const o = validate.object(cloneJson(v), ["commandId", "projectId", "profileId", "capability", ...(revoke ? ["expectedGrantId"] : [])]);
  commandId(o.commandId); uuid(o.projectId); uuid(o.profileId); validate.capability(o.capability);
  if (revoke) uuid(o.expectedGrantId);
  return o;
}
function receipt(data: unknown, kind: Parameters<typeof parseReceipt>[1], o: JsonObject, expectedDraftKind?: "activity" | "menu") {
  const parsed = parseReceipt(data, kind, { code: o.code as string | undefined, projectId: o.projectId as string | undefined, profileId: o.profileId as string | undefined, capability: o.capability as Capability | undefined });
  if (expectedDraftKind && parsed.kind !== expectedDraftKind) throw changed();
  if (kind === "draft" && parsed.revision !== (o.expectedRevision as number) + 1) throw changed();
  if (kind === "publish") {
    if (parsed.version !== (o.expectedLatestVersion as number) + 1) throw changed();
    const requested = o.effectiveFrom === null ? parsed.publishedAt : o.effectiveFrom;
    if (postgresInstantMicros(parsed.effectiveFrom) !== postgresInstantMicros(requested)) throw changed();
  }
  if (kind === "select" && (parsed.revision !== (o.expectedCurrentRevision as number) + 1 || parsed.menuVersionId !== o.menuVersionId)) throw changed();
  return parsed;
}
/** Read one fresh snapshot. A company-wide call passes null; a crew call needs a job. */
export async function fetchWorkConfiguration(projectId: string | null): Promise<WorkConfigurationSnapshot> {
  if (projectId !== null) uuid(projectId);
  const data = await invoke("work_configuration_snapshot", { p_project_id: projectId });
  return parseWorkConfiguration(data, projectId);
}
export async function fetchJobCapabilityGrants(projectId: string): Promise<GrantSnapshot> {
  uuid(projectId);
  return parseGrantSnapshot(await invoke("work_job_capability_grants", { p_project_id: projectId }), projectId);
}
export interface ActivityDraftCommand { commandId: string; code: string; expectedRevision: number; scope: "general" | "specific"; labelEn: string; labelEs: string; machineSelection: boolean; typedFields: unknown[] }
export interface MenuDraftCommand { commandId: string; code: string; expectedRevision: number; labelEn: string; labelEs: string; items: unknown[] }
export interface ActivityPublishCommand extends Omit<ActivityDraftCommand, "expectedRevision"> { expectedLatestVersion: number; effectiveFrom: string | null }
export interface MenuPublishCommand extends Omit<MenuDraftCommand, "expectedRevision"> { expectedLatestVersion: number; effectiveFrom: string | null }
export interface RetireCommand { commandId: string; code: string; expectedLatestVersion: number }
export interface SelectJobMenuCommand { commandId: string; projectId: string; menuVersionId: string; expectedCurrentRevision: number }
export interface GrantCommand { commandId: string; projectId: string; profileId: string; capability: Capability }
export interface RevokeCommand extends GrantCommand { expectedGrantId: string }
export async function proposeActivityDraft(input: ActivityDraftCommand) {
  const o = activityPayload(input);
  return receipt(await invoke("work_propose_activity_draft", { p_command_id: o.commandId, p_code: o.code, p_expected_revision: o.expectedRevision, p_scope: o.scope, p_label_en: o.labelEn, p_label_es: o.labelEs, p_machine_selection: o.machineSelection, p_typed_fields: o.typedFields }), "draft", o, "activity");
}
export async function proposeMenuDraft(input: MenuDraftCommand) {
  const o = menuPayload(input, false);
  return receipt(await invoke("work_propose_menu_draft", { p_command_id: o.commandId, p_code: o.code, p_expected_revision: o.expectedRevision, p_label_en: o.labelEn, p_label_es: o.labelEs, p_items: o.items }), "draft", o, "menu");
}
export async function publishActivityVersion(input: ActivityPublishCommand) {
  const o = publishActivityPayload(input);
  return receipt(await invoke("work_publish_activity_version", { p_command_id: o.commandId, p_code: o.code, p_expected_latest_version: o.expectedLatestVersion, p_scope: o.scope, p_label_en: o.labelEn, p_label_es: o.labelEs, p_machine_selection: o.machineSelection, p_typed_fields: o.typedFields, p_effective_from: o.effectiveFrom }), "publish", o);
}
export async function publishMenuVersion(input: MenuPublishCommand) {
  const o = menuPayload(input, true);
  return receipt(await invoke("work_publish_menu_version", { p_command_id: o.commandId, p_code: o.code, p_expected_latest_version: o.expectedLatestVersion, p_label_en: o.labelEn, p_label_es: o.labelEs, p_items: o.items, p_effective_from: o.effectiveFrom }), "publish", o);
}
export async function retireActivity(input: RetireCommand) {
  const o = retirePayload(input);
  return receipt(await invoke("work_retire_activity", { p_command_id: o.commandId, p_code: o.code, p_expected_latest_version: o.expectedLatestVersion }), "retire", o);
}
export async function retireMenu(input: RetireCommand) {
  const o = retirePayload(input);
  return receipt(await invoke("work_retire_menu", { p_command_id: o.commandId, p_code: o.code, p_expected_latest_version: o.expectedLatestVersion }), "retire", o);
}
export async function selectJobMenu(input: SelectJobMenuCommand) {
  const o = selectPayload(input);
  return receipt(await invoke("work_select_job_menu", { p_command_id: o.commandId, p_project_id: o.projectId, p_menu_version_id: o.menuVersionId, p_expected_current_revision: o.expectedCurrentRevision }), "select", o);
}
export async function grantJobCapability(input: GrantCommand) {
  const o = grantPayload(input, false);
  return receipt(await invoke("work_grant_job_capability", { p_command_id: o.commandId, p_project_id: o.projectId, p_profile_id: o.profileId, p_capability: o.capability }), "grant", o);
}
export async function revokeJobCapability(input: RevokeCommand) {
  const o = grantPayload(input, true);
  return receipt(await invoke("work_revoke_job_capability", { p_command_id: o.commandId, p_project_id: o.projectId, p_profile_id: o.profileId, p_capability: o.capability, p_expected_grant_id: o.expectedGrantId }), "revoke", o);
}
