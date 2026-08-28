import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMyProfile,
  listCapabilityBadges,
  listProfiles,
  setCapabilityBadge,
  updateProfile,
} from "../lib/install/api";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  type Capability,
} from "../lib/dispatch";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { PinSetter } from "../components/PinGate";
import { SavedCrewsSection } from "../components/schedule/SavedCrewsSection";
import {
  isOwner,
  isSupervisorPlus,
  isForemanPlus,
  ROLE_LABELS,
  visibleRole,
  type CrewRole,
  type Profile,
} from "../lib/install/types";

const SKILL_LABELS: Record<number, string> = {
  1: "Apprentice",
  2: "Installer",
  3: "Installer II",
  4: "Senior",
  5: "Lead hand",
};

const ROLE_ORDER: CrewRole[] = ["installer", "foreman", "supervisor", "owner"];

export function Crew() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });
  const badges = useQuery({
    queryKey: ["capabilityBadges"],
    queryFn: listCapabilityBadges,
  });
  const badgeSet = new Set(
    (badges.data ?? []).map((b) => `${b.installer_id}:${b.capability}`),
  );
  const toggleBadge = useMutation({
    mutationFn: (args: { id: string; capability: Capability; granted: boolean }) =>
      setCapabilityBadge(args.id, args.capability, args.granted),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["capabilityBadges"] }),
  });

  const patch = useMutation({
    mutationFn: (args: { id: string; patch: Partial<Profile> }) =>
      updateProfile(args.id, args.patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      queryClient.invalidateQueries({ queryKey: ["myProfile"] });
    },
  });

  const { effectiveRole } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const canSetRoles = isSupervisorPlus(effectiveRole);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Roster</h1>
          <p className="muted" style={{ margin: 0 }}>
            Skill tier drives who gets which window.
          </p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>
      {!isLead && (
        <p className="muted">
          Only leads can edit the roster. You can set your own display name.
        </p>
      )}

      <PinSetter />

      <h2>Roster</h2>
      <ul className="unit-list">
        {(crew.data ?? []).map((p) => {
          const editable = isLead || p.id === me.data?.id;
          const initials = p.display_name
            .split(/\s+/)
            .map((s) => s[0])
            .join("")
            .slice(0, 2)
            .toUpperCase();
          return (
            <li key={p.id} className={p.active ? "crew-row live" : "crew-row"}>
              <div className="crew-main">
                <span className={p.active ? "avatar-chip" : "avatar-chip ghost"} aria-hidden>
                  {initials || "?"}
                </span>
                <input
                  className="crew-name"
                  defaultValue={p.display_name}
                  disabled={!editable}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== p.display_name) {
                      patch.mutate({ id: p.id, patch: { display_name: v } });
                    }
                  }}
                />
                <span className="muted">
                  {/* Owners wear "Supervisor" to everyone below owner (owner
                      ask, 2026-08-26) — the disguise, everywhere this word
                      shows. */}
                  {p.role !== "installer"
                    ? ROLE_LABELS[visibleRole(p.role, effectiveRole) as CrewRole] ??
                      visibleRole(p.role, effectiveRole)
                    : SKILL_LABELS[p.skill_level]}
                  {p.role === "installer"
                    ? CAPABILITIES.filter((c) => badgeSet.has(`${p.id}:${c}`))
                        .map((c) => ` · ${CAPABILITY_LABELS[c]}`)
                        .join("")
                    : ""}
                  {!p.active ? " · off today" : ""}
                </span>
              </div>
              {isLead && (
                <div className="crew-controls">
                  <label className="field-label">Skill</label>
                  <div className="grade-row">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <button
                        key={s}
                        className={p.skill_level === s ? "grade-btn selected" : "grade-btn"}
                        onClick={() => patch.mutate({ id: p.id, patch: { skill_level: s } })}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  {p.role === "installer" && (
                    <>
                      <label className="field-label">
                        Badges — what they may take on
                      </label>
                      <div className="row-gap" style={{ flexWrap: "wrap" }}>
                        {CAPABILITIES.map((c) => {
                          const held = badgeSet.has(`${p.id}:${c}`);
                          return (
                            <button
                              key={c}
                              className={held ? "button-like active-pill" : "button-like"}
                              disabled={toggleBadge.isPending}
                              onClick={() =>
                                toggleBadge.mutate({
                                  id: p.id,
                                  capability: c,
                                  granted: !held,
                                })
                              }
                            >
                              {CAPABILITY_LABELS[c]}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                  {/* Only owners manage owners (owner ask, 2026-08-26): a
                      disguised owner's row offers no role controls at all —
                      a supervisor "correcting" the Supervisor pill would
                      really be demoting the owner — and non-owners never get
                      the Owner button. The server refuses both anyway; the
                      UI just doesn't offer the refused tap. */}
                  {canSetRoles && (isOwner(effectiveRole) || p.role !== "owner") && (
                    <>
                      <label className="field-label">Role</label>
                      <div className="row-gap" style={{ flexWrap: "wrap" }}>
                        {ROLE_ORDER.filter(
                          (r) => isOwner(effectiveRole) || r !== "owner",
                        ).map((r) => (
                          <button
                            key={r}
                            className={p.role === r ? "button-like active-pill" : "button-like"}
                            onClick={() => patch.mutate({ id: p.id, patch: { role: r } })}
                          >
                            {ROLE_LABELS[r]}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="row-gap" style={{ marginTop: 8 }}>
                    <button
                      className={p.active ? "button-like" : "button-like active-pill"}
                      onClick={() => patch.mutate({ id: p.id, patch: { active: !p.active } })}
                    >
                      {p.active ? "On site" : "Off today"}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {crew.data?.length === 0 && (
          <p className="muted">No crew yet — sign-ins create profiles automatically.</p>
        )}
      </ul>

      {/* Foreman+ visibility (crew visibility norm, matches saved_crews' own
          RLS floor); only supervisor+ get create/edit/delete. */}
      {isLead && <SavedCrewsSection profiles={crew.data ?? []} canEdit={canSetRoles} />}
    </div>
  );
}
