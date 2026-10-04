import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchWorkConfiguration, isWorkConfigurationRejected, proposeActivityDraft, proposeMenuDraft,
  publishActivityVersion, publishMenuVersion, retireActivity, retireMenu,
  type ActivityDraftCommand, type ActivityPublishCommand, type MenuDraftCommand,
  type MenuPublishCommand, type RetireCommand,
} from "../../lib/workConfiguration/api";
import {
  code, draftMenuItems, postgresInstantMicros, publishedMenuItems, typedFields, validate,
  type ActivityDefinition, type ActivityVersion, type CompanySnapshot, type Draft,
  type MenuDefinition, type MenuVersion, type TypedField,
} from "../../lib/workConfiguration/model";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { signInGeneration, signInMark, signedInUserId, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import { useConnection } from "../../lib/offline/useWeakSignal";
import { beginConfigurationAttempt, finishConfigurationAttempt, pendingConfiguration, subscribePendingConfiguration } from "../../lib/workConfiguration/pending";
import "./WorkConfigurationSettings.css";

type FieldType = TypedField["type"];
type FieldEdit = { id: string; label_en: string; label_es: string; type: FieldType; required: boolean; unit: string; min: string; max: string; options: { id: string; label_en: string; label_es: string }[] };
type ActivityEdit = { code: string; labelEn: string; labelEs: string; scope: "general" | "specific"; machineSelection: boolean; fields: FieldEdit[]; effectiveFrom: string };
type MenuRow = { code: string; definitionId: string; versionId: string; enabled: boolean };
type MenuEdit = { code: string; labelEn: string; labelEs: string; rows: MenuRow[]; effectiveFrom: string };
type EditorBase = { code: string; draftRevision: number; latestVersion: number };
type Intent =
  | { kind: "activityDraft"; payload: ActivityDraftCommand }
  | { kind: "menuDraft"; payload: MenuDraftCommand }
  | { kind: "activityPublish"; payload: ActivityPublishCommand }
  | { kind: "menuPublish"; payload: MenuPublishCommand }
  | { kind: "activityRetire" | "menuRetire"; payload: RetireCommand };
const TYPES: FieldType[] = ["text", "number", "boolean", "single_select", "multi_select"];
const UNITS = ["", "count", "in", "ft", "mm", "cm", "sq_ft", "sq_m", "min", "h", "lb", "kg"];
const emptyActivity = (): ActivityEdit => ({ code: "", labelEn: "", labelEs: "", scope: "specific", machineSelection: false, fields: [], effectiveFrom: "" });
const emptyMenu = (): MenuEdit => ({ code: "", labelEn: "", labelEs: "", rows: [], effectiveFrom: "" });
const newField = (): FieldEdit => ({ id: "", label_en: "", label_es: "", type: "text", required: false, unit: "", min: "", max: "", options: [] });
const newOption = () => ({ id: "", label_en: "", label_es: "" });
const onlineNow = () => typeof navigator === "undefined" || navigator.onLine !== false;
function fieldEdits(fields: TypedField[]): FieldEdit[] {
  return fields.map(f => ({ ...f, unit: f.unit ?? "", min: f.min === undefined ? "" : String(f.min), max: f.max === undefined ? "" : String(f.max), options: f.options?.map(o => ({ ...o })) ?? [] }));
}
function toFields(fields: FieldEdit[]): TypedField[] {
  const result = fields.map(f => {
    const value: TypedField = { id: f.id.trim(), label_en: f.label_en.trim(), label_es: f.label_es.trim(), type: f.type, required: f.required };
    if (f.type === "number") {
      if (f.unit) value.unit = f.unit;
      if (f.min.trim()) value.min = Number(f.min);
      if (f.max.trim()) value.max = Number(f.max);
    }
    if (f.type === "single_select" || f.type === "multi_select") value.options = f.options.map(o => ({ id: o.id.trim(), label_en: o.label_en.trim(), label_es: o.label_es.trim() }));
    return value;
  });
  const checked = typedFields(result);
  if (new TextEncoder().encode(JSON.stringify(checked)).byteLength > 20000) throw Error("Too many field details");
  return checked;
}
function effectiveTime(text: string): string | null {
  const v = text.trim();
  if (!v) return null;
  postgresInstantMicros(v);
  return v;
}
function latest<T extends { version: number }>(versions: T[]): T | null { return versions.reduce<T | null>((best, row) => !best || row.version > best.version ? row : best, null); }
function currentActivityBody(row: ActivityDefinition | undefined, draft: Draft | undefined): ActivityEdit {
  const version = row ? latest(row.versions) : null;
  const body = draft?.body;
  return {
    code: row?.code ?? draft?.code ?? "",
    labelEn: typeof body?.labelEn === "string" ? body.labelEn : version?.labelEn ?? "",
    labelEs: typeof body?.labelEs === "string" ? body.labelEs : version?.labelEs ?? "",
    scope: body?.scope === "general" || body?.scope === "specific" ? body.scope : version?.scope ?? "specific",
    machineSelection: typeof body?.machineSelection === "boolean" ? body.machineSelection : version?.machineSelection ?? false,
    fields: fieldEdits((body?.typedFields as TypedField[] | undefined) ?? version?.typedFields ?? []),
    effectiveFrom: "",
  };
}
function rowForVersion(catalog: ActivityDefinition[], item: { definitionId: string; versionId: string; enabled: boolean }): MenuRow {
  const def = catalog.find(a => a.definitionId === item.definitionId);
  return { code: def?.code ?? "", definitionId: item.definitionId, versionId: item.versionId, enabled: item.enabled };
}
function preferredVersion(def: ActivityDefinition): ActivityVersion | null {
  return latest(def.versions.filter(v => v.eligibleNow && def.retiredAt === null));
}
function currentMenuBody(row: MenuDefinition | undefined, draft: Draft | undefined, catalog: ActivityDefinition[]): MenuEdit {
  const version = row ? latest(row.versions) : null;
  const body = draft?.body;
  let rows: MenuRow[] = [];
  if (Array.isArray(body?.items)) {
    rows = (body.items as { code: string; enabled: boolean; position: number }[]).slice().sort((a, b) => a.position - b.position).map(item => {
      const def = catalog.find(a => a.code === item.code);
      const preferred = def && preferredVersion(def);
      return { code: item.code, definitionId: def?.definitionId ?? "", versionId: preferred?.versionId ?? "", enabled: item.enabled };
    });
  } else if (version) {
    rows = version.items.slice().sort((a, b) => a.position - b.position).map(item => rowForVersion(catalog, item));
  }
  return { code: row?.code ?? draft?.code ?? "", labelEn: typeof body?.labelEn === "string" ? body.labelEn : version?.labelEn ?? "", labelEs: typeof body?.labelEs === "string" ? body.labelEs : version?.labelEs ?? "", rows, effectiveFrom: "" };
}
async function execute(intent: Intent): Promise<unknown> {
  switch (intent.kind) {
    case "activityDraft": return proposeActivityDraft(intent.payload);
    case "menuDraft": return proposeMenuDraft(intent.payload);
    case "activityPublish": return publishActivityVersion(intent.payload);
    case "menuPublish": return publishMenuVersion(intent.payload);
    case "activityRetire": return retireActivity(intent.payload);
    case "menuRetire": return retireMenu(intent.payload);
  }
}

/** Self-contained Settings card. The parent mounts it lazily without private props. */
export function WorkConfigurationSettings() {
  const viewerId = useSyncExternalStore(subscribeSignedIn, signedInUserId, signedInUserId);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const role = useEffectiveRole();
  const { online } = useConnection();
  const allowed = Boolean(viewerId && !role.isPreviewing && role.realRole === role.effectiveRole && (role.realRole === "owner" || role.realRole === "supervisor"));
  if (!allowed) return null;
  return <CompanyEditor key={`${viewerId}:${generation}:${role.realRole}`} viewerId={viewerId!} generation={generation} role={role.realRole as "owner" | "supervisor"} online={online} />;
}

function CompanyEditor({ viewerId, generation, role, online }: { viewerId: string; generation: number; role: "owner" | "supervisor"; online: boolean }) {
  const qc = useQueryClient();
  const [mountKey] = useState(() => crypto.randomUUID());
  const key = ["workConfigurationCompany", viewerId, generation, role, mountKey] as const;
  const alive = useRef(true);
  const [mark] = useState(signInMark);
  const stored = useSyncExternalStore(subscribePendingConfiguration, () => pendingConfiguration<Intent>("company", mark), () => null);
  const pending = stored?.intent ?? null;
  const pendingRef = useRef<Intent | null>(pending); pendingRef.current = pending;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [message, setMessage] = useState("");
  const [activity, setActivity] = useState<ActivityEdit | null>(null);
  const [activityBase, setActivityBase] = useState<EditorBase | null>(null);
  const [menu, setMenu] = useState<MenuEdit | null>(null);
  const [menuBase, setMenuBase] = useState<EditorBase | null>(null);
  const validViewer = () => alive.current && onlineNow() && stillSignedInAs(mark, viewerId) && signInGeneration() === generation;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingRef.current = null;
      const exact = { queryKey: key, exact: true };
      void qc.cancelQueries(exact);
      qc.removeQueries(exact);
    };
    // The keyed remount owns this exact query and local editor state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, mountKey]);
  const snapshot = useQuery({ queryKey: key, queryFn: async () => {
    const callMark = signInMark();
    if (callMark.userId !== viewerId || callMark.generation !== generation || !onlineNow()) throw Error("Session changed");
    const result = await fetchWorkConfiguration(null);
    if (!stillSignedInAs(callMark, viewerId) || result.role !== "company") throw Error("Session changed");
    return result;
  }, enabled: online, gcTime: 0, staleTime: 0, retry: false, networkMode: "always", refetchOnMount: "always" });
  const data: CompanySnapshot | null = online && snapshot.isSuccess && !snapshot.isFetching && !needsRefresh && snapshot.data?.role === "company" ? snapshot.data : null;
  const canAct = Boolean(data && online && !busy && !stored?.inFlight && !pending && !needsRefresh);
  const owner = role === "owner";

  async function refresh() {
    if (!onlineNow() || !validViewer()) return;
    setNeedsRefresh(true);
    const result = await snapshot.refetch();
    if (!validViewer()) return;
    setNeedsRefresh(!result.isSuccess || result.data?.role !== "company");
    if (!result.isSuccess) setMessage("Current records are unavailable. Refresh before making another change.");
  }
  async function send(intent: Intent, retrying: boolean) {
    if (!validViewer() || busyRef.current || (!retrying && (pendingRef.current || needsRefresh))) return;
    let attempt: ReturnType<typeof beginConfigurationAttempt<Intent>>;
    try { attempt = beginConfigurationAttempt("company", mark, intent); }
    catch { setMessage("Resolve the original request before starting another change."); return; }
    pendingRef.current = attempt.intent;
    busyRef.current = true; setBusy(true); setMessage("");
    try {
      await execute(attempt.intent);
      finishConfigurationAttempt(attempt, "receipt");
      if (!validViewer()) return;
      pendingRef.current = null;
      setMessage("Saved. Loading the current version and revision…");
      await refresh();
    } catch (error) {
      finishConfigurationAttempt(attempt, isWorkConfigurationRejected(error) ? "refused" : "unknown");
      if (!validViewer()) return;
      if (isWorkConfigurationRejected(error) && !attempt.hadUnknown) {
        pendingRef.current = null;
        setMessage("The server refused this change. Refreshing current records before another attempt.");
        await refresh();
      } else {
        setMessage("The result is unknown. Retry this exact request with its original command ID. Do not start a new change yet.");
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function submit(make: () => Intent) {
    if (!canAct || busyRef.current || pendingRef.current) return;
    try { send(make(), false); }
    catch { setMessage("Check the code, both labels, fields, options, numbers and effective time before saving."); }
  }
  function retryPending() { if (pendingRef.current && !busy && !stored?.inFlight && online && validViewer()) void send(pendingRef.current, true); }
  const activityRow = activity && data?.activities.find(a => a.code === activity.code);
  const activityDraft = activity && data?.drafts.find(d => d.kind === "activity" && d.code === activity.code);
  const menuRow = menu && data?.menus.find(m => m.code === menu.code);
  const menuDraft = menu && data?.drafts.find(d => d.kind === "menu" && d.code === menu.code);
  const latestActivity = activityRow ? latest(activityRow.versions) : null;
  const latestMenu = menuRow ? latest(menuRow.versions) : null;
  const activityStale = Boolean(activity && activityBase && (
    (activityBase.code !== "" && activity.code !== activityBase.code) ||
    (activityDraft?.revision ?? 0) !== activityBase.draftRevision ||
    (latestActivity?.version ?? 0) !== activityBase.latestVersion
  ));
  const menuStale = Boolean(menu && menuBase && (
    (menuBase.code !== "" && menu.code !== menuBase.code) ||
    (menuDraft?.revision ?? 0) !== menuBase.draftRevision ||
    (latestMenu?.version ?? 0) !== menuBase.latestVersion
  ));
  const fieldPayload = () => { if (!activity) throw Error("No activity"); code(activity.code.trim()); return toFields(activity.fields); };
  function activityIntent(publish: boolean): Intent {
    if (!activity) throw Error("No activity");
    const checkedCode = code(activity.code.trim());
    const labelEn = validate.label(activity.labelEn.trim()), labelEs = validate.label(activity.labelEs.trim());
    const fields = fieldPayload();
    const effectiveFrom = publish ? effectiveTime(activity.effectiveFrom) : null;
    const base = { commandId: crypto.randomUUID(), code: checkedCode, scope: activity.scope, labelEn, labelEs, machineSelection: activity.machineSelection, typedFields: fields };
    if (publish) return { kind: "activityPublish", payload: { ...base, expectedLatestVersion: activityBase?.latestVersion ?? 0, effectiveFrom } };
    return { kind: "activityDraft", payload: { ...base, expectedRevision: activityBase?.draftRevision ?? 0 } };
  }
  function menuIntent(publish: boolean): Intent {
    if (!menu) throw Error("No menu");
    const checkedCode = code(menu.code.trim());
    const labelEn = validate.label(menu.labelEn.trim()), labelEs = validate.label(menu.labelEs.trim());
    if (publish) {
      const items = publishedMenuItems(menu.rows.map((r, position) => ({ definitionId: r.definitionId, versionId: r.versionId, enabled: r.enabled, position })));
      const effectiveFrom = effectiveTime(menu.effectiveFrom);
      return { kind: "menuPublish", payload: { commandId: crypto.randomUUID(), code: checkedCode, labelEn, labelEs, expectedLatestVersion: menuBase?.latestVersion ?? 0, items, effectiveFrom } };
    }
    const items = draftMenuItems(menu.rows.map((r, position) => ({ code: r.code, enabled: r.enabled, position })));
    if (new TextEncoder().encode(JSON.stringify(items)).byteLength > 40000) throw Error("Too many menu details");
    return { kind: "menuDraft", payload: { commandId: crypto.randomUUID(), code: checkedCode, labelEn, labelEs, expectedRevision: menuBase?.draftRevision ?? 0, items } };
  }
  function retireIntent(kind: "activity" | "menu"): Intent {
    const selected = kind === "activity" ? activity : menu;
    const expected = kind === "activity" ? activityBase?.latestVersion : menuBase?.latestVersion;
    if (!selected || !expected) throw Error("No published version");
    return { kind: kind === "activity" ? "activityRetire" : "menuRetire", payload: { commandId: crypto.randomUUID(), code: code(selected.code), expectedLatestVersion: expected } };
  }
  function openActivity(row?: ActivityDefinition) {
    if (!data || pendingRef.current || busyRef.current) return;
    const draft = data.drafts.find(d => d.kind === "activity" && d.code === row?.code);
    setActivity(row || draft ? currentActivityBody(row, draft) : emptyActivity());
    setActivityBase({ code: row?.code ?? draft?.code ?? "", draftRevision: draft?.revision ?? 0, latestVersion: row ? latest(row.versions)?.version ?? 0 : 0 });
    setMenu(null); setMenuBase(null); setMessage("");
  }
  function openActivityDraft(draft: Draft) {
    if (!data || pendingRef.current || busyRef.current) return;
    const row = data.activities.find(a => a.code === draft.code);
    setActivity(currentActivityBody(row, draft));
    setActivityBase({ code: draft.code, draftRevision: draft.revision, latestVersion: row ? latest(row.versions)?.version ?? 0 : 0 });
    setMenu(null); setMenuBase(null); setMessage("");
  }
  function openMenu(row?: MenuDefinition) {
    if (!data || pendingRef.current || busyRef.current) return;
    const draft = data.drafts.find(d => d.kind === "menu" && d.code === row?.code);
    setMenu(row || draft ? currentMenuBody(row, draft, data.activities) : emptyMenu());
    setMenuBase({ code: row?.code ?? draft?.code ?? "", draftRevision: draft?.revision ?? 0, latestVersion: row ? latest(row.versions)?.version ?? 0 : 0 });
    setActivity(null); setActivityBase(null); setMessage("");
  }
  function reloadActivity() {
    if (!data || !activity) return;
    const row = data.activities.find(a => a.code === activity.code);
    const draft = data.drafts.find(d => d.kind === "activity" && d.code === activity.code);
    if (row) openActivity(row); else if (draft) openActivityDraft(draft); else openActivity();
  }
  function reloadMenu() {
    if (!data || !menu) return;
    const row = data.menus.find(m => m.code === menu.code);
    const draft = data.drafts.find(d => d.kind === "menu" && d.code === menu.code);
    if (row) openMenu(row); else if (draft) openMenuDraft(draft); else openMenu();
  }
  function openMenuDraft(draft: Draft) {
    if (!data || pendingRef.current || busyRef.current) return;
    const row = data.menus.find(m => m.code === draft.code);
    setMenu(currentMenuBody(row, draft, data.activities));
    setMenuBase({ code: draft.code, draftRevision: draft.revision, latestVersion: row ? latest(row.versions)?.version ?? 0 : 0 });
    setActivity(null); setActivityBase(null); setMessage("");
  }
  return <section className="detail-card wc-settings" aria-label="Work configuration">
    <div className="wc-head"><div><h2>Work configuration</h2><p className="muted">Versioned company activities and capture menus. Drafts are proposals; publication requires the owner.</p></div><button type="button" className="button-like" disabled={!online || busy} onClick={() => void refresh()}>Refresh</button></div>
    {!online ? <p role="status">Work configuration is hidden while offline. Reconnect to refresh. {pending && "An uncertain request remains ready to retry."}</p> : null}
    {message && online ? <p className="wc-message" role="status">{message}</p> : null}
    {pending && online ? <div className="wc-pending" role="alert"><strong>Outcome unknown: {pending.kind}</strong><span>Code {pending.payload.code}; command {pending.payload.commandId}</span><button type="button" className="button-like" disabled={busy || stored?.inFlight} onClick={retryPending}>Retry exact request</button></div> : null}
    {online && (snapshot.isError || needsRefresh) ? <p role="alert">Current configuration is unavailable. Use Refresh before editing.</p> : null}
    {online && snapshot.isPending ? <p>Loading configuration…</p> : null}
    {data && <>
      <p className="wc-asof">Catalog checked {new Date(data.asOf).toLocaleString()} · {role === "owner" ? "Owner publishing" : "Supervisor proposals"}</p>
      <div className="wc-columns">
        <div className="wc-list"><div className="wc-list-head"><h3>Activities</h3><button type="button" className="button-like" disabled={!canAct} onClick={() => openActivity()}>New activity</button></div>
          {data.activities.map(a => <div className="wc-item" key={a.definitionId}><button type="button" disabled={!canAct} onClick={() => openActivity(a)}>{latest(a.versions)?.labelEn ?? a.code} <small>{a.code}</small></button><span>{a.retiredAt ? "Retired" : `v${latest(a.versions)?.version ?? 0}`}</span><VersionHistory kind="activity" versions={a.versions} /></div>)}
          {data.drafts.filter(d => d.kind === "activity" && !data.activities.some(a => a.code === d.code)).map(d => <button className="wc-draft-link" type="button" key={d.draftId} disabled={!canAct} onClick={() => openActivityDraft(d)}>Draft: {d.code} · r{d.revision}</button>)}
        </div>
        <div className="wc-list"><div className="wc-list-head"><h3>Capture menus</h3><button type="button" className="button-like" disabled={!canAct} onClick={() => openMenu()}>New menu</button></div>
          {data.menus.map(m => <div className="wc-item" key={m.menuId}><button type="button" disabled={!canAct} onClick={() => openMenu(m)}>{latest(m.versions)?.labelEn ?? m.code} <small>{m.code}</small></button><span>{m.retiredAt ? "Retired" : `v${latest(m.versions)?.version ?? 0}`}</span><VersionHistory kind="menu" versions={m.versions} /></div>)}
          {data.drafts.filter(d => d.kind === "menu" && !data.menus.some(m => m.code === d.code)).map(d => <button className="wc-draft-link" type="button" key={d.draftId} disabled={!canAct} onClick={() => openMenuDraft(d)}>Draft: {d.code} · r{d.revision}</button>)}
        </div>
      </div>
      {activity && <>
        {activityStale && <p className="wc-stale" role="alert">This activity changed since you opened it. Reload the editor before sending another change. <button type="button" className="button-like" disabled={!canAct} onClick={reloadActivity}>Reload editor</button></p>}
        <ActivityEditor value={activity} onChange={setActivity} disabled={!canAct || activityStale} draftRevision={activityBase?.draftRevision ?? 0} latestVersion={activityBase?.latestVersion ?? 0} retired={Boolean(activityRow?.retiredAt)} owner={owner} onDraft={() => submit(() => activityIntent(false))} onPublish={() => submit(() => activityIntent(true))} onRetire={() => submit(() => retireIntent("activity"))} />
      </>}
      {menu && <>
        {menuStale && <p className="wc-stale" role="alert">This menu changed since you opened it. Reload the editor before sending another change. <button type="button" className="button-like" disabled={!canAct} onClick={reloadMenu}>Reload editor</button></p>}
        <MenuEditor value={menu} onChange={setMenu} disabled={!canAct || menuStale} draftRevision={menuBase?.draftRevision ?? 0} latestVersion={menuBase?.latestVersion ?? 0} retired={Boolean(menuRow?.retiredAt)} owner={owner} catalog={data.activities} onDraft={() => submit(() => menuIntent(false))} onPublish={() => submit(() => menuIntent(true))} onRetire={() => submit(() => retireIntent("menu"))} />
      </>}
    </>}
  </section>;
}

function VersionHistory({ kind, versions }: { kind: "activity"; versions: ActivityVersion[] } | { kind: "menu"; versions: MenuVersion[] }) {
  return <details className="wc-history"><summary>Published history ({versions.length})</summary>{versions.map(v => <article key={v.versionId}><strong>Version {v.version} · {v.labelEn} / {v.labelEs}</strong><p>ID {v.versionId}</p><p>Published {v.publishedAt} · effective {v.effectiveFrom} · {v.eligibleNow ? "Eligible now" : "Not currently eligible"}</p>{kind === "activity" ? <><p>{(v as ActivityVersion).scope} · machine choice {(v as ActivityVersion).machineSelection ? "yes" : "no"}</p><ul>{(v as ActivityVersion).typedFields.map(f => <li key={f.id}>{f.id} · {f.label_en} / {f.label_es} · {f.type} · {f.required ? "required" : "optional"}{f.unit ? ` · ${f.unit}` : ""}{f.min !== undefined ? ` · min ${f.min}` : ""}{f.max !== undefined ? ` · max ${f.max}` : ""}{f.options ? <ul>{f.options.map(o => <li key={o.id}>{o.id} · {o.label_en} / {o.label_es}</li>)}</ul> : null}</li>)}</ul></> : <ul>{(v as MenuVersion).items.map(i => <li key={i.versionId}>Definition {i.definitionId} · version {i.versionId} · position {i.position + 1} · {i.enabled ? "on" : "off"}</li>)}</ul>}</article>)}</details>;
}
function ActivityEditor({ value, onChange, disabled, draftRevision, latestVersion, retired, owner, onDraft, onPublish, onRetire }: { value: ActivityEdit; onChange: (v: ActivityEdit) => void; disabled: boolean; draftRevision: number; latestVersion: number; retired: boolean; owner: boolean; onDraft: () => void; onPublish: () => void; onRetire: () => void }) {
  const set = (patch: Partial<ActivityEdit>) => onChange({ ...value, ...patch });
  const setField = (i: number, next: FieldEdit) => set({ fields: value.fields.map((f, n) => n === i ? next : f) });
  return <div className="wc-editor" aria-label="Activity editor"><h3>Activity proposal</h3><p>Draft revision {draftRevision} · latest published version {latestVersion}</p>
    <div className="wc-form-grid"><label>Stable code<input value={value.code} disabled={disabled || latestVersion > 0 || draftRevision > 0} onChange={e => set({ code: e.target.value })} placeholder="shimming" /></label><label>Scope<select value={value.scope} disabled={disabled} onChange={e => set({ scope: e.target.value as ActivityEdit["scope"] })}><option value="general">General</option><option value="specific">Specific</option></select></label><label>English label<input value={value.labelEn} disabled={disabled} onChange={e => set({ labelEn: e.target.value })} /></label><label>Spanish label<input value={value.labelEs} disabled={disabled} onChange={e => set({ labelEs: e.target.value })} /></label></div>
    <label className="wc-check"><input type="checkbox" checked={value.machineSelection} disabled={disabled} onChange={e => set({ machineSelection: e.target.checked })} /> Require a machine choice</label>
    <div className="wc-list-head"><h4>Custom fields</h4><button type="button" className="button-like" disabled={disabled || value.fields.length >= 40} onClick={() => set({ fields: [...value.fields, newField()] })}>Add field</button></div>
    {value.fields.map((f, i) => <div className="wc-subcard" key={i}><div className="wc-form-grid"><label>Field ID<input value={f.id} disabled={disabled} onChange={e => setField(i, { ...f, id: e.target.value })} placeholder="shim_count" /></label><label>Type<select value={f.type} disabled={disabled} onChange={e => setField(i, { ...f, type: e.target.value as FieldType, unit: "", min: "", max: "", options: [] })}>{TYPES.map(t => <option key={t} value={t}>{t.replaceAll("_", " ")}</option>)}</select></label><label>English label<input value={f.label_en} disabled={disabled} onChange={e => setField(i, { ...f, label_en: e.target.value })} /></label><label>Spanish label<input value={f.label_es} disabled={disabled} onChange={e => setField(i, { ...f, label_es: e.target.value })} /></label></div><label className="wc-check"><input type="checkbox" checked={f.required} disabled={disabled} onChange={e => setField(i, { ...f, required: e.target.checked })} /> Required</label>
      {f.type === "number" && <div className="wc-form-grid"><label>Unit<select value={f.unit} disabled={disabled} onChange={e => setField(i, { ...f, unit: e.target.value })}>{UNITS.map(u => <option key={u} value={u}>{u || "No unit"}</option>)}</select></label><label>Minimum<input type="number" value={f.min} disabled={disabled} onChange={e => setField(i, { ...f, min: e.target.value })} /></label><label>Maximum<input type="number" value={f.max} disabled={disabled} onChange={e => setField(i, { ...f, max: e.target.value })} /></label></div>}
      {(f.type === "single_select" || f.type === "multi_select") && <div className="wc-options"><div className="wc-list-head"><h5>Options</h5><button type="button" className="button-like" disabled={disabled || f.options.length >= 50} onClick={() => setField(i, { ...f, options: [...f.options, newOption()] })}>Add option</button></div>{f.options.map((o, n) => <div className="wc-option" key={n}><input aria-label={`Option ${n + 1} ID`} placeholder="option_id" value={o.id} disabled={disabled} onChange={e => setField(i, { ...f, options: f.options.map((x, k) => k === n ? { ...x, id: e.target.value } : x) })} /><input aria-label={`Option ${n + 1} English`} placeholder="English" value={o.label_en} disabled={disabled} onChange={e => setField(i, { ...f, options: f.options.map((x, k) => k === n ? { ...x, label_en: e.target.value } : x) })} /><input aria-label={`Option ${n + 1} Spanish`} placeholder="Español" value={o.label_es} disabled={disabled} onChange={e => setField(i, { ...f, options: f.options.map((x, k) => k === n ? { ...x, label_es: e.target.value } : x) })} /><button type="button" disabled={disabled} onClick={() => setField(i, { ...f, options: f.options.filter((_, k) => k !== n) })}>Remove</button></div>)}</div>}
      <button type="button" className="wc-remove" disabled={disabled} onClick={() => set({ fields: value.fields.filter((_, n) => n !== i) })}>Remove field</button></div>)}
    <PublishControls effectiveFrom={value.effectiveFrom} setEffectiveFrom={v => set({ effectiveFrom: v })} disabled={disabled || !owner || retired} />
    <div className="wc-actions"><button type="button" className="button-like" disabled={disabled || retired} onClick={onDraft}>Save proposal</button>{owner && <><button type="button" className="action-btn" disabled={disabled || retired} onClick={onPublish}>Publish new version</button><button type="button" className="button-like wc-danger" disabled={disabled || retired || !latestVersion} onClick={onRetire}>Retire activity</button></>}</div>
    {retired && <p>Retired definitions remain in published history and cannot be republished.</p>}
  </div>;
}
function PublishControls({ effectiveFrom, setEffectiveFrom, disabled }: { effectiveFrom: string; setEffectiveFrom: (v: string) => void; disabled: boolean }) {
  return <label className="wc-effective">Effective time for owner publication (optional ISO timestamp)<input value={effectiveFrom} disabled={disabled} onChange={e => setEffectiveFrom(e.target.value)} placeholder="Blank = immediately; or 2026-11-08T12:00:00Z" /><small>Enter a future timestamp with timezone. Blank publishes immediately. Up to six fractional digits.</small></label>;
}
function MenuEditor({ value, onChange, disabled, draftRevision, latestVersion, retired, owner, catalog, onDraft, onPublish, onRetire }: { value: MenuEdit; onChange: (v: MenuEdit) => void; disabled: boolean; draftRevision: number; latestVersion: number; retired: boolean; owner: boolean; catalog: ActivityDefinition[]; onDraft: () => void; onPublish: () => void; onRetire: () => void }) {
  const [addCode, setAddCode] = useState("");
  const set = (patch: Partial<MenuEdit>) => onChange({ ...value, ...patch });
  const move = (index: number, delta: number) => { const rows = value.rows.slice(); const other = index + delta; if (other < 0 || other >= rows.length) return; [rows[index], rows[other]] = [rows[other], rows[index]]; set({ rows }); };
  const available = catalog.filter(a => !value.rows.some(r => r.code === a.code));
  function add() {
    const def = catalog.find(a => a.code === addCode); if (!def || value.rows.length >= 200) return;
    const version = preferredVersion(def);
    set({ rows: [...value.rows, { code: def.code, definitionId: def.definitionId, versionId: version?.versionId ?? "", enabled: true }] }); setAddCode("");
  }
  return <div className="wc-editor" aria-label="Menu editor"><h3>Capture menu proposal</h3><p>Draft revision {draftRevision} · latest published version {latestVersion}</p>
    <div className="wc-form-grid"><label>Stable code<input value={value.code} disabled={disabled || latestVersion > 0 || draftRevision > 0} onChange={e => set({ code: e.target.value })} placeholder="standard_install" /></label><label>English label<input value={value.labelEn} disabled={disabled} onChange={e => set({ labelEn: e.target.value })} /></label><label>Spanish label<input value={value.labelEs} disabled={disabled} onChange={e => set({ labelEs: e.target.value })} /></label></div>
    <div className="wc-menu-add"><label>Add activity<select value={addCode} disabled={disabled} onChange={e => setAddCode(e.target.value)}><option value="">Choose activity</option>{available.map(a => <option key={a.definitionId} value={a.code}>{latest(a.versions)?.labelEn ?? a.code} ({a.code})</option>)}</select></label><button type="button" className="button-like" disabled={disabled || !addCode} onClick={add}>Add</button></div>
    <p className="muted">Drafts store activity codes. Publication freezes the selected definition and version IDs shown below.</p>
    <ol className="wc-menu-rows">{value.rows.map((r, i) => {
      const def = catalog.find(a => a.code === r.code);
      const selected = def?.versions.find(v => v.versionId === r.versionId);
      return <li key={`${r.code}:${i}`}><div className="wc-menu-row-head"><strong>{r.code}</strong><span>Position {i + 1}</span></div><label>Published activity version<select aria-label={`${r.code} published version`} value={r.versionId} disabled={disabled} onChange={e => set({ rows: value.rows.map((x, n) => n === i ? { ...x, definitionId: def?.definitionId ?? "", versionId: e.target.value } : x) })}><option value="">No published version</option>{def?.versions.map(v => <option key={v.versionId} value={v.versionId}>v{v.version} · {v.labelEn} · {v.eligibleNow ? "eligible" : "not eligible"} · {v.versionId}</option>)}</select></label><p className="wc-ids">Definition {r.definitionId || "none"} · version {selected?.versionId ?? (r.versionId || "none")}</p><label className="wc-check"><input type="checkbox" checked={r.enabled} disabled={disabled} onChange={e => set({ rows: value.rows.map((x, n) => n === i ? { ...x, enabled: e.target.checked } : x) })} /> Enabled</label><div className="wc-row-actions"><button type="button" disabled={disabled || i === 0} onClick={() => move(i, -1)}>Move up</button><button type="button" disabled={disabled || i === value.rows.length - 1} onClick={() => move(i, 1)}>Move down</button><button type="button" disabled={disabled} onClick={() => set({ rows: value.rows.filter((_, n) => n !== i) })}>Remove</button></div></li>;
    })}</ol>
    <PublishControls effectiveFrom={value.effectiveFrom} setEffectiveFrom={v => set({ effectiveFrom: v })} disabled={disabled || !owner || retired} />
    <div className="wc-actions"><button type="button" className="button-like" disabled={disabled || retired} onClick={onDraft}>Save proposal</button>{owner && <><button type="button" className="action-btn" disabled={disabled || retired || value.rows.some(r => !r.definitionId || !r.versionId)} onClick={onPublish}>Publish new version</button><button type="button" className="button-like wc-danger" disabled={disabled || retired || !latestVersion} onClick={onRetire}>Retire menu</button></>}</div>
    {retired && <p>Retired menus remain in published history and cannot be republished.</p>}
  </div>;
}
