import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects, listWindowTypes } from "../../lib/api";
import {
  aiExtractSchedule,
  linkOpeningsToProjectMarks,
  listPlansets,
  listProjectMarks,
  plansetFormatFromName,
  saveDraftOpenings,
  saveProjectMarks,
  updatePlanset,
  uploadPlanset,
} from "../../lib/install/api";
import {
  buildingMarksToDraftOpenings,
  extractBuildingMarks,
  extractScheduleRows,
  rowsToSpecMarks,
  type SpecMarkDraft,
} from "../../lib/install/extract";
import type { PlansetKind } from "../../lib/install/types";

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
  const marks = useQuery({
    queryKey: ["projectMarks", projectId],
    queryFn: () => listProjectMarks(projectId),
  });

  const upload = useMutation({
    mutationFn: async ({ file, kind }: { file: File; kind: PlansetKind }) => {
      const format = plansetFormatFromName(file.name);
      if (!format) throw new Error("Choose a PDF, DWG, or DXF file.");

      setProgress(
        kind === "specs" ? "Uploading specs…" : "Uploading building plan…",
      );
      const planset = await uploadPlanset(projectId, file, kind);

      if (format !== "pdf") {
        return {
          kind,
          planset,
          drafts: 0,
          marks: 0,
          skipped: 0,
          converted: false,
        };
      }

      setProgress("Reading PDF…");
      const { extractAllText, extractPageFragments, loadPdf } = await import(
        "../../lib/install/pdf"
      );
      const doc = await loadPdf(await file.arrayBuffer());
      await updatePlanset(planset.id, {
        status: "extracting",
        page_count: doc.numPages,
      });

      const catalog = (types.data ?? []).map((t) => ({
        type_code: t.type_code,
        name: t.name,
      }));

      if (kind === "specs") {
        setProgress("Extracting window/door schedule…");
        const pages = await extractAllText(doc);
        const { rows, source } = await extractScheduleRows(pages, async (pgs) => {
          setProgress("No schedule found — trying AI extract…");
          const aiRows = await aiExtractSchedule(pgs, catalog);
          return aiRows.map((r) => ({
            openingCode: r.openingCode,
            typeText: r.typeText,
            qty: r.qty,
            label: r.label,
            pageNumber: r.pageNumber,
          }));
        });
        const specMarks = rowsToSpecMarks(rows, types.data ?? []);
        const saved = await saveProjectMarks(projectId, planset.id, specMarks);
        const linked = await linkOpeningsToProjectMarks(projectId);
        await updatePlanset(planset.id, { status: "ready" });
        return {
          kind,
          planset,
          drafts: 0,
          marks: saved,
          linked,
          skipped: 0,
          converted: true,
          source,
        };
      }

      // Building plan: locate #14-style marks and pin them on the map.
      setProgress("Finding opening marks on the floor plan…");
      const pageFrags = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const frag = await extractPageFragments(doc, p);
        pageFrags.push({
          pageNumber: p,
          width: frag.width,
          height: frag.height,
          fragments: frag.fragments,
        });
      }
      const hits = extractBuildingMarks(pageFrags);
      const existingMarks: SpecMarkDraft[] = (marks.data ?? []).map((m) => ({
        mark: m.mark,
        type_text: m.type_text ?? m.mark,
        size_text: m.size_text,
        color_text: m.color_text,
        unit_kind: m.unit_kind,
        window_type_id: m.window_type_id,
        match_score: m.window_type_id ? 1 : 0,
      }));
      const drafts = buildingMarksToDraftOpenings(hits, existingMarks);
      const result = await saveDraftOpenings(projectId, planset.id, drafts);
      await linkOpeningsToProjectMarks(projectId);
      await updatePlanset(planset.id, { status: "ready" });
      return {
        kind,
        planset,
        drafts: result.inserted,
        marks: 0,
        skipped: result.skipped,
        converted: true,
        hits: hits.length,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["projectMarks", projectId] });
      setProgress(null);
      if (!result.converted) {
        setProgress("File stored — CAD conversion is queued (PDF works now).");
        return;
      }
      if (result.kind === "specs") {
        if (result.marks > 0) {
          setProgress(
            `Saved ${result.marks} specs mark${result.marks === 1 ? "" : "s"}` +
              (result.linked
                ? ` · linked ${result.linked} existing opening${result.linked === 1 ? "" : "s"}`
                : "") +
              ". Upload a building plan to place them on the map.",
          );
        } else {
          setProgress(
            "No schedule rows found in the specs PDF. Check that marks look like #14 / W1 in a table.",
          );
        }
        return;
      }
      if (result.drafts > 0) {
        navigate(`/projects/${projectId}?tab=map`);
      } else {
        setProgress(
          "No #mark labels found on the building plan. Place openings by hand on the map, or check that marks look like #14.",
        );
      }
    },
    onError: (e) => setProgress(String(e)),
  });

  const pick = (kind: PlansetKind) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload.mutate({ file, kind });
    e.target.value = "";
  };

  const building = (plansets.data ?? []).filter(
    (ps) => (ps.kind ?? "building") === "building",
  );
  const specs = (plansets.data ?? []).filter((ps) => ps.kind === "specs");

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Plansets</p>
          <h1>{project?.job_code ?? "Upload"}</h1>
        </div>
        <Link
          to={`/projects/${projectId}?tab=map`}
          className="back-chip"
          aria-label="Map"
        >
          ‹
        </Link>
      </header>

      <p className="muted">
        Upload a <strong>building plan</strong> (floor plan with #14 marks) and a{" "}
        <strong>specs</strong> sheet (schedule table with sizes/types). Specs
        define what each mark is; the building plan places them on the map.
      </p>

      <div className="planset-slots">
        <label className="action-btn primary" style={{ cursor: "pointer" }}>
          {upload.isPending && upload.variables?.kind === "building"
            ? "Working…"
            : "Upload building plan"}
          <input
            type="file"
            accept=".pdf,.dwg,.dxf,application/pdf"
            style={{ display: "none" }}
            disabled={upload.isPending}
            onChange={pick("building")}
          />
        </label>
        <label className="action-btn" style={{ cursor: "pointer" }}>
          {upload.isPending && upload.variables?.kind === "specs"
            ? "Working…"
            : "Upload specs"}
          <input
            type="file"
            accept=".pdf,.dwg,.dxf,application/pdf"
            style={{ display: "none" }}
            disabled={upload.isPending}
            onChange={pick("specs")}
          />
        </label>
      </div>

      {progress && <p className="scanner-hint">{progress}</p>}

      <h2>Building plans</h2>
      <ul className="unit-list">
        {building.map((ps) => (
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
        {building.length === 0 && (
          <p className="muted">No building plans yet.</p>
        )}
      </ul>

      <h2>Specs</h2>
      <ul className="unit-list">
        {specs.map((ps) => (
          <li key={ps.id}>
            <strong>{ps.storage_path.split("/").pop()}</strong>{" "}
            <span className="muted">{ps.source_format.toUpperCase()}</span>{" "}
            <span className={ps.status === "ready" ? "ok" : "muted"}>
              {ps.status}
            </span>
          </li>
        ))}
        {specs.length === 0 && <p className="muted">No specs uploaded yet.</p>}
      </ul>

      {(marks.data?.length ?? 0) > 0 && (
        <>
          <h2>Marks from specs ({marks.data!.length})</h2>
          <ul className="unit-list">
            {marks.data!.map((m) => (
              <li key={m.id} className="find-row">
                <strong>#{m.mark}</strong>
                <span className="muted">
                  {m.size_text ?? m.type_text ?? ""}{" "}
                  {m.color_text ? `· ${m.color_text}` : ""}
                </span>
                <span
                  className="big-address"
                  style={{
                    color: m.unit_kind === "door" ? "var(--ok)" : "var(--info)",
                  }}
                >
                  {m.unit_kind}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
