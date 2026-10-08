// The Job location card near the top of a job's Overview (owner ask,
// 2026-10-08: "add a way to manually add an address and/or gps coordinates to
// a job"). Before this the address sat buried in Job details and a job had no
// GPS point at all.
//
// Everyone who can see the job reads it, copies it and gets directions — the
// installer standing in a subdivision with no street signs is who it is for.
// Only EDITING is foreman+, and set_project_location holds the same line on
// the server; isLead here only decides what is drawn.
//
// Address and GPS are independent and both optional. A GPS point is whatever a
// person typed, never geocoded from the address and never read from the phone:
// no location prompt, no clock, no inference. When both exist, directions go
// to the point (the address is often a lot number that maps cannot find) and
// the address stays as the readable label.
//
// The save is an optimistic compare: the editor remembers what the location
// was when it OPENED and sends that as `expected`, and the server refuses if
// someone else changed it since. That snapshot is taken once, on open, and a
// background refetch that hands this card a fresher project must not move it —
// otherwise the refetch would quietly turn "someone else changed this" into a
// silent overwrite.

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/jobLocationCatalog";
import type { JobLocationKey } from "../../lib/i18n/jobLocationCatalog";
import {
  invalidateJobLocation,
  parseJobCoordinates,
  saveProjectLocation,
} from "../../lib/jobLocation";
import { pushToast, toastSuccess } from "../../lib/toast";
import type { Project } from "../../lib/types";
import { DirectionsButton } from "../maps/DirectionsButton";
import "./job-location.css";

interface SavedLocation {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** What the project holds right now, normalised so "no value" is always null. */
function locationOf(project: Project): SavedLocation {
  return {
    address: project.address ?? null,
    latitude: project.latitude ?? null,
    longitude: project.longitude ?? null,
  };
}

/** A pair only counts when both halves exist — and 0 is a real coordinate. */
function hasPoint(loc: SavedLocation): loc is SavedLocation & { latitude: number; longitude: number } {
  return loc.latitude != null && loc.longitude != null;
}

function pointText(loc: SavedLocation): string {
  return hasPoint(loc) ? `${loc.latitude}, ${loc.longitude}` : "";
}

/** The parser throws an Error carrying coordinatesPair or coordinatesRange.
 * Anything else it could throw is still a typing problem with the field, so it
 * reads as the pair message — never as String(err). */
function coordinateErrorKey(err: unknown): JobLocationKey {
  const rec = err && typeof err === "object" ? (err as { code?: unknown; message?: unknown }) : null;
  const code = rec?.code ?? rec?.message;
  return code === "coordinatesRange" ? "jobLocation.error.range" : "jobLocation.error.pair";
}

export function JobLocationPanel({
  project,
  isLead,
}: {
  project: Project;
  isLead: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  // Non-null exactly while the editor is open; see the header on why it is
  // captured once and never refreshed from props.
  const [expected, setExpected] = useState<SavedLocation | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [gpsDraft, setGpsDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // isPending only flips on the next render, so two taps inside one frame
  // would both see false. The ref closes that gap.
  const inFlight = useRef(false);

  const saved = locationOf(project);
  const savedAddress = saved.address?.trim() || null;
  const savedPoint = hasPoint(saved);
  const hasLocation = !!savedAddress || savedPoint;

  const save = useMutation({
    mutationFn: (input: { location: SavedLocation; expected: SavedLocation }) =>
      saveProjectLocation(project.id, input.location, input.expected),
    onSuccess: async () => {
      // Refetch before closing, so the card the person returns to already
      // shows what they saved rather than flashing the old value.
      await invalidateJobLocation(queryClient);
      setExpected(null);
      setError(null);
      toastSuccess(t("jobLocation.saved"));
    },
    // The draft stays exactly as typed, so a retry is one tap.
    onError: (e) => setError(formatApiError(e)),
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const busy = save.isPending;

  const openEditor = () => {
    setExpected(saved);
    setAddressDraft(saved.address ?? "");
    setGpsDraft(pointText(saved));
    setError(null);
  };

  const submit = () => {
    if (!isLead || !expected || inFlight.current) return;
    let point: { latitude: number | null; longitude: number | null };
    try {
      point = parseJobCoordinates(gpsDraft);
    } catch (e) {
      setError(t(coordinateErrorKey(e)));
      return;
    }
    const address = addressDraft.trim() || null;
    setError(null);
    inFlight.current = true;
    save.mutate({ location: { address, ...point }, expected });
  };

  const copy = async () => {
    const text = [savedAddress, savedPoint ? pointText(saved) : null]
      .filter(Boolean)
      .join("\n");
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      toastSuccess(t("jobLocation.copied"));
    } catch {
      pushToast(t("jobLocation.copyFailed"), "error");
    }
  };

  const editing = isLead && expected !== null;

  return (
    <section className="detail-card job-location" aria-labelledby={`job-location-${project.id}`}>
      <div className="job-location-head">
        <h2 id={`job-location-${project.id}`} className="job-location-title">
          {t("jobLocation.heading")}
        </h2>
        {isLead && !editing && (
          <button type="button" className="link job-location-edit" onClick={openEditor}>
            {hasLocation ? t("jobLocation.edit") : t("jobLocation.add")}
          </button>
        )}
      </div>

      {!editing && !hasLocation && (
        <div className="job-location-empty">
          <p className="job-location-empty-text">{t("jobLocation.empty")}</p>
          <p className="muted job-location-empty-text">
            {isLead ? t("jobLocation.emptyLead") : t("jobLocation.emptyCrew")}
          </p>
        </div>
      )}

      {!editing && hasLocation && (
        <>
          <dl className="job-location-facts">
            <div className="job-location-fact">
              <dt className="field-label">{t("jobLocation.address")}</dt>
              <dd className={savedAddress ? "job-location-value" : "job-location-value muted"}>
                {savedAddress ?? t("jobLocation.noAddress")}
              </dd>
            </div>
            <div className="job-location-fact">
              <dt className="field-label">{t("jobLocation.gps")}</dt>
              <dd
                className={savedPoint ? "job-location-value job-location-coords" : "job-location-value muted"}
              >
                {savedPoint ? pointText(saved) : t("jobLocation.noGps")}
              </dd>
            </div>
          </dl>
          {savedPoint && savedAddress && (
            <p className="muted job-location-note">{t("jobLocation.gpsUsedForDirections")}</p>
          )}
          <div className="job-location-actions">
            <DirectionsButton
              address={savedAddress}
              latitude={savedPoint ? saved.latitude : null}
              longitude={savedPoint ? saved.longitude : null}
              label={t("jobLocation.directions")}
              title={t("jobLocation.directionsTitle")}
            />
            <button type="button" className="link job-location-copy" onClick={() => void copy()}>
              <Copy size={14} aria-hidden /> {t("jobLocation.copy")}
            </button>
          </div>
        </>
      )}

      {isLead && editing && (
        <form className="job-location-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <div className="job-location-field">
            <label className="field-label" htmlFor={`job-location-address-${project.id}`}>
              {t("jobLocation.address")}
            </label>
            <textarea
              id={`job-location-address-${project.id}`}
              name="job-location-address"
              className="job-location-input"
              rows={2}
              autoComplete="street-address"
              value={addressDraft}
              disabled={busy}
              onChange={(e) => setAddressDraft(e.target.value)}
            />
          </div>
          <div className="job-location-field">
            <label className="field-label" htmlFor={`job-location-gps-${project.id}`}>
              {t("jobLocation.gps")}
            </label>
            <input
              id={`job-location-gps-${project.id}`}
              name="job-location-gps"
              className="job-location-input"
              // A plain text keyboard on purpose: iOS's decimal pad has no
              // minus sign and no comma, and western longitudes are negative.
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="40.7608, -111.8910"
              aria-describedby={`job-location-gps-hint-${project.id}`}
              value={gpsDraft}
              disabled={busy}
              onChange={(e) => setGpsDraft(e.target.value)}
            />
            <p id={`job-location-gps-hint-${project.id}`} className="muted job-location-hint">
              {t("jobLocation.gpsHint")}
            </p>
          </div>
          <p className="muted job-location-hint">{t("jobLocation.blankHint")}</p>

          {error && (
            <p className="error job-location-error" role="alert">
              {error}
            </p>
          )}

          <div className="job-location-actions">
            <button
              type="submit"
              className="button-like active-pill job-location-save"
              disabled={busy}
            >
              {busy ? t("jobLocation.saving") : t("jobLocation.save")}
            </button>
            <button
              type="button"
              className="link"
              disabled={busy || (!addressDraft && !gpsDraft)}
              onClick={() => {
                setAddressDraft("");
                setGpsDraft("");
                setError(null);
              }}
            >
              {t("jobLocation.clearBoth")}
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => {
                setExpected(null);
                setError(null);
              }}
            >
              {t("jobLocation.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
