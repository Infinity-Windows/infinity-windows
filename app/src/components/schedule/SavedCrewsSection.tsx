// Saved crews (wave A, A1): named teams (2-6 people) a supervisor builds on
// the Roster because they work well together. CONTEXT.md: "Saved crew" — a
// SOFT law for the scheduling AI (wave A2), which keeps one together to the
// best of its ability and must say when it splits one.
//
// Reads are foreman+ (RLS), writes are supervisor+ (save_crew/delete_crew,
// enforced server-side) — mirrors Crew.tsx's own isLead/canSetRoles split:
// this section renders read-only for a foreman and full CRUD for a
// supervisor+, same as the role/skill controls above it on the same page.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Profile } from "../../lib/install/types";
import { deleteCrew, listSavedCrews, saveCrew, type SavedCrew } from "../../lib/schedule/savedCrews";

interface Props {
  profiles: Profile[];
  /** Supervisor+ — matches isSupervisorPlus(effectiveRole) on the page. */
  canEdit: boolean;
}

interface Draft {
  id: string | null;
  name: string;
  memberIds: Set<string>;
  note: string;
}

const MAX_NAME = 40;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 6;

function emptyDraft(): Draft {
  return { id: null, name: "", memberIds: new Set(), note: "" };
}

function fromSaved(c: SavedCrew): Draft {
  return { id: c.id, name: c.name, memberIds: new Set(c.member_ids), note: c.note ?? "" };
}

export function SavedCrewsSection({ profiles, canEdit }: Props) {
  const qc = useQueryClient();
  const crews = useQuery({ queryKey: ["savedCrews"], queryFn: listSavedCrews });
  const [draft, setDraft] = useState<Draft | null>(null);

  const nameOf = useMemo(() => {
    const byId = new Map(profiles.map((p) => [p.id, p.display_name]));
    return (id: string) => byId.get(id) ?? "Former crew member";
  }, [profiles]);

  const pickable = useMemo(() => profiles.filter((p) => p.active), [profiles]);

  const save = useMutation({
    mutationFn: (d: Draft) =>
      saveCrew({
        id: d.id,
        name: d.name.trim(),
        memberIds: [...d.memberIds],
        note: d.note.trim() || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["savedCrews"] });
      setDraft(null);
    },
    onError: (e) => window.alert(String((e as Error)?.message ?? e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCrew(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["savedCrews"] }),
    onError: (e) => window.alert(String((e as Error)?.message ?? e)),
  });

  function toggleMember(id: string) {
    setDraft((d) => {
      if (!d) return d;
      const next = new Set(d.memberIds);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_MEMBERS) next.add(id);
      return { ...d, memberIds: next };
    });
  }

  const trimmedName = draft?.name.trim() ?? "";
  const canSave =
    draft != null &&
    trimmedName.length > 0 &&
    trimmedName.length <= MAX_NAME &&
    draft.memberIds.size >= MIN_MEMBERS &&
    draft.memberIds.size <= MAX_MEMBERS;

  return (
    <>
      <div className="page-header" style={{ margin: "20px 0 6px" }}>
        <div>
          <h2 style={{ margin: 0 }}>Saved crews</h2>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            Teams that work well together. The AI keeps them together when it schedules.
          </p>
        </div>
        {canEdit && (
          <button className="button-like" onClick={() => setDraft(emptyDraft())}>
            + New crew
          </button>
        )}
      </div>

      {crews.isLoading ? (
        <p className="muted">Loading…</p>
      ) : (crews.data ?? []).length === 0 ? (
        <p className="muted">
          {canEdit ? "No saved crews yet — build one below." : "No saved crews yet."}
        </p>
      ) : (
        (crews.data ?? []).map((c) => (
          <div key={c.id} className="detail-card">
            <div className="row-gap" style={{ justifyContent: "space-between" }}>
              <strong>{c.name}</strong>
              {canEdit && (
                <div className="row-gap">
                  <button className="link" onClick={() => setDraft(fromSaved(c))}>
                    Edit
                  </button>
                  <button
                    className="link"
                    onClick={() => {
                      if (window.confirm(`Delete "${c.name}"? This can't be undone.`)) {
                        remove.mutate(c.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
              {c.member_ids.map(nameOf).join(", ")}
            </p>
            {c.note && <p style={{ margin: "4px 0 0", fontSize: 13 }}>{c.note}</p>}
          </div>
        ))
      )}

      {draft && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setDraft(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: 0, fontWeight: 700 }}>
              {draft.id ? "Edit saved crew" : "New saved crew"}
            </p>

            <label className="field-label">Name</label>
            <input
              value={draft.name}
              maxLength={MAX_NAME}
              placeholder="Team 1"
              onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
            />

            <label className="field-label">
              Members ({MIN_MEMBERS}-{MAX_MEMBERS})
            </label>
            <div className="sched-chips">
              {pickable.map((p) => {
                const picked = draft.memberIds.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={picked ? "sched-chip is-picked" : "sched-chip"}
                    disabled={!picked && draft.memberIds.size >= MAX_MEMBERS}
                    onClick={() => toggleMember(p.id)}
                  >
                    {p.display_name}
                  </button>
                );
              })}
              {pickable.length === 0 && <p className="muted">No active crew to pick from.</p>}
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              {draft.memberIds.size} picked
            </p>

            <label className="field-label">Note (optional)</label>
            <textarea
              value={draft.note}
              rows={2}
              placeholder="What this crew is good at, or why it works"
              onChange={(e) => setDraft((d) => (d ? { ...d, note: e.target.value } : d))}
            />

            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="button-like active-pill"
                disabled={!canSave || save.isPending}
                onClick={() => draft && save.mutate(draft)}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
              <button className="button-like" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
