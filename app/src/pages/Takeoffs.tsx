// Takeoffs (owner spec + grill, 2026-08-18): the warehouse bundles a job's
// supplies for a named person. "Warehouse manager" is a hat, not a rung —
// and since ADR-0007 (2026-09-04) that is true of the whole screen: every
// crew member sees the shared warehouse inbox, asks for a bundle, answers a
// request with a rough when, and marks one ready. The one thing still keyed
// to a rank is handing a READY bundle to somebody other than the person it
// was built for.

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
  ETA_ORDER,
  etaLabel,
  listTakeoffs,
  readyTakeoff,
  shortageLines,
  takeoffStatusLabel,
  takeoffStatusLine,
  type Takeoff,
  type TakeoffEta,
} from "../lib/takeoffs";
import { useT } from "../lib/i18n";

export function Takeoffs() {
  const t = useT();
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
    // Pushes here and below render in the CALLER's language, not necessarily
    // the recipient's — same gap as the timecard revert push (TimecardPanel).
    onSuccess: (row, input) => {
      pushToast(t("takeoffs.answered"));
      refresh();
      if (row.created_by) {
        void sendPush({
          profileIds: [row.created_by],
          title: t("takeoffs.push.answeredTitle", {
            job: jobCode.get(row.project_id) ?? t("takeoffs.yourJob"),
            eta: etaLabel(input.eta, t),
          }),
          body: input.note || t("takeoffs.push.answeredBody"),
          tag: `takeoff-${row.id}`,
          url: "/takeoffs",
        });
      }
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const ready = useMutation({
    mutationFn: (row: Takeoff) => readyTakeoff(row.id),
    onSuccess: (row) => {
      pushToast(t("takeoffs.markedReady"));
      refresh();
      if (row.for_profile_id) {
        void sendPush({
          profileIds: [row.for_profile_id],
          title: t("takeoffs.push.readyTitle", { job: jobCode.get(row.project_id) ?? t("takeoffs.yourJob") }),
          body: t("takeoffs.push.readyBody"),
          tag: `takeoff-${row.id}`,
          url: "/takeoffs",
        });
      }
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const pickup = useMutation({
    mutationFn: (row: Takeoff) => pickupTakeoffOffline(row.id),
    onSuccess: (r, row) => {
      pushToast(
        writeToast(r, t("takeoffs.pickedUpToast")),
      );
      refresh();
      void qc.invalidateQueries({ queryKey: ["supplies"] });
      if (row.created_by && row.created_by !== me.data) {
        void sendPush({
          profileIds: [row.created_by],
          title: t("takeoffs.push.pickedUpTitle", { job: jobCode.get(row.project_id) ?? t("takeoffs.aJob") }),
          tag: `takeoff-${row.id}`,
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
          <BackChip fallback="/warehouse" label={t("takeoffs.warehouse")} />
          <p className="home-greeting">{t("takeoffs.warehouse")}</p>
          <h1>{t("takeoffs.title")}</h1>
        </div>
      </header>
      <Explain id="wh-takeoffs">
        {t("takeoffs.explain")}
      </Explain>

      <button
        className="button-like active-pill"
        style={{ marginBottom: 10 }}
        onClick={() => setCreating(true)}
      >
        {t("takeoffs.newTakeoff")}
      </button>

      <div className="home-projects">
        {active.map((row) => (
          <TakeoffRow
            key={row.id}
            t={row}
            open={open === row.id}
            onToggle={() => setOpen(open === row.id ? null : row.id)}
            jobCode={jobCode}
            personName={personName}
            supplyById={supplyById}
            lead={lead}
            meId={me.data ?? null}
            onAck={(eta, note) => ack.mutate({ t: row, eta, note })}
            onReady={() => ready.mutate(row)}
            onPickup={() => pickup.mutate(row)}
            busy={ack.isPending || ready.isPending || pickup.isPending}
          />
        ))}
        {active.length === 0 && (
          <p className="muted">{t("takeoffs.nothingWaiting")}</p>
        )}
      </div>

      {done.length > 0 && (
        <>
          <h2>{t("takeoffs.pickedUpHeading")}</h2>
          <div className="home-projects">
            {done.map((row) => (
              <TakeoffRow
                key={row.id}
                t={row}
                open={open === row.id}
                onToggle={() => setOpen(open === row.id ? null : row.id)}
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
                title: t("takeoffs.push.readyTitle", { job: jobCode.get(created.project_id) ?? t("takeoffs.yourJob") }),
                body: t("takeoffs.push.readyBody"),
                tag: `takeoff-${created.id}`,
                url: "/takeoffs",
              });
            } else if (!wasReady && foremanIds.length > 0) {
              void sendPush({
                profileIds: foremanIds,
                title: t("takeoffs.push.requestTitle", { job: jobCode.get(created.project_id) ?? t("takeoffs.aJob") }),
                // Not "a foreman" any more: anyone on the crew can ask.
                body: t("takeoffs.push.requestBody"),
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
  const tr = useT();
  const [eta, setEta] = useState<TakeoffEta>("today");
  const [etaNote, setEtaNote] = useState("");
  const items = t.takeoff_items ?? [];
  const shortages = shortageLines(
    items,
    [...supplyById.entries()].map(([id, s]) => ({ id, ...s }) as never),
    tr,
  );
  const canPickup = t.status === "ready" && (t.for_profile_id === meId || lead);

  return (
    <div className="project-card home-project" style={{ cursor: "pointer" }}>
      <div className="home-project-head" onClick={onToggle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {tr("takeoffs.jobFor", {
              job: jobCode.get(t.project_id) ?? "?",
              name: t.for_profile_id ? (personName.get(t.for_profile_id) ?? "?") : "?",
            })}
            <span className="muted" style={{ fontWeight: 400 }}>
              {" "}·{" "}
              {items.length === 1
                ? tr("takeoffs.lineCount.one")
                : tr("takeoffs.lineCount.many", { count: items.length })}
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {takeoffStatusLine(t, tr)}
          </div>
        </div>
        <span className="muted">{takeoffStatusLabel(t.status, tr)}</span>
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
              <label className="field-label">{tr("takeoffs.roughlyWhen")}</label>
              <div className="row-gap" style={{ flexWrap: "wrap" }}>
                {ETA_ORDER.map((k) => (
                  <button
                    key={k}
                    className={eta === k ? "button-like active-pill" : "button-like"}
                    onClick={() => setEta(k)}
                  >
                    {etaLabel(k, tr)}
                  </button>
                ))}
              </div>
              <input
                placeholder={tr("takeoffs.etaNotePlaceholder")}
                value={etaNote}
                onChange={(e) => setEtaNote(e.target.value)}
                style={{ marginTop: 6 }}
              />
              <div className="row-gap" style={{ marginTop: 6 }}>
                <button className="button-like" disabled={busy} onClick={() => onAck(eta, etaNote)}>
                  {tr("takeoffs.gotItSendWhen")}
                </button>
                <button className="button-like active-pill" disabled={busy} onClick={onReady}>
                  {tr("takeoffs.readyNow")}
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
              {tr("takeoffs.markReadyTellThem")}
            </button>
          )}
          {canPickup && (
            <button
              className="button-like active-pill"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={onPickup}
            >
              {tr("takeoffs.pickedUpPutOnTab")}
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
  const t = useT();
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
    onSuccess: ({ t: created, ready }) => {
      pushToast(ready ? t("takeoffs.readyTheyKnow") : t("takeoffs.requestSent"));
      onDone(created, ready);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const shortages = shortageLines(lines, supplies.data ?? [], t);
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
        <p style={{ margin: 0, fontWeight: 700 }}>{t("takeoffs.newTakeoff")}</p>
        <label className="field-label">{t("takeoffs.job")}</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{t("takeoffs.pickTheJob")}</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code} — {p.name}
            </option>
          ))}
        </select>
        <label className="field-label">{t("takeoffs.for")}</label>
        <select value={forId} onChange={(e) => setForId(e.target.value)}>
          <option value="">{t("takeoffs.myself")}</option>
          {(profiles.data ?? [])
            .filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name ?? p.id.slice(0, 8)}
              </option>
            ))}
        </select>
        <label className="field-label">{t("takeoffs.lines")}</label>
        <div className="row-gap">
          <select
            value={lineSupply}
            onChange={(e) => setLineSupply(e.target.value)}
            style={{ flex: 1 }}
          >
            <option value="">{t("takeoffs.pickASupply")}</option>
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
            aria-label={t("takeoffs.howMany")}
          />
          <button className="button-like" onClick={addLine}>
            {t("takeoffs.add")}
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
                {t("takeoffs.remove")}
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
              {t("takeoffs.warningNotStop")}
            </p>
          </div>
        )}
        <label className="field-label">{t("takeoffs.noteOptional")}</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like"
            disabled={!projectId || lines.length === 0 || save.isPending}
            onClick={() => save.mutate(false)}
          >
            {t("takeoffs.requestIt")}
          </button>
          <button
            className="button-like active-pill"
            disabled={!projectId || lines.length === 0 || save.isPending}
            onClick={() => save.mutate(true)}
          >
            {t("takeoffs.itsBuiltMarkReady")}
          </button>
          <button className="button-like" onClick={onClose}>
            {t("takeoffs.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
