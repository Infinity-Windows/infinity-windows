import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UnitContributorsPanel } from "../../components/work/UnitContributorsPanel";
import { signInMark, stillSignedInAs, subscribeSignedIn } from "../../lib/signedIn";
import { useViewAsRole } from "../../lib/viewAsRoleContext";
import { getRealProfile } from "../../lib/install/api";
import { fetchActivityCatalog } from "../../lib/workActivity/catalogApi";
import { fetchActivityUnitBasis } from "../../lib/workActivity/api";
import { createUnitReviewSelectionSource, REVIEW_FRESH_MS, type UnitReviewSelectionSource } from "../../lib/workUnitReview/selection";
import { useUnitContributors } from "../../lib/workUnitContributions/useUnitContributors";
import type { UnitContributorsScope } from "../../lib/workUnitContributions/api";

type Profile = Awaited<ReturnType<typeof getRealProfile>>;
export interface SelectedUnitContributorsProps {
  projectId: string;
  unitId: string | null;
  /** Parent increments on every human selection, including equal-ID ABA. */
  selectionRevision: string | number;
  enabled: boolean;
  /** Reads the parent's live selection/lifetime, never a captured true. */
  admitted: () => boolean;
  locale: "en" | "es";
  /** Parent publishes before navigation or canonical-source replacement. */
  invalidationSource?: UnitReviewSelectionSource;
}
interface CheckedUnit { scope: UnitContributorsScope; revision: number; current: () => boolean }
const profileStamp = (state: ReturnType<ReturnType<typeof useQueryClient>["getQueryState"]>) =>
  JSON.stringify([state?.dataUpdateCount, state?.errorUpdateCount, state?.status,
    state?.fetchStatus, state?.isInvalidated, state?.dataUpdatedAt]);

/** Dormant manual reader. No route/selection/remount/focus can initiate a
 * contributor RPC. Check first obtains two independently matching canonical
 * unit reads, then binds the contributor snapshot to their incarnation. */
export function SelectedUnitContributors(props: SelectedUnitContributorsProps) {
  const qc = useQueryClient(), preview = useViewAsRole().sensitiveLifetime;
  const [source] = useState(createUnitReviewSelectionSource);
  const [checked, setChecked] = useState<CheckedUnit | null>(null);
  const [status, setStatus] = useState<"held" | "loading" | "unavailable">("held");
  const lifetime = useRef({ alive: false, epoch: 0 });
  const deadline = useRef<number | null>(null);
  const key = JSON.stringify([props.projectId, props.unitId, props.selectionRevision, props.enabled]);
  const liveKey = useRef(key), admission = useRef(props.admitted);
  // A pending response cannot use an old selection during its layout commit.
  liveKey.current = key;
  useLayoutEffect(() => { admission.current = props.admitted; });
  const invalidate = useCallback(() => {
    if (deadline.current !== null) window.clearTimeout(deadline.current);
    lifetime.current.epoch++; source.invalidate(); setChecked(null); setStatus("held");
  }, [source]);
  useLayoutEffect(() => { invalidate(); }, [key, invalidate]);
  useLayoutEffect(() => {
    const currentLifetime = lifetime.current;
    currentLifetime.alive = true;
    const close = () => invalidate();
    const profileClose = qc.getQueryCache().subscribe(event => {
      if ((event.type === "updated" || event.type === "removed")
        && JSON.stringify(event.query.queryKey) === '["myRealProfile"]') close();
    });
    const authClose = subscribeSignedIn(close), previewClose = preview?.subscribe(close);
    const parentClose = props.invalidationSource?.subscribe(close);
    for (const event of ["online", "offline", "pagehide", "pageshow", "popstate", "focus"]) window.addEventListener(event, close);
    document.addEventListener("visibilitychange", close);
    return () => {
      if (deadline.current !== null) window.clearTimeout(deadline.current);
      currentLifetime.alive = false; currentLifetime.epoch++; source.invalidate();
      profileClose(); authClose(); previewClose?.(); parentClose?.();
      for (const event of ["online", "offline", "pagehide", "pageshow", "popstate", "focus"]) window.removeEventListener(event, close);
      document.removeEventListener("visibilitychange", close);
    };
  }, [invalidate, preview, qc, source, props.invalidationSource]);
  const admitted = () => !!checked && liveKey.current === key && checked.current();
  const read = useUnitContributors(admitted() ? checked!.scope : null, source, admitted, checked?.revision ?? -1);

  async function check() {
    invalidate(); setStatus("loading");
    let epoch = lifetime.current.epoch;
    const started = performance.now(), login = signInMark();
    let profile = qc.getQueryState<Profile>(["myRealProfile"]), person = profile?.data;
    let stamp = profileStamp(profile), previewRevision = preview?.getSnapshot();
    const projectId = props.projectId, unitId = props.unitId;
    const current = (requireFreshProfile = true) => {
      try {
        const p = qc.getQueryState<Profile>(["myRealProfile"]), elapsed = performance.now() - started;
        return lifetime.current.alive && lifetime.current.epoch === epoch && liveKey.current === key
          && props.enabled && !!unitId && !!login.userId && stillSignedInAs(login, login.userId)
          && navigator.onLine !== false && document.visibilityState !== "hidden"
          && elapsed >= 0 && elapsed < REVIEW_FRESH_MS && admission.current()
          && !!preview && preview.getSnapshot() === previewRevision && !!person && person.id === login.userId
          && (person.role === "owner" || person.role === "supervisor") && !person.retired_at
          && preview.admitted(login.userId, person.role) && p?.data === person && profileStamp(p) === stamp
          && p.status === "success" && p.fetchStatus === "idle" && !p.isInvalidated
          && Date.now() >= p.dataUpdatedAt && (!requireFreshProfile || Date.now() - p.dataUpdatedAt < REVIEW_FRESH_MS);
      } catch { return false; }
    };
    const armDeadline = (ms: number) => {
      if (deadline.current !== null) window.clearTimeout(deadline.current);
      const armedEpoch = epoch;
      deadline.current = window.setTimeout(() => { if (lifetime.current.epoch === armedEpoch) invalidate(); }, Math.max(0, ms));
    };
    armDeadline(REVIEW_FRESH_MS);
    try {
      // A stale but unchanged cache can authorize a bounded profile refresh,
      // never a named read. Do not publish a late profile across any ABA.
      if (!current(false)) throw Error("held");
      if (Date.now() - profile!.dataUpdatedAt >= REVIEW_FRESH_MS) {
        const refreshed = await getRealProfile();
        if (!current(false) || !refreshed || refreshed.id !== login.userId
          || (refreshed.role !== "owner" && refreshed.role !== "supervisor") || refreshed.retired_at) throw Error("held");
        // These synchronous profile notifications intentionally close the old
        // Check. Capture the new lifetime only after our verified refresh.
        qc.setQueryData(["myRealProfile"], refreshed);
        epoch = lifetime.current.epoch;
        profile = qc.getQueryState<Profile>(["myRealProfile"]); person = profile?.data;
        stamp = profileStamp(profile); previewRevision = preview?.getSnapshot();
        setStatus("loading");
      }
      armDeadline(Math.min(REVIEW_FRESH_MS - (performance.now() - started),
        (profile?.dataUpdatedAt ?? 0) + REVIEW_FRESH_MS - Date.now()));
      if (!current()) throw Error("held");
      const catalog = await fetchActivityCatalog(projectId, unitId!, login);
      if (!current() || catalog.availability !== "available" || catalog.projectId !== projectId
        || catalog.unit?.id !== unitId) throw Error("held");
      const basis = await fetchActivityUnitBasis(unitId!, login);
      if (!current() || basis.availability !== "available" || basis.unit.projectId !== projectId
        || basis.unit.id !== unitId || JSON.stringify(catalog.unit) !== JSON.stringify(basis.unit)) throw Error("held");
      const scope = { projectId, unitId: unitId!, unitIncarnation: String(basis.unit.incarnationEpoch) };
      source.select({ login, realRole: person!.role, selectedJobId: projectId, selectedUnitId: unitId!,
        binding: { projectId: basis.unit.projectId, unitId: basis.unit.id }, admitted: () => current() });
      if (!current()) throw Error("held");
      setChecked({ scope, revision: epoch, current: () => current() }); setStatus("held");
    } catch {
      if (lifetime.current.alive && lifetime.current.epoch === epoch) {
        if (deadline.current !== null) window.clearTimeout(deadline.current);
        source.invalidate(); setChecked(null); setStatus("unavailable");
      }
    }
  }
  const currentProfile = qc.getQueryData<Profile>(["myRealProfile"]);
  const visible = !!currentProfile && currentProfile.id === signInMark().userId && !currentProfile.retired_at
    && (currentProfile.role === "owner" || currentProfile.role === "supervisor") && !!preview && !preview.hasPreview();
  if (!props.enabled || !props.unitId || !visible) return null;
  const safeRead = status === "loading" ? { state: "loading" as const, data: null }
    : !admitted() ? { state: status === "unavailable" ? "unavailable" as const : "held" as const, data: null }
    : read;
  return <UnitContributorsPanel locale={props.locale} read={safeRead} onCheck={() => void check()}
    disabled={!props.enabled || !props.unitId} busy={safeRead.state === "loading"} />;
}
