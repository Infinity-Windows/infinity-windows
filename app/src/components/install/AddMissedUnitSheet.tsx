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
import { usePhotoPicker } from "../../lib/photo/usePhotoPicker";
import { imageFilesOnly } from "../../lib/photo/imageFiles";
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

  // The app's ONE file-input pair (lib/photo/usePhotoPicker.tsx). This sheet
  // wrote its own input until now, and that input carried `capture="environment"`
  // — which tells iOS and Android to open the camera and offer nothing else. So
  // the only picture this form could take was one shot standing right there,
  // and the one already on the phone (taken on the first walk of the house,
  // before anyone opened the app) could not be attached to the unit it was of.
  //
  // One file, deliberately: a missed unit gets ONE photo — `add_field_unit`
  // takes a single `p_photo_path` — so a multi-pick would silently drop all but
  // the first. The photo is NOT watermarked here and never has been; that is
  // left exactly as it was rather than changed on the way past.
  //
  // Filtered, and the filter is new work: while this input carried `capture`
  // only a camera could feed it, and a camera cannot hand back a PDF. The
  // library door can, and `uploadMissedUnitPhoto` would name it `.jpg` and file
  // it without complaint — so the unit would exist forever pointing at a broken
  // image, with nothing on screen ever having said so. Say so instead.
  const picker = usePhotoPicker({
    camera: true,
    onFiles: (files) => {
      const picked = imageFilesOnly(files)[0] ?? null;
      if (!picked) {
        setError(t("photo.fileUnreadable"));
        return;
      }
      // A good pick answers the complaint the bad one made — and the submit
      // button clears this same line for the same reason.
      setError(null);
      setPhoto(picked);
    },
  });

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

      <span className="field-label">{t("missed.photo")}</span>
      {/* Two buttons where there was one input. A plain label can no longer
          point at the field with `htmlFor` — there are two hidden inputs and
          neither is "the" one — so the label is a span and the buttons name
          themselves. The class on this wrapper is how the e2e spec tells the
          camera door from the library one. */}
      <div className="row-gap missed-photo-actions">
        <button type="button" className="chip" onClick={picker.openCamera}>
          {t("photo.action.useCamera")}
        </button>
        <button type="button" className="chip" onClick={picker.openLibrary}>
          {t("photo.action.uploadFiles")}
        </button>
        {picker.inputs}
      </div>
      {/* The inputs are hidden now, so the browser no longer shows the picked
          file's name and this sheet has to. Without it there is nothing at all
          on screen to say the photo took. */}
      {photo && (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {photo.name}
        </p>
      )}

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
