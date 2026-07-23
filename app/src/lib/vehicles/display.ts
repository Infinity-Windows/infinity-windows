import type { Vehicle } from "./types";
import { TRAILER_SUBTYPE_LABELS, VEHICLE_KIND_LABELS } from "./types";

// Pure display formatting for a vehicle's name/subtitle. Kept free of React so
// the card, detail header, and map popup all read the same label.

/** "2021 Ford F-150", falling back to the kind label when fields are blank. */
export function vehicleTitle(v: Pick<Vehicle, "kind" | "year" | "make" | "model">): string {
  const parts = [v.year ? String(v.year) : "", v.make ?? "", v.model ?? ""]
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return VEHICLE_KIND_LABELS[v.kind];
}

/** "Truck · White · ABC-1234" style secondary line. */
export function vehicleSubtitle(
  v: Pick<Vehicle, "kind" | "trailer_subtype" | "color" | "plate">,
): string {
  const kind =
    v.kind === "trailer" && v.trailer_subtype
      ? `${TRAILER_SUBTYPE_LABELS[v.trailer_subtype]} trailer`
      : VEHICLE_KIND_LABELS[v.kind];
  const parts = [kind, v.color?.trim() || "", v.plate?.trim() || ""].filter(Boolean);
  return parts.join(" · ");
}

/** Odometer/engine-hours reading appropriate to the vehicle kind. */
export function usageLabel(
  v: Pick<Vehicle, "kind" | "odometer" | "engine_hours">,
): string | null {
  if (v.kind === "heavy_machinery") {
    return v.engine_hours != null ? `${formatNumber(v.engine_hours)} hrs` : null;
  }
  if (v.kind === "trailer") return null;
  return v.odometer != null ? `${formatNumber(v.odometer)} mi` : null;
}

function formatNumber(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
