import { BackChip } from "../components/BackChip";
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listProjects } from "../lib/api";
import { PhotoFeed } from "../components/photos/PhotoFeed";
import { PhotoKindTabs } from "../components/photos/PhotoKindTabs";
import { useT } from "../lib/i18n";

export function Photos() {
  const [params, setParams] = useSearchParams();
  const t = useT();
  const projectId = params.get("project");
  const kind = params.get("kind") === "receipt" ? "receipt" : "photo";
  const initialCapture = params.get("capture") === "1";

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const jobCodeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects.data ?? []) map.set(p.id, p.job_code);
    return map;
  }, [projects.data]);

  const selectedJobCode = projectId ? jobCodeById.get(projectId) ?? null : null;

  const setProject = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("project", id);
    else next.delete("project");
    next.delete("capture");
    setParams(next, { replace: true });
  };

  // Keeps the job, drops the capture flag — the same shape setProject uses, and
  // for the same reason: ?capture=1 is a one-shot "open the sheet now" from a
  // deep link, and re-firing it every time somebody switches tabs would open
  // the camera over the list they were trying to read. Replace, not push, so
  // Back still leaves the Photos page rather than walking back through every
  // toggle.
  const setKind = (next: "photo" | "receipt") => {
    const params2 = new URLSearchParams(params);
    if (next === "receipt") params2.set("kind", "receipt");
    else params2.delete("kind");
    params2.delete("capture");
    setParams(params2, { replace: true });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">
            {kind === "receipt" ? t("photos.kind.receipts") : t("photos.kind.photos")}
          </p>
          <h1>{selectedJobCode ? selectedJobCode : "Recent across all jobs"}</h1>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      <PhotoFeed
        projectId={projectId}
        selectedJobCode={selectedJobCode}
        kind={kind}
        initialCapture={initialCapture}
        toolbarExtra={
          <>
            <PhotoKindTabs kind={kind} onChange={setKind} />
            <select
              className="photos-filter"
              value={projectId ?? ""}
              onChange={(e) => setProject(e.target.value)}
              aria-label="Filter by job"
            >
              <option value="">All jobs</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.job_code} — {p.name}
                </option>
              ))}
            </select>
          </>
        }
      />
    </div>
  );
}
