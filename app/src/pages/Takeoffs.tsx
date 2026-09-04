// Takeoffs (owner spec + grill, 2026-08-18): the warehouse bundles a job's
// supplies for a named person. Foreman+ see every takeoff (the shared
// warehouse inbox — "warehouse manager" is a hat, not a rung); an installer
// sees the ones for them. Requests come from foremen; ready bundles can be
// for anyone.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../components/BackChip";
import { Explain } from "../components/ui/Explain";
import { formatApiError } from "../lib/errors";
import { pushToast } from "../lib/toast";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { isForemanPlus } from "../lib/install/types";
import { listProjects } from "../lib/api";
import { listProfiles } from "../lib/install/api";
import { listSupplies } from "../lib/ops";
import { sendPush } from "../lib/permissions/pushServer";
import { pickupTakeoffOffline, writeToast } from "../lib/warehouse/offlineWrites";
import { supabase } from "../lib/supabase";
import {
  acknowledgeTakeoff,
  createTakeoff,
  ETA_LABELS,
  listTakeoffs,
  readyTakeoff,
  shortageLines,
  TAKEOFF_STATUS_LABELS,
  takeoffStatusLine,
  type Takeoff,
  type TakeoffEta,
} from "../lib/takeoffs";

export function Takeoffs() {
  const qc = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  // ADR-0007: building a takeoff, answering one with a rough when, and
  // marking it ready are warehouse work — whoever is filling the bundle does
  // them, at any rank. `lead` survives for one thing only: handing a READY
  // bundle to somebody other than the person it was built for, which is the
  // warehouse acting on someone else's behalf, not warehouse work.
  const lead = isForemanPlus(effectiveRole);
  const takeoffs = useQuery({ queryKey: ["takeoffs"], queryFn: listTakeoffs });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const supplies = useQuery({ queryKey: ["supplies"], queryFn: listSupplies });
  const me = useQuery({
    queryKey: ["myId"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
  });

  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const jobCode = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.job_code])),
    [projects.data],
  );
  const personName = useMemo(
    () =>
      new Map(
        (profiles.data ?? []).map((p) => [p.id, p.display_name ?? p.id.slice(0, 8)]),
      ),
    [profiles.data],
  );
  const supplyById = useMemo(
    () => new Map((supplies.data ?? []).map((s) => [s.id, s])),
    [supplies.data],
  );
  const foremanIds = useMemo(
    () =>
      (profiles.data ?? [])
        .filter((p) => p.active && isForemanPlus(p.role))
        .map((p) => p.id),
    [profiles.data],
  );

  const refresh = () => void qc.invalidateQueries({ queryKey: ["takeoffs"] });

  const ack = useMutation({
    mutationFn: (input: { t: Takeoff; eta: TakeoffEta; note: string }) =>
      acknowledgeTakeoff({
        takeoffId: input.t.id,
        eta: input.eta,
        etaNote: input.note || null,
      }),
    onSuccess: (row, input) => {
      pushToast("Answered.");
      refresh();
      if (row.created_by) {
        void sendPush({
          profileIds: [row.created_by],
          title: `Takeoff for ${jobCode.get(row.project_id) ?? "your job"}: ${ETA_LABELS[input.eta]}`,
          body: input.note || "The warehouse has your list.",
          tag: `takeoff-${row.id}`,
          url: "/takeoffs",
        });
      }
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const ready = useMutation({
    mutationFn: (t: Takeoff) => readyTakeoff(t.id),
    onSuccess: (row) => {
      pushToast("Marked ready — they know.");
      refresh();
      if (row.for_profile_id) {
        void sendPush({
          profileIds: [row.for_profile_id],
          title: `Your takeoff for ${jobCode.get(row.project_id) ?? "your job"} is ready`,
          body: "Pick it up at the warehouse.",
          tag: `takeoff-${row.id}`,
          url: "/takeoffs",
        });
      }
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const pickup = useMutation({
    mutationFn: (t: Takeoff) => pickupTakeoffOffline(t.id),
    onSuccess: (r, t) => {
      pushToast(
        writeToast(r, "Picked up — the supplies are on the job's tab now."),
      );
      refresh();
      void qc.invalidateQueries({ queryKey: ["supplies"] });
      if (t.created_by && t.created_by !== me.data) {
        void sendPush({
          profileIds: [t.created_by],
          title: `Takeoff for ${jobCode.get(t.project_id) ?? "a job"} picked up`,
          tag: `takeoff-${t.id}`,
          url: "/takeoffs",
        });
      }
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const rows = takeoffs.data ?? [];
  const active = rows.filter((t) => t.status !== "picked_up");
  const done = rows.filter((t) => t.status === "picked_up").slice(0, 10);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip fallback="/warehouse" label="Warehouse" />
          <p className="home-greeting">Warehouse</p>
          <h1>Takeoffs</h1>
        </div>
      </header>
      <Explain id="wh-takeoffs">
        A takeoff is a job&rsquo;s supplies, bundled by the warehouse for a
        named person. Anyone on the crew can ask for one; whoever is filling
        it answers with a rough when, marks it ready, and picking it up logs
        every line against the job — pickup <em>is</em> the take.
      </Explain>

      <button
        className="button-like active-pill"
        style={{ marginBottom: 10 }}
        onClick={() => setCreating(true)}
      >
        New takeoff
      </button>

      <div className="home-projects">
        {active.map((t) => (
          <TakeoffRow
            key={t.id}
            t={t}
            open={open === t.id}
            onToggle={() => setOpen(open === t.id ? null : t.id)}
            jobCode={jobCode}
            personName={personName}
            supplyById={supplyById}
            lead={lead}
            meId={me.data ?? null}
            onAck={(eta, note) => ack.mutate({ t, eta, note })}
            onReady={() => ready.mutate(t)}
            onPickup={() => pickup.mutate(t)}
            busy={ack.isPending || ready.isPending || pickup.isPending}
          />
        ))}
        {active.length === 0 && (
          <p className="muted">Nothing waiting. New takeoffs land here.</p>
        )}
      </div>

      {done.length > 0 && (
        <>
          <h2>Picked up</h2>
          <div className="home-projects">
            {done.map((t) => (
              <TakeoffRow
                key={t.id}
                t={t}
                open={open === t.id}
                onToggle={() => setOpen(open === t.id ? null : t.id)}
                jobCode={jobCode}
                personName={personName}
                supplyById={supplyById}
                lead={lead}
                meId={me.data ?? null}
                onAck={() => {}}
                onReady={() => {}}
                onPickup={() => {}}
                busy
              />
            ))}
          </div>
        </>
      )}

      {creating && (
        <CreateTakeoffSheet
          onClose={() => setCreating(false)}
          onDone={(created, wasReady) => {
            setCreating(false);
            refresh();
            if (wasReady && created.for_profile_id) {
              void sendPush({
                profileIds: [created.for_profile_id],
                title: `Your takeoff for ${jobCode.get(created.project_id) ?? "your job"} is ready`,
                body: "Pick it up at the warehouse.",
                tag: `takeoff-${created.id}`,
                url: "/takeoffs",
              });
            } else if (!wasReady && foremanIds.length > 0) {
              void sendPush({
                profileIds: foremanIds,
                title: `Supply request — ${jobCode.get(created.project_id) ?? "a job"}`,
                body: "A foreman needs a takeoff built.",
                tag: `takeoff-${created.id}`,
                url: "/takeoffs",
              });
            }
          }}
        />
      )}
    </div>
  );
}

function TakeoffRow({
  t,
  open,
  onToggle,
  jobCode,
  personName,
  supplyById,
  lead,
  meId,
  onAck,
  onReady,
  onPickup,
  busy,
}: {
  t: Takeoff;
  open: boolean;
  onToggle: () => void;
  jobCode: Map<string, string>;
  personName: Map<string, string>;
  supplyById: Map<string, { name: string; unit: string; on_hand?: number | null }>;
  lead: boolean;
  meId: string | null;
  onAck: (eta: TakeoffEta, note: string) => void;
  onReady: () => void;
  onPickup: () => void;
  busy: boolean;
}) {
  const [eta, setEta] = useState<TakeoffEta>("today");
  const [etaNote, setEtaNote] = useState("");
  const items = t.takeoff_items ?? [];
  const shortages = shortageLines(
    items,
    [...supplyById.entries()].map(([id, s]) => ({ id, ...s }) as never),
  );
  const canPickup = t.status === "ready" && (t.for_profile_id === meId || lead);

  return (
    <div className="project-card home-project" style={{ cursor: "pointer" }}>
      <div className="home-project-head" onClick={onToggle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {jobCode.get(t.project_id) ?? "?"} · for{" "}
            {t.for_profile_id ? (personName.get(t.for_profile_id) ?? "?") : "?"}
            <span className="muted" style={{ fontWeight: 400 }}>
              {" "}· {items.length} line{items.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {takeoffStatusLine(t)}
          </div>
        </div>
        <span className="muted">{TAKEOFF_STATUS_LABELS[t.status]}</span>
      </div>

      {open && (
        <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          <ul className="unit-list" style={{ margin: 0 }}>
            {items.map((it) => (
              <li key={it.id} className="find-row">
                {supplyById.get(it.supply_id)?.name ?? "?"} ×{it.qty}{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                  {supplyById.get(it.supply_id)?.unit ?? ""}
                </span>
              </li>
            ))}
          </ul>
          {t.note && (
            <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
              {t.note}
            </p>
          )}
          {shortages.length > 0 && t.status !== "picked_up" && (
            <div className="wh-pending" style={{ marginTop: 6 }}>
              {shortages.map((line) => (
                <p key={line} style={{ margin: "2px 0", fontSize: 12.5 }}>
                  ⚠ {line}
                </p>
              ))}
            </div>
          )}

          {t.status === "requested" && (
            <div style={{ marginTop: 8 }}>
              <label className="field-label">Roughly when?</label>
              <div className="row-gap" style={{ flexWrap: "wrap" }}>
                {(Object.keys(ETA_LABELS) as TakeoffEta[]).map((k) => (
                  <button
                    key={k}
                    className={eta === k ? "button-like active-pill" : "button-like"}
                    onClick={() => setEta(k)}
                  >
                    {ETA_LABELS[k]}
                  </button>
                ))}
              </div>
              <input
                placeholder="note (optional) — e.g. waiting on the caulk order"
                value={etaNote}
                onChange={(e) => setEtaNote(e.target.value)}
                style={{ marginTop: 6 }}
              />
              <div className="row-gap" style={{ marginTop: 6 }}>
                <button className="button-like" disabled={busy} onClick={() => onAck(eta, etaNote)}>
                  Got it — send the when
                </button>
                <button className="button-like active-pill" disabled={busy} onClick={onReady}>
                  It&rsquo;s ready now
                </button>
              </div>
            </div>
          )}
          {t.status === "acknowledged" && (
            <button
              className="button-like active-pill"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={onReady}
            >
              Mark ready — tell them
            </button>
          )}
          {canPickup && (
            <button
              className="button-like active-pill"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={onPickup}
            >
              Picked up — put it on the job&rsquo;s tab
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CreateTakeoffSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (t: Takeoff, ready: boolean) => void;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const supplies = useQuery({ queryKey: ["supplies"], queryFn: listSupplies });
  const [projectId, setProjectId] = useState("");
  const [forId, setForId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<{ supply_id: string; qty: number }[]>([]);
  const [lineSupply, setLineSupply] = useState("");
  const [lineQty, setLineQty] = useState("1");

  const save = useMutation({
    mutationFn: (ready: boolean) =>
      createTakeoff({
        projectId,
        forProfileId: forId || null,
        items: lines,
        note: note || null,
        ready,
      }).then((t) => ({ t, ready })),
    onSuccess: ({ t, ready }) => {
      pushToast(ready ? "Takeoff ready — they know." : "Request sent to the warehouse.");
      onDone(t, ready);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const shortages = shortageLines(lines, supplies.data ?? []);
  const addLine = () => {
    const qty = Number(lineQty);
    if (!lineSupply || !Number.isFinite(qty) || qty <= 0) return;
    setLines((prev) => {
      const existing = prev.find((l) => l.supply_id === lineSupply);
      return existing
        ? prev.map((l) =>
            l.supply_id === lineSupply ? { ...l, qty: l.qty + qty } : l,
          )
        : [...prev, { supply_id: lineSupply, qty }];
    });
    setLineQty("1");
  };
  const supplyName = (id: string) =>
    (supplies.data ?? []).find((s) => s.id === id)?.name ?? "?";

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>New takeoff</p>
        <label className="field-label">Job</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Pick the job…</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code} — {p.name}
            </option>
          ))}
        </select>
        <label className="field-label">For</label>
        <select value={forId} onChange={(e) => setForId(e.target.value)}>
          <option value="">Myself</option>
          {(profiles.data ?? [])
            .filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name ?? p.id.slice(0, 8)}
              </option>
            ))}
        </select>
        <label className="field-label">Lines</label>
        <div className="row-gap">
          <select
            value={lineSupply}
            onChange={(e) => setLineSupply(e.target.value)}
            style={{ flex: 1 }}
          >
            <option value="">Pick a supply…</option>
            {(supplies.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            inputMode="numeric"
            value={lineQty}
            onChange={(e) => setLineQty(e.target.value)}
            style={{ width: 64, marginBottom: 0 }}
            aria-label="How many"
          />
          <button className="button-like" onClick={addLine}>
            Add
          </button>
        </div>
        <ul className="unit-list" style={{ margin: "6px 0 0" }}>
          {lines.map((l) => (
            <li key={l.supply_id} className="find-row">
              {supplyName(l.supply_id)} ×{l.qty}
              <button
                className="link"
                style={{ marginLeft: "auto" }}
                onClick={() =>
                  setLines((prev) => prev.filter((x) => x.supply_id !== l.supply_id))
                }
              >
                remove
              </button>
            </li>
          ))}
        </ul>
        {shortages.length > 0 && (
          <div className="wh-pending" style={{ marginTop: 6 }}>
            {shortages.map((line) => (
              <p key={line} style={{ margin: "2px 0", fontSize: 12.5 }}>
                ⚠ {line}
              </p>
            ))}
            <p className="muted" style={{ margin: "2px 0 0", fontSize: 12 }}>
              A warning, not a stop — short lines get filled when stock lands.
            </p>
          </div>
        )}
        <label className="field-label">Note (optional)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like"
            disabled={!projectId || lines.length === 0 || save.isPending}
            onClick={() => save.mutate(false)}
          >
            Request it
          </button>
          <button
            className="button-like active-pill"
            disabled={!projectId || lines.length === 0 || save.isPending}
            onClick={() => save.mutate(true)}
          >
            It&rsquo;s built — mark ready
          </button>
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
