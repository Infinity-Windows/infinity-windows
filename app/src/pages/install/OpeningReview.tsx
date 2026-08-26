import { BackChip } from "../../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects } from "../../lib/api";
import { WindowTypePicker } from "../../components/WindowTypePicker";
import { SpecReviewSection } from "../../components/install/SpecReviewSection";
import { ConfirmDanger } from "../../components/ConfirmDanger";
import {
  addOpening,
  confirmOpenings,
  listMarkSpecs,
  listOpenings,
  listRemovedOpenings,
  openingsReferencedElsewhere,
  removeOpening,
  restoreOpening,
  updateOpening,
} from "../../lib/install/api";
import { describeOpeningDeletion } from "../../lib/install/openingAccess";
import type { ProjectOpening } from "../../lib/install/types";
import { openingMarkCode } from "../../lib/install/types";
import { openingUnitKindResolver } from "../../lib/install/unitKind";
import { describeMarkCount } from "../../lib/install/extract";
import { formatApiError } from "../../lib/install/errors";

export function OpeningReview() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [newCode, setNewCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Pick 10: one danger-confirm pattern app-wide. A single remove needs an
  // async "is this referenced elsewhere" check before the confirm card can
  // even say what will happen, so the card's text is computed once (while
  // "Checking…" shows) and held here rather than recomputed per render.
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [checkingRemoveId, setCheckingRemoveId] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });
  const markSpecs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    enabled: !!projectId,
  });

  const removed = useQuery({
    queryKey: ["removedOpenings", projectId],
    queryFn: () => listRemovedOpenings(projectId),
    enabled: !!projectId,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    queryClient.invalidateQueries({ queryKey: ["projectWindows", projectId] });
    queryClient.invalidateQueries({ queryKey: ["removedOpenings", projectId] });
  };

  const patch = useMutation({
    mutationFn: (args: { id: string; patch: Parameters<typeof updateOpening>[1] }) =>
      updateOpening(args.id, args.patch),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeOpening(id),
    onSuccess: () => {
      setConfirmRemove(null);
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Bulk removal for extraction mistakes: N wrong marks go in one confirmed
  // sweep instead of N taps. Same RPC, same guards, same Removed list — a
  // mark that refuses (installed, holding a unit) is reported, not forced.
  const bulkRemove = useMutation({
    mutationFn: async (ids: string[]) => {
      const failed: { code: string; err: string }[] = [];
      let done = 0;
      for (const id of ids) {
        const o = (openings.data ?? []).find((x) => x.id === id);
        try {
          await removeOpening(id, "removed in a sweep from the review screen");
          done += 1;
        } catch (e) {
          failed.push({ code: o?.opening_code ?? id, err: formatApiError(e) });
        }
      }
      return { done, failed };
    },
    onSuccess: (r) => {
      refresh();
      setSelecting(false);
      setSelected(new Set());
      setConfirmBulk(false);
      setMessage(
        r.failed.length === 0
          ? `Removed ${r.done} opening${r.done === 1 ? "" : "s"}. They're under Removed below if you need them back.`
          : `Removed ${r.done}. Couldn't remove ${r.failed
              .map((f) => `#${f.code} — ${f.err}`)
              .join("; ")}`,
      );
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Pick 10: the trigger button only opens the confirm card now — the sweep
  // itself fires from ConfirmDanger's own confirm button, below.
  const askThenBulkRemove = () => {
    if (selected.size === 0) return;
    setConfirmBulk(true);
  };

  const putBack = useMutation({
    mutationFn: restoreOpening,
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Removing an opening now HIDES it — its install history, assignment,
  // measurements and flags go with it and all of it comes back from Removed
  // below. The question still names what is going, because removing a
  // duplicate the extract invented and removing a window someone has already
  // worked on are the same two taps.
  const askThenRemove = async (o: ProjectOpening) => {
    setMessage(null);
    setCheckingRemoveId(o.id);
    let referenced = false;
    try {
      referenced = (await openingsReferencedElsewhere([o.id])).has(o.id);
    } catch {
      // Can't see what it's linked to — say so in the question rather than
      // quietly promising the mark is safe to drop.
      referenced = o.status !== "planned";
    }
    setCheckingRemoveId(null);
    setConfirmRemove({
      id: o.id,
      text: describeOpeningDeletion({
        opening: o,
        referencedElsewhere: referenced,
        jobLabel: project?.job_code ?? null,
      }),
    });
  };

  const add = useMutation({
    mutationFn: (code: string) =>
      addOpening(projectId, { opening_code: code.toUpperCase() }),
    onSuccess: () => {
      setNewCode("");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const confirm = useMutation({
    mutationFn: () => confirmOpenings(projectId),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["projectWindows", projectId] });
      navigate(`/projects/${projectId}?tab=map`);
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const drafts = (openings.data ?? []).filter((o) => !o.confirmed);
  const confirmed = (openings.data ?? []).filter((o) => o.confirmed);

  const markSummary = (() => {
    const unitKind = openingUnitKindResolver(markSpecs.data ?? []);
    const map = new Map<string, { mark: string; count: number; door: boolean }>();
    for (const o of drafts) {
      const mark = openingMarkCode(o.opening_code);
      const door = unitKind(o) === "door";
      const key = `${door ? "d" : "w"}:${mark}`;
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { mark, count: 1, door });
    }
    return [...map.values()].sort((a, b) => a.mark.localeCompare(b.mark));
  })();

  const row = (o: ProjectOpening) => (
    <li key={o.id} className="opening-review-row">
      {selecting && o.status === "planned" && (
        <input
          type="checkbox"
          checked={selected.has(o.id)}
          onChange={() => toggleSelected(o.id)}
          aria-label={`Select #${o.opening_code}`}
        />
      )}
      <input
        className="opening-code-input"
        defaultValue={o.opening_code}
        onBlur={(e) => {
          const v = e.target.value.trim().toUpperCase();
          if (v && v !== o.opening_code) {
            patch.mutate({ id: o.id, patch: { opening_code: v } });
          }
        }}
      />
      <WindowTypePicker
        variant="select"
        value={o.window_type_id ?? null}
        onChange={(id) =>
          patch.mutate({
            id: o.id,
            patch: { window_type_id: id || null },
          })
        }
      />
      <input
        placeholder="Location (e.g. Living room N)"
        defaultValue={o.label ?? ""}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== (o.label ?? "")) {
            patch.mutate({ id: o.id, patch: { label: v || null } });
          }
        }}
      />
      {o.status === "planned" && confirmRemove?.id !== o.id && (
        <button
          className="link"
          disabled={checkingRemoveId === o.id}
          onClick={() => void askThenRemove(o)}
        >
          {checkingRemoveId === o.id ? "Checking…" : "Remove"}
        </button>
      )}
      {confirmRemove?.id === o.id && (
        <ConfirmDanger
          confirmText={remove.isPending ? "Removing…" : "Remove"}
          disabled={remove.isPending}
          onConfirm={() => remove.mutate(o.id)}
          onCancel={() => setConfirmRemove(null)}
        >
          {confirmRemove.text}
        </ConfirmDanger>
      )}
    </li>
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Openings</p>
          <h1>{project?.job_code ?? "Review"}</h1>
        </div>
        <BackChip fallback={`/projects/${projectId}?tab=map`} label="Map" />
      </header>

      {message && <p className="error">{message}</p>}

      {(openings.data ?? []).some((o) => o.status === "planned") && (
        <div className="bulk-remove-bar">
          {!selecting ? (
            <button
              className="link"
              onClick={() => {
                setSelecting(true);
                setSelected(new Set());
              }}
            >
              Remove several…
            </button>
          ) : confirmBulk ? (
            <div style={{ flex: "1 1 100%" }}>
              <ConfirmDanger
                confirmText={bulkRemove.isPending ? "Removing…" : "Remove"}
                disabled={bulkRemove.isPending}
                onConfirm={() => bulkRemove.mutate([...selected])}
                onCancel={() => setConfirmBulk(false)}
              >
                Remove {selected.size} opening{selected.size === 1 ? "" : "s"} from
                this job? Nothing is deleted — they move to Removed below and can be
                put back.
              </ConfirmDanger>
            </div>
          ) : (
            <>
              <button
                className="link"
                onClick={() =>
                  setSelected(
                    new Set(
                      (openings.data ?? [])
                        .filter((o) => o.status === "planned")
                        .map((o) => o.id),
                    ),
                  )
                }
              >
                Select all
              </button>
              <button
                className="link"
                onClick={() => {
                  setSelecting(false);
                  setSelected(new Set());
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={selected.size === 0}
                onClick={askThenBulkRemove}
              >
                {`Remove ${selected.size} selected`}
              </button>
            </>
          )}
        </div>
      )}

      {drafts.length > 0 && (
        <>
          <h2>Extracted drafts ({drafts.length}) — confirm before install</h2>
          {markSummary.length > 0 && (
            <p className="scanner-hint">
              We found{" "}
              {markSummary
                .map((m) =>
                  describeMarkCount({
                    mark: m.mark,
                    count: m.count,
                    kind: m.door ? "door" : "window",
                  }),
                )
                .join(", ")}{" "}
              — accept or fix below.
            </p>
          )}
          <p className="muted">
            Fix codes and types where the extract got it wrong. Confirmed
            openings are never overwritten by a re-extract. A mark is the number
            written on the plan beside a type of window — mark #14 appearing 25
            times means 25 separate windows, all the same.
          </p>
          <ul className="unit-list">{drafts.map(row)}</ul>
          <button
            className="primary big"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate()}
          >
            Confirm all {drafts.length} openings
          </button>
        </>
      )}

      <h2>Confirmed ({confirmed.length})</h2>
      <ul className="unit-list">{confirmed.map(row)}</ul>
      {confirmed.length === 0 && drafts.length === 0 && (
        <p className="muted">
          Nothing yet.{" "}
          <Link to={`/projects/${projectId}/upload`}>Upload specs</Link> or
          add openings by hand below.
        </p>
      )}

      <SpecReviewSection projectId={projectId} />

      {(removed.data ?? []).length > 0 && (
        <>
          <h2>Removed ({(removed.data ?? []).length})</h2>
          <p className="muted">
            Taken off the job, not deleted. Everything recorded against these —
            install history, who was on them, measurements, checks and photos —
            is still here and comes back with them.
          </p>
          <ul className="unit-list">
            {(removed.data ?? []).map((r) => (
              <li key={r.id} className="opening-review-row opening-review-row--removed">
                <span className="removed-mark">#{r.opening_code}</span>
                <span className="muted">
                  {r.label ? `${r.label} — ` : ""}
                  removed{r.removed_by_name ? ` by ${r.removed_by_name}` : ""}
                  {r.removed_reason ? ` — “${r.removed_reason}”` : ""}
                </span>
                {r.code_taken ? (
                  <span className="muted">#{r.opening_code} is in use again</span>
                ) : (
                  <button
                    className="link"
                    disabled={putBack.isPending}
                    onClick={() => putBack.mutate(r.id)}
                  >
                    Put back
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Add opening</h2>
      <div className="manual-entry">
        <input
          value={newCode}
          onChange={(e) => setNewCode(e.target.value)}
          placeholder="Opening code, e.g. W7"
          onKeyDown={(e) =>
            e.key === "Enter" && newCode.trim() && add.mutate(newCode.trim())
          }
        />
        <button
          onClick={() => newCode.trim() && add.mutate(newCode.trim())}
          disabled={add.isPending}
        >
          Add
        </button>
      </div>
    </div>
  );
}
