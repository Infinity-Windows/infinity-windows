import { useState } from "react";
import { formatApiError } from "../../lib/errors";
import { readActivityDone } from "../../lib/installerWorkflow/sharedPlan";
import type { WorkCommand, WorkSession } from "../../lib/customWork/model";
import { listOpeningWorkProgress } from "../../lib/customWork/api";
import { readUnitState } from "../../lib/installerWorkflow/unitState";
import { activityLabel } from "../installerPilot/workdayActivities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/i18n";
import { getOpening } from "../../lib/install/api";
import { openingFullSheetPath } from "../../lib/install/openingRowAction";
import { isForemanPlus } from "../../lib/install/types";
import { UnitActivityFacts, UnitCompletion, UnitDetailsDialog, UnitDetailsPanel, UnitLastFinishedFact } from "../../components/install/UnitDetails";
import type { ProjectOpening } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";

export type AgendaUnit = {
  id: string;
  label: string;
  projectId: string;
  activity?: string;
  leadId?: string;
  crewIds: string[];
};

export function AgendaUnitDetails({ unit, profileId, onClose, localSessions, localUnitComplete, openingRow, markDone, queuedMark }: {
  unit: AgendaUnit;
  profileId: string;
  onClose: () => void;
  localSessions: readonly WorkSession[];
  localUnitComplete?: boolean;
  openingRow?: ProjectOpening;
  markDone?: () => Promise<void>;
  queuedMark?: WorkCommand;
}) {
  const { lang } = useLanguage();
  const { effectiveRole } = useEffectiveRole();
  const es = lang === "es";
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState("");
  const marks = useQuery({ queryKey: ["planActivityDone", unit.projectId, profileId],
    queryFn: () => readActivityDone(unit.projectId) });
  const client = useQueryClient();
  const opening = useQuery({
    queryKey: ["work-agenda-opening", unit.projectId, unit.id],
    enabled: !openingRow,
    queryFn: async () => {
      const row = await getOpening(unit.id);
      return row?.project_id === unit.projectId ? row : null;
    },
  });
  const cachedOpenings = client.getQueryData<ProjectOpening[]>(["openings", unit.projectId]);
  const row = openingRow ?? opening.data ?? cachedOpenings?.find(row => row.id === unit.id);
  const work = useQuery({
    queryKey: ["opening-work-progress", unit.projectId, unit.id],
    queryFn: () => listOpeningWorkProgress(unit.projectId, unit.id),
    refetchInterval: 15000,
  });
  const sessions = new Map((work.data?.sessions ?? []).map(session => [session.id, session]));
  for (const session of localSessions) sessions.set(session.id, session);
  const rows = [...sessions.values()];
  // Everything fetched here is for this one opening, so every session's unit
  // is this unit, whichever work unit row it was recorded against.
  const state = readUnitState({ sessions: rows, marks: marks.data,
    units: [...(work.data?.units ?? []), ...rows.flatMap(row => row.unit_id ? [{ id: row.unit_id, opening_id: unit.id, facts: {} }] : [])]
      .map(row => ({ ...row, opening_id: unit.id })),
    completeOverride: localUnitComplete === undefined ? undefined : { [unit.id]: localUnitComplete } });
  const wholeUnitComplete = state.complete(unit.id);
  const status = unit.activity ? state.status(unit.id, unit.activity) : undefined;
  const statusKnown = status === "complete" || localSessions.length > 0 || work.isSuccess;

  return <UnitDetailsDialog title={row?.opening_code ?? unit.label} subtitle={unit.activity && activityLabel(unit.activity, es)} onClose={onClose}>
    <UnitCompletion complete={wholeUnitComplete} />
    {row ? <UnitDetailsPanel projectId={unit.projectId} opening={row} />
      : <p>{opening.isLoading ? (es ? "Cargando…" : "Loading…") : (es ? "Unidad no disponible" : "Unit unavailable")}</p>}
    {unit.activity && <UnitActivityFacts status={statusKnown ? status : undefined} unavailable={work.isError} lastDone={state.lastDone(unit.id)}
      leadId={unit.leadId} crewIds={unit.crewIds} profileId={profileId} />}
    {!unit.activity && <UnitLastFinishedFact lastDone={state.lastDone(unit.id)} />}
    {markDone && status !== "complete" && !queuedMark && <button type="button" disabled={marking}
      onClick={async () => {
        setMarking(true); setError("");
        try { await markDone(); } catch (error) { setError(formatApiError(error)); }
        finally { setMarking(false); }
      }}>{es ? "Marcar actividad como terminada" : "Mark activity done"}</button>}
    {queuedMark?.error || error ? <p role="alert">{queuedMark?.error || error}</p>
      : queuedMark && <p role="status">{es ? "Pendiente de sincronizar" : "Waiting to sync"}</p>}
    <footer>
      <Link to={openingFullSheetPath(unit.projectId, unit.id)} onClick={onClose}>{es ? "Ficha de la unidad" : "Opening sheet"}</Link>
      {unit.activity && isForemanPlus(effectiveRole) && <Link to="/catalog" onClick={onClose}>{es ? "Catálogo" : "Catalog"}</Link>}
    </footer>
  </UnitDetailsDialog>;
}
