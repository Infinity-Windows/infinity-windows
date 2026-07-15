import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getMyProfile, listProfiles, updateProfile } from "../lib/install/api";
import type { CrewRole, Profile } from "../lib/install/types";

const SKILL_LABELS: Record<number, string> = {
  1: "Apprentice",
  2: "Installer",
  3: "Installer II",
  4: "Senior",
  5: "Lead hand",
};

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

  const isLead = me.data?.role === "lead";

  return (
    <div className="page">
      <header className="page-header">
        <h1>Crew</h1>
        <Link to="/" className="button-like">
          Home
        </Link>
      </header>
      <p className="muted">
        Skill tier drives who gets which window. Leads can take anything;
        apprentices get the simpler types.
      </p>
      {!isLead && (
        <p className="muted">
          Only leads can edit the roster. You can set your own display name.
        </p>
      )}

      <ul className="unit-list">
        {(crew.data ?? []).map((p) => {
          const editable = isLead || p.id === me.data?.id;
          return (
            <li key={p.id} className="crew-row">
              <div className="crew-main">
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
                  {p.role === "lead" ? "Lead" : SKILL_LABELS[p.skill_level]}
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
                  <div className="row-gap">
                    <button
                      className={p.role === "lead" ? "button-like active-pill" : "button-like"}
                      onClick={() =>
                        patch.mutate({
                          id: p.id,
                          patch: { role: (p.role === "lead" ? "installer" : "lead") as CrewRole },
                        })
                      }
                    >
                      {p.role === "lead" ? "Lead ✓" : "Make lead"}
                    </button>
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
