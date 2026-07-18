import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { listProjects, listWindowTypes } from "../../lib/api";
import {
  ensureTypesFromSpecs,
  getPlansetSignedUrl,
  linkSpecsToOpenings,
  listPlansets,
  plansetFormatFromName,
  plansetIsViewable,
  saveDraftOpenings,
  updatePlanset,
  uploadPlanset,
  aiExtractSchedule,
} from "../../lib/install/api";
import {
  calloutsToDraftOpenings,
  extractScheduleRows,
  rowsToDraftOpenings,
  summarizeDraftMarks,
} from "../../lib/install/extract";
import { extractCadDetailPages } from "../../lib/install/planDetails";
import type { Planset, PlansetKind } from "../../lib/install/types";
import { PlansetViewer } from "./PlansetViewer";

function fileName(ps: Planset): string {
  return ps.storage_path.split("/").pop() ?? ps.storage_path;
}

export function PlansetUpload() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Planset | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const project = projects.data?.find((p) => p.id === projectId);
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId),
  });
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });

  const building = (plansets.data ?? []).filter(
    (p) => (p.kind ?? "building") === "building",
  );
  const specs = (plansets.data ?? []).filter((p) => p.kind === "specs");

  const upload = useMutation({
    mutationFn: async (args: { file: File; kind: PlansetKind }) => {
      const { file, kind } = args;
      const format = plansetFormatFromName(file.name);
      if (!format) throw new Error("Choose a PDF, DWG, or DXF file.");

      setSummary(null);
      setProgress(
        kind === "building"
          ? "Uploading building plan…"
          : "Uploading specs / schedule…",
      );
      const planset = await uploadPlanset(projectId, file, kind);

      if (format !== "pdf") {
        return {
          planset,
          kind,
          drafts: 0,
          skipped: 0,
          linked: 0,
          converted: false,
        };
      }

      const { extractAllText, extractPlanMarkCallouts, loadPdf } = await import(
        "../../lib/install/pdf"
      );
      const doc = await loadPdf(await file.arrayBuffer());
      await updatePlanset(planset.id, {
        status: kind === "specs" ? "extracting" : "ready",
        page_count: doc.numPages,
      });

      // Marked building plans carry FreeText callouts (#6 ×12, etc.).
      if (kind === "building") {
        setProgress("Reading mark callouts on the building plan…");
        const callouts = await extractPlanMarkCallouts(doc);
        if (callouts.length === 0) {
          return {
            planset,
            kind,
            drafts: 0,
            skipped: 0,
            linked: 0,
            converted: true,
          };
        }
        let drafts = calloutsToDraftOpenings(callouts, [], types.data ?? []);
        drafts = await ensureTypesFromSpecs(drafts);
        const linked = await linkSpecsToOpenings(projectId, drafts);
        const result = await saveDraftOpenings(projectId, planset.id, drafts);
        const marks = summarizeDraftMarks(drafts);
        return {
          planset,
          kind,
          drafts: result.inserted,
          skipped: result.skipped,
          linked: linked.linked,
          converted: true,
          source: "details" as const,
          marks,
        };
      }

      setProgress("Extracting window/door schedule…");
      const pages = await extractAllText(doc);
      const detailSheets = extractCadDetailPages(pages);
      const catalog = (types.data ?? []).map((t) => ({
        type_code: t.type_code,
        name: t.name,
      }));
      const { rows, source } = await extractScheduleRows(pages, async (pgs) => {
        try {
          setProgress("No schedule table found — checking PDF details…");
          const aiRows = await aiExtractSchedule(pgs, catalog);
          return aiRows.map((r) => ({
            openingCode: r.openingCode,
            typeText: r.typeText,
            qty: r.qty,
            label: r.label,
            pageNumber: r.pageNumber,
            widthIn: r.widthIn ?? null,
            heightIn: r.heightIn ?? null,
            color: r.color ?? null,
            kind: r.kind ?? "window",
          }));
        } catch {
          // A manufacturer detail PDF can be useful without containing a
          // schedule table. Keep it available in the 2D source viewer.
          return [];
        }
      });

      let drafts = rowsToDraftOpenings(rows, types.data ?? []);
      setProgress("Linking marks to types…");
      drafts = await ensureTypesFromSpecs(drafts);
      const linked = await linkSpecsToOpenings(projectId, drafts);
      const result = await saveDraftOpenings(projectId, planset.id, drafts);
      await updatePlanset(planset.id, { status: "ready" });

      const marks = summarizeDraftMarks(drafts);
      return {
        planset,
        kind,
        drafts: result.inserted,
        skipped: result.skipped,
        linked: linked.linked,
        converted: true,
        source,
        marks,
        detailSheets: detailSheets.length,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
      queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
      queryClient.invalidateQueries({ queryKey: ["windowTypes"] });
      setProgress(null);
      const detailSheetCount =
        "detailSheets" in result ? (result.detailSheets ?? 0) : 0;

      if (result.kind === "building") {
        if (!result.converted) {
          setSummary("Building plan stored. CAD conversion is queued.");
          return;
        }
        if ("marks" in result && result.marks?.length) {
          const markLine = result.marks
            .map(
              (m) =>
                `${m.count}× #${m.mark} ${m.kind === "door" ? "doors" : "windows"}`,
            )
            .join(", ");
          setSummary(
            `Building plan ready. Loaded ${markLine} from plan callouts.`,
          );
          return;
        }
        setSummary(
          "Building plan ready for the map. Upload specs or use Load marks on the map.",
        );
        return;
      }

      if (!result.converted) {
        setSummary("Specs file stored. CAD conversion is queued.");
        return;
      }

      if (result.drafts > 0 || result.linked > 0) {
        const markLine =
          "marks" in result && result.marks?.length
            ? result.marks
                .map(
                  (m) =>
                    `${m.count}× #${m.mark} ${m.kind === "door" ? "doors" : "windows"}`,
                )
                .join(", ")
            : null;
        const sourceNote =
          "source" in result && result.source === "details"
            ? "Pulled from manufacturer detail sheets."
            : "source" in result && result.source === "merged"
              ? "Merged schedule table with detail-sheet marks."
              : null;
        setSummary(
          [
            markLine ? `Found ${markLine}.` : null,
            sourceNote,
            result.drafts > 0 ? `${result.drafts} draft openings.` : null,
            result.linked > 0 ? `Linked types on ${result.linked} existing openings.` : null,
          ]
            .filter(Boolean)
            .join(" "),
        );
        navigate(`/projects/${projectId}/review`);
      } else if (detailSheetCount > 0) {
        setSummary(
          `Indexed ${detailSheetCount} manufacturer detail sheets from the PDF. Open the map to view them beside the 2D floor plan.`,
        );
        navigate(`/projects/${projectId}?tab=map`);
      } else {
        setSummary(
          "PDF saved as a source document. No schedule rows or marked detail sheets were found.",
        );
      }
    },
    onError: (e) => setProgress(String(e)),
  });

  const openPlanset = async (ps: Planset) => {
    setViewError(null);
    if (plansetIsViewable(ps)) {
      setViewing(ps);
      return;
    }
    // DWG/DXF without a converted PDF — offer a download link instead.
    try {
      const url = await getPlansetSignedUrl(ps);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setViewError(String(e));
    }
  };

  if (viewing) {
    return (
      <div className="page">
        <PlansetViewer planset={viewing} onClose={() => setViewing(null)} />
      </div>
    );
  }

  const slot = (kind: PlansetKind, title: string, blurb: string, list: Planset[]) => (
    <section className="planset-slot" key={kind}>
      <h2>{title}</h2>
      <p className="muted">{blurb}</p>
      <label className="action-btn primary" style={{ cursor: "pointer" }}>
        {upload.isPending ? "Working…" : `Upload ${kind === "building" ? "building plan" : "specs"}`}
        <input
          type="file"
          accept=".pdf,.dwg,.dxf,application/pdf"
          style={{ display: "none" }}
          disabled={upload.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate({ file, kind });
            e.target.value = "";
          }}
        />
      </label>
      <ul className="unit-list">
        {list.map((ps) => (
          <li key={ps.id} className="planset-row">
            <button
              type="button"
              className="planset-open"
              onClick={() => void openPlanset(ps)}
            >
              <strong>{fileName(ps)}</strong>
              <span className="muted">
                {" "}
                {ps.source_format.toUpperCase()}
                {ps.status === "converting"
                  ? " · conversion queued"
                  : ` · ${ps.status}`}
                {ps.page_count ? ` · ${ps.page_count} pages` : ""}
              </span>
              <span className="planset-open-cta">
                {plansetIsViewable(ps) ? "View ›" : "Download ›"}
              </span>
            </button>
          </li>
        ))}
        {list.length === 0 && <p className="muted">Nothing in this slot yet.</p>}
      </ul>
    </section>
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Plansets</p>
          <h1>{project?.job_code ?? "Upload"}</h1>
        </div>
        <Link to={`/projects/${projectId}?tab=map`} className="back-chip" aria-label="Map">
          ‹
        </Link>
      </header>

      <p className="muted">
        Two slots per job: the building plan for the map, and the specs/schedule
        that defines each mark (#14 → size, color, type). Tap a file to view it.
        Confirm drafts before they drive inventory.
      </p>

      {slot(
        "building",
        "Building plan",
        "Floor drawings with #14 / #6 marks at openings. Used as the map background.",
        building,
      )}
      {slot(
        "specs",
        "Specs / schedule",
        "Window & door schedule table — mark, size, type, color. Creates/links openings.",
        specs,
      )}

      {progress && <p className="scanner-hint">{progress}</p>}
      {summary && <p className="ok">{summary}</p>}
      {viewError && <p className="error">{viewError}</p>}

      <p className="muted" style={{ marginTop: 16 }}>
        After specs extract →{" "}
        <Link to={`/projects/${projectId}/review`}>Review openings</Link>
        {" · "}
        <Link to={`/projects/${projectId}?tab=map`}>Map</Link>
      </p>
    </div>
  );
}
