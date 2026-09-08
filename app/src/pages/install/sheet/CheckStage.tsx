// STAGE 1 of the unit sheet (S7): everything before the clock starts —
// briefing, physical window, rough opening, condition, before photo,
// flashing status. Moved out of OpeningSheet.tsx unchanged; every handler,
// effect and mutation still lives in the router (OpeningSheet.tsx) and
// arrives here as a prop. See installer-os-spec.md S7 and
// pages/install/sheet/README.md for the file layout this belongs to.
import { Link } from "react-router-dom";
import { useT } from "../../../lib/i18n";
import { Scanner } from "../../../components/Scanner";
import { PhotoCaptureSheet, type BeforeAfterValue } from "../../../components/PhotoCaptureSheet";
import type { WindowUnit } from "../../../lib/types";
import { formatAssignMeta } from "../../../lib/install/assignRank";
import type { TypeBrainStats } from "../../../lib/install/api";
import type { FitResult } from "../../../lib/install/fit";
import { roFailures, type RoCheckId, type RoJudgment, type RoVerdict } from "../../../lib/install/roCheck";
import type { OpeningPhase } from "../../../lib/install/phases";
import type { ProjectOpening } from "../../../lib/install/types";
import { formatPhaseClock, phaseElapsedSeconds } from "../../../lib/install/phases";
import type { QrPayload } from "../../../lib/qr";
import { FlashingWayOut } from "./FlashingWayOut";
import { SheetMore, type SheetMoreProps } from "./SheetMore";

/**
 * The teach-by-picture for each rough-opening check: the opening as a frame,
 * with the measurement drawn the way you'd make it - X across the diagonals
 * for square, top/bottom lines for width, left/right lines for height.
 */
function RoDiagram({ kind }: { kind: RoCheckId }) {
  const frame = (
    <rect x="7" y="5" width="34" height="52" rx="2" fill="none"
      stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" />
  );
  return (
    <svg
      className="ro-diagram"
      viewBox="0 0 48 62"
      width="44"
      height="57"
      aria-hidden
    >
      {frame}
      {kind === "square" && (
        <g stroke="#ff9a6a" strokeWidth="2.5" strokeLinecap="round">
          <line x1="9" y1="7" x2="39" y2="55" />
          <line x1="39" y1="7" x2="9" y2="55" />
        </g>
      )}
      {kind === "width" && (
        <g stroke="#ff9a6a" strokeWidth="2.5" strokeLinecap="round">
          <line x1="9" y1="12" x2="39" y2="12" />
          <line x1="9" y1="50" x2="39" y2="50" />
        </g>
      )}
      {kind === "height" && (
        <g stroke="#ff9a6a" strokeWidth="2.5" strokeLinecap="round">
          <line x1="13" y1="7" x2="13" y2="55" />
          <line x1="35" y1="7" x2="35" y2="55" />
        </g>
      )}
    </svg>
  );
}

/**
 * Placeholder for one height input slot. `roH` is `[left, ...mids, right]`
 * (roCheck.ts) - length tells us how many mid points are showing, position
 * tells us which one this is. A 2-slot array (every saved check before this
 * feature, and every narrow opening since) reads exactly as it always did.
 */
function heightLabel(index: number, length: number): string {
  if (length <= 2) return index === 0 ? "left" : "right";
  if (index === 0) return "left";
  if (index === length - 1) return "right";
  if (length === 3) return "mid";
  return index === 1 ? "mid-left" : "mid-right";
}

export interface CheckStageProps {
  projectId: string;
  opening: ProjectOpening;
  typeMatches: boolean;
  fit: FitResult;
  hasRoNumbers: boolean;
  roHasBadTap: boolean;
  quickCheckWho: string;

  brain: TypeBrainStats | undefined;
  tips: string[];
  watchOuts: string[];

  // Physical window
  scanOpen: boolean;
  onToggleScan: () => void;
  codeInput: string;
  onCodeInputChange: (v: string) => void;
  onAssignByCode: (v: string) => void;
  onAssignFromScan: (payload: QrPayload) => void;
  search: string;
  onSearchChange: (v: string) => void;
  rankedSearch: WindowUnit[];
  onAssignUnit: (unitId: string) => void;
  assignPending: boolean;

  // Rough opening
  roW: string[];
  roH: string[];
  roDiag: string[];
  roJudge: Record<RoCheckId, RoJudgment>;
  onRoWChange: (next: string[]) => void;
  onRoHChange: (next: string[]) => void;
  onRoDiagChange: (next: string[]) => void;
  onRoJudgeToggle: (id: RoCheckId, value: "good" | "bad") => void;
  requiredMids: number;
  roChecklist: RoVerdict[];
  saveRoPending: boolean;
  onSaveRo: () => void;
  quickCheckRoPending: boolean;
  onQuickCheckRo: () => void;

  // Condition
  conditionNote: string;
  onConditionNoteChange: (v: string) => void;
  onSaveCondition: (condition: "ok" | "damaged") => void;
  saveConditionPending: boolean;
  onSkip: () => void;
  skipPending: boolean;

  // Before photo
  photos: BeforeAfterValue;
  onPhotosChange: (v: BeforeAfterValue) => void;
  beforeCardAutoOpen: "before" | null;
  onBeforeAutoOpened: () => void;

  // Flashing
  flashing: OpeningPhase | null;
  now: number;
  canManageFlashing: boolean;
  toggleFlashingPending: boolean;
  onToggleFlashing: (needs: boolean) => void;
  flashingBlocked: boolean;
  startedAt: string | null;
  onBackToInstall: () => void;

  more: Omit<SheetMoreProps, "stage" | "installed">;
}

export function CheckStage({
  projectId,
  opening: o,
  typeMatches,
  fit,
  hasRoNumbers,
  roHasBadTap,
  quickCheckWho,
  brain,
  tips,
  watchOuts,
  scanOpen,
  onToggleScan,
  codeInput,
  onCodeInputChange,
  onAssignByCode,
  onAssignFromScan,
  search,
  onSearchChange,
  rankedSearch,
  onAssignUnit,
  assignPending,
  roW,
  roH,
  roDiag,
  roJudge,
  onRoWChange,
  onRoHChange,
  onRoDiagChange,
  onRoJudgeToggle,
  requiredMids,
  roChecklist,
  saveRoPending,
  onSaveRo,
  quickCheckRoPending,
  onQuickCheckRo,
  conditionNote,
  onConditionNoteChange,
  onSaveCondition,
  saveConditionPending,
  onSkip,
  skipPending,
  photos,
  onPhotosChange,
  beforeCardAutoOpen,
  onBeforeAutoOpened,
  flashing,
  now,
  canManageFlashing,
  toggleFlashingPending,
  onToggleFlashing,
  flashingBlocked,
  startedAt,
  onBackToInstall,
  more,
}: CheckStageProps) {
  const t = useT();

  return (
    <>
      {/* Pre-install briefing (north-star screen) */}
      {o.window_types && (
        <div className="briefing">
          <div className="briefing-stats">
            <span>
              <strong>
                {brain?.medianMinutes != null ? `${Math.round(brain.medianMinutes)}m` : "—"}
              </strong>
              target
            </span>
            <span>
              <strong>
                {brain?.p90Minutes != null ? `${Math.round(brain.p90Minutes)}m` : "—"}
              </strong>
              slow case
              <span
                className="wh-row-sub"
                style={{
                  display: "block",
                  textTransform: "none",
                  letterSpacing: "normal",
                  fontWeight: 400,
                }}
              >
                9 out of 10 installs of this type finish faster than this
              </span>
            </span>
            <span>
              <strong>
                {(() => {
                  const d = brain?.outcomeDifficulty ?? o.window_types.difficulty_rating;
                  return d ? "★".repeat(d) : "—";
                })()}
              </strong>
              difficulty
            </span>
            <span>
              <strong>{brain?.failRate != null ? `${brain.failRate}%` : "—"}</strong>
              fail rate
            </span>
          </div>
          {tips.length > 0 && (
            <div className="briefing-tips">
              <span className="field-label">Top tips</span>
              <ol>
                {tips.slice(0, 5).map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ol>
            </div>
          )}
          {watchOuts.length > 0 && (
            <div className="briefing-tips watch-callout">
              <span className="field-label" style={{ color: "var(--warn)", margin: 0 }}>Watch-outs</span>
              <ul className="watch" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {watchOuts.slice(0, 5).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {brain?.videos?.[0]?.signedUrl ? (
            <video controls src={brain.videos[0].signedUrl} className="golden-video" />
          ) : o.window_types.tutorial_url ? (
            <a href={o.window_types.tutorial_url} className="suggest">
              Tutorial video →
            </a>
          ) : null}
          <Link to={`/brain/${o.window_types.id}`} className="muted brain-more">
            Full type brain →
          </Link>
        </div>
      )}

      {/* Assign inventory unit */}
      <h2>Physical window</h2>
      {o.assigned_window_id && o.windows ? (
        <p>
          <Link to={`/w/${encodeURIComponent(o.windows.window_id)}`}>
            <strong>{o.windows.window_id}</strong>
          </Link>{" "}
          {typeMatches ? (
            <span className="ok">assigned</span>
          ) : (
            <span className="error">wrong type!</span>
          )}
        </p>
      ) : (
        <>
          <p className="muted">
            Scan the QR on the window you're putting in this opening, or search.
          </p>
          <button className="big" onClick={onToggleScan}>
            {scanOpen ? "Close scanner" : "Scan window QR"}
          </button>
          {scanOpen && (
            <Scanner
              hint="Scan the window's QR — or type its short code below."
              onScan={onAssignFromScan}
            />
          )}
          <label className="field-label">Type the window code</label>
          <div className="manual-entry">
            <input
              value={codeInput}
              onChange={(e) => onCodeInputChange(e.target.value)}
              placeholder="6-char code or serial, e.g. K7M2QX"
              autoCapitalize="characters"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onAssignByCode(codeInput);
                  onCodeInputChange("");
                }
              }}
            />
            <button
              disabled={!codeInput.trim() || assignPending}
              onClick={() => {
                onAssignByCode(codeInput);
                onCodeInputChange("");
              }}
            >
              Assign
            </button>
          </div>
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search W-… or type code"
          />
          {search.trim().length >= 2 && (
            <ul className="unit-list">
              {rankedSearch.map((u) => (
                <li key={u.id} className="find-row">
                  <div>
                    <strong>{u.window_id}</strong>{" "}
                    <span className="muted">{u.window_types?.type_code}</span>
                    <div className="wh-row-sub">
                      {formatAssignMeta(u)}
                      {u.project_id === projectId ? " · this job" : ""}
                    </div>
                  </div>
                  <button className="link wh-actions" onClick={() => onAssignUnit(u.id)}>
                    Assign
                  </button>
                </li>
              ))}
              {rankedSearch.length === 0 && (
                <p className="muted">No matching units (type filter applied).</p>
              )}
            </ul>
          )}
        </>
      )}

      {/* --- FIT CHECK (rough opening) --- */}
      <h2>Rough opening</h2>
      <p className="muted">
        Check in order: square, then width, then height. Tap Good or Bad,
        then put the tape on it — the numbers are judged against this
        window ({"≥"}1/8" and {"≤"}1/2" over the unit), and a
        failed check files a framing issue by itself.
      </p>

      {([
        {
          id: "square" as RoCheckId,
          title: "Square?",
          how: "Measure both diagonals of the X — they should match.",
          inputs: (
            <div className="ro-row">
              {roDiag.map((v, i) => (
                <input
                  key={i}
                  type="number"
                  inputMode="decimal"
                  step="0.0625"
                  value={v}
                  placeholder={["diagonal 1", "diagonal 2"][i]}
                  onChange={(e) => {
                    const next = [...roDiag];
                    next[i] = e.target.value;
                    onRoDiagChange(next);
                  }}
                />
              ))}
            </div>
          ),
        },
        {
          id: "width" as RoCheckId,
          title: "Width?",
          how: "Across the top and bottom (and middle) — smallest wins.",
          inputs: (
            <div className="ro-row">
              {roW.map((v, i) => (
                <input
                  key={i}
                  type="number"
                  inputMode="decimal"
                  step="0.0625"
                  value={v}
                  placeholder={["top", "mid", "bot"][i]}
                  onChange={(e) => {
                    const next = [...roW];
                    next[i] = e.target.value;
                    onRoWChange(next);
                  }}
                />
              ))}
            </div>
          ),
        },
        {
          id: "height" as RoCheckId,
          title: "Height?",
          how:
            requiredMids > 0
              ? `Down the left and right sides, plus ${requiredMids === 1 ? "mid-span" : "both third-points"} — smallest wins. Wide opening — that catches a bowed header.`
              : "Down the left and right sides — smallest wins.",
          inputs: (
            <div className="ro-row">
              {roH.map((v, i) => (
                <input
                  key={i}
                  type="number"
                  inputMode="decimal"
                  step="0.0625"
                  value={v}
                  placeholder={heightLabel(i, roH.length)}
                  onChange={(e) => {
                    const next = [...roH];
                    next[i] = e.target.value;
                    onRoHChange(next);
                  }}
                />
              ))}
            </div>
          ),
        },
      ]).map((row) => {
        const verdict = roChecklist.find((v) => v.check === row.id);
        const judged = roJudge[row.id];
        const disagree = judged === "good" && verdict?.measured === "bad";
        return (
          <div key={row.id} className="ro-check">
            <div className="ro-check-head">
              <RoDiagram kind={row.id} />
              <div className="ro-check-title">
                <strong>{row.title}</strong>
                <span className="muted">{row.how}</span>
              </div>
              <div className="ro-judge" role="group" aria-label={row.title}>
                <button
                  type="button"
                  className={judged === "good" ? "ro-pill good on" : "ro-pill good"}
                  onClick={() => onRoJudgeToggle(row.id, "good")}
                >
                  Good ✓
                </button>
                <button
                  type="button"
                  className={judged === "bad" ? "ro-pill bad on" : "ro-pill bad"}
                  onClick={() => onRoJudgeToggle(row.id, "bad")}
                >
                  Bad ✕
                </button>
              </div>
            </div>
            {judged !== null && (
              <>
                {row.inputs}
                {verdict?.detail && (
                  <p className={verdict.measured === "bad" ? "ro-verdict bad" : "ro-verdict"}>
                    {verdict.measured === "bad" ? "✕ " : verdict.measured === "good" ? "✓ " : ""}
                    {verdict.detail}
                    {disagree && " — the tape disagrees with your Good; this files as framing."}
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}

      <div className="ro-save-row">
        <button className="action-btn" disabled={saveRoPending} onClick={onSaveRo}>
          {saveRoPending
            ? "Saving…"
            : roFailures(roChecklist, roJudge).length > 0
              ? "Save — files a framing issue for this window"
              : "Save rough opening"}
        </button>
        {!hasRoNumbers && (
          <button
            type="button"
            className="action-btn secondary"
            disabled={quickCheckRoPending || roHasBadTap}
            onClick={onQuickCheckRo}
          >
            {quickCheckRoPending ? "Saving…" : "Quick check: all good"}
          </button>
        )}
      </div>
      {!hasRoNumbers && roHasBadTap && (
        <p className="muted ro-quick-why">
          Clear the Bad marks first, or save the numbers.
        </p>
      )}
      <div className={`fit-verdict fit-${fit.verdict}`}>
        {hasRoNumbers ? (
          <>
            <strong>Rough opening {o.ro_width_in}×{o.ro_height_in}"</strong> — {fit.message}
          </>
        ) : o.ro_quick_ok ? (
          <>
            <strong>Quick check: all good</strong>
            {quickCheckWho && ` — ${quickCheckWho}`}
          </>
        ) : (
          <span className="muted">{fit.message}</span>
        )}
      </div>

      {/* --- CONDITION / DAMAGE CHECK --- */}
      {o.assigned_window_id && (
        <>
          <h2>Condition on arrival</h2>
          <div className="grade-row">
            <button
              className={o.condition === "ok" ? "grade-btn selected" : "grade-btn"}
              onClick={() => onSaveCondition("ok")}
              disabled={saveConditionPending}
            >
              OK
            </button>
            <button
              className={o.condition === "damaged" ? "grade-btn selected danger" : "grade-btn"}
              onClick={() => onSaveCondition("damaged")}
              disabled={saveConditionPending}
            >
              Damaged
            </button>
          </div>
          <input
            value={conditionNote}
            onChange={(e) => onConditionNoteChange(e.target.value)}
            placeholder="Damage note (optional)"
          />
          {o.condition === "damaged" && (
            <>
              <p className="error">
                Unit flagged damaged. Don't install — swap the unit and re-check.
                Your foreman has been notified.
              </p>
              <button className="action-btn" disabled={skipPending} onClick={onSkip}>
                {skipPending ? "Skipping…" : "Skip for now — go to my work"}
              </button>
            </>
          )}
        </>
      )}

      {/* Before photo — captured HERE, while "before" still exists. See
          OpeningSheet.tsx's original comment (git history) for why this card
          has no show/hide condition: it stays on screen, filled or empty,
          for as long as the unit is unfiled. */}
      <h2 style={{ marginBottom: 2 }}>Before photo</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {photos.before
          ? t("opening.before.taken")
          : startedAt
            ? t("opening.before.clockRunning")
            : t("opening.before.requiredToStart")}
      </p>
      <PhotoCaptureSheet
        mode="beforeAfter"
        slots={["before"]}
        autoOpen={beforeCardAutoOpen}
        onAutoOpened={onBeforeAutoOpened}
        value={photos}
        onChange={onPhotosChange}
        label={o.opening_code}
      />

      {/* Flashing is the FLASH RUN's job now (owner, 2026-08-14). */}
      {o.needs_flashing === true && (
        <div className="detail-card wh-card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="field-label" style={{ margin: 0 }}>Flashing</span>
            {flashing?.status === "submitted" ? (
              <span className="ok" style={{ fontSize: 12.5 }}>
                ✓ done · {flashing.submitter?.display_name ?? "crew"}
                {flashing.minutes != null && ` · ${flashing.minutes}m`}
              </span>
            ) : flashing ? (
              <span className="warn-text" style={{ fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
                {flashing.paused_at ? "paused" : "flashing"} ·{" "}
                {formatPhaseClock(phaseElapsedSeconds(flashing, now))}
                {flashing.starter?.display_name && ` · ${flashing.starter.display_name}`}
              </span>
            ) : (
              <span className="wh-row-sub">required before install</span>
            )}
            {canManageFlashing && flashing?.status !== "submitted" && (
              <button
                className="link wh-actions"
                style={{ fontSize: 12 }}
                disabled={toggleFlashingPending}
                onClick={() => onToggleFlashing(false)}
              >
                Doesn't need flashing
              </button>
            )}
          </div>
        </div>
      )}
      {o.needs_flashing === false && canManageFlashing && (
        <p className="wh-row-sub">
          No flashing required here.{" "}
          <button className="link" onClick={() => onToggleFlashing(true)}>
            Require it
          </button>
        </p>
      )}

      {/* The flashing gate is the one blocker with somewhere to go. A unit
          whose clock is already running keeps its way back into the install
          stage — the gate is on FILING the install, and the sheet still
          refuses that at Submit. The pinned "Start install" button (router)
          also disables and says why while this is showing. */}
      {flashingBlocked && (
        <>
          <FlashingWayOut
            projectId={projectId}
            openingCode={o.opening_code}
            canClear={canManageFlashing}
            clearing={toggleFlashingPending}
            onClear={() => onToggleFlashing(false)}
          />
          {startedAt && (
            <button className="button-like" onClick={onBackToInstall}>
              {t("opening.action.backToInstall")}
            </button>
          )}
        </>
      )}

      <SheetMore stage="check" installed={false} {...more} />
    </>
  );
}
