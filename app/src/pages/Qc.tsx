import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getMyProfile } from "../lib/install/api";
import { isForemanPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { listQcHistory, listQcQueue, setQc } from "../lib/ops";
import { addPriorityTerm } from "../lib/learn";
import { openServiceCase } from "../lib/service";
import { CATS, TERMS } from "../lib/glossary";
import { pushToast, toastError } from "../lib/toast";
import { SkeletonList } from "../components/ui/States";
import { supabase } from "../lib/supabase";

// listQcQueue's range is (0, limit-1) from the start, not an offset cursor —
// so "load more" here just re-asks for a bigger limit rather than tracking a
// page number. Simple, and matches how the query itself is built.
const QC_PAGE_SIZE = 50;

interface QcPhotoReview {
  review: {
    summary: string;
    visible_checks: string[];
    questions_for_foreman: string[];
    limitation: string;
  };
  photoId: string;
  photoCreatedAt: string;
  openingId: string;
}

async function reviewQcPhoto(openingId: string): Promise<QcPhotoReview> {
  const { data, error } = await supabase.functions.invoke("review-qc-photo", {
    body: { openingId }, signal: AbortSignal.timeout(100_000),
  });
  if (error) throw error;
  if (data?.error === "no_after_photo" || data?.error === "no_install_photo") {
    throw new Error("Add an after-install photo to this opening before asking AI to review it.");
  }
  if (data?.error) throw new Error(String(data.note ?? data.error));
  return data as QcPhotoReview;
}

export function Qc() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const lead = isForemanPlus(effectiveRole);
  // limit grows on "load more" instead of tracking an offset — see the note
  // by QC_PAGE_SIZE above.
  const [limit, setLimit] = useState(QC_PAGE_SIZE);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(QC_PAGE_SIZE);
  const rows = useQuery({
    queryKey: ["qcQueue", limit],
    queryFn: () => listQcQueue(limit),
    enabled: lead,
  });
  const history = useQuery({
    queryKey: ["qcHistory", historyLimit],
    queryFn: () => listQcHistory(historyLimit),
    enabled: lead && historyOpen,
  });

  // Which opening is mid-callback (awaiting a root-cause term), and the picked term.
  const [callbackFor, setCallbackFor] = useState<{ id: string; code: string } | null>(null);
  const [rootTerm, setRootTerm] = useState("");
  const [photoReviewFor, setPhotoReviewFor] = useState<string | null>(null);
  const [photoReview, setPhotoReview] = useState<QcPhotoReview | null>(null);
  const [photoReviewError, setPhotoReviewError] = useState<string | null>(null);
  // Keep one request ID across a failed send and its retry. A fresh UUID for
  // every call would turn a double tap or weak-signal retry into two reviews.
  const decisionIds = useRef(new Map<string, string>());
  const decisionIdFor = (id: string, status: "passed" | "callback") => {
    const key = `${id}:${status}`;
    let requestId = decisionIds.current.get(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      decisionIds.current.set(key, requestId);
    }
    return requestId;
  };
  const reviewPhoto = useMutation({
    mutationFn: reviewQcPhoto,
    onSuccess: (result) => { setPhotoReviewFor(result.openingId); setPhotoReview(result); setPhotoReviewError(null); },
    onError: (error: Error, openingId) => {
      setPhotoReviewFor(openingId);
      setPhotoReview(null);
      setPhotoReviewError(error.message);
    },
  });
  // After a callback is logged, offer to open a linked warranty/service case so
  // QC and after-service tracking don't diverge. Only offerable when the opening
  // is backed by a physical window unit (assigned_window_id).
  const [caseOffer, setCaseOffer] = useState<
    { code: string; windowId: string; term: string } | null
  >(null);

  const decide = useMutation({
    mutationFn: async (a: { id: string; status: "passed" | "callback"; decisionId: string }) => {
      await setQc(a.id, a.status, a.decisionId);
      // The server records the reviewer and resolves pending points in the
      // same transaction, so a failed request cannot leave half a decision.
    },
    onSuccess: (_data, a) => {
      if (a.status === "passed") {
        decisionIds.current.delete(`${a.id}:passed`);
        decisionIds.current.delete(`${a.id}:callback`);
        setCallbackFor((current) => current?.id === a.id ? null : current);
      }
      // Prefix match: invalidates every ["qcQueue", limit] variant, not just
      // whatever limit is active right now.
      queryClient.invalidateQueries({ queryKey: ["qcQueue"] });
      queryClient.invalidateQueries({ queryKey: ["qcHistory"] });
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
      await decide.mutateAsync({ id: a.id, status: "callback", decisionId: decisionIdFor(a.id, "callback") });
      if (a.term) await addPriorityTerm(a.term, `callback on ${a.code}`);
    },
    onSuccess: (_data, a) => {
      decisionIds.current.delete(`${a.id}:callback`);
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

      <div className="row-gap" role="group" aria-label="Quality views" style={{ marginBottom: 16 }}>
        <button type="button" className={historyOpen ? "button-like" : "primary"} onClick={() => setHistoryOpen(false)}>
          Needs review
        </button>
        <button type="button" className={historyOpen ? "primary" : "button-like"} onClick={() => setHistoryOpen(true)}>
          Review history
        </button>
      </div>

      <div hidden={historyOpen}>

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
                <button
                  className="button-like"
                  disabled={reviewPhoto.isPending}
                  onClick={() => {
                    setPhotoReviewFor(o.id);
                    setPhotoReview(null);
                    setPhotoReviewError(null);
                    reviewPhoto.mutate(o.id);
                  }}
                >
                  {reviewPhoto.isPending && reviewPhoto.variables === o.id ? "Reviewing photo…" : "AI photo review"}
                </button>
                <button className="button-like qc-pass" disabled={decide.isPending || logCallback.isPending} onClick={() => decide.mutate({ id: o.id, status: "passed", decisionId: decisionIdFor(o.id, "passed") })}>Pass ✓</button>
                <button
                  className="button-like qc-callback"
                  disabled={decide.isPending || logCallback.isPending}
                  onClick={() => {
                    setCallbackFor({ id: o.id, code: o.opening_code });
                    setRootTerm("");
                  }}
                >
                  Callback
                </button>
              </div>
              {photoReviewFor === o.id && (photoReview || photoReviewError) && (
                <div className="detail-card" style={{ marginTop: 8, width: "100%" }}>
                  <strong>Photo review suggestion</strong>
                  {photoReviewError ? (
                    <p className="muted">{photoReviewError} <Link to={`/projects/${o.project_id}/opening/${o.id}`}>Open this opening</Link></p>
                  ) : photoReview && (
                    <>
                      <p>{photoReview.review.summary}</p>
                      {photoReview.review.visible_checks.length > 0 && <>
                        <strong>Visible details</strong>
                        <ul>{photoReview.review.visible_checks.map((item, i) => <li key={i}>{item}</li>)}</ul>
                      </>}
                      {photoReview.review.questions_for_foreman.length > 0 && <>
                        <strong>Check in person</strong>
                        <ul>{photoReview.review.questions_for_foreman.map((item, i) => <li key={i}>{item}</li>)}</ul>
                      </>}
                      <p className="muted" style={{ fontSize: 12 }}>{photoReview.review.limitation}</p>
                      <p className="muted" style={{ fontSize: 12 }}>
                        Based on an after photo saved {new Date(photoReview.photoCreatedAt).toLocaleString()}.{" "}
                        <Link to={`/projects/${o.project_id}/opening/${o.id}`}>Open the photo and full record</Link> before deciding.
                      </p>
                    </>
                  )}
                </div>
              )}
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
                      disabled={logCallback.isPending || decide.isPending}
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
      <section aria-label="QC review history" style={{ marginTop: 24 }}>
        {historyOpen && (
          <div style={{ marginTop: 16 }}>
            <h2 style={{ marginBottom: 4 }}>Review history</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Every recorded pass and callback stays here, even after a later decision changes the unit’s status.
            </p>
            {history.isLoading ? <SkeletonList rows={3} /> : history.isError ? (
              <div className="detail-card" role="alert">
                <p>Review history could not load. {history.error instanceof Error ? history.error.message : "Please try again."}</p>
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
    </div>
  );
}
