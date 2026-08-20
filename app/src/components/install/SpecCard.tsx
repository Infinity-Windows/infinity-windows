// Read-only display of a mark's rich line-item spec. Used on the opening/install
// sheet, the unit detail, and (compact) on My Work. All field roles can read.
//
// When the caller supplies a projectId and the extractor located the mark's
// elevation drawing on the specs planset, the card leads with that picture
// (white line-work on black) above the text.
//
// The FULL card also shows a second, independent picture when one's
// available: where the mark sits on the OUTSIDE of the building (Studio
// 100x #36 — see MarkElevationCrop's own header for why that's a different
// "elevation" from the spec drawing above). Skipped in compact form — a
// dense list is no place to mount a 3D render.

import {
  checkSpecSize,
  PRINTED_SIZE_EXTRA_KEYS,
} from "../../lib/install/printedSize";
import type { MarkSpec } from "../../lib/install/specs";
import { formatSize } from "../../lib/install/specs";
import { MarkDrawing } from "./MarkDrawing";
import { MarkElevationCrop } from "./MarkElevationCrop";

interface SpecCardProps {
  spec: MarkSpec;
  /**
   * Rendered when the spec row exists but carries nothing to show.
   *
   * The card is the only thing that knows whether it has content — the test
   * includes the elevation drawing, which is fetched in here. Callers used to
   * choose between this card and the "no spec sheet" notice by asking whether
   * a spec ROW existed, so an empty row (normal after a supplier revision is
   * reprocessed) picked the card, the card returned null, and the screen
   * showed blank space where the specs belong. Passing the notice as a
   * fallback keeps that one decision in the one place that can make it.
   */
  fallback?: React.ReactNode;
  /**
   * Project the spec belongs to. Supplying it lets the card show the mark's
   * elevation drawing, cropped from that project's specs planset.
   */
  projectId?: string | null;
  /** Compact form for dense lists (My Work rows). */
  compact?: boolean;
}

/**
 * One spec line. Consecutive fields draw their own divider (see .spec-field
 * in index.css: an ember line, bright in the middle, fading to the sides), so
 * dividers appear exactly between the fields that actually rendered.
 */
function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="spec-field">
      <span className="spec-field-label">{label}</span>
      <span className="spec-field-value">{value}</span>
    </div>
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
export function SpecCard({
  spec,
  projectId,
  compact = false,
  fallback,
}: SpecCardProps) {
  const size = formatSize(spec);
  const chips = badges(spec);
  const energy = [
    spec.u_factor != null ? `U ${spec.u_factor}` : null,
    spec.shgc != null ? `SHGC ${spec.shgc}` : null,
  ].filter(Boolean) as string[];
  // The size-check bookkeeping in `extra` is for the foreman's review screen,
  // not the installer's card — the size shown here is already the trusted one.
  const extras = spec.extra
    ? Object.entries(spec.extra).filter(
        ([k, v]) => v != null && v !== "" && !PRINTED_SIZE_EXTRA_KEYS.includes(k),
      )
    : [];
  const sizeFlagged = checkSpecSize(spec) != null;

  const hasDrawing = Boolean(projectId && spec.image_bbox && spec.image_page);
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
    extras.length > 0 ||
    hasDrawing;
  if (!hasContent) return <>{fallback ?? null}</>;

  if (compact) {
    // One-line summary for dense lists: color · size · badges.
    const parts = [
      spec.color,
      size,
      spec.operation,
      spec.tempered ? "tempered" : null,
      spec.egress ? "egress" : null,
    ].filter(Boolean) as string[];
    if (parts.length === 0 && !spec.style && !hasDrawing) return null;
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {spec.style ? <span>{spec.style}</span> : null}
        {parts.length > 0 ? (
          <span>
            {spec.style ? " · " : ""}
            {parts.join(" · ")}
          </span>
        ) : null}
        {hasDrawing && <MarkDrawing spec={spec} projectId={projectId} compact />}
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

      {hasDrawing && <MarkDrawing spec={spec} projectId={projectId} />}
      {projectId && <MarkElevationCrop markCode={spec.mark_code} projectId={projectId} />}

      <Field label="Style" value={spec.style} />
      <Field label="Glass" value={spec.glass} />
      <Field label="Color" value={spec.color} />
      <Field label="Size" value={size} />
      {sizeFlagged && size && (
        <p className="muted" style={{ margin: "0 0 2px", fontSize: 11 }}>
          measured off the drawing — the call size disagrees, foreman checking
        </p>
      )}
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
