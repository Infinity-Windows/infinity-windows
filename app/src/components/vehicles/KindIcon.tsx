import { Car, Container, Tractor, Truck } from "lucide-react";
import type { VehicleKind } from "../../lib/vehicles/types";

const ICONS = {
  pickup: Truck,
  car: Car,
  heavy_machinery: Tractor,
  trailer: Container,
} as const;

/** The Lucide glyph for a vehicle kind. */
export function KindIcon({ kind, size = 18 }: { kind: VehicleKind; size?: number }) {
  const Icon = ICONS[kind];
  return <Icon size={size} aria-hidden />;
}
