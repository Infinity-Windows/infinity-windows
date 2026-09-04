// "There's a window here that isn't on the plans."
//
// Wave E (transcripts program, Q18 — the owner's own addition). The permission
// is PRESENCE, not rank: whoever is clocked in on the job can record it, because
// the person looking at the hole is the person who should be able to write it
// down. The server enforces that (add_field_unit checks time_shifts); this sheet
// only has to be quick enough to use in gloves.
//
// Two entry points open it: the job's Overview, and the map toolbar. From the
// map it arrives with the point somebody tapped, so the unit lands where it
// actually is; from Overview it has no point and lands unplaced, which is
// exactly what a job with no plan set can offer.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import { addFieldUnit } from "../../lib/install/api";
import { announceMissedUnit } from "../../lib/install/missedUnit";
import { uploadMissedUnitPhoto } from "../../lib/install/missedUnitPhoto";
import { formatApiError } from "../../lib/install/errors";

export interface AddMissedUnitSheetProps {
  projectId: string;
  jobName: string;
  /** Whoever is signed in — so the push never rings them back. */
  callerId: string | null;
  callerName: string | null;
  /** Where it was tapped on the plan, 0–1 each. Absent = unplaced. */
  pin?: { x: number; y: number; pageNumber: number } | null;
  /** True when this job has a drawing at all — drives which sentence shows. */
  hasMap: boolean;
  onClose: () => void;
  onAdded: (code: string, openingId: string) => void;
}

export function AddMissedUnitSheet({
  projectId,
  jobName,
  callerId,
  callerName,
  pin,
  hasMap,
  onClose,
  onAdded,
}: AddMissedUnitSheetProps) {
  const t = useT();
  const [kind, setKind] = useState<"window" | "door">("window");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: async () => {
      const w = Number(width);
      const h = Number(height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        throw new Error(t("missed.needSize"));
      }
      // The photo goes up FIRST and its path rides into the RPC, so a unit is
      // never created pointing at a picture that failed to upload.
      const photoPath = photo ? await uploadMissedUnitPhoto(projectId, photo) : null;
      const row = await addFieldUnit({
        projectId,
        kind,
        widthIn: w,
        heightIn: h,
        photoPath,
        pinX: pin?.x ?? null,
        pinY: pin?.y ?? null,
        pageNumber: pin?.pageNumber ?? null,
        note: note.trim() || null,
      });
      // Best-effort, and deliberately after the row exists: a push that fails
      // must never lose the record somebody stood outside to make.
      await announceMissedUnit({
        projectId,
        jobName,
        openingCode: row.opening_code,
        openingId: row.id,
        addedBy: callerName,
        callerId,
      });
      return row;
    },
    onSuccess: (row) => onAdded(row.opening_code, row.id),
    onError: (e) =>
      setError(e instanceof Error && !("code" in e) ? e.message : formatApiError(e)),
  });

  return (
    <div className="detail-card missed-unit-sheet">
      <h3 style={{ margin: "0 0 4px" }}>{t("missed.title")}</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        {t("missed.help")}
      </p>
      <p className="muted" style={{ fontSize: 13 }}>
        {pin ? t("missed.placed") : hasMap ? t("missed.tapTheMap") : t("missed.unplaced")}
      </p>

      <span className="field-label">{t("missed.kind")}</span>
      <div className="row-gap">
        <button
          type="button"
          className={kind === "window" ? "chip active" : "chip"}
          aria-pressed={kind === "window"}
          onClick={() => setKind("window")}
        >
          {t("missed.window")}
        </button>
        <button
          type="button"
          className={kind === "door" ? "chip active" : "chip"}
          aria-pressed={kind === "door"}
          onClick={() => setKind("door")}
        >
          {t("missed.door")}
        </button>
      </div>

      <label className="field-label" htmlFor="missed-width">
        {t("missed.width")}
      </label>
      <input
        id="missed-width"
        inputMode="decimal"
        value={width}
        onChange={(e) => setWidth(e.target.value)}
      />
      <label className="field-label" htmlFor="missed-height">
        {t("missed.height")}
      </label>
      <input
        id="missed-height"
        inputMode="decimal"
        value={height}
        onChange={(e) => setHeight(e.target.value)}
      />

      <label className="field-label" htmlFor="missed-photo">
        {t("missed.photo")}
      </label>
      <input
        id="missed-photo"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
      />

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t("missed.notePlaceholder")}
        aria-label={t("missed.notePlaceholder")}
      />

      {error && <p className="scanner-hint error">{error}</p>}

      <div className="row-gap">
        <button
          className="primary"
          disabled={add.isPending}
          onClick={() => {
            setError(null);
            add.mutate();
          }}
        >
          {add.isPending ? t("missed.submitting") : t("missed.submit")}
        </button>
        <button className="button-like" disabled={add.isPending} onClick={onClose}>
          {t("missed.cancel")}
        </button>
      </div>
    </div>
  );
}
