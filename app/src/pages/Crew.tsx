import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getMyProfile, listProfiles, updateProfile } from "../lib/install/api";
import { PinSetter } from "../components/PinGate";
import {
  isAdmin,
  isLeadLike,
  ROLE_LABELS,
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

const ROLE_ORDER: CrewRole[] = ["installer", "foreman", "admin", "big_boss"];

export function Crew() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });

  const patch = useMutation({
    mutationFn: (args: { id: string; patch: Partial<Profile> }) =>
      updateProfile(args.id, args.patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      queryClient.invalidateQueries({ queryKey: ["myProfile"] });
    },
  });

  const isLead = isLeadLike(me.data?.role);
  const canSetRoles = isAdmin(me.data?.role);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Crew</h1>
          <p className="muted" style={{ margin: 0 }}>
            Skill tier drives who gets which window.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">
          ‹
        </Link>
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
                  {p.role !== "installer"
                    ? ROLE_LABELS[p.role as CrewRole] ?? p.role
                    : SKILL_LABELS[p.skill_level]}
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
                  {canSetRoles && (
                    <>
                      <label className="field-label">Role</label>
                      <div className="row-gap" style={{ flexWrap: "wrap" }}>
                        {ROLE_ORDER.map((r) => (
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
    </div>
  );
}
