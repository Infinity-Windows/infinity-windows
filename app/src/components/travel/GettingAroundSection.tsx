import { Car, Pencil, Plus, Trash2 } from "lucide-react";
import type { GroundTransport } from "../../lib/travel/types";
import { formatDateTimeWithZone } from "../../lib/travel/dates";
import { DirectionsButton } from "../maps/DirectionsButton";
import { CopyButton } from "./CopyButton";

export function GettingAroundSection({
  ground,
  canEdit,
  codesVisible,
  onAdd,
  onEdit,
  onDelete,
}: {
  ground: GroundTransport[];
  canEdit: boolean;
  codesVisible: boolean;
  onAdd: () => void;
  onEdit: (g: GroundTransport) => void;
  onDelete: (g: GroundTransport) => void;
}) {
  return (
    <section className="travel-section">
      <div className="travel-section-head">
        <h3><Car size={16} aria-hidden /> Getting around</h3>
        {canEdit && (
          <button className="travel-add-btn" onClick={onAdd}>
            <Plus size={15} aria-hidden /> Add transport
          </button>
        )}
      </div>

      {ground.length === 0 ? (
        <p className="muted travel-empty-note">No ground transport yet.</p>
      ) : (
        <div className="travel-cards">
          {ground.map((g) => (
            <article key={g.id} className="travel-card">
              <div className="travel-card-head">
                <strong>{[g.type, g.provider].filter(Boolean).join(" · ") || "Transport"}</strong>
                {canEdit && (
                  <span className="travel-card-tools">
                    <button aria-label="Edit transport" onClick={() => onEdit(g)}><Pencil size={14} /></button>
                    <button aria-label="Delete transport" onClick={() => onDelete(g)}><Trash2 size={14} /></button>
                  </span>
                )}
              </div>
              <dl className="travel-kv">
                {g.pickup_location && (
                  <div><dt>Pickup</dt><dd>{g.pickup_location}
                    {g.pickup_at && <> · {formatDateTimeWithZone(g.pickup_at, g.pickup_timezone)}</>}
                    <DirectionsButton address={g.pickup_location} />
                  </dd></div>
                )}
                {g.dropoff_location && (
                  <div><dt>Drop-off</dt><dd>{g.dropoff_location}
                    {g.dropoff_at && <> · {formatDateTimeWithZone(g.dropoff_at, g.dropoff_timezone)}</>}
                    <DirectionsButton address={g.dropoff_location} />
                  </dd></div>
                )}
              </dl>
              {codesVisible && g.confirmation_code && (
                <div className="travel-code-row">
                  <span className="travel-code-label">Confirmation</span>
                  <code className="travel-code">{g.confirmation_code}</code>
                  <CopyButton value={g.confirmation_code} label="Confirmation code" />
                </div>
              )}
              {g.notes && <p className="travel-notes">{g.notes}</p>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
