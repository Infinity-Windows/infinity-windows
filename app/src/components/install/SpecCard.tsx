// Read-only display of a mark's rich line-item spec. Used on the opening/install
// sheet, the unit detail, and (compact) on My Work. All field roles can read.

import type { MarkSpec } from "../../lib/install/specs";
import { formatSize } from "../../lib/install/specs";

interface SpecCardProps {
  spec: MarkSpec;
  /** Compact form for dense lists (My Work rows). */
  compact?: boolean;
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <p style={{ margin: "2px 0" }}>
      <span className="muted">{label}: </span>
      <strong style={{ fontWeight: 600 }}>{value}</strong>
    </p>
  );
}

function badges(spec: MarkSpec): string[] {
  const out: string[] = [];
  if (spec.operation) out.push(spec.operation);
  if (spec.tempered) out.push("Tempered");
  if (spec.egress) out.push("Egress");
  return out;
}

/**
 * Render a mark's spec. Degrades gracefully: renders nothing when the spec has
 * no usable content, and each field hides when absent.
 */
export function SpecCard({ spec, compact = false }: SpecCardProps) {
  const size = formatSize(spec);
  const chips = badges(spec);
  const energy = [
    spec.u_factor != null ? `U ${spec.u_factor}` : null,
    spec.shgc != null ? `SHGC ${spec.shgc}` : null,
  ].filter(Boolean) as string[];
  const extras = spec.extra
    ? Object.entries(spec.extra).filter(([, v]) => v != null && v !== "")
    : [];

  const hasContent =
    spec.style ||
    spec.glass ||
    spec.color ||
    size ||
    chips.length > 0 ||
    energy.length > 0 ||
    spec.grids ||
    spec.screen ||
    spec.product_line ||
    extras.length > 0;
  if (!hasContent) return null;

  if (compact) {
    // One-line summary for dense lists: color · size · badges.
    const parts = [
      spec.color,
      size,
      spec.operation,
      spec.tempered ? "tempered" : null,
      spec.egress ? "egress" : null,
    ].filter(Boolean) as string[];
    if (parts.length === 0 && !spec.style) return null;
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {spec.style ? <span>{spec.style}</span> : null}
        {parts.length > 0 ? (
          <span>
            {spec.style ? " · " : ""}
            {parts.join(" · ")}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="detail-card spec-card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span className="field-label" style={{ margin: 0 }}>
          Spec · mark #{spec.mark_code}
        </span>
        {!spec.confirmed && (
          <span className="warn-text" style={{ fontSize: 11 }}>
            draft — not confirmed
          </span>
        )}
      </div>

      <Field label="Style" value={spec.style} />
      <Field label="Glass" value={spec.glass} />
      <Field label="Color" value={spec.color} />
      <Field label="Size" value={size} />
      <Field label="Product line" value={spec.product_line} />
      <Field label="Grids" value={spec.grids} />
      <Field label="Screen" value={spec.screen} />

      {chips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {chips.map((c) => (
            <span
              key={c}
              className="pill"
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                background: "var(--surface-2, rgba(255,255,255,0.08))",
                border: "1px solid var(--border, rgba(255,255,255,0.15))",
              }}
            >
              {c}
            </span>
          ))}
        </div>
      )}

      {energy.length > 0 && (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
          {energy.join(" · ")}
        </p>
      )}

      {extras.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary className="muted" style={{ fontSize: 12 }}>
            More details
          </summary>
          <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12 }}>
            {extras.map(([k, v]) => (
              <li key={k}>
                {k.replace(/_/g, " ")}: {String(v)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
