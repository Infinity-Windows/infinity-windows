// Job facts on the unit sheet (S5, .scratch/installer-os): the READ-ONLY
// half of ADR-0011. The Job facts card on a job's Overview (BuildFactsPanel)
// is where a foreman writes these answers; this card is where every crew
// role — installers included — reads them back, one screen down, on the
// exact unit they're standing at. No editing here, and no data-flow change:
// same buildFacts query key the rest of the app already warms, so this card
// is never the first thing to ask the network for anything.
//
// Shows only answered fields. The exterior situations come first, one row
// each ("Brick · Outset 1"", "Stucco · Inset 1¼" · sides"), because a house
// is more than one finish and an installer needs the one for the wall in
// front of them. When the unit's own spec (project_mark_specs.extra
// .inset_outset) names a set depth that NO recorded situation uses, the
// spec's value is shown and wins — job facts are a DEFAULT, never an
// override.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  EXTERIOR_FINISH_KEYS,
  FASTENER_TYPE_KEYS,
  FLASHING_SYSTEM_KEYS,
  SET_DEPTH_KEYS,
  buildFactsKey,
  getBuildFacts,
  isBlankExteriorLine,
  pickListLabel,
} from "../../lib/install/buildFacts";
import { formatInches } from "../../lib/install/specs";
import { telHref } from "../../lib/travel/links";
import {
  formatSetDepthValue,
  hasAnyUnitFact,
  joinFactLine,
  specInsetOutsetOf,
  specOverrideLine,
} from "../../lib/install/unitFactsCard";
import { useT } from "../../lib/i18n";

interface UnitFactsCardProps {
  projectId: string | null | undefined;
  /** The unit's own spec `extra`, straight off the spec card's spec — read
   * for inset_outset only. */
  specExtra: Record<string, unknown> | null | undefined;
}

interface FactRow {
  key: string;
  label: string;
  value: ReactNode;
}

export function UnitFactsCard({ projectId, specExtra }: UnitFactsCardProps) {
  const t = useT();

  const facts = useQuery({
    queryKey: buildFactsKey(projectId ?? ""),
    queryFn: () => getBuildFacts(projectId as string),
    enabled: Boolean(projectId),
  });

  // Loading, offline with nothing cached, or the migration hasn't reached
  // this database yet all look the same from here: nothing to show yet.
  // Never a spinner on a card this far down a sheet an installer is already
  // scanning past.
  if (facts.isLoading) return null;

  const f = facts.data ?? null;

  if (!f || !hasAnyUnitFact(f)) {
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

  const rows: FactRow[] = [];

  f.exterior_lines.forEach((line, i) => {
    if (isBlankExteriorLine(line)) return;
    const finishLabel = line.exterior_finish ? t(EXTERIOR_FINISH_KEYS[line.exterior_finish]) : null;
    const depthLabel = line.set_depth
      ? formatSetDepthValue(t(SET_DEPTH_KEYS[line.set_depth]), line.set_depth_inches)
      : formatInches(line.set_depth_inches);
    const value = joinFactLine([finishLabel, depthLabel, line.exterior_note]);
    if (value) {
      rows.push({ key: `exterior-${i}`, label: t("buildFacts.field.exteriorFinish"), value });
    }
  });

  const override = specOverrideLine(f.exterior_lines, specInsetOutsetOf(specExtra));
  if (override) {
    const depthLabel = t(SET_DEPTH_KEYS[override.value]);
    rows.push({
      key: "setDepth",
      label: t("buildFacts.field.setDepth"),
      value: (
        <>
          {depthLabel}
          <span className="unit-facts-wins"> {t("unitFacts.setDepth.specWins", { value: depthLabel })}</span>
        </>
      ),
    });
  }

  const flashingLabel = pickListLabel(
    f.flashing_system ? t(FLASHING_SYSTEM_KEYS[f.flashing_system]) : null,
    f.flashing_system,
    f.flashing_system_other,
  );
  const flashingValue = joinFactLine([flashingLabel, f.flashing_note]);
  if (flashingValue) {
    rows.push({ key: "flashing", label: t("buildFacts.field.flashingSystem"), value: flashingValue });
  }

  const fastenerTypeLabel = pickListLabel(
    f.fastener_type ? t(FASTENER_TYPE_KEYS[f.fastener_type]) : null,
    f.fastener_type,
    f.fastener_type_other,
  );
  const fastenerLength = formatInches(f.fastener_length_in);
  const fastenerSpacing = formatInches(f.fastener_spacing_in);
  const spacingPhrase = fastenerSpacing
    ? t("unitFacts.fastener.every", { spacing: fastenerSpacing })
    : null;
  const fastenerValue = joinFactLine([fastenerTypeLabel, fastenerLength, spacingPhrase, f.fastener_note]);
  if (fastenerValue) {
    rows.push({ key: "fasteners", label: t("buildFacts.field.fastenerType"), value: fastenerValue });
  }

  if (f.elevation_notes && f.elevation_notes.trim() !== "") {
    rows.push({ key: "elevationNotes", label: t("buildFacts.field.elevationNotes"), value: f.elevation_notes });
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
