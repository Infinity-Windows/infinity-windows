// One view of everything the app knows a person is allowed to do (Wave O, O3).
//
// Three different things had grown up in three different places and never sat
// beside each other:
//   * BADGES        — what a foreman has said this person may take on
//                     (capability_badges, 20260923010000).
//   * CLEARANCES    — which window types a lead, or a passed video quiz, has
//                     signed them off for (installer_clearance).
//   * CERTIFICATIONS— the cards with expiry dates (wave O).
//
// The same component renders on a Roster row, where a supervisor can act on it,
// and on My Work, where a person reads it about themselves and can only add
// their own card. Nothing here decides permission — the callers pass what they
// are, and set_certification refuses anything else in SQL.

import { useT } from "../../lib/i18n";
import { CAPABILITIES, CAPABILITY_LABELS, type Capability } from "../../lib/dispatch";
import { todayLocalDay, type Certification } from "../../lib/credentials";
import { CredentialsSection } from "./CredentialsSection";

export function SkillTree({
  profileId,
  badges,
  clearanceCount,
  certifications,
  isSelf,
  canManage,
  onChanged,
  today = todayLocalDay(),
}: {
  profileId: string;
  /** The capabilities this person holds, from the Roster's one badge read. */
  badges: Capability[];
  /** How many window types they are cleared for. A number rather than a list:
   * the list is a catalog screen's job, and this is a summary. */
  clearanceCount: number;
  certifications: Certification[];
  isSelf: boolean;
  canManage: boolean;
  onChanged: () => void;
  today?: string;
}) {
  const t = useT();
  const held = CAPABILITIES.filter((c) => badges.includes(c));
  const empty =
    held.length === 0 && clearanceCount === 0 && certifications.length === 0;

  return (
    <div className="skill-tree">
      <label className="field-label">{t("cred.skillTree")}</label>
      {empty && !isSelf && !canManage && (
        <p className="muted" style={{ margin: 0 }}>
          {t("cred.nothingYet")}
        </p>
      )}

      {held.length > 0 && (
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
          {t("cred.badges")}: {held.map((c) => CAPABILITY_LABELS[c]).join(" · ")}
        </p>
      )}
      {clearanceCount > 0 && (
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
          {clearanceCount === 1
            ? t("cred.clearances.one", { n: clearanceCount })
            : t("cred.clearances.many", { n: clearanceCount })}
        </p>
      )}

      <CredentialsSection
        profileId={profileId}
        certifications={certifications}
        isSelf={isSelf}
        canManage={canManage}
        onChanged={onChanged}
        today={today}
      />
    </div>
  );
}
