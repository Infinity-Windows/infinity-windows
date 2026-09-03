// Plans & specs — the read-only planset list a TRACKING job shows in place of
// the data-heavy map/Studio (standard-tracking-jobs slice 2). It only VIEWS and
// downloads the uploaded planset files (a signed URL, 1 hour); it does NOT
// extract, trace, or place anything — that whole loop is a data-job concern and
// stays out of a tracking job by design (extraction changes are slice 3).

import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { getPlansetSignedUrl, listPlansets } from "../../lib/install/api";
import type { Planset } from "../../lib/install/types";
import { EmptyState, QueryError, SkeletonList } from "../ui/States";
import { toastError } from "../../lib/toast";
import { useT } from "../../lib/i18n";

function plansetLabel(p: Planset): string {
  const name = p.storage_path.split("/").pop() ?? p.storage_path;
  return name.replace(/^\d+-/, "");
}

export function SpecsTab({ projectId }: { projectId: string }) {
  const t = useT();
  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId),
  });

  const open = useMutation({
    mutationFn: (p: Planset) => getPlansetSignedUrl(p),
    onSuccess: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    onError: () => toastError(t("specs.error")),
  });

  if (plansets.isLoading) return <SkeletonList rows={3} />;
  if (plansets.isError) {
    return (
      <QueryError
        error={plansets.error}
        onRetry={() => void plansets.refetch()}
        label={t("specs.error")}
      />
    );
  }
  const rows = plansets.data ?? [];
  if (rows.length === 0) {
    return <EmptyState icon={<FileText size={22} />} title={t("specs.empty")} />;
  }

  return (
    <ul className="unit-list work-list">
      {rows.map((p) => (
        <li key={p.id} className="find-row">
          <div className="job-row" style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              <FileText size={14} aria-hidden /> {plansetLabel(p)}
              <span className="muted"> · {p.kind}</span>
            </span>
            <button
              type="button"
              className="button-like"
              disabled={open.isPending}
              onClick={() => open.mutate(p)}
            >
              {t("specs.open")}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
