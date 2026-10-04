import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkConfiguration, parseGrantSnapshot, typedFields, iso, cloneJson, WorkConfigurationUnavailableError } from "./model";
const JOB = "3cc5b810-45e0-4445-a115-efa98f8efad3";
const OTHER = "00000000-0000-4000-8000-00000000f0f0";
const ME = "00000000-0000-4000-8000-0000000000e2";
const CMD = "00000000-0000-4000-8000-0000000000c1";
let active: string | null = ME;
let returned: string | null = ME;
let generation = 0;
let afterSession: (() => void) | null = null;
let afterRpc: (() => void) | null = null;
let response: unknown;
let rpcError: unknown = null;
const calls: { token: string; name: string; args: Record<string, unknown> }[] = [];
vi.mock("../supabase", () => ({
  supabase: { auth: { getSession: async () => {
    const session = returned ? { access_token: `token-${returned}`, user: { id: returned } } : null;
    afterSession?.();
    return { data: { session }, error: null };
  } } },
  clientWithToken: (token: string) => ({ rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ token, name, args }); afterRpc?.(); return { data: response, error: rpcError };
  } }),
}));
vi.mock("../signedIn", () => ({
  signInMark: () => ({ userId: active, generation }),
  stillSignedInAs: (mark: { userId: string | null; generation: number }, who: string) => mark.userId === who && mark.generation === generation && active === who,
}));
const api = await import("./api");
const asOf = "2026-11-08T12:00:00Z";
function company(projectId: string | null = null) { return { protocolVersion: 1, role: "company", asOf, projectId, currentSelection: null, activities: [], menus: [], drafts: [] }; }
function crew(projectId = JOB) { return { protocolVersion: 1, role: "crew", asOf, projectId, menu: null }; }
const draft = { commandId: CMD, code: "window_install", expectedRevision: 0, scope: "specific" as const, labelEn: "Window install", labelEs: "Instalar ventana", machineSelection: false, typedFields: [] };
const draftReceipt = { protocolVersion: 1, kind: "activity", code: draft.code, revision: 1, draftId: OTHER };
beforeEach(() => { active = ME; returned = ME; generation = 0; afterSession = null; afterRpc = null; response = company(); rpcError = null; calls.length = 0; });
describe("configuration snapshots", () => {
  it("accepts both roles and binds every job response", async () => {
    expect((await api.fetchWorkConfiguration(null)).role).toBe("company");
    response = crew();
    expect((await api.fetchWorkConfiguration(JOB)).role).toBe("crew");
    expect(calls.map(x => x.token)).toEqual([`token-${ME}`, `token-${ME}`]);
    response = crew(OTHER);
    await expect(api.fetchWorkConfiguration(JOB)).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    response = company(OTHER);
    await expect(api.fetchWorkConfiguration(JOB)).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
  });
  it("refuses missing and unknown protocol fields as unavailable", () => {
    expect(() => parseWorkConfiguration({ ...company(), asOf: undefined }, null)).toThrow(WorkConfigurationUnavailableError);
    expect(() => parseWorkConfiguration({ ...company(), protocolVersion: 2 }, null)).toThrow(WorkConfigurationUnavailableError);
    expect(() => parseWorkConfiguration({ ...company(), currentSelection: undefined }, null)).toThrow(WorkConfigurationUnavailableError);
    expect(() => parseWorkConfiguration({ ...company(), extra: true }, null)).toThrow(WorkConfigurationUnavailableError);
  });
  it("preserves future/retired publication metadata and all frozen ids", () => {
    const future = "2030-01-01T00:00:00Z";
    const snapshot = company(JOB);
    snapshot.currentSelection = { revision: 1, menuVersionId: OTHER } as never;
    snapshot.activities = [{ code: "window_install", definitionId: JOB, retiredAt: asOf, versions: [{ versionId: OTHER, version: 1, scope: "specific", labelEn: "Install", labelEs: "Instalar", machineSelection: false, typedFields: [], publishedAt: asOf, effectiveFrom: future, eligibleNow: false }] }] as never;
    const parsed = parseWorkConfiguration(snapshot, JOB);
    if (parsed.role !== "company") throw Error("wrong role");
    expect(parsed.activities[0].versions[0].effectiveFrom).toBe(future);
    expect(parsed.activities[0].retiredAt).toBe(asOf);
    expect(parsed.currentSelection?.menuVersionId).toBe(OTHER);
    const c = { ...crew(), menu: { revision: 1, menuVersionId: OTHER, activities: [{ definitionId: JOB, versionId: OTHER, position: 0, enabled: true, scope: "specific", labelEn: "Install", labelEs: "Instalar", machineSelection: false, typedFields: [], publishedAt: asOf, effectiveFrom: future, retiredAt: asOf, eligibleNow: false }] } };
    const crewParsed = parseWorkConfiguration(c, JOB);
    if (crewParsed.role !== "crew") throw Error("wrong role");
    expect(crewParsed.menu?.activities[0].retiredAt).toBe(asOf);
  });
  it("refuses duplicate published versions, menu positions, and malformed quantities", () => {
    const version = { versionId: OTHER, version: 1, scope: "specific", labelEn: "Install", labelEs: "Instalar", machineSelection: false, typedFields: [], publishedAt: asOf, effectiveFrom: asOf, eligibleNow: true };
    expect(() => parseWorkConfiguration({ ...company(), activities: [{ code: "a", definitionId: JOB, retiredAt: null, versions: [version, version] }] }, null)).toThrow(WorkConfigurationUnavailableError);
    const a = { definitionId: JOB, versionId: OTHER, position: 0, enabled: true, scope: "specific", labelEn: "A", labelEs: "A", machineSelection: false, typedFields: [], publishedAt: asOf, effectiveFrom: asOf, retiredAt: null, eligibleNow: true };
    expect(() => parseWorkConfiguration({ ...crew(), menu: { revision: 1, menuVersionId: OTHER, activities: [a, { ...a, definitionId: CMD }] } }, JOB)).toThrow(WorkConfigurationUnavailableError);
    expect(() => typedFields([{ id: "count", label_en: "Count", label_es: "Cantidad", type: "number", required: true, unit: "count", min: 0.5 }])).toThrow(WorkConfigurationUnavailableError);
    expect(() => typedFields([{ id: "length", label_en: "Length", label_es: "Longitud", type: "number", required: true, min: NaN }])).toThrow(WorkConfigurationUnavailableError);
  });
  it("validates real calendar days and timezone offsets without losing microseconds", () => {
    expect(() => iso("2026-02-31T10:00:00Z")).toThrow(WorkConfigurationUnavailableError);
    expect(() => iso("2025-02-29T10:00:00Z")).toThrow(WorkConfigurationUnavailableError);
    expect(iso("2024-02-29T10:00:00.123456+06:30")).toBe("2024-02-29T10:00:00.123456+06:30");
    expect(() => iso("2026-10-03T25:00:00Z")).toThrow(WorkConfigurationUnavailableError);
  });
  it("bounds deeply nested, oversized and cyclic inputs with a safe error", () => {
    let deep: unknown = null;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => cloneJson(deep)).toThrow(WorkConfigurationUnavailableError);
    expect(() => cloneJson({ blob: "x".repeat(1000001) })).toThrow(WorkConfigurationUnavailableError);
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => cloneJson(cyclic)).toThrow(WorkConfigurationUnavailableError);
  });
  it("requires exact grant job and strict grant rows", () => {
    expect(() => parseGrantSnapshot({ protocolVersion: 1, projectId: OTHER, grants: [] }, JOB)).toThrow(WorkConfigurationUnavailableError);
    expect(() => parseGrantSnapshot({ protocolVersion: 1, projectId: JOB, grants: [{ grantId: CMD, profileId: ME, capability: "menu_select", grantedAt: asOf }] }, JOB)).toThrow(WorkConfigurationUnavailableError);
  });
});
describe("configuration commands", () => {
  it("captures mark before session and refuses logout or ABA before sending", async () => {
    afterSession = () => { active = null; generation++; active = ME; generation++; };
    await expect(api.proposeActivityDraft(draft)).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    expect(calls).toHaveLength(0);
  });
  it("refuses an auth change before treating a late success or error as current", async () => {
    response = draftReceipt;
    afterRpc = () => { active = null; generation++; };
    await expect(api.proposeActivityDraft(draft)).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    rpcError = { message: "constraint details should not surface" };
    active = ME; generation = 0;
    await expect(api.proposeActivityDraft(draft)).rejects.toThrow("Work configuration is unavailable");
  });
  it("keeps the original command id and cloned payload if caller mutates while waiting", async () => {
    response = draftReceipt;
    const command = { ...draft, typedFields: [{ id: "length", label_en: "Length", label_es: "Longitud", type: "number", required: true, unit: "in", min: 0 }] };
    afterSession = () => { command.typedFields[0].min = 999; command.commandId = OTHER; };
    await api.proposeActivityDraft(command);
    expect(calls[0].args.p_command_id).toBe(CMD);
    expect(calls[0].args.p_typed_fields).toEqual([{ id: "length", label_en: "Length", label_es: "Longitud", type: "number", required: true, unit: "in", min: 0 }]);
    expect(calls[0].token).toBe(`token-${ME}`);
  });
  it("refuses malformed commands before any session or RPC", async () => {
    const fields = [{ id: "quantity", label_en: "Quantity", label_es: "Cantidad", type: "number", required: true, unit: "count", min: 1.5 }];
    await expect(api.proposeActivityDraft({ ...draft, typedFields: fields })).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    await expect(api.publishMenuVersion({ commandId: CMD, code: "menu", expectedLatestVersion: 0, labelEn: "Menu", labelEs: "Menú", effectiveFrom: null, items: [{ definitionId: JOB, versionId: OTHER, position: NaN, enabled: true }] })).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    expect(calls).toHaveLength(0);
  });
  it("rejects prototype pollution and accessor inputs before send", async () => {
    const bad = Object.create({ sneaky: true }); Object.assign(bad, draft);
    await expect(api.proposeActivityDraft(bad)).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    const accessor = { ...draft }; Object.defineProperty(accessor, "code", { get: () => "window_install", enumerable: true });
    await expect(api.proposeActivityDraft(accessor)).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    expect(calls).toHaveLength(0);
  });
  it("routes each named command with typed arguments and checks its receipt", async () => {
    const menuDraft = { commandId: CMD, code: "main_menu", expectedRevision: 0, labelEn: "Main", labelEs: "Principal", items: [{ code: "window_install", position: 0, enabled: true }] };
    const common = { commandId: CMD, code: "window_install", expectedLatestVersion: 0 };
    const published = { protocolVersion: 1, code: "window_install", version: 1, versionId: OTHER, publishedAt: asOf, effectiveFrom: asOf };
    response = { protocolVersion: 1, kind: "menu", code: "main_menu", revision: 1, draftId: OTHER };
    await api.proposeMenuDraft(menuDraft);
    response = published;
    await api.publishActivityVersion({ commandId: CMD, code: draft.code, expectedLatestVersion: 0, scope: draft.scope, labelEn: draft.labelEn, labelEs: draft.labelEs, machineSelection: draft.machineSelection, typedFields: [], effectiveFrom: null });
    response = { ...published, code: "main_menu" };
    await api.publishMenuVersion({ commandId: CMD, code: menuDraft.code, expectedLatestVersion: 0, labelEn: menuDraft.labelEn, labelEs: menuDraft.labelEs, effectiveFrom: null, items: [{ definitionId: JOB, versionId: OTHER, position: 0, enabled: true }] });
    response = { protocolVersion: 1, code: "window_install", retiredAt: asOf };
    await api.retireActivity({ ...common, expectedLatestVersion: 1 });
    response = { protocolVersion: 1, code: "main_menu", retiredAt: asOf };
    await api.retireMenu({ commandId: CMD, code: "main_menu", expectedLatestVersion: 1 });
    response = { protocolVersion: 1, projectId: JOB, revision: 1, menuVersionId: OTHER, selectionId: CMD, frozenDefinitionVersionIds: [OTHER] };
    await api.selectJobMenu({ commandId: CMD, projectId: JOB, menuVersionId: OTHER, expectedCurrentRevision: 0 });
    response = { protocolVersion: 1, projectId: JOB, profileId: OTHER, capability: "menu_select", grantedAt: asOf, grantId: CMD };
    await api.grantJobCapability({ commandId: CMD, projectId: JOB, profileId: OTHER, capability: "menu_select" });
    response = { protocolVersion: 1, projectId: JOB, profileId: OTHER, capability: "menu_select", revokedAt: asOf };
    await api.revokeJobCapability({ commandId: CMD, projectId: JOB, profileId: OTHER, capability: "menu_select", expectedGrantId: CMD });
    expect(calls.map(x => x.name)).toEqual(["work_propose_menu_draft", "work_publish_activity_version", "work_publish_menu_version", "work_retire_activity", "work_retire_menu", "work_select_job_menu", "work_grant_job_capability", "work_revoke_job_capability"]);
    expect(calls[7].args.p_expected_grant_id).toBe(CMD);
    expect(calls[2].args.p_effective_from).toBeNull();
  });
  it("refuses receipts with a mismatched revision, version, or selected menu", async () => {
    response = { ...draftReceipt, revision: 2 };
    await expect(api.proposeActivityDraft(draft)).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    response = { protocolVersion: 1, code: draft.code, version: 2, versionId: OTHER, publishedAt: asOf, effectiveFrom: asOf };
    await expect(api.publishActivityVersion({ commandId: CMD, code: draft.code, expectedLatestVersion: 0, scope: draft.scope, labelEn: draft.labelEn, labelEs: draft.labelEs, machineSelection: false, typedFields: [], effectiveFrom: null })).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    response = { protocolVersion: 1, projectId: JOB, revision: 1, menuVersionId: CMD, selectionId: OTHER, frozenDefinitionVersionIds: [] };
    await expect(api.selectJobMenu({ commandId: CMD, projectId: JOB, menuVersionId: OTHER, expectedCurrentRevision: 0 })).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
    response = { protocolVersion: 1, projectId: JOB, revision: 3, menuVersionId: OTHER, selectionId: CMD, frozenDefinitionVersionIds: [] };
    await expect(api.selectJobMenu({ commandId: CMD, projectId: JOB, menuVersionId: OTHER, expectedCurrentRevision: 0 })).rejects.toBeInstanceOf(WorkConfigurationUnavailableError);
  });
  it("keeps the same caller-supplied id for an exact retry", async () => {
    response = draftReceipt;
    await api.proposeActivityDraft(draft); await api.proposeActivityDraft(draft);
    expect(calls.map(x => x.args.p_command_id)).toEqual([CMD, CMD]);
    expect(calls[0].args).toEqual(calls[1].args);
  });
});
