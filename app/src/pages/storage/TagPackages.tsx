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
  PART_LABELS,
  PART_TYPES,
  type PackageCategory,
  type PartType,
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
  // The label's "#16 2/3": which piece, and N of M. Type and total stay put
  // between binds — a truck usually unloads a run of same-kind packages —
  // while the piece number and the manufacturer's mark reset every sticker.
  const [partType, setPartType] = useState<PartType | null>(null);
  const [partIndex, setPartIndex] = useState("");
  const [partTotal, setPartTotal] = useState("");
  const [mfrMark, setMfrMark] = useState("");
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

  // "2 of 3" needs both halves and the first can't beat the second. Empty is
  // fine — plenty of labels carry no part number, and receiving never blocks.
  const idx = partIndex.trim() === "" ? null : parseInt(partIndex, 10);
  const tot = partTotal.trim() === "" ? null : parseInt(partTotal, 10);
  const partInvalid =
    (idx === null) !== (tot === null) ||
    (idx !== null && (!Number.isFinite(idx) || idx < 1)) ||
    (tot !== null && (!Number.isFinite(tot) || tot < 1)) ||
    (idx !== null && tot !== null && idx > tot);

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
        partIndex: idx,
        partTotal: tot,
        partType,
        mfrMark: mfrMark.trim() || null,
      });
    },
    onSuccess: (p) => {
      localStorage.setItem(LAST_JOB_KEY, projectId);
      pushToast(`${p.serial} assigned — sticker is now permanent.`);
      setSelected(null);
      setMarks(new Set());
      setNote("");
      // Piece number and their mark are per-package; type and total usually
      // repeat down the truck, so those stay for the next sticker.
      setPartIndex("");
      setMfrMark("");
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
      <label className="field-label">
        Which piece is it? (from the label, e.g. “#16 2/3”)
      </label>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        {PART_TYPES.map((t) => (
          <button
            key={t}
            className={partType === t ? "button-like active-pill" : "button-like"}
            onClick={() => setPartType(partType === t ? null : t)}
          >
            {PART_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="row-gap" style={{ alignItems: "center", marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 13 }}>Part</span>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          placeholder="2"
          value={partIndex}
          onChange={(e) => setPartIndex(e.target.value)}
          style={{ width: 64, marginBottom: 0 }}
        />
        <span className="muted" style={{ fontSize: 13 }}>of</span>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          placeholder="3"
          value={partTotal}
          onChange={(e) => setPartTotal(e.target.value)}
          style={{ width: 64, marginBottom: 0 }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          — leave empty if the label has none
        </span>
      </div>
      {partInvalid && (
        <p className="error" style={{ fontSize: 12, margin: "4px 0 0" }}>
          A part number needs both halves, and “2 of 3” can’t be “4 of 3”.
        </p>
      )}
      <label className="field-label">
        Their mark # (only if it differs from ours)
      </label>
      <input
        placeholder="e.g. A-2216"
        value={mfrMark}
        onChange={(e) => setMfrMark(e.target.value)}
      />
      <label className="field-label">Note (optional)</label>
      <input
        placeholder="e.g. glass crate, fragile"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div style={{ marginTop: 12 }}>
        <button
          className="button-like active-pill"
          disabled={!selected || !projectId || partInvalid || bind.isPending}
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
