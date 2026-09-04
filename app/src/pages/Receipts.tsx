// Wave P, P4: the office table. Supervisor+ reviews every receipt the crew
// has snapped — filter by month/job/category/passthrough, flip category or
// the bill-to-customer flag (both server-enforced: flipping category pins
// category_by='manual' so a later rescan can never touch it again — see
// update_receipt's own comment), mark reviewed, and export the current
// filter as CSV + a zip of the images — the accounting bridge Horizon never
// had (spec: "their gap, our feature").

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import JSZip from "jszip";
import { CheckCircle2, Circle, Download, FileArchive } from "lucide-react";
import { BackChip } from "../components/BackChip";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { formatApiError } from "../lib/errors";
import { formatCents } from "../lib/aiSpend";
import { listProjects } from "../lib/api";
import {
  buildReceiptsCsv,
  listReceipts,
  reviewReceipt,
  setCategory,
  setPassthrough,
  type Receipt,
  type ReceiptCategory,
  type ReceiptFilter,
} from "../lib/receipts";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadText(text: string, filename: string, mime: string) {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/** The last 12 calendar months, newest first, as "YYYY-MM" filter values. */
function monthOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    out.push({ value, label });
  }
  return out;
}

function dateLabel(iso: string | null): string {
  if (!iso) return "No date";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** A safe-ish file name for one receipt inside the export zip. */
function zipEntryName(r: Receipt): string {
  const ext = r.photoPath.split(".").pop() || "jpg";
  const day = r.purchasedOn ?? r.createdAt.slice(0, 10);
  const who = (r.vendor ?? r.id).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return `${day}-${who || r.id.slice(0, 8)}.${ext}`;
}

export function Receipts() {
  const qc = useQueryClient();
  const [month, setMonth] = useState("");
  const [projectId, setProjectId] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [passthroughFilter, setPassthroughFilter] = useState("");
  const [unreviewedFirst, setUnreviewedFirst] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);

  const filter: ReceiptFilter = useMemo(
    () => ({
      month: month || null,
      projectId: projectId || null,
      category: categoryFilter
        ? (categoryFilter as ReceiptCategory | "uncategorized")
        : null,
      passthrough: passthroughFilter === "" ? null : passthroughFilter === "yes",
    }),
    [month, projectId, categoryFilter, passthroughFilter],
  );

  const receipts = useQuery({
    queryKey: ["receipts-office", filter],
    queryFn: () => listReceipts(filter),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const sorted = useMemo(() => {
    const rows = [...(receipts.data ?? [])];
    if (unreviewedFirst) {
      rows.sort((a, b) => {
        const ar = a.reviewedAt ? 1 : 0;
        const br = b.reviewedAt ? 1 : 0;
        if (ar !== br) return ar - br;
        return b.createdAt.localeCompare(a.createdAt);
      });
    }
    return rows;
  }, [receipts.data, unreviewedFirst]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["receipts-office"] });

  const flipCategory = useMutation({
    mutationFn: (input: { id: string; value: ReceiptCategory }) =>
      setCategory(input.id, input.value),
    onMutate: (input) => setBusyId(input.id),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
    onSettled: () => setBusyId(null),
  });
  const flipPassthrough = useMutation({
    mutationFn: (input: { id: string; value: boolean }) => setPassthrough(input.id, input.value),
    onMutate: (input) => setBusyId(input.id),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
    onSettled: () => setBusyId(null),
  });
  const flipReviewed = useMutation({
    mutationFn: (input: { id: string; value: boolean }) => reviewReceipt(input.id, input.value),
    onMutate: (input) => setBusyId(input.id),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
    onSettled: () => setBusyId(null),
  });

  const exportCsv = () => {
    downloadText(buildReceiptsCsv(sorted), `receipts-${month || "all"}.csv`, "text/csv;charset=utf-8");
  };

  const exportZip = async () => {
    setZipping(true);
    setMessage(null);
    try {
      const zip = new JSZip();
      const withPhotos = sorted.filter((r) => r.signedUrl);
      const used = new Set<string>();
      await Promise.all(
        withPhotos.map(async (r) => {
          const res = await fetch(r.signedUrl!);
          if (!res.ok) return;
          const blob = await res.blob();
          let name = zipEntryName(r);
          // Two receipts on the same day from the same vendor would
          // otherwise collide inside the zip and silently overwrite.
          if (used.has(name)) name = `${r.id.slice(0, 8)}-${name}`;
          used.add(name);
          zip.file(name, blob);
        }),
      );
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, `receipts-${month || "all"}-images.zip`);
    } catch (e) {
      setMessage(formatApiError(e));
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Business</p>
          <h1>Receipts</h1>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>
      <p className="muted">
        Every receipt the crew has snapped — machine-read, human-confirmed.
        Flip a flag, mark it reviewed, or export the accounting bridge.
      </p>

      {message && <p className="error">{message}</p>}

      <div
        className="filter-row"
        style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 16px" }}
      >
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Filter by month">
          <option value="">All months</option>
          {monthOptions().map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Filter by job"
        >
          <option value="">All jobs</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code} — {p.name}
            </option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          <option value="gas">Gas</option>
          <option value="other">Other</option>
          <option value="uncategorized">Uncategorized</option>
        </select>
        <select
          value={passthroughFilter}
          onChange={(e) => setPassthroughFilter(e.target.value)}
          aria-label="Filter by billing"
        >
          <option value="">Billed or not</option>
          <option value="yes">Billed to customer</option>
          <option value="no">Not billed</option>
        </select>
        <label className="row-gap" style={{ alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={unreviewedFirst}
            onChange={(e) => setUnreviewedFirst(e.target.checked)}
          />
          Unreviewed first
        </label>
      </div>

      <div className="row-gap" style={{ margin: "0 0 16px" }}>
        <button type="button" className="action-btn" onClick={exportCsv} disabled={sorted.length === 0}>
          <Download size={16} aria-hidden /> Export CSV
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={() => void exportZip()}
          disabled={sorted.length === 0 || zipping}
        >
          <FileArchive size={16} aria-hidden /> {zipping ? "Zipping…" : "Export images (zip)"}
        </button>
      </div>

      {receipts.isLoading && <SkeletonList rows={6} />}
      {receipts.isError && (
        <QueryError
          error={receipts.error}
          onRetry={() => void receipts.refetch()}
          label="Couldn't load receipts"
        />
      )}

      {!receipts.isLoading && !receipts.isError && sorted.length === 0 && (
        <EmptyState
          title="No receipts match these filters."
          message="A snapped receipt shows up here the moment it's filed."
        />
      )}

      {!receipts.isLoading && !receipts.isError && sorted.length > 0 && (
        <ul className="unit-list">
          {sorted.map((r) => (
            <li key={r.id} className="opening-review-row">
              <div className="wh-row">
                <div className="receipt-row-thumb">
                  {r.signedUrl ? (
                    <img src={r.signedUrl} alt={r.vendor ?? "Receipt"} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
                <div className="wh-row-main">
                  <span className="wh-row-title">
                    {r.vendor ?? "Unknown vendor"} ·{" "}
                    {r.amountCents != null ? formatCents(r.amountCents) : "No amount"}
                  </span>
                  <span className="wh-row-sub">
                    {dateLabel(r.purchasedOn ?? r.createdAt)}
                    {" · "}
                    {r.jobCode ?? r.pendingJobName ?? "No job"}
                    {r.uploaderName ? ` · ${r.uploaderName}` : ""}
                    {/* Wave Z: once a receipt has become a job cost line it
                        says so forever — un-reviewing does not unpost it,
                        because the money was still spent. */}
                    {r.jobCostId ? " · posted to the job" : ""}
                  </span>
                </div>
                <div className="wh-actions">
                  <button
                    type="button"
                    className={`button-like${r.category === "gas" ? " button-like--primary" : ""}`}
                    disabled={busyId === r.id}
                    title={
                      r.categoryBy === "manual"
                        ? "Set by a human — locked against a rescan"
                        : r.categoryBy === "ai"
                          ? "The machine's guess — tap to confirm/flip"
                          : "Not read yet"
                    }
                    onClick={() =>
                      flipCategory.mutate({ id: r.id, value: r.category === "gas" ? "other" : "gas" })
                    }
                  >
                    {r.category === "gas" ? "Gas" : r.category === "other" ? "Other" : "Category?"}
                  </button>
                  <button
                    type="button"
                    className={`button-like${r.isPassthrough ? " button-like--primary" : ""}`}
                    disabled={busyId === r.id}
                    onClick={() =>
                      flipPassthrough.mutate({ id: r.id, value: !r.isPassthrough })
                    }
                  >
                    {r.isPassthrough == null ? "Bill?" : r.isPassthrough ? "Billed" : "Not billed"}
                  </button>
                  <button
                    type="button"
                    className="button-like"
                    aria-label={r.reviewedAt ? "Mark unreviewed" : "Mark reviewed"}
                    disabled={busyId === r.id}
                    onClick={() => flipReviewed.mutate({ id: r.id, value: !r.reviewedAt })}
                  >
                    {r.reviewedAt ? <CheckCircle2 size={18} aria-hidden /> : <Circle size={18} aria-hidden />}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
