// Tag at the truck: stick a blank license-plate sticker on a package, tap
// it here (or scan it), and bind it — job (defaults to the last one used,
// so ten BLACK22 crates in a row are one tap each), category chip, optional
// marks off the job schedule, optional note. Binding is one-time forever.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "../../lib/api";
import { listMarkSpecs } from "../../lib/install/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { BackChip } from "../../components/BackChip";
import { Scanner } from "../../components/Scanner";
import type { QrPayload } from "../../lib/qr";
import {
  bindPackage,
  CATEGORY_LABELS,
  defaultDeliveryLabel,
  ensureDelivery,
  listBlankPackages,
  type PackageCategory,
  type StoragePackage,
} from "../../lib/storage";

const LAST_JOB_KEY = "infinity.storage.lastJob";

export function TagPackages() {
  const qc = useQueryClient();
  const blanks = useQuery({ queryKey: ["storageBlanks"], queryFn: listBlankPackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [selected, setSelected] = useState<StoragePackage | null>(null);
  const [scanning, setScanning] = useState(false);
  const [projectId, setProjectId] = useState<string>(
    () => localStorage.getItem(LAST_JOB_KEY) ?? "",
  );
  const [category, setCategory] = useState<PackageCategory | null>("windows");
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [tagged, setTagged] = useState(0);

  // One delivery group per truck: created lazily on first bind, reused after.
  useEffect(() => {
    void (async () => {
      try {
        const d = await ensureDelivery(defaultDeliveryLabel(new Date()));
        setDeliveryId(d.id);
      } catch {
        /* delivery grouping is a nice-to-have — binding works without it */
      }
    })();
  }, []);

  // Job list defaults to the remembered one; validate it still exists.
  useEffect(() => {
    if (!projects.data) return;
    if (projectId && !projects.data.some((p) => p.id === projectId)) {
      setProjectId("");
    }
  }, [projects.data, projectId]);

  const specs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    enabled: Boolean(projectId),
  });
  const markOptions = useMemo(
    () => (specs.data ?? []).map((s) => s.mark_code),
    [specs.data],
  );

  const bind = useMutation({
    mutationFn: async () => {
      if (!selected || !projectId) throw new Error("Pick a sticker and a job");
      return bindPackage({
        packageId: selected.id,
        projectId,
        category,
        note: note || null,
        marks: [...marks],
        deliveryId,
      });
    },
    onSuccess: (p) => {
      localStorage.setItem(LAST_JOB_KEY, projectId);
      pushToast(`${p.serial} assigned — sticker is now permanent.`);
      setSelected(null);
      setMarks(new Set());
      setNote("");
      setTagged((n) => n + 1);
      void qc.invalidateQueries({ queryKey: ["storageBlanks"] });
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const onScan = (payload: QrPayload) => {
    if (payload.kind !== "packageSerial") {
      pushToast("That's not a package sticker.", "error");
      return;
    }
    const hit = (blanks.data ?? []).find((b) => b.serial === payload.serial);
    if (!hit) {
      pushToast(`${payload.serial} is already assigned or unknown.`, "error");
      return;
    }
    setSelected(hit);
    setScanning(false);
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">Storage</p>
          <h1>Tag packages</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {defaultDeliveryLabel(new Date())}
            {tagged > 0 ? ` · ${tagged} tagged this session` : ""}
          </p>
        </div>
      </header>

      <h2>1 · The sticker</h2>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <button
          className="button-like"
          onClick={() => setScanning((v) => !v)}
        >
          {scanning ? "Stop scanning" : "Scan sticker"}
        </button>
        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
          or tap one from the roll:
        </span>
      </div>
      {scanning && <Scanner onScan={onScan} />}
      <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 6 }}>
        {(blanks.data ?? []).slice(0, 24).map((b) => (
          <button
            key={b.id}
            className={
              selected?.id === b.id ? "button-like active-pill" : "button-like"
            }
            onClick={() => setSelected(b)}
          >
            {b.short_code ?? b.serial}
          </button>
        ))}
        {(blanks.data ?? []).length === 0 && (
          <p className="muted">
            No blank stickers left — print a batch from the Storage page.
          </p>
        )}
      </div>

      <h2>2 · What it is</h2>
      <label className="field-label">Job</label>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">Pick the job…</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>
      <label className="field-label">Category</label>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        {(Object.keys(CATEGORY_LABELS) as PackageCategory[]).map((c) => (
          <button
            key={c}
            className={category === c ? "button-like active-pill" : "button-like"}
            onClick={() => setCategory(c)}
          >
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      {projectId && markOptions.length > 0 && (
        <>
          <label className="field-label">
            Marks inside (optional — makes “where is window 16?” answerable)
          </label>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {markOptions.map((m) => (
              <button
                key={m}
                className={marks.has(m) ? "button-like active-pill studio-mini" : "button-like studio-mini"}
                onClick={() =>
                  setMarks((prev) => {
                    const next = new Set(prev);
                    if (next.has(m)) next.delete(m);
                    else next.add(m);
                    return next;
                  })
                }
              >
                {m}
              </button>
            ))}
          </div>
        </>
      )}
      <label className="field-label">Note (optional)</label>
      <input
        placeholder="e.g. glass crate, fragile"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div style={{ marginTop: 12 }}>
        <button
          className="button-like active-pill"
          disabled={!selected || !projectId || bind.isPending}
          onClick={() => bind.mutate()}
        >
          {bind.isPending
            ? "Assigning…"
            : selected
              ? `Assign ${selected.short_code ?? selected.serial} & next`
              : "Pick a sticker first"}
        </button>
      </div>
    </div>
  );
}
