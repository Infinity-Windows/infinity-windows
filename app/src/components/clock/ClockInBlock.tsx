// The one big clock-in spot, on every landing (standard-tracking-jobs slice 1).
//
// WHY (owner ask, 2026-09-02): clocking in was three different treatments — a
// rich morning hero on My Work, a small card on Home, nothing on Heartbeat.
// This is ONE component mounted at the top of all three, the same way
// LiveSummonsStrip rides every landing: big and can't-miss OFF the clock, and a
// slim status bar ON the clock (current job, a live timer, Switch, Clock out).
//
// It does NOT fork the time logic: it calls the same clockIn RPC and the same
// cost-code / recent-job reads the clock sheet uses, and hands OFF to the full
// clock sheet (offline outbox, toolbox sign-off, injury flag on clock-out) for
// everything that already lives there. The sheet stays the single owner of the
// complex, safety-relevant flows — this block is the front door to them.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { getMyProfile } from "../../lib/install/api";
import { listProjects } from "../../lib/api";
import { getTodayTalk } from "../../lib/ops";
import { myTodayCompletion } from "../../lib/toolbox";
import { captureGeoSoft } from "../../lib/geo";
import { farFromJob, type DeviceFix } from "../../lib/jobProximity";
import { toastSuccess } from "../../lib/toast";
import { openClockGlobally } from "../../lib/clockContext";
import {
  clockIn,
  elapsedWorkSeconds,
  formatClock,
  getJobLastGeo,
  getOpenShift,
  isOnTheClock,
  listCostCodes,
  listRecentJobs,
} from "../../lib/timeclock";
import { useT } from "../../lib/i18n";
import { effectiveClockInMode, normalizeModes, type JobMode } from "../../lib/jobModes";

export function ClockInBlock() {
  const t = useT();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const profileId = me.data?.id ?? null;

  // Shares the exact query key the clock provider polls, so the block and the
  // nav timer always agree without a second poll of their own.
  const openShift = useQuery({
    queryKey: ["openShift", profileId],
    queryFn: () => getOpenShift(profileId!),
    enabled: Boolean(profileId),
  });
  const costCodes = useQuery({ queryKey: ["costCodes"], queryFn: listCostCodes });
  const recents = useQuery({
    queryKey: ["recentJobs", profileId],
    queryFn: () => listRecentJobs(profileId!),
    enabled: Boolean(profileId),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Today's toolbox talk and whether this person signed it — only relevant off
  // the clock (the first clock-in of the day is the gate).
  const todayTalk = useQuery({
    queryKey: ["todayTalk"],
    queryFn: getTodayTalk,
    enabled: !openShift.data,
  });
  const toolboxDone = useQuery({
    queryKey: ["toolboxToday", profileId],
    queryFn: () => myTodayCompletion(profileId!),
    enabled: Boolean(profileId) && !openShift.data,
  });

  const [pickProjectId, setPickProjectId] = useState<string>("");
  const [pickCostCodeId, setPickCostCodeId] = useState<string>("");
  // The mode a worker picks when the chosen job allows BOTH data and tracking
  // (standard-tracking-jobs slice 2). Only shown for a both-mode job; a
  // single-mode job records its one mode silently. Defaults to install work.
  const [pickedMode, setPickedMode] = useState<JobMode>("data");
  const [search, setSearch] = useState("");
  const [showFullList, setShowFullList] = useState(false);
  // Optional free-text the worker adds for the office. It rides the existing
  // time_shifts.note column — clockIn has always carried it; the UI just never
  // offered a box for it until now.
  const [note, setNote] = useState("");
  const [now, setNow] = useState(Date.now());
  // The device's current fix, captured ONLY when geolocation is already
  // permitted — the advisory must never trigger its own permission prompt.
  const [myGeo, setMyGeo] = useState<DeviceFix | null>(null);
  const primedRef = useRef(false);
  const geoTriedRef = useRef(false);

  // Where this job's clock-ins have happened — the reference for "near the
  // job". Only worth fetching once we have a fix to compare it against.
  const jobGeo = useQuery({
    queryKey: ["jobLastGeo", pickProjectId],
    queryFn: () => getJobLastGeo(pickProjectId),
    enabled: Boolean(pickProjectId) && Boolean(myGeo) && !openShift.data,
  });

  const shift = openShift.data ?? null;
  const onClock = isOnTheClock(shift);

  // 1s tick drives the live timer (only meaningful on the clock).
  useEffect(() => {
    if (!onClock) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [onClock]);

  // Prime the picker with the most recent job so "Clock in" is one tap for the
  // common case. Runs once, and never while a shift is open.
  useEffect(() => {
    if (primedRef.current || shift) return;
    const r = recents.data?.[0];
    if (!r) return;
    primedRef.current = true;
    setPickProjectId(r.projectId);
    if (r.costCodeId) setPickCostCodeId(r.costCodeId);
  }, [recents.data, shift]);

  // Capture the current fix ONCE, and only when geolocation is already granted —
  // the "not near this job" note must never trigger its own permission prompt.
  // Off the clock only. clock-in itself still stamps geo via captureGeoSoft.
  useEffect(() => {
    if (geoTriedRef.current || openShift.data) return;
    geoTriedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const perms = (navigator as Navigator & { permissions?: Permissions })
          .permissions;
        if (!perms?.query) return;
        const status = await perms.query({
          name: "geolocation" as PermissionName,
        });
        if (status.state !== "granted") return;
        const fix = await captureGeoSoft();
        if (!cancelled && fix.lat != null && fix.lng != null) {
          setMyGeo({ lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM });
        }
      } catch {
        /* no advisory without a fix — never blocks the clock-in */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openShift.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["openShift"] });
    void queryClient.invalidateQueries({ queryKey: ["myShifts"] });
    void queryClient.invalidateQueries({ queryKey: ["recentJobs"] });
  };

  // The chosen job's declared modes drive the mode step below and what the
  // shift records. A both-mode job asks; a single-mode job records its one mode
  // silently; a job we can't read a mode for records nothing.
  const chosenProject = (projects.data ?? []).find((p) => p.id === pickProjectId);
  const chosenModes = normalizeModes(chosenProject?.allowed_modes);
  const isBothMode = chosenModes.length >= 2;
  const effectiveMode = effectiveClockInMode(chosenProject?.allowed_modes, pickedMode);

  const doStart = useMutation({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      await clockIn(
        pickProjectId || null,
        pickCostCodeId || null,
        geo,
        note.trim() || null,
        effectiveMode,
      );
    },
    onSuccess: () => {
      toastSuccess(t("clock.action.clockingIn"));
      refresh();
    },
    // Whatever went wrong — offline, or the server's toolbox gate — the clock
    // sheet is the full path (outbox, pickers, sign today's talk). Hand off
    // rather than fork any of that here.
    onError: () => openClockGlobally(),
  });

  const filteredProjects = useMemo(() => {
    const list = projects.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) =>
      `${p.job_code} ${p.name} ${p.address ?? ""}`.toLowerCase().includes(q),
    );
  }, [projects.data, search]);

  // Not signed in yet (or the profile is still resolving): render nothing rather
  // than a half-built card. In the running app the provider has this cached, so
  // there is no flash.
  if (!profileId) return null;

  // ---- ON THE CLOCK: a slim status bar. Switch / Clock out open the full
  // sheet, which owns the injury flag and the runaway-shift finish guard. ----
  if (shift && onClock) {
    const workSec = elapsedWorkSeconds(shift, now);
    const jobLine = shift.projects
      ? `${shift.projects.job_code} · ${shift.projects.name}`
      : t("clock.status.working");
    return (
      <section className="clockin-bar" aria-label={t("clockblock.onClock")}>
        <span className="clockin-live-dot" aria-hidden />
        <div className="clockin-bar-job">
          <span className="clockin-bar-label">{t("clockblock.onClock")}</span>
          <span className="clockin-bar-name">{jobLine}</span>
        </div>
        <span className="clockin-bar-timer" aria-label="Time worked">
          {formatClock(workSec)}
        </span>
        <div className="clockin-bar-actions">
          <button type="button" className="button-like" onClick={openClockGlobally}>
            {t("clockblock.switch")}
          </button>
          <button
            type="button"
            className="button-like active-pill"
            onClick={openClockGlobally}
          >
            {t("clock.action.clockOut")}
          </button>
        </div>
      </section>
    );
  }

  // A shift the server stopped counting: not "on the clock", but unresolved.
  // The sheet asks "when did you finish"; the block just points there.
  if (shift && shift.status === "needs_finish") {
    return (
      <section className="clockin-bar needs-finish" aria-label={t("clockblock.needsFinish")}>
        <div className="clockin-bar-job">
          <span className="clockin-bar-label">{t("clockblock.needsFinish")}</span>
          <span className="clockin-bar-name">{t("clockblock.needsFinishSub")}</span>
        </div>
        <div className="clockin-bar-actions">
          <button
            type="button"
            className="button-like active-pill"
            onClick={openClockGlobally}
          >
            {t("clock.action.saveFinish")}
          </button>
        </div>
      </section>
    );
  }

  // ---- OFF THE CLOCK: the big, can't-miss block. ----
  const busy = doStart.isPending;
  const canStart = Boolean(pickProjectId && pickCostCodeId);
  // The server refuses the first clock-in of the day without today's signed
  // toolbox talk. Hold the button only when we POSITIVELY know a talk exists
  // today and isn't signed; if the talk itself couldn't load, fail OPEN and let
  // the server (or the sheet) sort it out. Signing lives in the clock sheet's
  // ToolboxSignCard, so a held button routes there rather than embedding a
  // second copy of the sign-off here.
  const toolboxKnownUnsigned =
    todayTalk.isSuccess &&
    todayTalk.data !== null &&
    toolboxDone.isSuccess &&
    !toolboxDone.data;
  // SOFT, advisory only: far from where this job's clock-ins happen. Never
  // disables the button — a real reason to clock in off-site is common enough
  // (staging, the shop, a bad address) that this only ever whispers.
  const showFarNote = farFromJob(myGeo, jobGeo.data ?? null);

  return (
    <section className="clockin-block" aria-label={t("clockblock.title")}>
      <div>
        <h2 className="clockin-block-title">{t("clockblock.title")}</h2>
        <p className="clockin-block-sub">{t("clockblock.subtitle")}</p>
      </div>

      {/* Recent jobs — one tap sets the job and its last cost code. */}
      {(recents.data?.length ?? 0) > 0 && (
        <div className="clock-chip-row-wrap">
          <p className="clock-row-label">{t("clock.label.recentJobs")}</p>
          <div className="clock-chip-row">
            {(recents.data ?? []).map((r) => {
              const selected = pickProjectId === r.projectId;
              return (
                <button
                  key={r.projectId}
                  type="button"
                  className={selected ? "clock-chip current" : "clock-chip"}
                  onClick={() => {
                    setPickProjectId(r.projectId);
                    if (r.costCodeId) setPickCostCodeId(r.costCodeId);
                  }}
                >
                  {r.jobCode || r.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* The full job list, searchable — for anything not in the recent chips. */}
      <button
        type="button"
        className="clock-list-toggle"
        onClick={() => setShowFullList((v) => !v)}
      >
        {showFullList ? t("clock.label.hideJobList") : t("clock.label.chooseDifferentJob")}
      </button>
      {showFullList && (
        <div className="clock-picker">
          <input
            className="clock-search"
            placeholder={t("clock.search.jobs")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="clock-project-list">
            {filteredProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={
                  pickProjectId === p.id
                    ? "clock-project-item selected"
                    : "clock-project-item"
                }
                onClick={() => setPickProjectId(p.id)}
              >
                <span className="clock-project-code">{p.job_code}</span>
                <span className="clock-project-name">{p.name}</span>
              </button>
            ))}
            {filteredProjects.length === 0 && (
              <p className="muted">{t("clock.search.noJobs", { q: search })}</p>
            )}
          </div>
        </div>
      )}

      {/* Cost code — REQUIRED; Start stays disabled until one is picked. */}
      <p className="clock-row-label">{t("clock.label.costCode")}</p>
      <div className="clock-costcode-list">
        {(costCodes.data ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            className={
              pickCostCodeId === c.id
                ? "clock-costcode-item selected"
                : "clock-costcode-item"
            }
            onClick={() => setPickCostCodeId(c.id)}
          >
            <span className="clock-costcode-code">
              {c.code} — {c.label}
            </span>
            {c.description && (
              <span className="clock-costcode-desc">{c.description}</span>
            )}
          </button>
        ))}
      </div>

      {/* ---- Mode step (slice 2) ---------------------------------------------
          A both-mode job (one that allows BOTH the full data loop and lighter
          tracking) asks which you're here to do; the shift records the pick. A
          single-mode job records its one mode silently, so nothing shows here. */}
      {isBothMode && (
        <>
          <p className="clock-row-label">{t("clockblock.mode.label")}</p>
          <div className="clock-costcode-list">
            <button
              type="button"
              className={
                pickedMode === "data"
                  ? "clock-costcode-item selected"
                  : "clock-costcode-item"
              }
              aria-pressed={pickedMode === "data"}
              onClick={() => setPickedMode("data")}
            >
              <span className="clock-costcode-code">{t("clockblock.mode.data")}</span>
            </button>
            <button
              type="button"
              className={
                pickedMode === "tracking"
                  ? "clock-costcode-item selected"
                  : "clock-costcode-item"
              }
              aria-pressed={pickedMode === "tracking"}
              onClick={() => setPickedMode("tracking")}
            >
              <span className="clock-costcode-code">{t("clockblock.mode.tracking")}</span>
            </button>
          </div>
        </>
      )}

      {/* Optional note for the office — persists to time_shifts.note. */}
      <label className="clock-row-label" htmlFor="clockin-block-note">
        {t("clock.label.notesOffice")}
      </label>
      <textarea
        id="clockin-block-note"
        className="clock-note-input"
        rows={2}
        maxLength={1000}
        placeholder={t("clockblock.notePlaceholder")}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {showFarNote && <p className="clockin-note">{t("clockblock.notNearJob")}</p>}

      {toolboxKnownUnsigned ? (
        <>
          {/* SAFETY / toolbox — needs bilingual review. */}
          <p className="clockin-note">{t("clockblock.signFirst")}</p>
          <button
            type="button"
            className="clock-btn primary big"
            disabled={!canStart}
            onClick={openClockGlobally}
          >
            <Play size={18} aria-hidden /> {t("clockblock.signAndClockIn")}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="clock-btn primary big"
          disabled={busy || !canStart}
          onClick={() => doStart.mutate()}
        >
          {busy ? (
            t("clock.action.clockingIn")
          ) : (
            <>
              <Play size={18} aria-hidden /> {t("clock.action.startClock")}
            </>
          )}
        </button>
      )}
      {/* Everything the sheet does and this block doesn't (pick a different job
          via search, sign the talk, go offline) is one tap away. */}
      <button type="button" className="clock-list-toggle" onClick={openClockGlobally}>
        {t("clockblock.moreOptions")}
      </button>
    </section>
  );
}
