// Plans & specs — the planset list a TRACKING job shows in place of the
// data-heavy map/Studio (standard-tracking-jobs slice 2). It VIEWS and
// downloads the uploaded planset files (a signed URL, 1 hour), and lets a
// foreman+ upload more of them. It does NOT extract, trace, or place anything —
// that whole loop is a data-job concern and stays out of a tracking job by
// design (extraction changes are slice 3).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Upload } from "lucide-react";
import {
  getPlansetSignedUrl,
  listPlansets,
  uploadPlanset,
} from "../../lib/install/api";
import type { Planset } from "../../lib/install/types";
import { isForemanPlus } from "../../lib/install/types";
import { EmptyState, QueryError, SkeletonList } from "../ui/States";
import { toastError } from "../../lib/toast";
import { formatApiError } from "../../lib/install/errors";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useT } from "../../lib/i18n";

function plansetLabel(p: Planset): string {
  const name = p.storage_path.split("/").pop() ?? p.storage_path;
  return name.replace(/^\d+-/, "");
}

export function SpecsTab({ projectId }: { projectId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const canUpload = isForemanPlus(effectiveRole);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const plansets = useQuery({
    queryKey: ["plansets", projectId],
    queryFn: () => listPlansets(projectId),
  });

  const open = useMutation({
    mutationFn: (p: Planset) => getPlansetSignedUrl(p),
    onSuccess: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    onError: () => toastError(t("specs.error")),
  });

  // A tracking job uploads the RAW planset for view/download only. It reuses
  // uploadPlanset with no extraction step — reading the schedule, drafting
  // marks, and building the map are all data-job concerns and never run here.
  // Stored under the neutral "building" kind so nothing downstream mistakes a
  // tracking document for a mark-schedule source of truth.
  // (tracking-jobs polish, 2026-09-03)
  const upload = useMutation({
    mutationFn: (file: File) => uploadPlanset(projectId, file, "building"),
    onSuccess: () => {
      setUploadError(null);
      void queryClient.invalidateQueries({ queryKey: ["plansets", projectId] });
    },
    onError: (e) => setUploadError(formatApiError(e)),
  });

  // The upload affordance is foreman+ only; the list itself stays visible to
  // everyone so a crew member can open a plan.
  const uploadControl = canUpload ? (
    <div className="specs-upload">
      <label className="action-btn primary" style={{ cursor: "pointer" }}>
        <Upload size={16} aria-hidden />{" "}
        {upload.isPending ? t("specs.uploading") : t("specs.upload")}
        <input
          type="file"
          accept=".pdf,application/pdf"
          multiple
          style={{ display: "none" }}
          disabled={upload.isPending}
          onChange={(e) => {
            // Support uploading a whole bunch at once — fire each and let the
            // list refresh as they land.
            const files = Array.from(e.target.files ?? []);
            for (const file of files) upload.mutate(file);
            e.target.value = "";
          }}
        />
      </label>
      {uploadError && (
        <p className="error" style={{ margin: "8px 0 0" }}>
          {uploadError}
        </p>
      )}
    </div>
  ) : null;

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
    return (
      <EmptyState
        icon={<FileText size={22} />}
        title={t("specs.empty")}
        message={canUpload ? t("specs.emptyUploadHint") : undefined}
        action={uploadControl}
      />
    );
  }

  return (
    <div>
      {uploadControl && (
        <div style={{ marginBottom: 12 }}>{uploadControl}</div>
      )}
      <ul className="unit-list work-list">
        {rows.map((p) => (
          <li key={p.id} className="find-row">
            <div
              className="job-row"
              style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                <FileText size={14} aria-hidden /> {plansetLabel(p)}
                <span className="muted"> · {p.source_format.toUpperCase()}</span>
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
    </div>
  );
}
