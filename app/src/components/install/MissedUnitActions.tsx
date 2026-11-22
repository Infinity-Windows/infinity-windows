import { useMutation } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import { removeFieldUnit } from "../../lib/install/api";
import type { ProjectOpening } from "../../lib/install/types";

export interface MissedUnitActionsProps {
  opening: ProjectOpening;
  canAct: boolean;
  onDone: (message: string) => void;
  onError: (error: unknown) => void;
}

export function MissedUnitActions({ opening, canAct, onDone, onError }: MissedUnitActionsProps) {
  const t = useT();
  const remove = useMutation({
    mutationFn: () => removeFieldUnit(opening.id),
    onSuccess: () => onDone(t("missed.removed")),
    onError,
  });

  return (
    <div className="detail-card missed-unit-card">
      <p className="field-label" style={{ margin: 0 }}>{t("missed.badge")}</p>
      {canAct && <button
        className="link"
        style={{ color: "var(--danger)" }}
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        {t("missed.takeOff")}
      </button>}
    </div>
  );
}
