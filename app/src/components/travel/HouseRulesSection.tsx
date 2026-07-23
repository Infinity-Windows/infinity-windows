import { ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import type { Procedure } from "../../lib/travel/types";

export function HouseRulesSection({
  procedures,
  canEdit,
  onAdd,
  onEdit,
  onDelete,
}: {
  procedures: Procedure[];
  canEdit: boolean;
  onAdd: () => void;
  onEdit: (p: Procedure) => void;
  onDelete: (p: Procedure) => void;
}) {
  return (
    <section className="travel-section">
      <div className="travel-section-head">
        <h3><ListChecks size={16} aria-hidden /> House rules & living</h3>
        {canEdit && (
          <button className="travel-add-btn" onClick={onAdd}>
            <Plus size={15} aria-hidden /> Add rule
          </button>
        )}
      </div>

      {procedures.length === 0 ? (
        <p className="muted travel-empty-note">No procedures yet.</p>
      ) : (
        <div className="travel-rules">
          {procedures.map((p) => {
            const isTemplate = p.trip_id == null;
            return (
              <article key={p.id} className="travel-rule">
                <div className="travel-card-head">
                  <strong>{p.title}</strong>
                  {isTemplate && <span className="travel-badge travel-badge-crew">Company</span>}
                  {canEdit && !isTemplate && (
                    <span className="travel-card-tools">
                      <button aria-label="Edit rule" onClick={() => onEdit(p)}><Pencil size={14} /></button>
                      <button aria-label="Delete rule" onClick={() => onDelete(p)}><Trash2 size={14} /></button>
                    </span>
                  )}
                </div>
                {p.body && <p className="travel-notes">{p.body}</p>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
