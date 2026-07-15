import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects, listWindowTypes } from "../../lib/api";
import {
  listPlansets,
  plansetFormatFromName,
  saveDraftOpenings,
  updatePlanset,
  uploadPlanset,
} from "../../lib/install/api";
import { parseScheduleRows, rowsToDraftOpenings } from "../../lib/install/extract";

export function PlansetUpload() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId),
  });
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const format = plansetFormatFromName(file.name);
      if (!format) throw new Error("Choose a PDF, DWG, or DXF file.");

      setProgress("Uploading planset\u2026");
      const planset = await uploadPlanset(projectId, file);

      if (format !== "pdf") {
        // CAD conversion needs a server-side step (ODA converter) that
        // doesn't exist yet; the raw file is stored and flagged.
        return { planset, drafts: 0, skipped: 0, converted: false };
      }

      setProgress("Reading PDF\u2026");
      // pdf.js is heavy; load it only when a PDF actually arrives.
      const { extractAllText, loadPdf } = await import("../../lib/install/pdf");
      const doc = await loadPdf(await file.arrayBuffer());
      await updatePlanset(planset.id, {
        status: "extracting",
        page_count: doc.numPages,
      });

      setProgress("Extracting window schedule\u2026");
      const pages = await extractAllText(doc);
      const rows = pages.flatMap((p) => parseScheduleRows(p.text, p.pageNumber));
      const drafts = rowsToDraftOpenings(rows, types.data ?? []);

      const result = await saveDraftOpenings(projectId, planset.id, drafts);
      await updatePlanset(planset.id, { status: "ready" });
      return { planset, drafts: result.inserted, skipped: result.skipped, converted: true };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      setProgress(null);
      if (!result.converted) return; // stay here; show conversion-queued state
      if (result.drafts > 0) {
        navigate(`/projects/${projectId}/review`);
      } else {
        setProgress(
          "No schedule rows found in the PDF text. Add openings by hand in Review, or on the map.",
        );
      }
    },
    onError: (e) => setProgress(String(e)),
  });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Planset — {project?.job_code ?? ""}</h1>
        <Link to={`/projects/${projectId}?tab=map`} className="button-like">
          Map
        </Link>
      </header>

      <p className="muted">
        Upload the job's planset. PDF extracts the window schedule right here;
        DWG/DXF is stored raw until conversion runs.
      </p>

      <label className="action-btn primary" style={{ cursor: "pointer" }}>
        {upload.isPending ? "Working\u2026" : "Choose planset (PDF / DWG / DXF)"}
        <input
          type="file"
          accept=".pdf,.dwg,.dxf,application/pdf"
          style={{ display: "none" }}
          disabled={upload.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = "";
          }}
        />
      </label>

      {progress && <p className="scanner-hint">{progress}</p>}

      <h2>Uploaded plansets</h2>
      <ul className="unit-list">
        {(plansets.data ?? []).map((ps) => (
          <li key={ps.id}>
            <strong>{ps.storage_path.split("/").pop()}</strong>{" "}
            <span className="muted">{ps.source_format.toUpperCase()}</span>{" "}
            {ps.status === "converting" ? (
              <span className="warn-text">conversion queued</span>
            ) : (
              <span className={ps.status === "ready" ? "ok" : "muted"}>
                {ps.status}
              </span>
            )}
            {ps.page_count ? (
              <span className="muted"> — {ps.page_count} pages</span>
            ) : null}
          </li>
        ))}
        {plansets.data?.length === 0 && (
          <p className="muted">Nothing uploaded yet.</p>
        )}
      </ul>
    </div>
  );
}
