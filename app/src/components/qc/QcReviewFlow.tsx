import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/qcReviewCatalog";
import { formatApiError } from "../../lib/errors";
import { pushToast, toastError } from "../../lib/toast";
import { CATS, TERMS } from "../../lib/glossary";
import { supabase } from "../../lib/supabase";
import {
  classifyQcReviewDecisionError, fetchQcReviewJobs, fetchQcReviewPage, normalizeQcReviewNote,
  recordQcReviewDecision, type QcReviewDecisionErrorKind, type QcReviewDecisionStatus, type QcReviewFilter,
  type QcReviewJobRow, type QcReviewJobsCursor, type QcReviewUnit,
} from "../../lib/qcReview";
import {
  buildQcReviewSearchParams, createQcReviewDecisionIds, DEFAULT_QC_REVIEW_VIEW,
  parseQcReviewUrlState, qcReviewDecisionKey, readQcReviewSession, writeQcReviewSession,
  type QcReviewViewState,
} from "../../lib/qcReviewState";
import { signInMark, stillSignedInAs, type SignInMark } from "../../lib/signedIn";
import { addQcPriorityTerm, openQcServiceCase, runQcOwnedRequest } from "../../lib/qcReviewRequests";
import { clearQcSubmittedCommand, persistQcSubmittedCommand, readQcSubmittedCommand, type QcSubmittedCommand } from "../../lib/qcReviewRecovery";
import { QcUnitEvidence } from "./QcUnitEvidence";
import { registerQcReviewPopGuard } from "../../lib/qcReviewPopGuard";

interface QcPhotoReview {
  review: { summary: string; visible_checks: string[]; questions_for_foreman: string[]; limitation: string };
  photoId: string;
  photoCreatedAt: string;
  openingId: string;
}

async function reviewQcPhoto(openingId: string, signal: AbortSignal): Promise<QcPhotoReview> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 100_000);
  try {
    const { data, error } = await supabase.functions.invoke("review-qc-photo", {
      body: { openingId }, signal: controller.signal,
    });
    if (error) throw error;
    if (data?.error === "no_after_photo" || data?.error === "no_install_photo") {
      throw new Error("Add an after-install photo to this opening before asking AI to review it.");
    }
    if (data?.error) throw new Error(String(data.note ?? data.error));
    return data as QcPhotoReview;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

const PAGE_SIZE = 50;

/**
 * A decision attempt frozen at the moment it was first sent: unit, status,
 * note and the exact `expectedReviewVersion` that was true then. A retry
 * replays this SAME object — never a freshly re-read unit — so a retry after
 * the list has moved on can't silently turn into a different request under
 * the same decisionId (23505) or drift its expected version.
 */
interface PendingDecision {
  command: QcSubmittedCommand;
  ambiguous: boolean;
  unit: QcReviewUnit;
  status: QcReviewDecisionStatus;
  note: string | null;
  decisionId: string;
  key: string;
  term?: string;
  /** null while in flight; set once the attempt has failed. */
  errorKind: QcReviewDecisionErrorKind | null;
  errorText: string | null;
}

interface SavedReceipt {
  unit: QcReviewUnit;
  status: QcReviewDecisionStatus;
  decisionId: string;
  at: string;
  /** Only a read STARTED after the save can describe its current state. */
  afterReadSequence: number;
}

function recoveredUnit(command: QcSubmittedCommand): QcReviewUnit {
  return { id: command.openingId, projectId: command.projectId, openingCode: command.openingId,
    label: null, assignedWindowId: null, typeCode: null, workEndedAt: null,
    qcStatus: null, qcNote: null, reviewerId: null, reviewedAt: null,
    reviewVersion: command.expectedReviewVersion, matchesFilter: false };
}

export function QcReviewFlow({
  viewerId, onBlockedChange,
}: {
  viewerId: string | null;
  onBlockedChange?: (blocked: boolean) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  const viewerEpochRef = useRef(0);
  const prevViewerRef = useRef<string | null>(null);
  const [state, setState] = useState<QcReviewViewState>(DEFAULT_QC_REVIEW_VIEW);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [restoredViewer, setRestoredViewer] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const lifetimeRef = useRef(new AbortController());
  const writtenSearchRef = useRef<string | null>(null);
  const visitRef = useRef(crypto.randomUUID());
  const readSequenceRef = useRef(0);
  const [refreshRequired, setRefreshRequired] = useState<Record<string, number>>({});
  const [localSaveError, setLocalSaveError] = useState<string | null>(null);

  const [jobSearch, setJobSearch] = useState("");
  const [jobsAfter, setJobsAfter] = useState<QcReviewJobsCursor | null>(null);
  const [jobRows, setJobRows] = useState<QcReviewJobRow[]>([]);
  const autoChoseRef = useRef(false);

  const decisionIds = useRef(createQcReviewDecisionIds());
  const savingRef = useRef(false);
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(null);
  const [savedReceipts, setSavedReceipts] = useState<Record<string, SavedReceipt>>({});
  const [callbackDraft, setCallbackDraft] = useState<{ unit: QcReviewUnit; term: string; note: string } | null>(null);
  const [learningRetry, setLearningRetry] = useState<{ term: string; code: string; error: string } | null>(null);
  const [learningPending, setLearningPending] = useState(false);
  const learningAttemptRef = useRef<AbortController | null>(null);
  const caseAttemptRef = useRef<AbortController | null>(null);
  const [caseOffer, setCaseOffer] = useState<{ code: string; windowId: string; term: string } | null>(null);
  const [photoReviewFor, setPhotoReviewFor] = useState<string | null>(null);
  const [photoReview, setPhotoReview] = useState<QcPhotoReview | null>(null);
  const [photoReviewError, setPhotoReviewError] = useState<string | null>(null);
  const navRef = useRef(false);
  const [navPending, setNavPending] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const focusAfterCloseRef = useRef<string | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const blockedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    if (lifetimeRef.current.signal.aborted) lifetimeRef.current = new AbortController();
    return () => {
      mountedRef.current = false;
      viewerEpochRef.current += 1;
      lifetimeRef.current.abort();
    };
  }, []);

  function resetTransientUi() {
    setCallbackDraft(null);
    learningAttemptRef.current?.abort(); learningAttemptRef.current = null;
    caseAttemptRef.current?.abort(); caseAttemptRef.current = null;
    setLearningRetry(null);
    setLearningPending(false);
    setCaseOffer(null);
    setPhotoReviewFor(null);
    setPhotoReview(null);
    setPhotoReviewError(null);
    setPendingDecision(null);
    setSavedReceipts({});
    setNavError(null);
    setNavPending(false);
    setRefreshRequired({});
    setLocalSaveError(null);
    decisionIds.current.clear();
    savingRef.current = false;
    navRef.current = false;
  }

  function currentViewer(epoch: number, mark: SignInMark): boolean {
    return mountedRef.current && viewerEpochRef.current === epoch && Boolean(viewerId && stillSignedInAs(mark, viewerId));
  }

  function writeViewUrl(next: QcReviewViewState) {
    const params = buildQcReviewSearchParams(next, searchParams);
    const search = params.toString() ? `?${params}` : "";
    writtenSearchRef.current = search;
    if (search !== location.search || location.state?.qcReviewViewer !== viewerId) {
      setSearchParams(params, { replace: true, state: { ...location.state, qcReviewViewer: viewerId } });
    }
  }
  function updateState(patch: Partial<QcReviewViewState>) {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
    writeViewUrl(next);
  }

  // One effect covers both "first real viewer id arrives" and "account
  // switch" — a switch must never carry one viewer's job/selection/draft/
  // in-flight save onto whoever signs in next on the same device.
  useEffect(() => {
    if (prevViewerRef.current === viewerId) return;
    const firstViewer = prevViewerRef.current === null;
    prevViewerRef.current = viewerId;
    viewerEpochRef.current += 1;
    lifetimeRef.current.abort();
    lifetimeRef.current = new AbortController();
    setJobRows([]);
    setJobsAfter(null);
    setJobSearch("");
    autoChoseRef.current = false;
    resetTransientUi();
    const urlState = parseQcReviewUrlState(searchParams);
    const hasUrlState = ["job", "filter", "q", "sel", "after", "before"].some(key => searchParams.has(key));
    const ownUrl = !location.state?.qcReviewViewer || location.state.qcReviewViewer === viewerId;
    let initial = firstViewer && ownUrl && hasUrlState ? urlState : (readQcReviewSession(viewerId) ?? DEFAULT_QC_REVIEW_VIEW);
    if (viewerId) {
      const recovery = readQcSubmittedCommand(viewerId);
      if (recovery.kind === "command") {
        const command = recovery.command;
        const unit = recoveredUnit(command);
        initial = { ...DEFAULT_QC_REVIEW_VIEW, job: command.projectId, sel: command.openingId };
        setPendingDecision({ command, ambiguous: true, unit, status: command.status, note: command.note,
          decisionId: command.decisionId, key: qcReviewDecisionKey(command), term: command.term,
          errorKind: "unknown", errorText: t("qcReview.recoveredSubmission") });
      } else if (recovery.kind !== "empty") {
        setLocalSaveError(t(recovery.kind === "invalid" ? "qcReview.invalidRecovery" : "qcReview.storageUnavailable"));
      }
    }
    stateRef.current = initial;
    setState(initial);
    setRestoredViewer(viewerId);
    writeViewUrl(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerId]);

  useEffect(() => {
    if (!viewerId || restoredViewer !== viewerId) return;
    writeQcReviewSession(viewerId, state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, viewerId, restoredViewer]);

  useEffect(() => {
    if (!viewerId || restoredViewer !== viewerId) return;
    if (writtenSearchRef.current === location.search) { writtenSearchRef.current = null; return; }
    if (blockedRef.current) return;
    const next = parseQcReviewUrlState(new URLSearchParams(location.search));
    if (JSON.stringify(next) !== JSON.stringify(stateRef.current)) {
      stateRef.current = next;
      setState(next);
    }
    // Browser POP/PUSH on this same mounted route must update the view too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, location.search, restoredViewer, viewerId]);

  const jobsQuery = useQuery({
    queryKey: ["qcReviewJobs", viewerId, jobSearch, jobsAfter, state.job],
    queryFn: ({ signal }) => runQcOwnedRequest(viewerId!, lifetimeRef.current.signal, owned =>
      fetchQcReviewJobs({ search: jobSearch, limit: PAGE_SIZE, after: jobsAfter, selectedProjectId: state.job, signal: owned }), signal),
    enabled: Boolean(viewerId && restoredViewer === viewerId),
  });
  useEffect(() => { setJobsAfter(null); }, [jobSearch]);
  useEffect(() => {
    if (!jobsQuery.data) return;
    setJobRows((current) => jobsAfter
      ? [...new Map([...current, ...jobsQuery.data.rows].map(row => [row.id, row])).values()]
      : jobsQuery.data.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsQuery.data]);
  useEffect(() => {
    if (autoChoseRef.current || state.job || jobSearch) return;
    if (jobsQuery.data?.totalCount === 1 && jobRows.length >= 1) {
      autoChoseRef.current = true;
      chooseJob(jobRows[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsQuery.data, jobRows, state.job, jobSearch]);

  const blocked = Boolean(callbackDraft) || Boolean(pendingDecision) || Boolean(caseOffer) || Boolean(learningRetry) || learningPending || navPending;
  blockedRef.current = blocked;
  useEffect(() => { onBlockedChange?.(blocked); }, [blocked, onBlockedChange]);
  const protectedLocationRef = useRef({ url: window.location.href, history: window.history.state });
  useEffect(() => {
    protectedLocationRef.current = { url: window.location.href, history: window.history.state };
  }, [location.key, location.search]);
  useEffect(() => {
    let reversing = false;
    const unload = (event: BeforeUnloadEvent) => {
      if (!blockedRef.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    const anchor = (event: MouseEvent) => {
      if (!blockedRef.current || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download") || link.href === window.location.href) return;
      event.preventDefault(); event.stopPropagation();
      setNavError(t("qcReview.finishBeforeLeaving"));
    };
    const pop = (event: PopStateEvent) => {
      if (!blockedRef.current && !reversing) return;
      const kept = protectedLocationRef.current;
      // The bootstrap dispatcher invokes this before BrowserRouter's POP
      // listener. Window-target capture alone does not change listener order.
      event.stopImmediatePropagation();
      const oldIndex = kept.history?.idx;
      const targetIndex = event.state?.idx;
      if (reversing && oldIndex === targetIndex && window.location.href === kept.url) {
        reversing = false; return;
      }
      setNavError(t("qcReview.finishBeforeLeaving"));
      if (typeof oldIndex === "number" && typeof targetIndex === "number" && oldIndex !== targetIndex) {
        reversing = true; window.history.go(oldIndex - targetIndex);
      } else {
        window.history.pushState(kept.history, "", kept.url);
        reversing = false;
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", anchor, true);
    const unregisterPop = registerQcReviewPopGuard(pop);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", anchor, true);
      unregisterPop();
      onBlockedChange?.(false);
    };
    // Event handlers read the current blocked/location refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function chooseJob(job: QcReviewJobRow) {
    if (blocked) return;
    resetTransientUi();
    updateState({ job: job.id, filter: "all", search: "", sel: null, after: null, before: null });
  }
  function changeJob() {
    if (blocked) return;
    autoChoseRef.current = true;
    resetTransientUi();
    updateState(DEFAULT_QC_REVIEW_VIEW);
  }
  function setFilter(filter: QcReviewFilter) {
    if (blocked) return;
    updateState({ filter, after: null, before: null });
  }
  function setSearchText(search: string) {
    if (blocked) return;
    updateState({ search, after: null, before: null });
  }
  function selectUnit(id: string | null, opener?: HTMLElement) {
    if (blocked && id !== state.sel) return;
    if (id === null) focusAfterCloseRef.current = opener?.dataset.qcEvidenceOpener ?? state.sel;
    updateState({ sel: id });
  }

  const pageQuery = useQuery({
    queryKey: ["qcReviewPage", viewerId, state.job, state.filter, state.search, state.after, state.before, state.sel],
    queryFn: async ({ signal }) => {
      const readSequence = ++readSequenceRef.current;
      const page = await runQcOwnedRequest(viewerId!, lifetimeRef.current.signal, owned => fetchQcReviewPage({
        projectId: state.job!, filter: state.filter, search: state.search, limit: PAGE_SIZE,
        after: state.after, before: state.before, selectedOpeningId: state.sel, signal: owned,
      }), signal);
      return { ...page, readSequence, visit: visitRef.current };
    },
    enabled: Boolean(viewerId && restoredViewer === viewerId && state.job),
    staleTime: 0,
    refetchOnMount: "always",
  });

  const rows = pageQuery.data?.rows ?? [];
  const confirmedRead = pageQuery.isSuccess && !pageQuery.isFetching && pageQuery.data?.visit === visitRef.current;
  const selectedReceipt = state.sel ? savedReceipts[state.sel] : null;
  const receiptAwaitingRead = selectedReceipt && (!confirmedRead || pageQuery.data!.readSequence <= selectedReceipt.afterReadSequence);
  const pendingCanonical = pendingDecision && pageQuery.data?.selected?.id === pendingDecision.command.openingId
    && pageQuery.data.selected.projectId === pendingDecision.command.projectId ? pageQuery.data.selected : null;
  const selectedUnit = (pendingDecision?.unit.id === state.sel ? (pendingCanonical ?? pendingDecision.unit) : null)
    ?? (receiptAwaitingRead ? selectedReceipt.unit : null)
    ?? pageQuery.data?.selected
    ?? (callbackDraft?.unit.id === state.sel ? callbackDraft.unit : null)
    ?? selectedReceipt?.unit ?? null;

  useEffect(() => {
    if (!confirmedRead || !pageQuery.data) return;
    const data = pageQuery.data;
    setRefreshRequired(current => {
      const remaining = Object.fromEntries(Object.entries(current).filter(([id, after]) =>
        data.readSequence <= after || !(data.selected?.id === id || data.rows.some(row => row.id === id))));
      return Object.keys(remaining).length === Object.keys(current).length ? current : remaining;
    });
  }, [confirmedRead, pageQuery.data]);

  useEffect(() => {
    const id = focusAfterCloseRef.current;
    if (!id || state.sel !== null || pageQuery.isFetching) return;
    const frame = requestAnimationFrame(() => {
      const opener = flowRef.current?.querySelector<HTMLButtonElement>(`[data-qc-evidence-opener="${id}"]`);
      (opener ?? flowRef.current?.querySelector<HTMLButtonElement>("[data-qc-change-job]"))?.focus();
      focusAfterCloseRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [state.sel, pageQuery.isFetching, pageQuery.data]);

  function isOutOfQueue(unit: QcReviewUnit): boolean {
    return !unit.matchesFilter && !savedReceipts[unit.id];
  }

  function receiptFor(unit: QcReviewUnit): { receipt: SavedReceipt; historical: boolean; currentConfirmed: boolean } | null {
    const receipt = savedReceipts[unit.id];
    if (!receipt) return null;
    const currentConfirmed = confirmedRead && pageQuery.data!.readSequence > receipt.afterReadSequence;
    if (!currentConfirmed) return { receipt, historical: false, currentConfirmed: false };
    const historical = unit.qcStatus !== receipt.status || (Boolean(unit.reviewerId) && unit.reviewerId !== viewerId);
    return { receipt, historical, currentConfirmed: true };
  }

  async function goAdjacent(direction: 1 | -1) {
    if (navRef.current || blocked || !selectedUnit) return;
    navRef.current = true;
    setNavPending(true);
    setNavError(null);
    const epoch = viewerEpochRef.current;
    const mark = signInMark();
    try {
      const idx = rows.findIndex((r) => r.id === selectedUnit.id);
      const neighbor = idx !== -1 ? rows[idx + direction] : undefined;
      if (neighbor) {
        selectUnit(neighbor.id);
        return;
      }
      const anchor = { endedAt: selectedUnit.workEndedAt, id: selectedUnit.id };
      const page = await runQcOwnedRequest(viewerId!, lifetimeRef.current.signal, signal => fetchQcReviewPage({
        projectId: state.job!, filter: state.filter, search: state.search, limit: PAGE_SIZE,
        after: direction === 1 ? anchor : null,
        before: direction === -1 ? anchor : null,
        signal,
      }));
      if (!currentViewer(epoch, mark)) return;
      const candidate = direction === 1 ? page.rows[0] : page.rows[page.rows.length - 1];
      if (!candidate) {
        setNavError(t("qcReview.noFurtherUnit"));
        return;
      }
      updateState({ after: direction === 1 ? anchor : null, before: direction === -1 ? anchor : null, sel: candidate.id });
    } catch (err) {
      if (currentViewer(epoch, mark)) setNavError(formatApiError(err, t("qcReview.navError")));
    } finally {
      if (currentViewer(epoch, mark)) { navRef.current = false; setNavPending(false); }
    }
  }

  function decisionErrorText(err: unknown, kind: QcReviewDecisionErrorKind): string {
    if (kind === "stale") return t("qcReview.errorStale");
    if (kind === "conflict") return t("qcReview.errorConflict");
    if (kind === "unauthorized") return t("qcReview.errorUnauthorized");
    if (kind === "unavailable") return t("qcReview.errorUnavailable");
    if (kind === "rejected") return formatApiError(err, t("qcReview.errorUnavailable"));
    return formatApiError(err);
  }

  async function attemptDecision(frozen: PendingDecision) {
    const epoch = viewerEpochRef.current;
    const mark = signInMark();
    try {
      if (!currentViewer(epoch, mark)) return;
      if (!persistQcSubmittedCommand(viewerId!, frozen.command)) {
        savingRef.current = false;
        setLocalSaveError(t("qcReview.storageUnavailable"));
        setPendingDecision(current => current?.decisionId === frozen.decisionId
          ? { ...current, errorKind: "unknown", errorText: t("qcReview.storageUnavailable") } : current);
        return;
      }
      await runQcOwnedRequest(viewerId!, lifetimeRef.current.signal, signal =>
        recordQcReviewDecision({ ...frozen.command, signal }));
      if (!currentViewer(epoch, mark)) return;
      decisionIds.current.forget(frozen.key);
      savingRef.current = false;
      setPendingDecision(null);
      setLocalSaveError(clearQcSubmittedCommand(viewerId!, frozen.decisionId) ? null : t("qcReview.savedRecoveryRetained"));
      setSavedReceipts((current) => ({
        ...current,
        [frozen.unit.id]: { unit: { ...frozen.unit, qcStatus: frozen.status }, status: frozen.status, decisionId: frozen.decisionId, at: new Date().toISOString(), afterReadSequence: readSequenceRef.current },
      }));
      // Cancel reads begun before this save, then start a genuinely post-save
      // read. A late response's arrival time alone cannot make it current.
      void queryClient.cancelQueries({ queryKey: ["qcReviewPage", viewerId] }).then(() => {
        if (currentViewer(epoch, mark)) void queryClient.invalidateQueries({ queryKey: ["qcReviewPage", viewerId] });
      });
      void queryClient.invalidateQueries({ queryKey: ["qcReviewJobs"] });
      for (const root of ["qcHistory", "ledger", "pointsLeaderboard", "qcUnitEvidence"]) {
        void queryClient.invalidateQueries({ queryKey: [root] });
      }
      if (frozen.status === "passed") {
        pushToast(t("qcReview.savedPassed"));
        return;
      }
      pushToast(t("qcReview.callbackSaved"));
      const term = frozen.term ?? "";
      setCallbackDraft(null);
      setCaseOffer(frozen.unit.assignedWindowId ? { code: frozen.unit.openingCode, windowId: frozen.unit.assignedWindowId, term } : null);
      if (term) await attemptLearning(term, frozen.unit.openingCode, epoch, mark);
    } catch (err) {
      if (!currentViewer(epoch, mark)) return;
      savingRef.current = false;
      const kind = classifyQcReviewDecisionError(err, frozen.ambiguous);
      if (kind === "stale" || kind === "conflict") {
        setRefreshRequired(current => ({ ...current, [frozen.unit.id]: readSequenceRef.current }));
      }
      setPendingDecision((current) => (current && current.key === frozen.key
        ? { ...current, ambiguous: kind === "unknown", errorKind: kind, errorText: decisionErrorText(err, kind) }
        : current));
    }
  }

  function startDecision(unit: QcReviewUnit, status: QcReviewDecisionStatus, note: string | null, term?: string) {
    if (!currentViewer(viewerEpochRef.current, signInMark())) return;
    const canonical = pageQuery.data?.selected?.id === unit.id ? pageQuery.data.selected : rows.find(row => row.id === unit.id);
    if (savingRef.current || pendingDecision || !confirmedRead || refreshRequired[unit.id] !== undefined
      || !canonical || canonical.reviewVersion !== unit.reviewVersion || isOutOfQueue(canonical)) return;
    const normalizedNote = normalizeQcReviewNote(note);
    const key = qcReviewDecisionKey({ projectId: unit.projectId, openingId: unit.id, status, note: normalizedNote, expectedReviewVersion: unit.reviewVersion });
    const decisionId = decisionIds.current.idFor(key);
    const command: QcSubmittedCommand = { decisionId, projectId: unit.projectId, openingId: unit.id,
      status, note: normalizedNote, expectedReviewVersion: unit.reviewVersion, term: term ?? "" };
    if (!viewerId || !persistQcSubmittedCommand(viewerId, command)) {
      setLocalSaveError(t("qcReview.storageUnavailable"));
      return;
    }
    savingRef.current = true;
    setLocalSaveError(null);
    const frozen: PendingDecision = { command, ambiguous: false, unit, status, note: normalizedNote, decisionId, key, term, errorKind: null, errorText: null };
    updateState({ sel: frozen.unit.id });
    setPendingDecision(frozen);
    void attemptDecision(frozen);
  }

  function retryPendingDecision() {
    if (savingRef.current || !pendingDecision || pendingDecision.errorKind === null) return;
    savingRef.current = true;
    const canonical = pageQuery.data?.selected;
    const unit = canonical?.id === pendingDecision.command.openingId && canonical.projectId === pendingDecision.command.projectId
      ? canonical : pendingDecision.unit;
    const frozen: PendingDecision = { ...pendingDecision, unit, errorKind: null, errorText: null };
    updateState({ sel: frozen.unit.id });
    setPendingDecision(frozen);
    void attemptDecision(frozen);
  }

  function cancelPendingDecision() {
    // An "unknown" (transport/ambiguous) failure must never be silently
    // discarded — the server may already hold it. Only a definite rejection
    // (stale/conflict/unauthorized/unavailable) is safe to walk away from.
    if (!pendingDecision || pendingDecision.errorKind === null || pendingDecision.errorKind === "unknown") return;
    if (!viewerId || !clearQcSubmittedCommand(viewerId, pendingDecision.decisionId)) {
      setLocalSaveError(t("qcReview.storageUnavailable")); return;
    }
    decisionIds.current.forget(pendingDecision.key);
    setPendingDecision(null);
    savingRef.current = false;
  }

  async function attemptLearning(term: string, code: string, epoch: number, mark: SignInMark) {
    if (!currentViewer(epoch, mark)) return;
    const attempt = new AbortController();
    learningAttemptRef.current?.abort();
    learningAttemptRef.current = attempt;
    const active = () => currentViewer(epoch, mark) && learningAttemptRef.current === attempt;
    setLearningPending(true);
    try {
      await runQcOwnedRequest(viewerId!, lifetimeRef.current.signal,
        signal => addQcPriorityTerm(term, code, signal), attempt.signal);
      if (!active()) return;
      setLearningRetry(null);
      pushToast(t("qcReview.rootCausePushed"));
    } catch (err) {
      if (active()) setLearningRetry({ term, code, error: formatApiError(err) });
    } finally {
      if (active()) { learningAttemptRef.current = null; setLearningPending(false); }
    }
  }
  function retryLearning() {
    if (learningRetry && !learningPending) void attemptLearning(learningRetry.term, learningRetry.code, viewerEpochRef.current, signInMark());
  }
  function dismissLearning() {
    learningAttemptRef.current?.abort(); learningAttemptRef.current = null;
    setLearningPending(false); setLearningRetry(null);
  }
  function dismissCase() {
    caseAttemptRef.current?.abort(); caseAttemptRef.current = null;
    setCaseOffer(null);
  }
  const openCase = useMutation({
    mutationFn: async (a: { windowId: string; code: string; term: string; epoch: number; mark: SignInMark; attempt: AbortController }) => {
      if (!currentViewer(a.epoch, a.mark)) throw new Error("Review session ended.");
      return runQcOwnedRequest(viewerId!, lifetimeRef.current.signal,
        signal => openQcServiceCase(a.windowId, a.code, a.term, signal), a.attempt.signal);
    },
    onSuccess: (_result, a) => {
      if (!currentViewer(a.epoch, a.mark) || caseAttemptRef.current !== a.attempt) return;
      caseAttemptRef.current = null;
      pushToast(t("qcReview.serviceCaseOpened")); setCaseOffer(null);
    },
    onError: (e, a) => {
      if (currentViewer(a.epoch, a.mark) && caseAttemptRef.current === a.attempt) {
        caseAttemptRef.current = null; toastError(e);
      }
    },
  });
  const reviewPhoto = useMutation({
    mutationFn: (a: { openingId: string; epoch: number; mark: SignInMark }) => {
      if (!currentViewer(a.epoch, a.mark)) throw new Error("Review session ended.");
      return runQcOwnedRequest(viewerId!, lifetimeRef.current.signal, signal => reviewQcPhoto(a.openingId, signal));
    },
    onSuccess: (result, a) => {
      if (!currentViewer(a.epoch, a.mark)) return;
      setPhotoReviewFor(result.openingId); setPhotoReview(result); setPhotoReviewError(null);
    },
    onError: (error: unknown, a) => {
      if (!currentViewer(a.epoch, a.mark)) return;
      setPhotoReviewFor(a.openingId); setPhotoReview(null); setPhotoReviewError(formatApiError(error));
    },
  });

  if (!viewerId) return null;
  const safeViewerId: string = viewerId;

  if (!state.job) {
    return (
      <div ref={flowRef}>
        <h2>{t("qcReview.chooseJob")}</h2>
        <input
          type="search" maxLength={200} className="field" value={jobSearch}
          placeholder={t("qcReview.jobSearchPlaceholder")}
          onChange={(e) => setJobSearch(e.target.value)}
        />
        {jobsQuery.isLoading ? <p role="status">{t("qcReview.loadingJobs")}</p>
          : jobsQuery.isError ? (
            <div className="detail-card" role="alert">
              <p>{t("qcReview.jobsError")} {formatApiError(jobsQuery.error)}</p>
              <button type="button" className="button-like" onClick={() => void jobsQuery.refetch()}>{t("qcReview.retry")}</button>
            </div>
          ) : (
            <ul className="unit-list work-list">
              {jobRows.map((job) => (
                <li key={job.id} className="find-row">
                  <button type="button" className="button-like" style={{ width: "100%", textAlign: "left" }} onClick={() => chooseJob(job)}>
                    <strong>{job.jobCode}</strong> <span className="muted">{job.name}</span>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t("qcReview.queueCount", { n: job.queueCount })} · {t("qcReview.newCount", { n: job.newCount })} · {t("qcReview.callbackCount", { n: job.callbackCount })}
                    </div>
                  </button>
                </li>
              ))}
              {jobRows.length === 0 && <p className="muted">{t("qcReview.noJobs")}</p>}
            </ul>
          )}
        {jobsQuery.data?.hasMore && (
          <button type="button" className="button-like" disabled={jobsQuery.isFetching}
            onClick={() => jobsQuery.data?.nextCursor && setJobsAfter(jobsQuery.data.nextCursor)}>
            {t("qcReview.loadMoreJobs")}
          </button>
        )}
      </div>
    );
  }

  const jobLabel = jobsQuery.data?.selected;

  function renderUnitCard(unit: QcReviewUnit, pinned: boolean) {
    const isSelected = state.sel === unit.id;
    const draft = callbackDraft?.unit.id === unit.id ? callbackDraft : null;
    const pending = pendingDecision?.unit.id === unit.id ? pendingDecision : null;
    const receiptInfo = receiptFor(unit);
    const otherActionBusy = (blocked && !pending && !draft) || !confirmedRead || refreshRequired[unit.id] !== undefined;
    const canonical = pageQuery.data?.selected?.id === unit.id ? pageQuery.data.selected : rows.find(row => row.id === unit.id);
    const outOfQueue = isOutOfQueue(unit) || (confirmedRead && !canonical);
    const draftChanged = Boolean(draft && confirmedRead && canonical && canonical.reviewVersion !== draft.unit.reviewVersion);
    const displayStatus = receiptInfo && !receiptInfo.currentConfirmed ? receiptInfo.receipt.status : unit.qcStatus;
    const termFieldId = `qc-review-term-${unit.id}`;
    const noteFieldId = `qc-review-note-${unit.id}`;

    return (
      <li key={unit.id} className="find-row detail-card" style={{ flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ width: "100%" }}>
          {pinned && <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{t("qcReview.pinnedUnit")}</div>}
          <Link className="link" to={`/projects/${unit.projectId}/opening/${unit.id}`} aria-disabled={blocked} onClick={e => { if (blocked) e.preventDefault(); }}><strong>{unit.openingCode}</strong></Link>{" "}
          {unit.label && <span className="muted">{unit.label}</span>}{" "}
          <span className="muted">{unit.typeCode}</span>
          <div className={displayStatus === "passed" ? "ok" : displayStatus === "callback" ? "error" : "muted"} style={{ fontSize: 12 }}>
            {displayStatus ?? "pending"}
          </div>

          {outOfQueue && (
            <div role="status" style={{ margin: "6px 0" }}>
              <p className="muted">{t("qcReview.pinnedOutOfQueue")}</p>
              <button type="button" className="button-like" onClick={() => void pageQuery.refetch()}>{t("qcReview.refresh")}</button>
            </div>
          )}
          {refreshRequired[unit.id] !== undefined && !pending && (
            <div role="alert"><p>{t("qcReview.errorStale")}</p>
              <button type="button" className="button-like" disabled={pageQuery.isFetching}
                onClick={() => void pageQuery.refetch()}>{t("qcReview.refresh")}</button>
            </div>
          )}

          {receiptInfo && (
            <div role="status" style={{ margin: "6px 0" }}>
              <p>
                {receiptInfo.receipt.status === "passed" ? t("qcReview.savedReceiptPassed") : t("qcReview.savedReceiptCallback")}
                {receiptInfo.historical && " " + t("qcReview.savedReceiptHistorical")}
              </p>
            </div>
          )}

          <div className="row-gap" style={{ margin: "8px 0", flexWrap: "wrap" }}>
            <button type="button" className="button-like"
              data-qc-evidence-opener={unit.id}
              aria-expanded={isSelected}
              disabled={otherActionBusy && !isSelected}
              onClick={(e) => selectUnit(isSelected ? null : unit.id, e.currentTarget)}>
              {t("qcEvidence.open")}
            </button>
            <button type="button" className="button-like" disabled={reviewPhoto.isPending || (otherActionBusy)}
              onClick={() => { setPhotoReviewFor(unit.id); setPhotoReview(null); setPhotoReviewError(null); reviewPhoto.mutate({ openingId: unit.id, epoch: viewerEpochRef.current, mark: signInMark() }); }}>
              {reviewPhoto.isPending && reviewPhoto.variables?.openingId === unit.id ? t("qcReview.reviewingPhoto") : t("qcReview.aiPhotoReview")}
            </button>
            <button type="button" className="button-like qc-pass"
              disabled={Boolean(savedReceipts[unit.id]) || outOfQueue || savingRef.current || Boolean(pendingDecision) || Boolean(draft) || otherActionBusy}
              onClick={() => startDecision(unit, "passed", null)}>{t("qcReview.pass")}</button>
            <button type="button" className="button-like qc-callback"
              disabled={Boolean(savedReceipts[unit.id]) || outOfQueue || savingRef.current || Boolean(pendingDecision) || Boolean(draft) || otherActionBusy}
              onClick={() => { updateState({ sel: unit.id }); setCallbackDraft({ unit: { ...unit }, term: "", note: "" }); }}>
              {t("qcReview.callback")}
            </button>
          </div>

          {pending && !pending.errorKind && <p role="status">{t("qcReview.saving")}</p>}
          {pending?.errorKind && (
            <div className="detail-card" role="alert" style={{ marginBottom: 8 }}>
              <p>{pending.errorText}</p>
              {!draft && pending.command.note && <p>{t("qcReview.submittedNote")}: {pending.command.note}</p>}
              {pending.errorKind !== "unknown" ? (
                <div className="row-gap">
                  {(pending.errorKind === "unavailable") && (
                    <button type="button" className="button-like" onClick={retryPendingDecision}>{t("qcReview.retryDecision")}</button>
                  )}
                  {(pending.errorKind === "stale" || pending.errorKind === "conflict") && (
                    <button type="button" className="button-like" onClick={() => { cancelPendingDecision(); void pageQuery.refetch(); }}>{t("qcReview.refresh")}</button>
                  )}
                  <button type="button" className="button-like" onClick={cancelPendingDecision}>{t("qcReview.cancelDecision")}</button>
                </div>
              ) : (
                <div className="row-gap">
                  <p className="muted">{t("qcReview.cannotCancelAmbiguous")}</p>
                  <button type="button" className="button-like" onClick={retryPendingDecision}>{t("qcReview.retryDecision")}</button>
                </div>
              )}
            </div>
          )}

          {photoReviewFor === unit.id && (photoReview || photoReviewError) && (
            <div className="detail-card" style={{ marginBottom: 8 }}>
              <strong>Photo review suggestion</strong>
              {photoReviewError ? <p className="muted">{photoReviewError}</p> : photoReview && (
                <>
                  <p>{photoReview.review.summary}</p>
                  {photoReview.review.visible_checks.length > 0 && <>
                    <strong>{t("qcReview.visibleChecks")}</strong>
                    <ul>{photoReview.review.visible_checks.map((item, i) => <li key={i}>{item}</li>)}</ul>
                  </>}
                  {photoReview.review.questions_for_foreman.length > 0 && <>
                    <strong>{t("qcReview.questionsForForeman")}</strong>
                    <ul>{photoReview.review.questions_for_foreman.map((item, i) => <li key={i}>{item}</li>)}</ul>
                  </>}
                  <p className="muted" style={{ fontSize: 12 }}>{photoReview.review.limitation}</p>
                  <p className="muted" style={{ fontSize: 12 }}>
                    {t("qcReview.photoBasedOn", { date: new Date(photoReview.photoCreatedAt).toLocaleString() })}
                  </p>
                </>
              )}
            </div>
          )}

          {draft && (
            <div className="detail-card" style={{ marginBottom: 8 }}>
              {draftChanged && <div role="alert">
                <p>{t("qcReview.draftChanged")}</p>
                <button type="button" className="button-like" disabled={Boolean(pending) || otherActionBusy || outOfQueue}
                  onClick={() => { if (canonical) setCallbackDraft({ ...draft, unit: { ...canonical } }); }}>
                  {t("qcReview.reviewCurrentDecision")}
                </button>
              </div>}
              <label className="field-label" htmlFor={termFieldId}>{t("qcReview.termFieldLabel")}</label>
              <select id={termFieldId} aria-label={t("qcReview.termFieldLabel")} value={draft.term} disabled={Boolean(pending)}
                onChange={(e) => setCallbackDraft({ ...draft, term: e.target.value })}>
                <option value="">{t("qcReview.pickTerm")}</option>
                {CATS.map((c) => (
                  <optgroup key={c.id} label={c.label}>
                    {TERMS.filter((term) => term.cat === c.id).map((term) => (
                      <option key={term.id} value={term.id}>{term.term}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <label className="field-label" htmlFor={noteFieldId}>{t("qcReview.noteFieldLabel")}</label>
              <textarea id={noteFieldId} maxLength={4000} aria-label={t("qcReview.noteFieldLabel")} value={draft.note} disabled={Boolean(pending)}
                onChange={(e) => setCallbackDraft({ ...draft, note: e.target.value })} />
              {Boolean(pending) && <p className="muted" style={{ fontSize: 12 }}>{t("qcReview.draftLocked")}</p>}
              <div className="row-gap">
                <button type="button" className="primary big" disabled={savingRef.current || Boolean(pending) || otherActionBusy || draftChanged || outOfQueue}
                  onClick={() => startDecision(draft.unit, "callback", draft.note, draft.term)}>{t("qcReview.logCallback")}</button>
                <button type="button" className="button-like" disabled={Boolean(pending)} onClick={() => setCallbackDraft(null)}>{t("qcReview.cancel")}</button>
              </div>
            </div>
          )}


        </div>
      </li>
    );
  }

  return (
    <div ref={flowRef}>
      <div className="row-gap" style={{ justifyContent: "space-between", flexWrap: "wrap", marginBottom: 8 }}>
        <strong>{jobLabel ? `${jobLabel.jobCode} · ${jobLabel.name}` : t("qcReview.chooseJob")}</strong>
        <button type="button" className="button-like" data-qc-change-job disabled={blocked} onClick={changeJob}>{t("qcReview.changeJob")}</button>
      </div>
      {localSaveError && <div role="alert" className="detail-card"><p>{localSaveError}</p></div>}
      {navError && <p role="alert">{navError}</p>}

      {caseOffer && (
        <div className="detail-card" style={{ marginBottom: 12 }}>
          <strong>{t("qcReview.openServiceCasePrompt", { code: caseOffer.code })}</strong>
          <p className="muted" style={{ margin: "4px 0 8px" }}>{t("qcReview.openServiceCaseHint")}</p>
          <div className="row-gap">
            <button className="primary big" disabled={openCase.isPending}
              onClick={() => { const attempt = new AbortController(); caseAttemptRef.current = attempt;
                openCase.mutate({ ...caseOffer, epoch: viewerEpochRef.current, mark: signInMark(), attempt }); }}>{t("qcReview.openServiceCase")}</button>
            <button className="button-like" onClick={dismissCase}>{t("qcReview.notNow")}</button>
          </div>
        </div>
      )}

      {learningPending && <div className="detail-card" role="status">
        <p>{t("qcReview.learningPending")}</p>
        <button className="button-like" onClick={dismissLearning}>{t("qcReview.skipLearning")}</button>
      </div>}
      {learningRetry && !learningPending && (
        <div className="detail-card" role="alert" style={{ marginBottom: 12 }}>
          <p>{t("qcReview.decisionAlreadyRecorded")} {learningRetry.error}</p>
          <button className="button-like" disabled={learningPending} onClick={() => void retryLearning()}>{t("qcReview.retryLearning")}</button>
          <button className="button-like" onClick={dismissLearning}>{t("qcReview.skipLearning")}</button>
        </div>
      )}

      <div className="row-gap" role="group" aria-label="Filter" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        {(["all", "new", "callbacks"] as const).map((f) => (
          <button key={f} type="button" disabled={blocked} className={state.filter === f ? "primary" : "button-like"} onClick={() => setFilter(f)}>
            {t(f === "all" ? "qcReview.filterAll" : f === "new" ? "qcReview.filterNew" : "qcReview.filterCallbacks")}
          </button>
        ))}
        <input type="search" maxLength={200} className="field" disabled={blocked} value={state.search}
          placeholder={t("qcReview.searchPlaceholder")} onChange={(e) => setSearchText(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
      </div>

      {selectedUnit && <section aria-label={t("qcReview.selectedReview")}>
        <ul className="unit-list work-list">{renderUnitCard(selectedUnit, true)}</ul>
        <div className="row-gap" style={{ margin: "8px 0", justifyContent: "space-between" }}>
          <button type="button" className="button-like" disabled={blocked || pageQuery.isFetching || pageQuery.isError}
            onClick={() => void goAdjacent(-1)}>{t("qcReview.previous")}</button>
          <button type="button" className="button-like" disabled={blocked || pageQuery.isFetching || pageQuery.isError}
            onClick={() => void goAdjacent(1)}>{t("qcReview.next")}</button>
        </div>
        <QcUnitEvidence key={safeViewerId + ":" + selectedUnit.id}
          openingId={selectedUnit.id} projectId={selectedUnit.projectId} viewerId={safeViewerId}
          panelId={"qc-review-evidence-" + selectedUnit.id} history={false} onClose={() => selectUnit(null)} />
      </section>}
      {pageQuery.isLoading ? <p role="status">{t("qcReview.loading")}</p>
        : pageQuery.isError ? (
          <div className="detail-card" role="alert">
            <p>{t("qcReview.loadError")} {formatApiError(pageQuery.error)}</p>
            <button type="button" className="button-like" onClick={() => void pageQuery.refetch()}>{t("qcReview.retry")}</button>
          </div>
        ) : (
          <>
            <p className="muted">{t("qcReview.showingCount", { shown: rows.length, total: pageQuery.data?.totalCount ?? 0 })}</p>
            <details open={!selectedUnit}>
              <summary>{t("qcReview.unitList")}</summary>
              <ul className="unit-list work-list">
              {rows.filter(unit => unit.id !== selectedUnit?.id).map((unit) => renderUnitCard(unit, false))}
              {rows.length === 0 && !selectedUnit && <p className="muted">{t("qcReview.noUnits")}</p>}
              </ul>
            </details>
          </>
        )}
    </div>
  );
}
