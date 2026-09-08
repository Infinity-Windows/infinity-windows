// STAGE 3 of the unit sheet (S7): the after photo, the walkthrough video,
// the voice memo, who gets credited, and the quality grade. Submit itself is
// the stage's pinned primary button now (router); everything that feeds it
// still lives here, unchanged from OpeningSheet.tsx.
import { useT } from "../../../lib/i18n";
import { PhotoCaptureSheet, type BeforeAfterValue } from "../../../components/PhotoCaptureSheet";
import { MEMO_TOPICS, type MemoTopics } from "../../../lib/install/types";
import type { ReadyResult } from "../../../lib/install/fit";
import type { CreditCandidate } from "../../../lib/install/credit";
import { FlashingWayOut } from "./FlashingWayOut";
import { SheetMore, type SheetMoreProps } from "./SheetMore";

export interface CaptureStageProps {
  projectId: string;
  openingCode: string;
  hasAssignedUnit: boolean;

  photos: BeforeAfterValue;
  onPhotosChange: (v: BeforeAfterValue) => void;
  video: File | null;
  onVideoChange: (f: File | null) => void;

  recording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  audioBlob: Blob | null;
  audioUrl: string | null;

  topics: Partial<MemoTopics>;
  onTopicsChange: (topics: Partial<MemoTopics>) => void;

  timerMinutes: number | null;

  showCreditPicker: boolean;
  creditPeople: CreditCandidate[];
  creditedTo: string | null;
  myId: string | null;
  onCreditedToChange: (id: string) => void;

  grade: number | null;
  onGradeChange: (g: number) => void;

  ready: ReadyResult;
  submitBlockedBy: string | null;

  flashingBlocked: boolean;
  canManageFlashing: boolean;
  toggleFlashingPending: boolean;
  onToggleFlashing: (needs: boolean) => void;

  more: Omit<SheetMoreProps, "stage" | "installed">;
}

export function CaptureStage({
  projectId,
  openingCode,
  hasAssignedUnit,
  photos,
  onPhotosChange,
  video,
  onVideoChange,
  recording,
  onStartRecording,
  onStopRecording,
  audioBlob,
  audioUrl,
  topics,
  onTopicsChange,
  timerMinutes,
  showCreditPicker,
  creditPeople,
  creditedTo,
  myId,
  onCreditedToChange,
  grade,
  onGradeChange,
  ready,
  submitBlockedBy,
  flashingBlocked,
  canManageFlashing,
  toggleFlashingPending,
  onToggleFlashing,
  more,
}: CaptureStageProps) {
  const t = useT();

  return (
    <>
      <h2>Photos</h2>
      {/* The before was captured in step 1 (owner, 2026-08-14: no
          double-ask) — this stage only takes the after, lined up over the
          ghosted before. It says whichever is true, on a chained unit
          included. */}
      <p className="muted">
        {photos.before ? t("opening.capture.afterOverBefore") : t("opening.capture.afterOnly")}
      </p>
      <PhotoCaptureSheet
        mode="beforeAfter"
        slots={["after"]}
        value={photos}
        onChange={onPhotosChange}
        label={openingCode}
      />

      <label className="field-label">Walkthrough video (optional)</label>
      <label className="action-btn" style={{ cursor: "pointer" }}>
        {video ? `${video.name} — replace` : "Add a short video"}
        <input
          type="file"
          accept="video/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            onVideoChange(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
      </label>

      <h2>Install memo</h2>
      <p className="muted">
        Record once and talk it through — AI fills the fields from your voice
        and photos. Edit anything after.
      </p>
      <button
        className={recording ? "big record-btn recording" : "big record-btn"}
        onClick={recording ? onStopRecording : onStartRecording}
      >
        {recording ? "■ Stop recording" : audioBlob ? "● Re-record memo" : "● Record memo"}
      </button>
      {audioUrl && !recording && (
        <audio controls src={audioUrl} className="audio-preview" />
      )}

      <ol className="topic-prompts">
        {MEMO_TOPICS.map((topic) => (
          <li key={topic.key} className={recording ? "active" : ""}>
            {topic.prompt}
          </li>
        ))}
      </ol>

      <details className="topic-fields">
        <summary className="muted">Type notes instead (optional)</summary>
        {MEMO_TOPICS.map((topic) => (
          <div key={topic.key}>
            <label className="field-label">{topic.prompt}</label>
            <input
              value={topics[topic.key] ?? ""}
              onChange={(e) =>
                onTopicsChange({ ...topics, [topic.key]: e.target.value || null })
              }
            />
          </div>
        ))}
      </details>

      {/* The hand-typed era is over (spec .scratch/sessions): minutes are
          derived server-side from this window's sessions. */}
      <p className="wh-row-sub" style={{ margin: "4px 0 0" }}>
        Time records itself from your sessions
        {timerMinutes != null ? ` — about ${timerMinutes} min so far` : ""}.
        Breaks never count.
      </p>

      {/* Wave Y (Y2): this unit is on somebody else's list, so the sheet
          asks rather than assuming. */}
      {showCreditPicker && (
        <div className="detail-card" style={{ marginTop: 10 }}>
          <span className="field-label">{t("credit.who")}</span>
          <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12.5 }}>
            {t("credit.help")}
          </p>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {creditPeople.map((person) => (
              <button
                key={person.id}
                type="button"
                className={creditedTo === person.id ? "button-like active-pill" : "button-like"}
                aria-pressed={creditedTo === person.id}
                data-credit-id={person.id}
                onClick={() => onCreditedToChange(person.id)}
              >
                {person.id === myId ? t("credit.me") : person.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="field-label">Quality grade</label>
      <div className="grade-row">
        {[1, 2, 3, 4, 5].map((g) => (
          <button
            key={g}
            className={grade === g ? "grade-btn selected" : "grade-btn"}
            onClick={() => onGradeChange(g)}
          >
            {g}
          </button>
        ))}
      </div>

      {ready.status === "blocked" && (
        <p className="error">
          This opening is blocked ({ready.reasons.join(" ")}). Resolve before
          recording the install.
        </p>
      )}

      {submitBlockedBy && (
        <p className="muted" role="status">{submitBlockedBy}</p>
      )}

      {/* Saying "this needs flashing" and leaving them on a dead Submit is
          how the 2026-09-02 report started. The way out goes here, at the
          button they actually tap (now the pinned Submit button above). */}
      {flashingBlocked && (
        <FlashingWayOut
          projectId={projectId}
          openingCode={openingCode}
          canClear={canManageFlashing}
          clearing={toggleFlashingPending}
          onClear={() => onToggleFlashing(false)}
        />
      )}

      {!hasAssignedUnit && (
        <p className="muted">
          No unit linked yet — you can still submit; the memo attaches to
          the opening and type.
        </p>
      )}

      <SheetMore stage="capture" installed={false} {...more} />
    </>
  );
}
