import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryError, SkeletonList, EmptyState } from "../../components/ui/States";
import { stgJobList } from "../../lib/stg";
import { formatApiError } from "../../lib/errors";
import { partnerWarehouse, packageCommand, type WarehouseAction, type WarehouseCommand } from "../../lib/stgWarehouse";
import { signedInId } from "../../lib/signedIn";
import { supabase } from "../../lib/supabase";
import { Scanner } from "../../components/Scanner";
import { parseQr, type QrPayload } from "../../lib/qr";
import { packageLabelsPdf, downloadPdf } from "../../lib/labels";
import { queuePartnerCommand, flushPartnerOutbox, readPartnerOutbox, retryPartnerCommand, dismissPartnerCommand, type PartnerQueuedCommand } from "../../lib/stgWarehouseOutbox";
import { StgPackagePhotos } from "./StgPackagePhotos";
import "./stgWarehouse.css";

function JobWarehouse({ project }: { project: string }) {
  const data = useQuery({ queryKey: ["stgWarehouse", project], queryFn: () => partnerWarehouse(project) });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [container, setContainer] = useState("");
  const [note, setNote] = useState("");
  const [mark, setMark] = useState("");
  const [total, setTotal] = useState(1);
  const [blankSerial,setBlankSerial] = useState("");
  const [partIndex,setPartIndex] = useState(1);
  const [partType,setPartType] = useState("frame");
  const [supply, setSupply] = useState("");
  const [qty, setQty] = useState(1);
  const [boxName,setBoxName] = useState("");
  const [boxKind,setBoxKind] = useState("crate");
  const [box,setBox] = useState("");
  const [parent,setParent] = useState("");
  const [delivery,setDelivery] = useState("");
  const [deliveryLabel,setDeliveryLabel] = useState("");
  const [deliveryDate,setDeliveryDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [actor, setActor] = useState<string | null>(null);
  const [queue, setQueue] = useState<PartnerQueuedCommand[]>([]);
  const [camera, setCamera] = useState(false);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const uid = signedInId();
        if (!active) return;
        setActor(uid); setQueue(uid ? readPartnerOutbox(uid) : []);
      } catch (e) { if (active) setError(formatApiError(e)); }
    }
    async function drain() {
      const uid = signedInId();
      if (uid) { try { const sent = await flushPartnerOutbox(uid); if (active && sent) { setMessage("Saved warehouse actions"); await data.refetch(); } } catch (e) { if (active) setError(formatApiError(e)); } }
      await refresh();
    }
    void drain();
    const auth = supabase.auth.onAuthStateChange(() => { void refresh(); });
    window.addEventListener("stg-warehouse-outbox", refresh);
    window.addEventListener("online", drain);
    return () => { active = false; auth.data.subscription.unsubscribe(); window.removeEventListener("stg-warehouse-outbox", refresh); window.removeEventListener("online", drain); };
  // Refetch is stable; changing jobs remounts this component.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function run(command: WarehouseCommand) {
    setBusy(true); setError(""); setMessage("");
    try {
      const uid = await queuePartnerCommand(command);
      await flushPartnerOutbox(uid);
      const pending = readPartnerOutbox(uid).some(r => r.command.id === command.id);
      setSelected([]);
      setMessage(pending ? "Saved on this device — not sent yet. Open Warehouse when connected to send it." : "Saved warehouse action");
      if (!pending) await data.refetch();
    } catch (e) { setError(formatApiError(e)); }
    finally { setBusy(false); }
  }
  if (data.isLoading) return <SkeletonList rows={3} />;
  if (data.isError) return <QueryError error={data.error} onRetry={() => data.refetch()} />;
  const warehouse = data.data;
  if (!warehouse) return null;
  const can = (action: WarehouseAction) => warehouse.capabilities.includes(action === "bind" ? "tag" : action === "stage" ? "move" : action === "reopen" ? "finalize" : action.startsWith("container_") ? "containers" : action.startsWith("delivery_") ? "deliveries" : action as Parameters<typeof warehouse.capabilities.includes>[0]);
  const picked = warehouse.packages.filter(p => selected.includes(p.id));
  const matches = warehouse.packages.filter(p => `${p.serial} ${p.short_code ?? ""} ${p.mark ?? ""} ${p.part_type ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  const locked = busy || queue.length > 0;
  const action = (kind: WarehouseAction, extra: Record<string, unknown> = {}) => void run(packageCommand(project, kind, picked, extra));
  const basic = (kind: WarehouseAction, input: Record<string, unknown> = {}) => void run({ id: crypto.randomUUID(), project, action: kind, input });
  const buttons: [WarehouseAction, string][] = [["receive","Receive selected"],["stage","Set aside"],["checkout","Send selected to site"],["arrival","Confirm arrival"]];
  function scan(payload: QrPayload) {
    if (!warehouse) return;
    if (payload.kind === "containerSerial") {
      const target = warehouse.containers.find(c => c.serial === payload.serial && c.active);
      if (target) { setContainer(target.id); setMessage(`Destination: ${target.name}`); } else setError("That sticker is not available for this job.");
    } else {
      const target = warehouse.packages.find(p => payload.kind === "packageSerial" ? p.serial === payload.serial : payload.kind === "windowCode" && p.short_code === payload.code);
      if (target) { setSelected(ids => ids.includes(target.id) ? ids : [...ids,target.id]); setSearch(""); setMessage(`Selected ${target.serial}`); } else setError("That sticker is not available for this job.");
    }
    setCamera(false);
  }
  return <div className="stg-warehouse">
    <div className="row-between"><h2>Warehouse</h2><button type="button" onClick={() => void data.refetch()} disabled={busy}>Refresh</button></div>
    {warehouse.capabilities.length === 0 && <p className="muted">Viewing access. The office can enable warehouse actions for your login.</p>}
    <p className="muted">{warehouse.finalized_at ? "Materials finalized · warehouse history" : "Current job material"} · {warehouse.packages.length} {warehouse.packages.length === 1 ? "package" : "packages"}</p>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    {queue.length > 0 && <section className="detail-card"><h3>Not sent yet ({queue.length})</h3>{queue.map(row => <div key={row.command.id}><p>{row.command.action}{row.error ? ` · ${row.error}` : " · waiting to send"}</p><button type="button" disabled={busy} onClick={async () => { if (!actor) return; setBusy(true); try { retryPartnerCommand(actor,row.command.id); await flushPartnerOutbox(actor); await data.refetch(); } catch(e) { setError(formatApiError(e)); } finally { setBusy(false); } }}>Retry</button><button type="button" disabled={busy} onClick={() => { if (actor) dismissPartnerCommand(actor,row.command.id); }}>Remove from queue</button></div>)}<p className="muted">Removing a queued action does not reverse anything already saved on the server.</p></section>}
    <button type="button" onClick={() => setCamera(!camera)}>{camera ? "Close camera" : "Scan package or container"}</button>
    {camera && <Scanner showManualEntry={false} onScan={scan} hint="Scan a sticker for this job" />}
    <label>Find a package or scan into this field<input type="search" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { const payload = parseQr(search); if (payload) scan(payload); } }} placeholder="Sticker, short code or window number" /></label>
    <div className="stg-package-list">
      {matches.map(p => <label className="stg-package" key={p.id}>
        <input type="checkbox" checked={selected.includes(p.id)} disabled={locked} onChange={e => setSelected(e.target.checked ? [...selected,p.id] : selected.filter(id => id !== p.id))} />
        <span><strong>{p.mark ? `Window ${p.mark}` : p.serial}</strong><span>{p.serial} · {p.part_type ?? "Package"}{p.part_index ? ` ${p.part_index}/${p.part_total}` : ""}</span><span>{p.status.replaceAll("_"," ")} · {warehouse.containers.find(c => c.id === p.container_id)?.name ?? (p.status === "checked_out" ? "On job site" : "No container")}{p.area ? ` · ${p.area}` : ""}</span></span>
      </label>)}
      {matches.length === 0 && <EmptyState title="No matching packages" message="Only this job's shared material appears here." />}
    </div>
    {picked.length === 1 && <StgPackagePhotos key={picked[0].id} project={project} packageId={picked[0].id} canUpload={!warehouse.finalized_at && (can("receive") || can("damage"))} />}
    <button type="button" disabled={busy || picked.length === 0} onClick={async () => { setBusy(true); try { downloadPdf(await packageLabelsPdf(picked.map(p => ({ ...p, bindLine: `${p.mark ? `Window ${p.mark}` : "Job material"} · ${p.part_index ?? "?"} of ${p.part_total ?? "?"}` }))),"STG-package-labels.pdf"); } catch(e) { setError(formatApiError(e)); } finally { setBusy(false); } }}>Print / reprint selected labels</button>
    {!warehouse.finalized_at && warehouse.capabilities.length > 0 && <section className="detail-card">
      <h3>{selected.length} selected</h3>
      <div className="stg-actions">{buttons.filter(([kind]) => can(kind)).map(([kind,label]) => <button key={kind} type="button" disabled={locked || picked.length === 0} onClick={() => action(kind)}>{label}</button>)}</div>
      {can("move") && <div className="stg-form"><label>Destination container<select value={container} onChange={e => setContainer(e.target.value)}><option value="">Choose container</option>{warehouse.containers.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button type="button" disabled={locked || !container || picked.length === 0} onClick={() => action("move", { container })}>Move / return selected</button></div>}
      {can("damage") && <div className="stg-form"><label>Damage description<textarea value={note} maxLength={1000} onChange={e => setNote(e.target.value)} /></label><button type="button" disabled={locked || !note.trim() || picked.length === 0} onClick={() => action("damage", { note })}>Report damage</button></div>}
    </section>}
    {!warehouse.finalized_at && can("tag") && <details className="detail-card"><summary>Prepare package labels</summary><p className="muted">Declare the pieces for an existing window number. Receive them when they arrive.</p><label>Window number<input value={mark} onChange={e => setMark(e.target.value)} /></label><label>Piece count<input type="number" min={1} max={20} value={total} onChange={e => setTotal(Number(e.target.value))} /></label><button type="button" disabled={locked || !mark.trim() || !Number.isInteger(total) || total < 1 || total > 20} onClick={() => basic("tag", { mark, total })}>Prepare labels</button><h3 style={{marginTop:16}}>Use a blank sticker</h3><label>Sticker serial or short code<input value={blankSerial} onChange={e=>setBlankSerial(e.target.value)}/></label><label>Piece number<input type="number" min={1} max={total} value={partIndex} onChange={e=>setPartIndex(Number(e.target.value))}/></label><label>Piece type<select value={partType} onChange={e=>setPartType(e.target.value)}>{["frame","glass","panel","threshold","hardware","screen","other"].map(t=><option key={t} value={t}>{t}</option>)}</select></label><p className="muted">This permanently binds the sticker to the window number above. Do not reuse it.</p><button type="button" disabled={locked||!blankSerial.trim()||!mark.trim()||partIndex<1||partIndex>total} onClick={()=>basic("bind",{serial:blankSerial,mark,part_index:partIndex,part_total:total,part_type:partType})}>Bind and receive sticker</button></details>}
    <details className="detail-card"><summary>Containers ({warehouse.containers.length})</summary>{warehouse.containers.map(c => <p key={c.id}>{c.name} · {c.kind} · {c.serial}</p>)}{can("containers") && !warehouse.finalized_at && <>
      <div className="stg-form"><label>New container name<input maxLength={100} value={boxName} onChange={e=>setBoxName(e.target.value)}/></label><label>Kind<select value={boxKind} onChange={e=>setBoxKind(e.target.value)}><option value="crate">Crate</option><option value="conex">Conex</option><option value="truck">Truck</option></select></label><button type="button" disabled={locked||!boxName.trim()} onClick={()=>basic("container_create",{name:boxName,kind:boxKind})}>Create job container</button></div>
      <div className="stg-form"><label>Move container<select value={box} onChange={e=>setBox(e.target.value)}><option value="">Choose container</option>{warehouse.containers.filter(c=>c.active&&!['bay','building'].includes(c.kind)).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Place inside<select value={parent} onChange={e=>setParent(e.target.value)}><option value="">Outside other containers</option>{warehouse.containers.filter(c=>c.active&&c.id!==box).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button type="button" disabled={locked||!box} onClick={()=>basic("container_move",{container:box,parent:parent||null,expected_parent:warehouse.containers.find(c=>c.id===box)?.parent_container_id??null})}>Move container</button></div><p className="muted">Shared containers need the office to arrange their move.</p>
    </>}</details>
    <details className="detail-card"><summary>Deliveries ({warehouse.deliveries.length})</summary>{warehouse.deliveries.map(d => <p key={d.id}>{d.label} · {d.expected_at ? new Date(d.expected_at).toLocaleDateString() : "Date pending"}{d.shared ? " · showing this job's packages only" : ""}</p>)}{can("deliveries")&&!warehouse.finalized_at&&<div className="stg-form">
      <label>Delivery<select value={delivery} onChange={e=>{setDelivery(e.target.value);const d=warehouse.deliveries.find(d=>d.id===e.target.value);setDeliveryLabel(d?.label??"");setDeliveryDate(d?.expected_at?.slice(0,10)??"");}}><option value="">New delivery from selected packages</option>{warehouse.deliveries.filter(d=>!d.shared).map(d=><option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
      <label>Delivery label<input value={deliveryLabel} maxLength={100} onChange={e=>setDeliveryLabel(e.target.value)}/></label><label>Expected date<input type="date" value={deliveryDate} onChange={e=>setDeliveryDate(e.target.value)}/></label>
      <button type="button" disabled={locked||!deliveryLabel.trim()||(!delivery&&picked.length===0)} onClick={()=>delivery?basic("delivery_update",{delivery,label:deliveryLabel,expected_at:deliveryDate?`${deliveryDate}T12:00:00Z`:null,expected_before:warehouse.deliveries.find(d=>d.id===delivery)?.expected_at??null}):action("delivery_create",{label:deliveryLabel,expected_at:deliveryDate?`${deliveryDate}T12:00:00Z`:null})}>{delivery?"Update delivery":"Create delivery"}</button>
    </div>}</details>
    <details className="detail-card"><summary>Job supplies ({warehouse.supplies.length})</summary>{warehouse.supplies.map(s => <p key={s.id}>{s.name} · {s.unit}</p>)}{can("supplies") && !warehouse.finalized_at && <div className="stg-form"><label>Supply<select value={supply} onChange={e => setSupply(e.target.value)}><option value="">Choose supply</option>{warehouse.supplies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>Quantity<input type="number" min={0.01} step="any" value={qty} onChange={e => setQty(Number(e.target.value))} /></label><button type="button" disabled={locked || !supply || !Number.isFinite(qty) || qty <= 0} onClick={() => basic("supplies", { supply, qty })}>Record supplies taken</button></div>}</details>
    <details className="detail-card"><summary>Movement history</summary><p className="muted">Latest 200 movements. Internal notes are private.</p>{warehouse.history.map(h => <p key={h.id}>{h.event.replaceAll("_"," ")} · {warehouse.packages.find(p => p.id === h.package_id)?.serial ?? "Job material"} · {new Date(h.created_at).toLocaleString()}</p>)}</details>
    {can("undo") && warehouse.undoable.length > 0 && <details className="detail-card"><summary>Undo my recent movements</summary>{warehouse.undoable.map(c => <p key={c.id}>{c.action} · {new Date(c.created_at).toLocaleString()} <button type="button" disabled={locked} onClick={() => basic("undo", { command: c.id })}>Undo</button></p>)}</details>}
    {can("finalize") && <button type="button" disabled={locked} onClick={() => basic(warehouse.finalized_at ? "reopen" : "finalize")}>{warehouse.finalized_at ? "Reopen materials" : "Finalize materials"}</button>}
  </div>;
}
export function StgWarehouse() {
  const jobs = useQuery({ queryKey: ["stgJobList"], queryFn: stgJobList });
  const [project, setProject] = useState("");
  if (jobs.isLoading) return <SkeletonList rows={2} />;
  if (jobs.isError) return <QueryError error={jobs.error} onRetry={() => jobs.refetch()} />;
  if (!jobs.data?.length) return <EmptyState title="No jobs shared yet" message="Ask the office to grant your login access to an STG job." />;
  const current = project || jobs.data[0].id;
  return <><label>Job<select value={current} onChange={e => setProject(e.target.value)}>{jobs.data.map(j => <option key={j.id} value={j.id}>{j.name} · {j.job_code}</option>)}</select></label><JobWarehouse key={current} project={current} /></>;
}
