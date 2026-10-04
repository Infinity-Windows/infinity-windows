import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useConnection } from "../../lib/offline/useWeakSignal";
import { useLanguage } from "../../lib/i18n";
import { listProfiles } from "../../lib/install/api";
import { signInMark, signInGeneration, signedInUserId, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import { fetchJobMenuChoices, fetchJobCapabilityGrants, selectJobMenu, grantJobCapability, revokeJobCapability, isWorkConfigurationRejected,
  type SelectJobMenuCommand, type GrantCommand, type RevokeCommand } from "../../lib/workConfiguration/api";
import { cloneJson, CAPABILITIES, type Capability } from "../../lib/workConfiguration/model";
import { beginConfigurationAttempt, finishConfigurationAttempt, pendingConfiguration, subscribePendingConfiguration } from "../../lib/workConfiguration/pending";
import "./WorkJobConfiguration.css";

type Intent = { kind: "select"; payload: SelectJobMenuCommand } | { kind: "grant"; payload: GrantCommand } | { kind: "revoke"; payload: RevokeCommand };
const onlineNow = () => navigator.onLine !== false;
const execute = (intent: Intent) => intent.kind === "select" ? selectJobMenu(intent.payload)
  : intent.kind === "grant" ? grantJobCapability(intent.payload) : revokeJobCapability(intent.payload);

export function WorkJobConfiguration({ projectId }: { projectId: string }) {
  const viewer = useSyncExternalStore(subscribeSignedIn, signedInUserId, signedInUserId);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const role = useEffectiveRole();
  const { online } = useConnection();
  if (!viewer || role.isPreviewing || !["owner", "supervisor", "foreman"].includes(role.realRole ?? "")) return null;
  return <JobConfiguration key={`${viewer}:${generation}:${role.realRole}:${projectId}`} projectId={projectId}
    viewer={viewer} generation={generation} manager={role.realRole !== "foreman"} online={online} />;
}

function JobConfiguration({ projectId, viewer, generation, manager, online }: { projectId: string; viewer: string; generation: number; manager: boolean; online: boolean }) {
  const { lang } = useLanguage();
  const text = (en: string, es: string) => lang === "es" ? es : en;
  const client = useQueryClient();
  const [mountId] = useState(() => crypto.randomUUID());
  const [mark] = useState(signInMark);
  const scope = `job:${projectId}`;
  const stored = useSyncExternalStore(subscribePendingConfiguration, () => pendingConfiguration<Intent>(scope, mark), () => null);
  const pending = stored?.intent ?? null;
  const alive = useRef(true), busyRef = useRef(false), pendingRef = useRef<Intent | null>(pending); pendingRef.current = pending;
  const [busy, setBusy] = useState(false), [needsRefresh, setNeedsRefresh] = useState(false);
  const [message, setMessage] = useState("");
  const [choice, setChoice] = useState(""), [foreman, setForeman] = useState("");
  const [choiceRevision, setChoiceRevision] = useState<number | null>(null);
  const [capability, setCapability] = useState<Capability>("menu_select");
  const choicesKey = ["workJobMenuChoices", viewer, generation, projectId, mountId] as const;
  const grantsKey = ["workJobCapabilityGrants", viewer, generation, projectId, mountId] as const;
  const peopleKey = ["workJobCapabilityPeople", viewer, generation, projectId, mountId] as const;
  const guard = () => alive.current && onlineNow() && mark.userId === viewer && mark.generation === generation && stillSignedInAs(mark, viewer);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; pendingRef.current = null;
      for (const key of [choicesKey, grantsKey, peopleKey]) {
        void client.cancelQueries({ queryKey: key, exact: true }); client.removeQueries({ queryKey: key, exact: true });
      }
    };
    // Each keyed mount owns these exact private queries and RAM-only intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, mountId]);
  const choices = useQuery({ queryKey: choicesKey, enabled: online, networkMode: "always", retry: false, gcTime: 0, staleTime: 0,
    queryFn: async () => { if (!guard()) throw Error("Session changed"); const result = await fetchJobMenuChoices(projectId); if (!guard()) throw Error("Session changed"); return result; } });
  const grants = useQuery({ queryKey: grantsKey, enabled: online && manager, networkMode: "always", retry: false, gcTime: 0, staleTime: 0,
    queryFn: async () => { if (!guard()) throw Error("Session changed"); const result = await fetchJobCapabilityGrants(projectId); if (!guard()) throw Error("Session changed"); return result; } });
  const people = useQuery({ queryKey: peopleKey, enabled: online && manager, networkMode: "always", retry: false, gcTime: 0, staleTime: 0,
    queryFn: async () => { if (!guard()) throw Error("Session changed"); const result = await listProfiles(); if (!guard()) throw Error("Session changed"); return result.filter(p => p.role === "foreman" && p.active && !p.retired_at && p.id !== viewer); } });
  const choicesReady = online && choices.isSuccess && !choices.isFetching && !needsRefresh;
  const grantsReady = online && grants.isSuccess && people.isSuccess && !grants.isFetching && !people.isFetching && !needsRefresh;
  const enabled = online && !busy && !stored?.inFlight && !pending && !needsRefresh;
  const capLabel = (cap: Capability) => cap === "menu_select" ? text("Choose job menu", "Elegir menú de obra")
    : cap === "dimensions_edit" ? text("Edit protected dimensions", "Editar medidas protegidas") : text("Final QC", "Control final de calidad");

  async function refresh() {
    if (!guard() || busyRef.current || pendingRef.current) return;
    setNeedsRefresh(true); setChoice(""); setForeman("");
    const results = await Promise.all([choices.refetch(), ...(manager ? [grants.refetch(), people.refetch()] : [])]);
    if (!guard()) return;
    if (results.every(result => result.isSuccess)) { setNeedsRefresh(false); setMessage(""); }
    else setMessage(text("Unable to refresh. Check your job permissions and try again.", "No se pudo actualizar. Revisa tus permisos de obra e intenta de nuevo."));
  }
  async function send(intent: Intent) {
    if (!guard() || busyRef.current || (pendingRef.current && pendingRef.current !== intent)) return;
    let attempt: ReturnType<typeof beginConfigurationAttempt<Intent>>;
    try { attempt = beginConfigurationAttempt(scope, mark, intent); }
    catch { setMessage("Resolve the original request before starting another change."); return; }
    busyRef.current = true; setBusy(true); pendingRef.current = attempt.intent; setMessage("");
    try {
      await execute(attempt.intent);
      finishConfigurationAttempt(attempt, "receipt");
      if (!guard()) return;
      pendingRef.current = null; setNeedsRefresh(true); setChoice(""); setForeman("");
      const results = await Promise.all([choices.refetch(), ...(manager ? [grants.refetch(), people.refetch()] : [])]);
      if (!guard()) return;
      setNeedsRefresh(!results.every(result => result.isSuccess));
      setMessage(text("Saved. Review the refreshed records below.", "Guardado. Revisa los registros actualizados abajo."));
    } catch (error) {
      finishConfigurationAttempt(attempt, isWorkConfigurationRejected(error) ? "refused" : "unknown");
      if (!guard()) return;
      if (isWorkConfigurationRejected(error) && !attempt.hadUnknown) {
        pendingRef.current = null; setNeedsRefresh(true);
        setMessage(text("This attempt was refused. Refresh the records, then confirm your choice again.", "Este intento fue rechazado. Actualiza los registros y confirma tu elección de nuevo."));
      } else setMessage(text("The result is unknown. Retry the same request before making another change.", "El resultado no se conoce. Reintenta la misma solicitud antes de hacer otro cambio."));
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function submit(intent: Intent) {
    if (!enabled || !guard() || pendingRef.current) return;
    void send(cloneJson(intent) as Intent);
  }
  const activeGrants = grantsReady ? grants.data?.grants.filter(g => !g.revokedAt) ?? [] : [];
  const alreadyGranted = activeGrants.some(g => g.profileId === foreman && g.capability === capability);
  return <section className="detail-card work-job-configuration">
    <h2>{text("Work menu and job permissions", "Menú de trabajo y permisos de obra")}</h2>
    <p>{text("Choose a published menu for this job. Existing work keeps its original choices.", "Elige un menú publicado para esta obra. El trabajo existente conserva sus opciones originales.")}</p>
    {!online && <p role="status">{text("Connect to read or change job configuration.", "Conéctate para leer o cambiar la configuración de obra.")}</p>}
    {message && <p role="status">{message}</p>}
    {pending && <button disabled={!online || busy || stored?.inFlight} onClick={() => void send(pending)}>{text("Retry same request", "Reintentar la misma solicitud")}</button>}
    {!pending && <button disabled={!online || busy} onClick={() => void refresh()}>{text("Refresh records", "Actualizar registros")}</button>}
    {online && choices.isPending && <p>{text("Loading job menu…", "Cargando menú de obra…")}</p>}
    {online && choices.isError && <p role="alert">{text("Menu choices are unavailable. A foreman needs permission for this job.", "Las opciones no están disponibles. Un capataz necesita permiso para esta obra.")}</p>}
    {choicesReady && choices.data && <>
      <p>{text("Current selection revision", "Revisión de selección actual")}: {choices.data.currentRevision}</p>
      <p>{choices.data.currentSelection ? (choices.data.choices.find(c => c.menuVersionId === choices.data.currentSelection?.menuVersionId)?.[lang === "es" ? "labelEs" : "labelEn"] ?? text("The saved menu is no longer available for new selections.", "El menú guardado ya no está disponible para nuevas selecciones.")) : text("No menu selected.", "Ningún menú seleccionado.")}</p>
      <label>{text("Published menu", "Menú publicado")}<select disabled={!enabled} value={choice} onChange={e => { setChoice(e.target.value); setChoiceRevision(choices.data!.currentRevision); }}>
        <option value="">{text("Choose a menu", "Elegir un menú")}</option>
        {choices.data.choices.map(c => <option key={c.menuVersionId} value={c.menuVersionId}>{lang === "es" ? c.labelEs : c.labelEn} · v{c.version}</option>)}
      </select></label>
      {!choices.data.choices.length && <p>{text("There are no eligible published menus.", "No hay menús publicados disponibles.")}</p>}
      {choice && choiceRevision !== choices.data.currentRevision && <p role="alert">{text("The selection changed. Choose a menu again to confirm the refreshed revision.", "La selección cambió. Elige un menú de nuevo para confirmar la revisión actualizada.")}</p>}
      <button disabled={!enabled || !choice || choiceRevision !== choices.data.currentRevision || !choices.data.choices.some(c => c.menuVersionId === choice)} onClick={() => submit({ kind: "select", payload: { commandId: crypto.randomUUID(), projectId, menuVersionId: choice, expectedCurrentRevision: choiceRevision! } })}>{text("Use this menu", "Usar este menú")}</button>
    </>}
    {manager && <>
      <h3>{text("Foreman permissions", "Permisos de capataz")}</h3>
      <p>{text("Each permission applies only to this job. Granting permission does not approve any work.", "Cada permiso se aplica solo a esta obra. Dar un permiso no aprueba ningún trabajo.")}</p>
      {online && (grants.isError || people.isError) && <p role="alert">{text("Permissions are unavailable. Refresh before changing them.", "Los permisos no están disponibles. Actualiza antes de cambiarlos.")}</p>}
      {grantsReady && <>
        <label>{text("Foreman", "Capataz")}<select disabled={!enabled} value={foreman} onChange={e => setForeman(e.target.value)}><option value="">{text("Choose a foreman", "Elegir un capataz")}</option>{people.data?.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></label>
        <label>{text("Permission", "Permiso")}<select disabled={!enabled} value={capability} onChange={e => setCapability(e.target.value as Capability)}>{CAPABILITIES.map(cap => <option key={cap} value={cap}>{capLabel(cap)}</option>)}</select></label>
        <button disabled={!enabled || !foreman || alreadyGranted} onClick={() => submit({ kind: "grant", payload: { commandId: crypto.randomUUID(), projectId, profileId: foreman, capability } })}>{alreadyGranted ? text("Already granted", "Ya otorgado") : text("Grant permission", "Dar permiso")}</button>
        {activeGrants.map(g => <div className="work-job-grant" key={g.grantId}><p>{people.data?.find(p => p.id === g.profileId)?.display_name ?? text("Former or unavailable foreman", "Capataz anterior o no disponible")} · {capLabel(g.capability)}</p><button disabled={!enabled} onClick={() => submit({ kind: "revoke", payload: { commandId: crypto.randomUUID(), projectId, profileId: g.profileId, capability: g.capability, expectedGrantId: g.grantId } })}>{text("Revoke permission", "Revocar permiso")}</button></div>)}
        {!activeGrants.length && <p>{text("No active foreman permissions.", "No hay permisos activos de capataz.")}</p>}
      </>}
    </>}
  </section>;
}
