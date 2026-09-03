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

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { getMyProfile } from "../../lib/install/api";
import { captureGeoSoft } from "../../lib/geo";
import { toastSuccess } from "../../lib/toast";
import { openClockGlobally } from "../../lib/clockContext";
import {
  clockIn,
  elapsedWorkSeconds,
  formatClock,
  getOpenShift,
  isOnTheClock,
  listCostCodes,
  listRecentJobs,
} from "../../lib/timeclock";
import { useT } from "../../lib/i18n";

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

  const [pickProjectId, setPickProjectId] = useState<string>("");
  const [pickCostCodeId, setPickCostCodeId] = useState<string>("");
  const [now, setNow] = useState(Date.now());
  const primedRef = useRef(false);

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

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["openShift"] });
    void queryClient.invalidateQueries({ queryKey: ["myShifts"] });
    void queryClient.invalidateQueries({ queryKey: ["recentJobs"] });
  };

  const doStart = useMutation({
    mutationFn: async () => {
      const geo = await captureGeoSoft();
      await clockIn(pickProjectId || null, pickCostCodeId || null, geo, null);
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
      {/* Everything the sheet does and this block doesn't (pick a different job
          via search, sign the talk, go offline) is one tap away. */}
      <button type="button" className="clock-list-toggle" onClick={openClockGlobally}>
        {t("clockblock.moreOptions")}
      </button>
    </section>
  );
}
