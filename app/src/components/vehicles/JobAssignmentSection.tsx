import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, X } from "lucide-react";
import { assignToProject, listAssignableProjects, unassignProject } from "../../lib/vehicles/api";
import { toastSuccess } from "../../lib/toast";
import type { VehicleWithMeta } from "../../lib/vehicles/types";

export function JobAssignmentSection({ vehicle }: { vehicle: VehicleWithMeta }) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [note, setNote] = useState("");

  const projects = useQuery({ queryKey: ["projects"], queryFn: listAssignableProjects });
  const current = vehicle.assignment;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["vehicle", vehicle.id] });
    qc.invalidateQueries({ queryKey: ["vehicles"] });
  };

  const assign = useMutation({
    mutationFn: () => assignToProject(vehicle.id, projectId, note.trim() || null),
    onSuccess: () => {
      toastSuccess("Assigned to job");
      setProjectId("");
      setNote("");
      refresh();
    },
  });

  const unassign = useMutation({
    mutationFn: () => unassignProject(vehicle.id),
    onSuccess: () => {
      toastSuccess("Removed from job");
      refresh();
    },
  });

  const currentLabel = current?.project
    ? `${current.project.job_code} — ${current.project.name}`
    : current
      ? "Assigned job"
      : null;

  return (
    <section className="veh-section">
      <div className="veh-section-head">
        <h2>Job assignment</h2>
      </div>

      {current ? (
        <div className="veh-assignment">
          <span className="veh-assignment-chip">
            <Briefcase size={14} aria-hidden /> {currentLabel}
          </span>
          {current.note && <p className="muted" style={{ margin: "4px 0 0" }}>{current.note}</p>}
          <button className="button-like danger-outline" onClick={() => unassign.mutate()} disabled={unassign.isPending}>
            <X size={14} aria-hidden /> {unassign.isPending ? "Removing…" : "Remove from job"}
          </button>
        </div>
      ) : (
        <div className="veh-assign-form">
          <label className="field-label">Assign to a job</label>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">— pick a job —</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.job_code} — {p.name}
              </option>
            ))}
          </select>
          <label className="field-label">Note (optional)</label>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. hauling the lift" />
          <button
            className="button-like active-pill"
            disabled={!projectId || assign.isPending}
            onClick={() => assign.mutate()}
          >
            <Briefcase size={15} aria-hidden /> {assign.isPending ? "Assigning…" : "Assign to job"}
          </button>
        </div>
      )}
    </section>
  );
}
