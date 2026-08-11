// The talk library, Horizon's catalog idea: leads browse all 30 window-trade
// talks by category, preview one, and pin it to a date (tomorrow by default)
// — overriding the automatic weekday rotation for that day. Upcoming pins
// are listed with one-tap removal; with no pins the rotation just runs.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import {
  assignTalk,
  listLibraryTalks,
  listTalkAssignments,
  removeTalkAssignment,
  TALK_CATEGORY_LABELS,
  type LibraryTalk,
} from "../../lib/ops";

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function TalkLibrary() {
  const qc = useQueryClient();
  const [cat, setCat] = useState<string | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [assignDate, setAssignDate] = useState(tomorrowISO());

  const talks = useQuery({ queryKey: ["talkLibrary"], queryFn: listLibraryTalks });
  const assignments = useQuery({
    queryKey: ["talkAssignments"],
    queryFn: () => listTalkAssignments(todayISO()),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["talkAssignments"] });
    qc.invalidateQueries({ queryKey: ["todayTalk"] });
  };
  const assign = useMutation({
    mutationFn: (args: { libraryId: string; date: string }) =>
      assignTalk(args.libraryId, args.date),
    onSuccess: () => {
      setOpenSlug(null);
      refresh();
    },
  });
  const unassign = useMutation({
    mutationFn: removeTalkAssignment,
    onSuccess: refresh,
  });

  const list = useMemo(() => {
    const all = talks.data ?? [];
    return cat ? all.filter((t) => t.category === cat) : all;
  }, [talks.data, cat]);
  const bySlug = useMemo(
    () => new Map((talks.data ?? []).map((t) => [t.slug, t])),
    [talks.data],
  );
  const byId = useMemo(
    () => new Map((talks.data ?? []).map((t) => [t.id, t])),
    [talks.data],
  );
  const open: LibraryTalk | null = openSlug ? (bySlug.get(openSlug) ?? null) : null;

  if (talks.isError || (talks.data ?? []).length === 0) return null;

  return (
    <>
      <h2>Talk library</h2>
      <p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>
        The rotation picks a talk automatically — Monday lifting through Friday
        jobsite, weekends across the whole library. Pin one here to override a
        specific day.
      </p>

      {(assignments.data ?? []).length > 0 && (
        <ul className="unit-list" style={{ marginBottom: 8 }}>
          {(assignments.data ?? []).map((a) => (
            <li key={a.id} className="find-row">
              <div style={{ minWidth: 0 }}>
                <strong>{byId.get(a.library_id)?.title ?? "Talk"}</strong>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  pinned for{" "}
                  {new Date(`${a.assigned_date}T00:00:00`).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </div>
              </div>
              <button
                className="button-like"
                style={{ marginLeft: "auto" }}
                disabled={unassign.isPending}
                onClick={() => unassign.mutate(a.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="row-gap" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        <button
          className={cat === null ? "button-like active-pill" : "button-like"}
          onClick={() => setCat(null)}
        >
          All ({(talks.data ?? []).length})
        </button>
        {Object.entries(TALK_CATEGORY_LABELS).map(([key, label]) => (
          <button
            key={key}
            className={cat === key ? "button-like active-pill" : "button-like"}
            onClick={() => setCat(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <ul className="unit-list">
        {list.map((t) => (
          <li
            key={t.slug}
            className="find-row"
            style={{ cursor: "pointer" }}
            onClick={() => setOpenSlug(openSlug === t.slug ? null : t.slug)}
          >
            <div style={{ minWidth: 0 }}>
              <strong>{t.title}</strong>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {TALK_CATEGORY_LABELS[t.category] ?? t.category}
                {t.citation && ` · ${t.citation}`}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {open && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setOpenSlug(null)}
        >
          <div
            className="modal-card"
            style={{ maxHeight: "82vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{ margin: 0, fontWeight: 700 }}>{open.title}</p>
            <span className={`tbx-cat ${open.category}`}>
              {TALK_CATEGORY_LABELS[open.category] ?? open.category}
            </span>
            {open.briefing.split("\n\n").map((p, i) => (
              <p key={i} style={{ margin: "8px 0 0", lineHeight: 1.6, fontSize: 13 }}>{p}</p>
            ))}
            <div className="talk-section">
              <h4>Key points</h4>
              <ul className="talk-list tbx-points">
                {open.key_points.map((k, i) => <li key={i}>{k}</li>)}
              </ul>
            </div>
            {open.watch_for.length > 0 && (
              <div className="tbx-callout warn">
                <h4>Watch for</h4>
                <ul className="talk-list">
                  {open.watch_for.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
            {open.stop_work_line && (
              <div className="tbx-callout stop">
                <h4>Stop work</h4>
                <p style={{ margin: 0 }}>{open.stop_work_line}</p>
              </div>
            )}
            <label className="field-label">Run this talk on</label>
            <input
              type="date"
              value={assignDate}
              min={todayISO()}
              onChange={(e) => setAssignDate(e.target.value)}
            />
            {assign.isError && (
              <p className="error">{formatApiError(assign.error)}</p>
            )}
            <div className="row-gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
              <button
                className="button-like active-pill"
                disabled={assign.isPending || !assignDate}
                onClick={() => assign.mutate({ libraryId: open.id, date: assignDate })}
              >
                {assign.isPending ? "Pinning…" : "Pin to this day"}
              </button>
              <button className="button-like" onClick={() => setOpenSlug(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
