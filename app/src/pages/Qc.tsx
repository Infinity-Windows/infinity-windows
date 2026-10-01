import { QcUnitEvidence } from "../components/qc/QcUnitEvidence";
import { QcReviewFlow } from "../components/qc/QcReviewFlow";
import { useT } from "../lib/i18n";
import { BackChip } from "../components/BackChip";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { getRealProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { listQcHistory } from "../lib/ops";
import { SkeletonList } from "../components/ui/States";
import { formatApiError } from "../lib/errors";
import { signedInUserId, subscribeSignedIn } from "../lib/signedIn";

const QC_PAGE_SIZE = 50;

export function Qc() {
  const t = useT();
  const actorId = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const me = useQuery({ queryKey: ["myRealProfile"], queryFn: getRealProfile });
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  // A cached profile is not proof of the current auth subject on a shared phone.
  const viewerId = actorId && me.data?.id === actorId ? actorId : null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(QC_PAGE_SIZE);
  const [evidenceFor, setEvidenceFor] = useState<{
    id: string; projectId: string; key: string; history: boolean;
  } | null>(null);
  const evidenceOpener = useRef<HTMLButtonElement | null>(null);
  const closeEvidence = () => {
    setEvidenceFor(null);
    if (evidenceOpener.current?.isConnected) evidenceOpener.current.focus();
  };
  const switchHistory = (open: boolean) => {
    if (blocked) return;
    setEvidenceFor(null);
    setHistoryOpen(open);
  };
  useEffect(() => { setEvidenceFor(null); setBlocked(false); setHistoryOpen(false); }, [viewerId]);
  const history = useQuery({
    queryKey: ["qcHistory", viewerId, historyLimit],
    queryFn: () => listQcHistory(historyLimit),
    enabled: lead && Boolean(viewerId) && historyOpen,
  });
  if (me.data && !lead) return <div className="page">
    <header className="page-header"><h1>Quality</h1><Link to="/" className="button-like">Home</Link></header>
    <p className="muted">QC sign-off is for foremen and up.</p>
  </div>;
  if (!viewerId || !lead) return <div className="page"><SkeletonList rows={3} /></div>;
  return <div className="page">
    <header className="page-header">
      <div><h1>Quality</h1><p className="muted" style={{ margin: 0 }}>
        Pass installs or log a callback — callbacks push terms into learning decks.
      </p></div>
      {blocked ? <button className="back-chip" disabled aria-label="Home">‹</button> : <BackChip fallback="/" label="Home" />}
    </header>
    <div className="row-gap" role="group" aria-label="Quality views" style={{ marginBottom: 16 }}>
      <button type="button" disabled={blocked} className={historyOpen ? "button-like" : "primary"} onClick={() => switchHistory(false)}>Needs review</button>
      <button type="button" disabled={blocked} className={historyOpen ? "primary" : "button-like"} onClick={() => switchHistory(true)}>Review history</button>
    </div>
    {!historyOpen && <QcReviewFlow key={viewerId} viewerId={viewerId} onBlockedChange={setBlocked} />}
      <section aria-label="QC review history" style={{ marginTop: 24 }}>
        {historyOpen && (
          <div style={{ marginTop: 16 }}>
            <h2 style={{ marginBottom: 4 }}>Review history</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Every recorded pass and callback stays here, even after a later decision changes the unit’s status.
            </p>
            {history.isLoading ? <SkeletonList rows={3} /> : history.isError ? (
              <div className="detail-card" role="alert">
                <p>Review history could not load. {formatApiError(history.error)}</p>
                <button className="button-like" onClick={() => void history.refetch()}>Try again</button>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {(history.data?.rows ?? []).map((decision) => (
                  <article className="detail-card" key={decision.id} style={{ minWidth: 0 }}>
                    <div className="row-gap" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                      <div>
                        {decision.project_id ? (
                          <Link to={`/projects/${decision.project_id}/opening/${decision.project_opening_id}`} className="link">
                            <strong>{decision.job_code ?? "Job"} · {decision.opening_code ?? "Unit"}</strong>
                          </Link>
                        ) : <strong>Unit record unavailable</strong>}
                      </div>
                      <strong className={decision.status === "passed" ? "ok" : "error"}>
                        {decision.status === "passed" ? "Passed" : "Callback"}
                      </strong>
                    </div>
                    <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                      {new Date(decision.decided_at).toLocaleString()} · {decision.reviewer_name
                        ?? (decision.source === "legacy_snapshot" && !decision.reviewer_id
                          ? "Reviewer not recorded in older data"
                          : decision.source === "system" && !decision.reviewer_id
                            ? "System update"
                            : "Reviewer unavailable")}
                    </div>
                    {decision.source === "legacy_snapshot" && (
                      <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                        Previous status saved before review history began
                      </div>
                    )}
                    {decision.source === "legacy_client" && (
                      <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                        Saved from an older app version
                      </div>
                    )}
                    {decision.note && (
                      <p style={{ marginBottom: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {decision.note}
                      </p>
                    )}
                    {lead && viewerId && decision.project_id && (
                      <button type="button" className="button-like" style={{ marginTop: 10 }}
                        aria-expanded={evidenceFor?.key === "history:" + decision.id}
                        aria-controls={"qc-evidence-history-" + decision.id}
                        onClick={event => {
                          evidenceOpener.current = event.currentTarget;
                          setEvidenceFor(current => current?.key === "history:" + decision.id ? null : {
                            id: decision.project_opening_id, projectId: decision.project_id!,
                            key: "history:" + decision.id, history: true,
                          });
                        }}
                      >{t("qcEvidence.open")}</button>
                    )}
                    {lead && viewerId && evidenceFor?.key === "history:" + decision.id && (
                      <QcUnitEvidence key={evidenceFor.key} openingId={evidenceFor.id}
                        projectId={evidenceFor.projectId} viewerId={viewerId}
                        panelId={"qc-evidence-history-" + decision.id} history onClose={closeEvidence} />
                    )}
                  </article>
                ))}
                {history.data?.rows.length === 0 && <p className="muted">No QC decisions recorded yet.</p>}
                {history.data?.hasMore && (
                  <button
                    className="button-like"
                    disabled={history.isFetching}
                    onClick={() => setHistoryLimit((n) => n + QC_PAGE_SIZE)}
                  >
                    Load older reviews
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>
  </div>;
}
