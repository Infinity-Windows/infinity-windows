// The unit sheet's "More" fold (S7): everything exceptional, one <details>
// per stage screen (each stage mounts its own instance, closed by default)
// plus one more mounted directly under the done card once a unit is
// installed — stages stop rendering at that point, and Redo/History/Notes/
// Data off/Missed-unit/Record all still need somewhere to live.
//
// Every row here used to be either unconditionally on the page or its own
// separate <details> — this only relocates them. The mutations, the gates
// and the copy inside each row are untouched; only the container moved.
// (installer-os-spec.md S7, item 4.)
import { Ban, RotateCcw } from "lucide-react";
import { useT } from "../../../lib/i18n";
import type { OpeningNote, UndoneInstall } from "../../../lib/install/api";
import type { OpeningPhase } from "../../../lib/install/phases";
import { movedAgoLabel } from "../../../lib/install/pinHistory";
import { BLOCK_REASONS } from "../../../lib/install/sessions";
import {
  showBlockFold,
  showSiteNoteFold,
  showSummonFold,
  type SheetStage,
} from "../../../lib/install/sheetStages";
import { DataOffCard, type DataOffCardProps } from "../../../components/install/DataOffCard";
import {
  MissedUnitActions,
  type MissedUnitActionsProps,
} from "../../../components/install/MissedUnitActions";
import { UnitRecordCard } from "../../../components/install/UnitRecordCard";
import { SummonPanel } from "../../../components/install/SummonPanel";
import { CallForHandsPanel } from "../../../components/install/CallForHandsPanel";

export interface SheetMoreProps {
  /** Which stage's fold this is, or `null` for the installed-state mount
   * (no stage is on screen once a unit is installed, but this content still
   * has to be reachable). */
  stage: SheetStage | null;
  installed: boolean;
  now: number;

  notes: OpeningNote[];
  noteText: string;
  onNoteTextChange: (v: string) => void;
  onAddNote: () => void;
  addingNote: boolean;

  dataOff: DataOffCardProps;

  /** `null` when this isn't a missed unit — `o.field_added` at the call
   * site, same gate as before. */
  missedUnit: MissedUnitActionsProps | null;

  openingId: string;
  flashing: OpeningPhase | null;

  undoHistory: UndoneInstall[];

  redo: {
    open: boolean;
    onOpen: () => void;
    reason: string;
    onReasonChange: (v: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    pending: boolean;
  };

  siteNote: {
    jobNoteText: string;
    onJobNoteChange: (v: string) => void;
    onSendJobNote: () => void;
    sendingJobNote: boolean;
    complicationText: string;
    onComplicationChange: (v: string) => void;
    onSendComplication: () => void;
    sendingComplication: boolean;
  };

  summon: {
    projectId: string;
    openingId: string;
    openingCode: string;
    widthIn: number | null;
    heightIn: number | null;
    myProfileId: string | null;
    myName: string | null;
    effectiveRole: string;
  };

  block: {
    open: boolean;
    onToggle: () => void;
    other: string;
    onOtherChange: (v: string) => void;
    onReason: (reason: string) => void;
    pending: boolean;
    nextOpeningCode: string | null;
  };
}

export function SheetMore({
  stage,
  installed,
  now,
  notes,
  noteText,
  onNoteTextChange,
  onAddNote,
  addingNote,
  dataOff,
  missedUnit,
  openingId,
  flashing,
  undoHistory,
  redo,
  siteNote,
  summon,
  block,
}: SheetMoreProps) {
  const t = useT();
  return (
    <details className="more-actions sheet-more">
      <summary className="muted">{t("sheet.more")}</summary>

      {/* REDO (CONTEXT.md): the install was REAL but the window needs doing
          again — different truth than undo, so a different button. Any
          installer, reason required; the foreman is notified, never asked.
          The original record stands; the window goes back in play. Only
          reachable once a unit is installed — there is nothing to redo
          before then. */}
      {installed && (
        <div className="sheet-more-item">
          {!redo.open ? (
            <button className="button-like" onClick={redo.onOpen}>
              <RotateCcw
                size={15}
                aria-hidden
                style={{ verticalAlign: "middle", marginRight: 6 }}
              />
              Redo this window — it needs doing again
            </button>
          ) : (
            <>
              <label className="field-label">
                Why does it need redoing? (required — your foreman gets pinged,
                the window goes back on the list)
              </label>
              <textarea
                rows={2}
                maxLength={500}
                value={redo.reason}
                placeholder="e.g. failed inspection / glass fogged / wrong unit went in"
                onChange={(e) => redo.onReasonChange(e.target.value)}
              />
              <div className="row-gap" style={{ marginTop: 8 }}>
                <button
                  className="button-like active-pill"
                  disabled={redo.pending || redo.reason.trim() === ""}
                  onClick={redo.onSubmit}
                >
                  {redo.pending ? "Filing…" : "Redo — put it back in play"}
                </button>
                <button
                  className="button-like"
                  disabled={redo.pending}
                  onClick={redo.onCancel}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* The Record (CONTEXT.md): the full story of this window, read back
          from what the crew saved. Every role sees it — raw facts about one
          window are history, not comparison. Shows on any status once the
          window has a story (sent-back windows keep theirs). */}
      <div className="sheet-more-item">
        <UnitRecordCard openingId={openingId} flashing={flashing} />
      </div>

      {/* Past undos stay visible on ANY status — the why is the point. */}
      {undoHistory.length > 0 && (
        <div className="sheet-more-item">
          <span className="field-label">Previously sent back</span>
          <ul className="unit-list" style={{ marginTop: 4 }}>
            {undoHistory.map((u) => (
              <li key={u.id} className="wh-row-sub">
                {u.voided_at &&
                  new Date(u.voided_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}{" "}
                · {u.voider?.display_name ?? "lead"} — “{u.void_reason ?? "no reason recorded"}”
                {u.minutes != null && ` · ${u.minutes}m install kept on file`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Notes: a free-form record on this opening (owner ask, settled
          2026-08-21) - the point is explaining why one window took much
          longer than expected than the estimate. Visible on every stage;
          like the Record above, nothing here is ever edited or removed
          once posted. */}
      <div className="sheet-more-item">
        <h2>Notes</h2>
        {notes.length > 0 ? (
          <ul className="unit-list" style={{ marginTop: 4 }}>
            {notes.map((n) => (
              <li key={n.id} style={{ fontSize: 13 }}>
                <strong>{n.author_profile?.display_name ?? "Unknown"}</strong>{" "}
                <span className="muted">{movedAgoLabel(n.created_at, now)}</span>
                <div>{n.body}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: "2px 0 8px" }}>
            No notes yet.
          </p>
        )}
        <textarea
          rows={3}
          maxLength={2000}
          value={noteText}
          onChange={(e) => onNoteTextChange(e.target.value)}
          placeholder="Out of the ordinary? Say what happened — why this one took the time it took."
        />
        <button className="action-btn" disabled={!noteText.trim() || addingNote} onClick={onAddNote}>
          {addingNote ? "Adding…" : "Add note"}
        </button>
      </div>

      {/*
        Data off (wave E). It never blocks Finish — the flag is about the
        RECORD, not the work — and it stays readable and clearable after the
        window is in and QC has passed, so it belongs in the fold that
        outlives the stage flow, not inside any one stage's own content.
      */}
      <div className="sheet-more-item">
        <DataOffCard {...dataOff} />
      </div>

      {/* --- Missed unit: what a supervisor does with one (wave E) --- */}
      {missedUnit && (
        <div className="sheet-more-item">
          <MissedUnitActions {...missedUnit} />
        </div>
      )}

      {/* --- Exceptions: site note (not during install screen) --- */}
      {stage !== null && showSiteNoteFold(stage) && (
        <div className="sheet-more-item">
          <label className="field-label">Site note for the lead (optional)</label>
          <input
            value={siteNote.jobNoteText}
            onChange={(e) => siteNote.onJobNoteChange(e.target.value)}
            placeholder="General note about this job/site"
          />
          <button
            className="action-btn"
            disabled={!siteNote.jobNoteText.trim() || siteNote.sendingJobNote}
            onClick={siteNote.onSendJobNote}
          >
            Send site note
          </button>

          <label className="field-label">Hit a complication?</label>
          <p className="muted">
            Something needs your foreman's attention now — this opens an urgent
            issue on the cross-job Issues board.
          </p>
          <input
            value={siteNote.complicationText}
            onChange={(e) => siteNote.onComplicationChange(e.target.value)}
            placeholder="e.g. rotten framing, needs a decision"
          />
          <button
            className="action-btn"
            disabled={!siteNote.complicationText.trim() || siteNote.sendingComplication}
            onClick={siteNote.onSendComplication}
          >
            I have a complication — notify foreman
          </button>
        </div>
      )}

      {/* Call for hands: the per-window summon plus the job-level call,
          folded together on the Check stage only — Install keeps its own
          SummonPanel inline (see sheetStages.showSummonFold). */}
      {stage !== null && showSummonFold(stage) && (
        <div className="sheet-more-item">
          <SummonPanel
            projectId={summon.projectId}
            openingId={summon.openingId}
            openingCode={summon.openingCode}
            widthIn={summon.widthIn}
            heightIn={summon.heightIn}
            myProfileId={summon.myProfileId}
            myName={summon.myName}
            effectiveRole={summon.effectiveRole}
            installRunning={false}
          />
          <CallForHandsPanel projectId={summon.projectId} />
        </div>
      )}

      {/* BLOCK: the first-class exit — stuck through no fault of yours.
          Reason required; the blocker issue files itself; the clock hands
          off exactly like Finish. Install stage only. */}
      {stage !== null && showBlockFold(stage) && (
        <div className="sheet-more-item">
          <button className="button-like" onClick={block.onToggle}>
            <Ban size={15} aria-hidden style={{ verticalAlign: "middle", marginRight: 6 }} />
            Blocked — can't continue
          </button>
          {block.open && (
            <div className="detail-card wh-card" style={{ textAlign: "left" }}>
              <span className="field-label">What's stopping you?</span>
              <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 6 }}>
                {BLOCK_REASONS.map((r) => (
                  <button
                    key={r}
                    className="button-like studio-mini"
                    disabled={block.pending}
                    onClick={() => block.onReason(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="row-gap" style={{ marginTop: 8 }}>
                <input
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder="Something else — say what"
                  value={block.other}
                  onChange={(e) => block.onOtherChange(e.target.value)}
                />
                <button
                  className="button-like"
                  disabled={block.pending || !block.other.trim()}
                  onClick={() => block.onReason(block.other.trim())}
                >
                  Block
                </button>
              </div>
              {block.nextOpeningCode && (
                <p className="wh-row-sub" style={{ margin: "6px 0 0" }}>
                  The clock hands off to {block.nextOpeningCode} — same as
                  finishing.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
