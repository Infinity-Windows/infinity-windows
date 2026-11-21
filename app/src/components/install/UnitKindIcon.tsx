import { AppWindow, DoorClosed, Grid2x2, SquareDashed } from "lucide-react";
import type { UnitDetails } from "../../lib/install/unitDetails";

// The last step of the unit picture rule shared by the details panel, Workday
// tiles and Plan tiles: a unit with no drawing still says what kind it is, and
// only a unit nobody has typed yet falls back to the dashed square.
export function UnitKindIcon({ kind, size }: { kind: UnitDetails["kind"] | undefined; size: number }) {
  return kind === "door" ? <DoorClosed size={size} aria-hidden="true" />
    : kind === "window" ? <AppWindow size={size} aria-hidden="true" />
    : kind === "curtain_wall" ? <Grid2x2 size={size} aria-hidden="true" />
    : <SquareDashed size={size} aria-hidden="true" />;
}
