import { BackChip } from "../components/BackChip";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getMyProfile,
  listCapabilityBadges,
  listClearances,
  listProfilesIncludingRemoved,
  setCapabilityBadge,
  setProfileGrants,
  updateProfile,
} from "../lib/install/api";
import { listCertifications, type Certification } from "../lib/credentials";
import { CredentialSummary } from "../components/crew/CredentialSummary";
import { SkillTree } from "../components/crew/SkillTree";
import { formatApiError } from "../lib/errors";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  type Capability,
} from "../lib/dispatch";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { formatRate, indexPayRates, listPayRates, salaryForMonth } from "../lib/payRates";
import { CompensationPanel } from "../components/crew/CompensationPanel";
import { PinSetter } from "../components/PinGate";
import { SavedCrewsSection } from "../components/schedule/SavedCrewsSection";
import { useT } from "../lib/i18n";
import {
  isOwner,
  isSupervisorPlus,
  isForemanPlus,
  isRemovedProfile,
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

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function Crew() {
  const queryClient = useQueryClient();
  const [payMonth, setPayMonth] = useState(todayIso().slice(0, 7));
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const crew = useQuery({
    queryKey: ["profilesIncludingRemoved"],
    queryFn: listProfilesIncludingRemoved,
  });
  const badges = useQuery({
    queryKey: ["capabilityBadges"],
    queryFn: listCapabilityBadges,
  });
  // Wave O: one read for the whole roster rather than one per row. Both
  // degrade to empty on a phone whose database has the app but not yet
  // 20260983000000, so this page still loads ahead of the migration.
  const clearances = useQuery({
    queryKey: ["clearances"],
    queryFn: listClearances,
  });
  const certs = useQuery({
    queryKey: ["certifications"],
    queryFn: () => listCertifications(),
  });
  const badgeSet = new Set(
    (badges.data ?? []).map((b) => `${b.installer_id}:${b.capability}`),
  );
  const clearanceCounts = new Map<string, number>();
  for (const c of clearances.data ?? []) {
    clearanceCounts.set(c.installer_id, (clearanceCounts.get(c.installer_id) ?? 0) + 1);
  }
  const certsByPerson = new Map<string, Certification[]>();
  for (const cert of certs.data ?? []) {
    const list = certsByPerson.get(cert.profileId);
    if (list) list.push(cert);
    else certsByPerson.set(cert.profileId, [cert]);
  }
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
      queryClient.invalidateQueries({ queryKey: ["profilesIncludingRemoved"] });
      queryClient.invalidateQueries({ queryKey: ["myProfile"] });
    },
  });

  const t = useT();
  const { effectiveRole, grants } = useEffectiveRole();
  const isLead = isForemanPlus(effectiveRole);
  const canSetRoles = isSupervisorPlus(effectiveRole);
  // Wave Z: only an owner hands out money. Same floor as set_profile_grants,
  // which refuses everyone else server-side — this just doesn't offer the tap.
  const canSetGrants = isOwner(effectiveRole);
  // Reading pay is its own grant. The query is `enabled` on it purely to save a
  // round trip: pay_rates' policy answers anybody else with no rows anyway.
  const canSeePay = isOwner(effectiveRole) || grants.pay === true;
  const payRates = useQuery({
    queryKey: ["payRates"],
    queryFn: () => listPayRates(),
    enabled: canSeePay,
  });
  const ratesByPerson = indexPayRates(payRates.data ?? []);
  const monthlySalaries = (crew.data ?? []).filter(p => !p.retired_at || p.retired_at.slice(0, 7) >= payMonth)
    .map(p => salaryForMonth(ratesByPerson.get(p.id), payMonth)).filter((amount): amount is number => amount !== null);
  const salaryTotal = monthlySalaries.reduce((total, amount) => total + amount, 0);

  const [grantError, setGrantError] = useState<string | null>(null);
  const setGrants = useMutation({
    mutationFn: (args: { id: string; costs?: boolean; pay?: boolean }) =>
      setProfileGrants(args.id, { costs: args.costs, pay: args.pay }),
    onSuccess: () => {
      setGrantError(null);
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      queryClient.invalidateQueries({ queryKey: ["profilesIncludingRemoved"] });
      queryClient.invalidateQueries({ queryKey: ["myProfile"] });
      queryClient.invalidateQueries({ queryKey: ["myRealProfile"] });
    },
    onError: (e) => setGrantError(formatApiError(e)),
  });

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

      {grantError && <p className="error">{grantError}</p>}

      {/* Wave O (O5): what a bid asks for. Supervisor+ only — it is a number
          about the company rather than about a person, and it is written to be
          copied out of the app. */}
      {canSetRoles && <CredentialSummary certifications={certs.data ?? []} />}

      {canSeePay && <section className="salary-month-summary" aria-label="Monthly salary summary">
        <header><div><h2>Monthly salaries on file</h2><strong>{payRates.isPending || crew.isPending ? "Loading…" : payRates.isError || crew.isError ? "Unavailable" : formatRate(salaryTotal)}</strong></div>
          <label>Pay month<input type="month" value={payMonth} onChange={e => {if(e.target.value) setPayMonth(e.target.value);}} /></label>
        </header>
        <p className="muted">{monthlySalaries.length} salaried {monthlySalaries.length === 1 ? "person" : "people"} · fixed monthly amounts. This is the pay setup, not a payment confirmation. Hourly pay and job hours stay separate.</p>
        {payRates.isError && <p className="error">{formatApiError(payRates.error)}</p>}
      </section>}
      <h2>Roster</h2>
      <ul className="unit-list">
        {(crew.data ?? []).map((p) => {
          // A removed login is still on this list, under the name it always
          // had, because every job record points at it — but nothing about it
          // is editable any more and nothing may be handed to it. See
          // listProfilesIncludingRemoved.
          const removed = isRemovedProfile(p);
          const editable = (isLead || p.id === me.data?.id) && !removed;
          const initials = p.display_name
            .split(/\s+/)
            .map((s) => s[0])
            .join("")
            .slice(0, 2)
            .toUpperCase();
          return (
            <li
              key={p.id}
              className={p.active && !removed ? "crew-row live" : "crew-row"}
              style={removed ? { opacity: 0.55 } : undefined}
            >
              <div className="crew-main">
                <span
                  className={p.active && !removed ? "avatar-chip" : "avatar-chip ghost"}
                  aria-hidden
                >
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
                  {!p.active && !removed ? " · off today" : ""}
                </span>
                {removed && (
                  <span
                    className="muted"
                    data-testid="crew-removed"
                    style={{
                      fontWeight: 700,
                      textTransform: "uppercase",
                      fontSize: 11,
                    }}
                  >
                    {t("crew.removedLogin")}
                  </span>
                )}
              </div>
              {canSeePay && removed && <CompensationPanel profileId={p.id} name={p.display_name}
                month={payMonth} rates={ratesByPerson.get(p.id) ?? []} canSet={false} onSaved={() => {}} />}
              {isLead && !removed && (
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
                  {/* Wave O (O3): badges, cleared window types and cards in one
                      view, on the row they are about. Everyone who can reach
                      this page can read it; only a supervisor+ can verify or
                      void a card, and only the cardholder can add their own —
                      set_certification refuses the rest in SQL either way. */}
                  <SkillTree
                    profileId={p.id}
                    badges={CAPABILITIES.filter((c) => badgeSet.has(`${p.id}:${c}`))}
                    clearanceCount={clearanceCounts.get(p.id) ?? 0}
                    certifications={certsByPerson.get(p.id) ?? []}
                    isSelf={p.id === me.data?.id}
                    canManage={canSetRoles}
                    onChanged={() =>
                      queryClient.invalidateQueries({ queryKey: ["certifications"] })
                    }
                  />
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
                  {canSeePay && (
                    <CompensationPanel
                      profileId={p.id}
                      name={p.display_name}
                      month={payMonth}
                      rates={ratesByPerson.get(p.id) ?? []}
                      canSet={isOwner(effectiveRole)}
                      onSaved={() => {
                        void queryClient.invalidateQueries({ queryKey: ["payRates"] });
                        void queryClient.invalidateQueries({ queryKey: ["companyCosting"] });
                      }}
                    />
                  )}
                  {/* Wave Z: money is a grant, not a rank. An owner can let one
                      supervisor read the cost books without making them an
                      owner, and can hand pay rates to somebody who never sees a
                      job's margin. Owners themselves always see both, so their
                      own row shows no checkboxes to mislead anyone. */}
                  {canSetGrants && p.role !== "owner" && (
                    <>
                      <label className="field-label">Money</label>
                      <div className="row-gap" style={{ flexWrap: "wrap" }}>
                        <label className="row-gap" style={{ alignItems: "center", gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={p.can_see_costs === true}
                            disabled={setGrants.isPending}
                            onChange={(e) =>
                              setGrants.mutate({ id: p.id, costs: e.target.checked })
                            }
                          />
                          Sees costs
                        </label>
                        <label className="row-gap" style={{ alignItems: "center", gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={p.can_see_pay === true}
                            disabled={setGrants.isPending}
                            onChange={(e) =>
                              setGrants.mutate({ id: p.id, pay: e.target.checked })
                            }
                          />
                          Sees pay rates
                        </label>
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
