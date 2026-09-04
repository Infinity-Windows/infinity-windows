// Supplies: where it lives, how many we think we have, take what you need
// (warehouse ticket 07 — grill Q8/Q9/Q25, owner-confirmed).
//
// The page leads with what an installer came for: find the caulk, see the
// home spot, tap Take, say how many and which job — three taps, never a
// pull list in the way. The count is always an estimate and always says so
// ("about 140 · last counted Aug 3" — onHandLabel enforces the pairing).
// Counting the shelf corrects it. The old per-job pull list survives below
// as REQUEST — a foreman planning ahead — and a take that matches a request
// ticks it off server-side.

import { BackChip } from "../components/BackChip";
import { Explain } from "../components/ui/Explain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { listLocations, listProjects } from "../lib/api";
import { containerKind, listContainers } from "../lib/storage";
import { formatApiError } from "../lib/errors";
import { pushToast } from "../lib/toast";
import { takeSupplyOffline, writeToast } from "../lib/warehouse/offlineWrites";
import {
  addOrder,
  addSupply,
  countSupply,
  filterSuppliesByName,
  listOrders,
  listSupplies,
  listSupplyTakes,
  onHandLabel,
  setOrderStatus,
  setSupplyHome,
  supplyHomeLabel,
  type Supply,
  type SupplyTake,
} from "../lib/ops";

const STATUSES = ["needed", "ordered", "picked", "used"];

/**
 * The units the catalog already speaks (ticket D7).
 *
 * "ea" is the supplies table's own default; the rest are the units the catalog
 * was seeded with — roll, can, bundle, tube, bag. A short list covers nearly
 * every add, and "other" keeps it from being a cage: the unit is just the word
 * the crew reads on the shelf, and the shelf occasionally has a word we did
 * not think of.
 */
export const SUPPLY_UNIT_PRESETS = [
  "ea",
  "roll",
  "tube",
  "bag",
  "bundle",
  "can",
] as const;

/** What actually gets saved: the preset, or the typed-in word behind "other". */
export function resolveNewSupplyUnit(preset: string, other: string): string {
  return preset === "other" ? other.trim() : preset;
}

/** "Other" with nothing typed is the only way to end up with no unit at all. */
export function newSupplyUnitInvalid(preset: string, other: string): boolean {
  return preset === "other" && other.trim().length === 0;
}

// Same key the tag screen uses: one muscle memory for "which job am I on".
const LAST_JOB_KEY = "infinity.storage.lastJob";

export function Supplies() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const supplies = useQuery({ queryKey: ["supplies"], queryFn: listSupplies });
  const locations = useQuery({ queryKey: ["locations"], queryFn: listLocations });
  // Deep-link from a job hub ("Supplies for this job") preselects that job.
  const [proj, setProj] = useState(searchParams.get("job") ?? "");
  const [supplyId, setSupplyId] = useState("");
  const [qty, setQty] = useState("1");
  // The shelf search (owner ask, 2026-08-18): the full catalog stays one
  // list, typing narrows it by name. Order stays as the API gives it (by
  // name), so the shelf reads like the shelf.
  const [shelfQ, setShelfQ] = useState("");
  const shelf = filterSuppliesByName(supplies.data ?? [], shelfQ);
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState<string>(SUPPLY_UNIT_PRESETS[0]);
  const [newUnitOther, setNewUnitOther] = useState("");
  const [taking, setTaking] = useState<Supply | null>(null);
  const [counting, setCounting] = useState<Supply | null>(null);
  const [homing, setHoming] = useState<Supply | null>(null);
  const [viewingHistory, setViewingHistory] = useState<Supply | null>(null);

  const containersQ = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const containerName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of containersQ.data ?? []) m.set(c.id, c.name);
    return m;
  }, [containersQ.data]);
  const locationAddress = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of locations.data ?? []) m.set(l.id, l.address);
    return m;
  }, [locations.data]);

  const orders = useQuery({
    queryKey: ["orders", proj],
    queryFn: () => listOrders(proj),
    enabled: Boolean(proj),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["orders", proj] });
  const refreshSupplies = () =>
    queryClient.invalidateQueries({ queryKey: ["supplies"] });
  const add = useMutation({
    mutationFn: () => addOrder(proj, supplyId, Number(qty) || 1),
    onSuccess: () => { setQty("1"); refresh(); },
  });
  const addCat = useMutation({
    mutationFn: () => addSupply(newName, resolveNewSupplyUnit(newUnit, newUnitOther)),
    onSuccess: () => {
      setNewName("");
      setNewUnit(SUPPLY_UNIT_PRESETS[0]);
      setNewUnitOther("");
      void refreshSupplies();
    },
  });
  const setStatus = useMutation({
    mutationFn: (a: { id: string; status: string }) => setOrderStatus(a.id, a.status),
    onSuccess: refresh,
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Supplies</h1>
          <p className="muted" style={{ margin: 0 }}>
            Find it, take it, log it — three taps.
          </p>
        </div>
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>

      <Explain id="supplies-how">
        Every supply has one home spot, so you always know where to go. Tap Take,
        say how many and which job — that&rsquo;s the whole log. The count is an
        estimate, not a promise: it drops when people take, and counting the shelf
        is what sets it right. Foremen can still request material for a job ahead
        of time under Request, and a take that matches a request ticks it off on
        its own.
      </Explain>

      <h2>On the shelf</h2>
      {supplies.isError && <p className="error">{formatApiError(supplies.error)}</p>}
      <input
        type="search"
        placeholder="Search supplies — caulk, screws…"
        value={shelfQ}
        onChange={(e) => setShelfQ(e.target.value)}
        style={{ width: "100%", margin: "0 0 8px" }}
        aria-label="Search supplies"
      />
      <ul className="unit-list" style={{ margin: 0 }}>
        {shelf.map((s) => (
          <li key={s.id} className="find-row" style={{ alignItems: "center", gap: 10 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong>{s.name}</strong>{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                {supplyHomeLabel(s, containerName, locationAddress)}
                {" · "}
                {onHandLabel(s)}
              </span>
            </div>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
              <button
                className="button-like active-pill"
                onClick={() => setTaking(s)}
              >
                Take
              </button>
              <button className="button-like" onClick={() => setCounting(s)}>
                Count
              </button>
              {/* ADR-0007: a home spot is "where the caulk lives" — the
                  person who put it there is the one who knows. */}
              <button className="button-like" onClick={() => setHoming(s)}>
                Home
              </button>
              <button className="button-like" onClick={() => setViewingHistory(s)}>
                History
              </button>
            </div>
          </li>
        ))}
        {shelf.length === 0 &&
          (shelfQ.trim() ? (
            <p className="muted">Nothing named like &ldquo;{shelfQ.trim()}&rdquo;.</p>
          ) : (
            <p className="muted">Nothing in the catalog yet — add supplies below.</p>
          ))}
      </ul>

      <h2>Request for a job (ahead of time)</h2>
      <div className="job-chip-row">
        {(projects.data ?? []).map((p) => (
          <button
            key={p.id}
            type="button"
            className={proj === p.id ? "job-chip active" : "job-chip"}
            onClick={() => setProj(p.id)}
          >
            {p.job_code}
          </button>
        ))}
      </div>

      {proj && (
        <>
          <div className="detail-card">
            <label className="field-label">Add to the request list</label>
            <select value={supplyId} onChange={(e) => setSupplyId(e.target.value)}>
              <option value="">— supply —</option>
              {(supplies.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" />
            <button className="action-btn primary" disabled={add.isPending || !supplyId} onClick={() => add.mutate()}>
              Add to job
            </button>
          </div>

          <h2>Requested</h2>
          <ul className="unit-list work-list">
            {(orders.data ?? []).map((o) => (
              <li key={o.id} className="find-row">
                <div>
                  <strong>{o.supplies?.name ?? o.name}</strong>{" "}
                  <span className="muted">×{o.qty}</span>
                </div>
                <select
                  style={{ marginLeft: "auto", maxWidth: 130, marginBottom: 0 }}
                  value={o.status}
                  onChange={(e) => setStatus.mutate({ id: o.id, status: e.target.value })}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </li>
            ))}
            {orders.data?.length === 0 && <p className="muted">Nothing requested yet.</p>}
          </ul>
        </>
      )}

      {/* ADR-0007: the catalog opens too. The company's official supply
          list stays a list, not a scratchpad, because add_supply already
          folds "Caulk", "caulk" and "CAULK" into one row — the duplicate
          guard is what protects the list, not the rank that used to sit
          in front of it. */}
      <h2>Add to catalog</h2>
      <div className="detail-card">
        {/* The unit is asked for here or it is wrong forever: there is no
            screen that edits it afterwards, and it is the word every
            installer reads on the Take form ("How many (roll)"). */}
        <div className="manual-entry" style={{ flexWrap: "wrap" }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New supply type" />
          <select
            aria-label="Unit"
            value={newUnit}
            style={{ marginBottom: 0 }}
            onChange={(e) => setNewUnit(e.target.value)}
          >
            {SUPPLY_UNIT_PRESETS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
            <option value="other">other…</option>
          </select>
          {newUnit === "other" && (
            <input
              aria-label="Other unit"
              value={newUnitOther}
              style={{ marginBottom: 0 }}
              placeholder="spool, sheet, box…"
              onChange={(e) => setNewUnitOther(e.target.value)}
            />
          )}
          <button
            className="primary"
            disabled={
              addCat.isPending ||
              !newName.trim() ||
              newSupplyUnitInvalid(newUnit, newUnitOther)
            }
            onClick={() => addCat.mutate()}
          >
            Add
          </button>
        </div>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
          How it is counted on the shelf — a roll of tape, a tube of
          sealant. Pick <em>other…</em> to type your own.
        </p>
      </div>

      {taking && (
        <TakeForm
          supply={taking}
          onClose={() => setTaking(null)}
          onDone={() => {
            setTaking(null);
            void refreshSupplies();
            refresh();
          }}
        />
      )}
      {counting && (
        <CountForm
          supply={counting}
          onClose={() => setCounting(null)}
          onDone={() => {
            setCounting(null);
            void refreshSupplies();
          }}
        />
      )}
      {homing && (
        <HomeForm
          supply={homing}
          onClose={() => setHoming(null)}
          onDone={() => {
            setHoming(null);
            void refreshSupplies();
          }}
        />
      )}
      {viewingHistory && (
        <HistoryForm supply={viewingHistory} onClose={() => setViewingHistory(null)} />
      )}
    </div>
  );
}

/** Take: how many, which job, go — the three taps. Job defaults to the last
 * one used anywhere in the warehouse, same key as tagging. */
function TakeForm({
  supply,
  onClose,
  onDone,
}: {
  supply: Supply;
  onClose: () => void;
  onDone: () => void;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [projectId, setProjectId] = useState<string>(
    () => localStorage.getItem(LAST_JOB_KEY) ?? "",
  );
  const [qty, setQty] = useState("1");
  const n = Number(qty);
  const invalid = !Number.isFinite(n) || n <= 0;

  // The remembered job may have finished since it was stored. It then drops
  // out of the dropdown while STAYING selected behind the scenes, so the
  // picker looks blank, Take stays live, and the material lands on a closed
  // job's costs. Same guard the tag-packages screen already carries.
  useEffect(() => {
    if (!projectId) return;
    const list = projects.data;
    if (!list) return;
    if (!list.some((p) => p.id === projectId)) setProjectId("");
  }, [projects.data, projectId]);

  const take = useMutation({
    mutationFn: () => takeSupplyOffline({ supplyId: supply.id, projectId, qty: n }),
    onSuccess: (r) => {
      localStorage.setItem(LAST_JOB_KEY, projectId);
      // Offline the server never answered, so there is no corrected count to
      // quote — say what was taken and be honest about where it got to.
      pushToast(writeToast(r, `Took ${n} ${supply.name}.`));
      onDone();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>Take {supply.name}</p>
        <label className="field-label">How many ({supply.unit})</label>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          autoFocus
        />
        <label className="field-label">For which job</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Pick the job…</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code} — {p.name}
            </option>
          ))}
        </select>
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like active-pill"
            disabled={invalid || !projectId || take.isPending}
            onClick={() => take.mutate()}
          >
            {take.isPending ? "Logging…" : "Take it"}
          </button>
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Count: what's actually on the shelf right now. Sets the estimate and its
 * date in one move — the correction the running number lives on. */
function CountForm({
  supply,
  onClose,
  onDone,
}: {
  supply: Supply;
  onClose: () => void;
  onDone: () => void;
}) {
  const [counted, setCounted] = useState(
    supply.on_hand != null ? String(supply.on_hand) : "",
  );
  const n = Number(counted);
  const invalid = counted.trim() === "" || !Number.isFinite(n) || n < 0;

  const count = useMutation({
    mutationFn: () => countSupply(supply.id, n),
    onSuccess: () => {
      pushToast(`${supply.name}: counted ${n}.`);
      onDone();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>Count {supply.name}</p>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
          What&rsquo;s physically on the shelf right now. This replaces the
          estimate — it doesn&rsquo;t add to it.
        </p>
        <label className="field-label">Counted ({supply.unit})</label>
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          autoFocus
        />
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like active-pill"
            disabled={invalid || count.isPending}
            onClick={() => count.mutate()}
          >
            {count.isPending ? "Saving…" : "Save count"}
          </button>
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Home: the one spot this supply lives (foreman+ — it's the answer the app
 * gives an installer, so somebody accountable sets it). */
function HomeForm({
  supply,
  onClose,
  onDone,
}: {
  supply: Supply;
  onClose: () => void;
  onDone: () => void;
}) {
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const [containerId, setContainerId] = useState(supply.home_container_id ?? "");
  const [note, setNote] = useState(supply.home_note ?? "");

  const save = useMutation({
    mutationFn: () =>
      setSupplyHome({
        supplyId: supply.id,
        containerId: containerId || null,
        note: note || null,
      }),
    onSuccess: () => {
      pushToast(`${supply.name} lives at its new spot.`);
      onDone();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>Where does {supply.name} live?</p>
        <label className="field-label">Which box</label>
        {/* The same crates, conexes and warehouse packages live in — one set
            of places for everything (owner ask, 2026-08-18). Slots come when
            the reorganization wakes them. */}
        <select value={containerId} onChange={(e) => setContainerId(e.target.value)}>
          <option value="">— nowhere yet —</option>
          {(containers.data ?? [])
            .filter((c) => c.active)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {containerKind(c) !== "conex" ? ` (${containerKind(c)})` : ""}
              </option>
            ))}
        </select>
        <label className="field-label">Where in it (optional)</label>
        <input
          placeholder="e.g. north wall, blue bins"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like active-pill"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** History: once a supply leaves the stores, the owner wants to know who
 * took it and where it went — read-only, nothing to save here. */
function HistoryForm({ supply, onClose }: { supply: Supply; onClose: () => void }) {
  // Same queryKey the rest of the page already fetches projects under, so
  // this rides the existing cache instead of firing a second network call.
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const takes = useQuery({
    queryKey: ["supply-takes", supply.id],
    queryFn: () => listSupplyTakes(supply.id),
  });
  const jobCode = (id: string | null) =>
    (projects.data ?? []).find((p) => p.id === id)?.job_code ?? "no job on file";
  const takeLine = (t: SupplyTake) => {
    const when = new Date(t.created_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    return `${t.actor_name ?? t.actor} took ${t.qty ?? "?"} · ${jobCode(t.project_id)} · ${when}`;
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>{supply.name}: who took it</p>
        {takes.isError && <p className="error">{formatApiError(takes.error)}</p>}
        <ul className="unit-list" style={{ margin: "8px 0 0" }}>
          {(takes.data ?? []).map((t) => (
            <li key={t.id} className="find-row">
              <span>{takeLine(t)}</span>
            </li>
          ))}
        </ul>
        {takes.data?.length === 0 && <p className="muted">Nothing taken yet.</p>}
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button className="button-like" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
