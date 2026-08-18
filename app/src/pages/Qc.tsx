import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { listQcQueue, setQc } from "../lib/ops";
import { addPriorityTerm } from "../lib/learn";
import { resolvePendingPoints } from "../lib/points";
import { openServiceCase } from "../lib/service";
import { CATS, TERMS } from "../lib/glossary";
import { pushToast, toastError } from "../lib/toast";
import { SkeletonList } from "../components/ui/States";

// listQcQueue's range is (0, limit-1) from the start, not an offset cursor —
// so "load more" here just re-asks for a bigger limit rather than tracking a
// page number. Simple, and matches how the query itself is built.
const QC_PAGE_SIZE = 50;

export function Qc() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  // limit grows on "load more" instead of tracking an offset — see the note
  // by QC_PAGE_SIZE above.
  const [limit, setLimit] = useState(QC_PAGE_SIZE);
  const rows = useQuery({
    queryKey: ["qcQueue", limit],
    queryFn: () => listQcQueue(limit),
    enabled: lead,
  });

  // Which opening is mid-callback (awaiting a root-cause term), and the picked term.
  const [callbackFor, setCallbackFor] = useState<{ id: string; code: string } | null>(null);
  const [rootTerm, setRootTerm] = useState("");
  // After a callback is logged, offer to open a linked warranty/service case so
  // QC and after-service tracking don't diverge. Only offerable when the opening
  // is backed by a physical window unit (assigned_window_id).
  const [caseOffer, setCaseOffer] = useState<
    { code: string; windowId: string; term: string } | null
  >(null);

  const decide = useMutation({
    mutationFn: async (a: { id: string; status: "passed" | "callback" }) => {
      await setQc(a.id, a.status);
      // Pass confirms the installer's pending points; callback voids them.
      await resolvePendingPoints(a.id, a.status === "passed" ? "confirmed" : "void");
    },
    onSuccess: () => {
      // Prefix match: invalidates every ["qcQueue", limit] variant, not just
      // whatever limit is active right now.
      queryClient.invalidateQueries({ queryKey: ["qcQueue"] });
      queryClient.invalidateQueries({ queryKey: ["ledger"] });
      queryClient.invalidateQueries({ queryKey: ["pointsLeaderboard"] });
    },
  });

  const logCallback = useMutation({
    mutationFn: async (a: {
      id: string;
      code: string;
      term: string;
      windowId: string | null;
    }) => {
      await decide.mutateAsync({ id: a.id, status: "callback" });
      if (a.term) await addPriorityTerm(a.term, `callback on ${a.code}`);
    },
    onSuccess: (_data, a) => {
      pushToast("Callback logged — root cause pushed to crew decks.");
      setCallbackFor(null);
      setRootTerm("");
      setCaseOffer(
        a.windowId ? { code: a.code, windowId: a.windowId, term: a.term } : null,
      );
    },
  });

  const openCase = useMutation({
    mutationFn: (a: { windowId: string; code: string; term: string }) =>
      openServiceCase({
        windowId: a.windowId,
        reason: "QC callback",
        failPoint: a.term || null,
        description: `Opened from QC callback on ${a.code}`,
      }),
    onSuccess: () => {
      pushToast("Service case opened — linked to this callback for warranty tracking.");
      setCaseOffer(null);
    },
    onError: (e) => toastError(e),
  });

  if (me.data && !lead) {
    return (
      <div className="page">
        <header className="page-header"><h1>Quality</h1><Link to="/" className="button-like">Home</Link></header>
        <p className="muted">QC sign-off is for foremen and up.</p>
      </div>
    );
  }

  const list = rows.data?.rows ?? [];
  const hasMore = rows.data?.hasMore ?? false;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Quality</h1>
          <p className="muted" style={{ margin: 0 }}>
            Pass installs or log a callback — callbacks push terms into learning decks.
          </p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      {caseOffer && (
        <div className="detail-card" style={{ marginBottom: 12 }}>
          <strong>Open a service case for {caseOffer.code}?</strong>
          <p className="muted" style={{ margin: "4px 0 8px" }}>
            Links this callback to warranty tracking so QC and after-service stay in sync.
          </p>
          <div className="row-gap">
            <button
              className="primary big"
              disabled={openCase.isPending}
              onClick={() =>
                openCase.mutate({
                  windowId: caseOffer.windowId,
                  code: caseOffer.code,
                  term: caseOffer.term,
                })
              }
            >
              Open service case
            </button>
            <button className="button-like" onClick={() => setCaseOffer(null)}>
              Not now
            </button>
          </div>
        </div>
      )}

      {rows.isLoading ? (
        <SkeletonList rows={6} />
      ) : (
      <ul className="unit-list work-list">
        {list.map((o) => {
          const status = o.qc?.status ?? "pending";
          return (
            <li key={o.id} className="find-row" style={{ flexWrap: "wrap" }}>
              <div>
                {/* QC judges the window — it should be able to OPEN it. The
                    sheet carries the Record (photos, memo, timeline). */}
                <Link to={`/projects/${o.project_id}/opening/${o.id}`} className="link">
                  <strong>{o.opening_code}</strong>
                </Link>{" "}
                {/* Opening codes are only unique within a job ("A1" can be two
                    different windows on two different jobs), so the job code
                    has to ride along or a foreman can't tell which is which. */}
                <span className="muted">{o.projects?.job_code ?? "job?"}</span>{" "}
                <span className="muted">{o.window_types?.type_code}</span>
                <div className={status === "passed" ? "ok" : status === "callback" ? "error" : "muted"} style={{ fontSize: 12 }}>
                  {status}
                </div>
                {status === "callback" && (
                  <Link
                    to={`/projects/${o.project_id}?tab=exceptions`}
                    className="link"
                    style={{ fontSize: 12 }}
                  >
                    See this job&apos;s open issues →
                  </Link>
                )}
              </div>
              <div className="row-gap" style={{ marginLeft: "auto" }}>
                <button className="button-like qc-pass" onClick={() => decide.mutate({ id: o.id, status: "passed" })}>Pass ✓</button>
                <button
                  className="button-like qc-callback"
                  onClick={() => {
                    setCallbackFor({ id: o.id, code: o.opening_code });
                    setRootTerm("");
                  }}
                >
                  Callback
                </button>
              </div>
              {callbackFor?.id === o.id && (
                <div className="detail-card" style={{ marginTop: 8, width: "100%" }}>
                  <label className="field-label">Root-cause term (pushed to crew decks)</label>
                  <select value={rootTerm} onChange={(e) => setRootTerm(e.target.value)}>
                    <option value="">— pick a term —</option>
                    {CATS.map((c) => (
                      <optgroup key={c.id} label={c.label}>
                        {TERMS.filter((t) => t.cat === c.id).map((t) => (
                          <option key={t.id} value={t.id}>{t.term}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <div className="row-gap">
                    <button
                      className="primary big"
                      disabled={logCallback.isPending}
                      onClick={() =>
                        logCallback.mutate({
                          id: o.id,
                          code: o.opening_code,
                          term: rootTerm,
                          windowId: o.assigned_window_id,
                        })
                      }
                    >
                      Log callback
                    </button>
                    <button className="button-like" onClick={() => setCallbackFor(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {list.length === 0 && <p className="muted">No installed openings to review.</p>}
      </ul>
      )}
      {hasMore && (
        <button
          className="button-like"
          disabled={rows.isFetching}
          onClick={() => setLimit((n) => n + QC_PAGE_SIZE)}
        >
          Load more
        </button>
      )}
    </div>
  );
}
