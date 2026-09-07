// Job facts on the unit sheet (S5, .scratch/installer-os): the READ-ONLY
// half of ADR-0011. The Job facts card on a job's Overview (BuildFactsPanel)
// is where a foreman writes these answers; this card is where every crew
// role — installers included — reads them back, one screen down, on the
// exact unit they're standing at. No editing here, and no data-flow change:
// same buildFacts/elevationViews query keys the rest of the app already
// warms, so this card is never the first thing to ask the network for
// anything.
//
// Shows only answered fields, in the order ADR-0011 settled on. When the
// unit's own spec (project_mark_specs.extra.inset_outset) disagrees with the
// job's set depth, the spec's value is shown and wins — job facts are a
// DEFAULT, never an override.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  EXTERIOR_FINISH_KEYS,
  FASTENER_TYPE_KEYS,
  FLASHING_SYSTEM_KEYS,
  SET_DEPTH_KEYS,
  SILL_PAN_KEYS,
  SILL_PAN_TYPE_KEYS,
  buildFactsKey,
  getBuildFacts,
} from "../../lib/install/buildFacts";
import { listElevationViews } from "../../lib/install/api";
import { formatInches } from "../../lib/install/specs";
import { telHref } from "../../lib/travel/links";
import {
  deriveUnitElevation,
  elevationNotesFor,
  formatSetDepthValue,
  hasAnyUnitFact,
  joinFactLine,
  resolveSetDepthLine,
  specInsetOutsetOf,
  type Elevation,
} from "../../lib/install/unitFactsCard";
import { useT } from "../../lib/i18n";
import type { TKey } from "../../lib/i18n/catalog";

interface UnitFactsCardProps {
  projectId: string | null | undefined;
  /** This unit's own code, e.g. "1A" or a chained "1A-2" — normalized to its
   * base mark before looking anything up, same as the spec card. */
  openingCode: string | null | undefined;
  /** The unit's own spec `extra`, straight off the spec card's spec — read
   * for inset_outset only. */
  specExtra: Record<string, unknown> | null | undefined;
}

/** Existing per-elevation field labels (buildFacts.field.note*) — reused
 * as the row label whenever the unit's own side can't be determined and
 * every non-empty note has to be shown, each named. */
const ELEVATION_LABEL_KEYS: Record<Elevation, TKey> = {
  north: "buildFacts.field.noteNorth",
  south: "buildFacts.field.noteSouth",
  east: "buildFacts.field.noteEast",
  west: "buildFacts.field.noteWest",
};

interface FactRow {
  key: string;
  label: string;
  value: ReactNode;
}

export function UnitFactsCard({ projectId, openingCode, specExtra }: UnitFactsCardProps) {
  const t = useT();

  const facts = useQuery({
    queryKey: buildFactsKey(projectId ?? ""),
    queryFn: () => getBuildFacts(projectId as string),
    enabled: Boolean(projectId),
  });

  // Same key ProjectMap/MarkElevationCrop already warm for this job — this
  // card rides their cache instead of asking the network again.
  const elevationViews = useQuery({
    queryKey: ["elevationViews", projectId],
    queryFn: () => listElevationViews(projectId as string),
    enabled: Boolean(projectId),
  });

  // Loading, offline with nothing cached, or the migration hasn't reached
  // this database yet all look the same from here: nothing to show yet.
  // Never a spinner on a card this far down a sheet an installer is already
  // scanning past.
  if (facts.isLoading) return null;

  const f = facts.data ?? null;
  const elevation = deriveUnitElevation(openingCode, elevationViews.data ?? []);

  if (!f || !hasAnyUnitFact(f, elevation)) {
    return (
      <div className="detail-card unit-facts-card">
        <h2 className="field-label" style={{ margin: 0 }}>
          {t("buildFacts.title")}
        </h2>
        <p className="muted unit-facts-empty">
          {t("unitFacts.empty")}{" "}
          <Link to="/ask" className="link">
            {t("unitFacts.showMe")}
          </Link>
        </p>
      </div>
    );
  }

  const specInsetOutset = specInsetOutsetOf(specExtra);
  const rows: FactRow[] = [];

  const exteriorLabel = f.exterior_finish ? t(EXTERIOR_FINISH_KEYS[f.exterior_finish]) : null;
  const exteriorValue = joinFactLine([exteriorLabel, f.exterior_note]);
  if (exteriorValue) {
    rows.push({ key: "exterior", label: t("buildFacts.field.exteriorFinish"), value: exteriorValue });
  }

  const setDepthLine = resolveSetDepthLine(f.set_depth, specInsetOutset);
  if (setDepthLine) {
    const depthLabel = t(SET_DEPTH_KEYS[setDepthLine.value]);
    const displayValue = formatSetDepthValue(depthLabel, f.set_depth_inches);
    rows.push({
      key: "setDepth",
      label: t("buildFacts.field.setDepth"),
      value: (
        <>
          {displayValue}
          {setDepthLine.disagrees && (
            <span className="unit-facts-wins">
              {" "}
              {t("unitFacts.setDepth.specWins", { value: depthLabel })}
            </span>
          )}
        </>
      ),
    });
  }

  const flashingLabel = f.flashing_system ? t(FLASHING_SYSTEM_KEYS[f.flashing_system]) : null;
  const flashingValue = joinFactLine([flashingLabel, f.flashing_note]);
  if (flashingValue) {
    rows.push({ key: "flashing", label: t("buildFacts.field.flashingSystem"), value: flashingValue });
  }

  const fastenerTypeLabel = f.fastener_type ? t(FASTENER_TYPE_KEYS[f.fastener_type]) : null;
  const fastenerLength = formatInches(f.fastener_length_in);
  const fastenerSpacing = formatInches(f.fastener_spacing_in);
  const spacingPhrase = fastenerSpacing
    ? t("unitFacts.fastener.every", { spacing: fastenerSpacing })
    : null;
  const fastenerValue = joinFactLine([fastenerTypeLabel, fastenerLength, spacingPhrase, f.fastener_note]);
  if (fastenerValue) {
    rows.push({ key: "fasteners", label: t("buildFacts.field.fastenerType"), value: fastenerValue });
  }

  const sillPanLabel = f.sill_pan ? t(SILL_PAN_KEYS[f.sill_pan]) : null;
  const sillPanTypeLabel = f.sill_pan_type ? t(SILL_PAN_TYPE_KEYS[f.sill_pan_type]) : null;
  const sillPanValue = joinFactLine([sillPanLabel, sillPanTypeLabel]);
  if (sillPanValue) {
    rows.push({ key: "sillPan", label: t("buildFacts.field.sillPan"), value: sillPanValue });
  }

  const elevationNotes = elevationNotesFor(f, elevation);
  if (elevation) {
    for (const n of elevationNotes) {
      rows.push({ key: "elevationNote", label: t("unitFacts.field.elevationNote"), value: n.note });
    }
  } else {
    for (const n of elevationNotes) {
      rows.push({
        key: `elevationNote-${n.elevation}`,
        label: t(ELEVATION_LABEL_KEYS[n.elevation]),
        value: n.note,
      });
    }
  }

  if (f.site_rules && f.site_rules.trim() !== "") {
    rows.push({ key: "siteRules", label: t("buildFacts.field.siteRules"), value: f.site_rules });
  }

  if (f.gc_contact_name || f.gc_contact_phone) {
    const tel = telHref(f.gc_contact_phone);
    rows.push({
      key: "gcContact",
      label: t("buildFacts.field.gcContactName"),
      value: (
        <>
          {f.gc_contact_name}
          {f.gc_contact_name && f.gc_contact_phone ? " · " : ""}
          {f.gc_contact_phone && (tel ? <a href={tel}>{f.gc_contact_phone}</a> : f.gc_contact_phone)}
        </>
      ),
    });
  }

  return (
    <div className="detail-card unit-facts-card">
      <h2 className="field-label" style={{ margin: 0 }}>
        {t("buildFacts.title")}
      </h2>
      {rows.map((row) => (
        <div className="unit-facts-field" key={row.key}>
          <span className="unit-facts-field-label">{row.label}</span>
          <span className="unit-facts-field-value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
