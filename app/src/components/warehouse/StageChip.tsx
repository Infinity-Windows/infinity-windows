// One hue per package stage, used everywhere a stage is named (owner pick 1,
// W2). Stage vocabulary is STAGE_LABELS in pages/storage/JobMaterials.tsx —
// this component only draws the pill; the words stay whatever the caller
// already says.
import type { ReactNode } from "react";

export type PackageStage = "minted" | "received" | "stored" | "checked_out";

export function StageChip({
  stage,
  children,
}: {
  stage: PackageStage;
  children: ReactNode;
}) {
  return (
    <span className="stage-chip" data-stage={stage}>
      {children}
    </span>
  );
}
