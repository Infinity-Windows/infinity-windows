// Foreman review + confirm surface for rich per-mark specs. Rendered inside the
// (foreman-gated) OpeningReview page. Each mark's fields are editable with a
// live decoded-size preview; Confirm marks the spec trusted.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  confirmMarkSpec,
  confirmMarkSpecs,
  listMarkSpecs,
  mergeMarkSpecExtra,
  listOpenings,
  updateMarkSpec,
} from "../../lib/install/api";
import {
  checkSpecSize,
  readPrintedSize,
  resolveSpecSize,
  sizeMismatchRecord,
} from "../../lib/install/printedSize";
import {
  decodeSizeCode,
  formatSize,
  indexSpecsByMark,
  type ProjectMarkSpec,
} from "../../lib/install/specs";
import { MarkDrawing } from "./MarkDrawing";
import { formatApiError } from "../../lib/install/errors";
import { syncProjectSignatures } from "../../lib/estimate/signatureSync";
import { setProjectNeedsFlashing } from "../../lib/install/phases";
import { roMismatchWarning } from "../../lib/install/roMismatch";
import { openingMarkCode, type ProjectOpening } from "../../lib/install/types";
import { catalogByMarkFrom, resolveMarkConfig } from "../../lib/modelstudio/fromProject";
import {
  constructabilityProblems,
  listStudioUnits,
  type UnitConfig,
} from "../../lib/modelstudio/units";
import { SpecReconciliationReport } from "./SpecReconciliationReport";
import { SpecSizeWarnings } from "./SpecSizeWarnings";

interface Props {
  projectId: string;
}

type TextField =
  | "style"
  | "glass"
  | "color"
  | "operation"
  | "grids"
  | "screen"
  | "product_line";

const TEXT_FIELDS: { key: TextField; label: string; placeholder: string }[] = [
  { key: "style", label: "Style", placeholder: "e.g. Aluminum Fixed Window (Nail Fins)" },
  { key: "glass", label: "Glass", placeholder: "e.g. Low-E 366, argon, tempered" },
  { key: "color", label: "Color", placeholder: "e.g. Black (Aluminum Profile)" },
  { key: "operation", label: "Operation", placeholder: "XO / OX / Fixed / Casement" },
  { key: "grids", label: "Grids", placeholder: "e.g. none / colonial" },
  { key: "screen", label: "Screen", placeholder: "e.g. half screen" },
  { key: "product_line", label: "Product line", placeholder: "manufacturer / series" },
];

export function SpecReviewSection({ projectId }: Props) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const specs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
  });

  // The plans side of the reconciliation: the marks this job actually has
  // openings for, so the report can name what the spec sheet missed — and what
  // it covers that the plans never asked for.
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });

  // Constructability preflight (#13) + RO-mismatch flags (#14): the SAME
  // catalog-beats-spec resolution signatureSync uses, read-only here — this
  // screen never writes a config, it only asks "what does this mark look
  // like" to warn, never to block.
  const units = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits });
  const specIndex = useMemo(() => indexSpecsByMark(specs.data ?? []), [specs.data]);
  const catalogByMark = useMemo(() => catalogByMarkFrom(units.data ?? []), [units.data]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["markSpecs", projectId] });

  const patch = useMutation({
    mutationFn: (args: { id: string; patch: Parameters<typeof updateMarkSpec>[1] }) =>
      updateMarkSpec(args.id, args.patch),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  // The size-code box and the Inset/Outset dropdown both live in the same
  // `extra` jsonb blob. A plain UPDATE writes that column whole, so whichever
  // saved second silently wiped the other's key — and Inset/Outset feeds the
  // signature a unit's cohort is keyed by, which nothing ever recomputes, so a
  // dropped pick stayed dropped.
  //
  // The write is now atomic in the database: merge_mark_spec_extra does the
  // read, the merge and the write inside one statement, so a field can only
  // ever speak for its OWN keys. Re-reading before saving used to narrow this
  // window; it could never close it, because two saves still interleave
  // between the read and the write.
  const mergeExtra = useMutation({
    mutationFn: (v: { id: string; patch: Record<string, unknown>; drop?: string[] }) =>
      mergeMarkSpecExtra(v.id, v.patch, v.drop ?? []),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["markSpecs", projectId] }),
  });

  const confirmOne = useMutation({
    mutationFn: confirmMarkSpec,
    onSuccess: () => {
      refresh();
      // A confirm can change the config-of-record → cohort key.
      void syncProjectSignatures(projectId);
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const confirmAll = useMutation({
    mutationFn: () => confirmMarkSpecs(projectId),
    onSuccess: () => {
      refresh();
      void syncProjectSignatures(projectId);
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // The table may not exist yet, or a project may simply have no specs.
  if (specs.isLoading) return null;
  const rows = specs.data ?? [];
  if (rows.length === 0) return null;

  const drafts = rows.filter((s) => !s.confirmed);
  const confirmed = rows.filter((s) => s.confirmed);

  const num = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  type SpecPatch = Parameters<typeof updateMarkSpec>[1];

  // Still read fresh before COMPUTING, which is a different concern: the
  // printed size lives in `extra` too and the mismatch verdict has to be
  // judged against what is stored now, not what this row drew with.
  const freshExtra = async (
    id: string,
    fallback: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> => {
    const fresh = await listMarkSpecs(projectId);
    return fresh.find((f) => f.id === id)?.extra ?? fallback ?? {};
  };

  const row = (s: ProjectMarkSpec) => (
    <SpecRow
      key={s.id}
      spec={s}
      projectId={projectId}
      config={resolveMarkConfig(s.mark_code, specIndex, catalogByMark)}
      openings={openings.data ?? []}
      onText={(key, value) =>
        patch.mutate({ id: s.id, patch: { [key]: value || null } as SpecPatch })
      }
      onSizeCode={async (size_code) => {
        // A hand-edited code goes through the same precedence as an extracted
        // one: the dimensions printed on the drawing win over a decode they
        // disagree with, and the stored mismatch record follows the new code
        // rather than describing the old one.
        const base = await freshExtra(s.id, s.extra);
        const decoded = decodeSizeCode(size_code);
        const printed = readPrintedSize(base);
        const size = resolveSpecSize({
          decodedWidthIn: decoded?.widthIn ?? null,
          decodedHeightIn: decoded?.heightIn ?? null,
          printedWidthIn: printed.widthIn,
          printedHeightIn: printed.heightIn,
        });
        const mismatch = sizeMismatchRecord(
          size_code,
          printed.widthIn,
          printed.heightIn,
        );
        // Scalar columns are this field's own — nothing else writes them.
        patch.mutate({
          id: s.id,
          patch: {
            size_code: size_code || null,
            width_in: size.widthIn,
            height_in: size.heightIn,
          },
        });
        // The shared blob gets exactly the one key this field owns.
        mergeExtra.mutate(
          mismatch
            ? { id: s.id, patch: { size_mismatch: mismatch } }
            : { id: s.id, patch: {}, drop: ["size_mismatch"] },
        );
      }}
      onFlag={(key, value) =>
        patch.mutate({ id: s.id, patch: { [key]: value } as SpecPatch })
      }
      onNum={(key, value) =>
        patch.mutate({ id: s.id, patch: { [key]: num(value) } as SpecPatch })
      }
      onInsetOutset={(value) => {
        // Signature field (.scratch/signature): stored in extra, blank is
        // an honest blank — clearing removes the key entirely.
        mergeExtra.mutate(
          value
            ? { id: s.id, patch: { inset_outset: value } }
            : { id: s.id, patch: {}, drop: ["inset_outset"] },
        );
      }}
      onConfirm={() => confirmOne.mutate(s.id)}
    />
  );

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Specs by mark ({rows.length})</h2>
      <p className="muted">
        Full window/door line-item pulled from the specs sheet — shared across
        every opening of that mark. Correct anything the extractor missed, then
        confirm. Editing a size code updates the decoded W×H live. The full
        spec sheet the fields were read from is shown above them — check the
        page matches the mark before confirming.
      </p>
      {/* Flashing default for the whole job. Every opening arrives needing
          flashing ("yes is the default, no is the change"); a job that
          doesn't flash gets cleared here in one tap. Per-window exceptions
          live on each opening sheet. */}
      <FlashingDefaultRow projectId={projectId} openings={openings.data ?? []} />
      <SpecReconciliationReport
        projectId={projectId}
        openings={openings.data ?? []}
        specs={rows}
      />
      <SpecSizeWarnings specs={rows} />
      {message && <p className="error">{message}</p>}

      {drafts.length > 0 && (
        <>
          <h3 style={{ marginBottom: 4 }}>
            Drafts ({drafts.length}) — confirm before crews trust them
          </h3>
          {drafts.map(row)}
          <button
            className="primary big"
            disabled={confirmAll.isPending}
            onClick={() => confirmAll.mutate()}
            style={{ marginTop: 8 }}
          >
            Confirm all {drafts.length} specs
          </button>
        </>
      )}

      {confirmed.length > 0 && (
        <>
          <h3 style={{ marginTop: 16, marginBottom: 4 }}>
            Confirmed ({confirmed.length})
          </h3>
          {confirmed.map(row)}
        </>
      )}
    </section>
  );
}

function SpecRow({
  spec,
  projectId,
  config,
  openings,
  onText,
  onSizeCode,
  onFlag,
  onNum,
  onInsetOutset,
  onConfirm,
}: {
  spec: ProjectMarkSpec;
  projectId: string;
  /** The mark's resolved Studio config (catalog beats spec), or null when
   * neither exists — feeds the #13/#14 warning lines below, never blocks. */
  config: UnitConfig | null;
  /** Every opening on the project — filtered to this mark's own (twins
   * included) for the RO-mismatch check (#14). */
  openings: ProjectOpening[];
  onText: (key: TextField, value: string) => void;
  onSizeCode: (sizeCode: string) => void;
  onFlag: (key: "tempered" | "egress", value: boolean) => void;
  onNum: (key: "u_factor" | "shgc", value: string) => void;
  onInsetOutset: (value: "inset" | "outset" | null) => void;
  onConfirm: () => void;
}) {
  const [sizeCode, setSizeCode] = useState(spec.size_code ?? "");
  // The box only reads `spec.size_code` on first mount. If someone else fixes
  // the code (another foreman, or a background re-extraction) while this
  // foreman has the page open, the box keeps showing the old value — and the
  // "matches the drawing / disagrees" line below ends up comparing that stale
  // typed value against the fresh printed dimensions, which can flag a
  // disagreement that's already been fixed. Re-sync from the record whenever
  // it changes, but only while nobody's mid-edit — otherwise a background
  // update could yank a foreman's own keystrokes out from under them.
  const [editingSizeCode, setEditingSizeCode] = useState(false);
  useEffect(() => {
    if (!editingSizeCode) setSizeCode(spec.size_code ?? "");
  }, [spec.size_code, editingSizeCode]);
  const decoded = decodeSizeCode(sizeCode);
  const preview =
    formatSize({
      size_code: sizeCode || null,
      width_in: decoded?.widthIn ?? null,
      height_in: decoded?.heightIn ?? null,
    }) ?? (sizeCode ? "can't decode — will store the raw code" : "—");
  // What the drawing itself says, so the foreman can see both numbers side by
  // side when the code and the sheet disagree.
  const printed = readPrintedSize(spec.extra);
  const mismatch = checkSpecSize({ ...spec, size_code: sizeCode || null });

  // Constructability preflight (#13) — never blocks; see constructabilityProblems.
  const constructProblems = config ? constructabilityProblems(config) : [];
  // RO-mismatch (#14): this mark's own openings (twins included), each
  // checked against the SAME resolved config — reconciled with roCheck's
  // gap math via roMismatchWarning, verbatim.
  const markOpenings = openings.filter(
    (o) => openingMarkCode(o.opening_code) === spec.mark_code.trim().toUpperCase(),
  );
  const roProblems = config
    ? markOpenings
        .map((o) => {
          const msg = roMismatchWarning(o, config);
          if (!msg) return null;
          return markOpenings.length > 1 ? `${o.opening_code}: ${msg}` : msg;
        })
        .filter((m): m is string => m != null)
    : [];

  return (
    <div className="detail-card" style={{ marginTop: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <strong>Mark #{spec.mark_code}</strong>
        <span className="muted" style={{ fontSize: 11 }}>
          {spec.confirmed ? "confirmed" : `draft · ${spec.source}`}
        </span>
      </div>

      {/* The full spec sheet, so the foreman can see the page matches the
          mark before confirming. */}
      <MarkDrawing spec={spec} projectId={projectId} />

      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        {TEXT_FIELDS.map((f) => (
          <label key={f.key} style={{ display: "grid", gap: 2 }}>
            <span className="field-label" style={{ margin: 0 }}>
              {f.label}
            </span>
            <input
              defaultValue={(spec[f.key] as string | null) ?? ""}
              placeholder={f.placeholder}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== ((spec[f.key] as string | null) ?? "")) {
                  onText(f.key, v);
                }
              }}
            />
          </label>
        ))}

        <label style={{ display: "grid", gap: 2 }}>
          <span className="field-label" style={{ margin: 0 }}>
            Mounts inset or outset — a signature field; blank until the sheet
            (or you) says
          </span>
          <select
            value={
              ((spec.extra as { inset_outset?: string } | null)?.inset_outset as
                | "inset"
                | "outset"
                | undefined) ?? ""
            }
            onChange={(e) =>
              onInsetOutset(
                e.target.value === "inset" || e.target.value === "outset"
                  ? e.target.value
                  : null,
              )
            }
          >
            <option value="">— not stated —</option>
            <option value="inset">Inset (recessed into the opening)</option>
            <option value="outset">Outset (flange/fin onto the face)</option>
          </select>
        </label>

        <label style={{ display: "grid", gap: 2 }}>
          <span className="field-label" style={{ margin: 0 }}>
            Size code (WWHH) — decoded: <strong>{preview}</strong>
          </span>
          <input
            value={sizeCode}
            placeholder="e.g. 3060"
            onFocus={() => setEditingSizeCode(true)}
            onChange={(e) => setSizeCode(e.target.value)}
            onBlur={(e) => {
              setEditingSizeCode(false);
              const v = e.target.value.trim();
              if (v !== (spec.size_code ?? "")) onSizeCode(v);
            }}
          />
          {(printed.widthRaw || printed.heightRaw) && (
            <span className="muted" style={{ fontSize: 11 }}>
              Printed on the drawing: {printed.widthRaw ?? "—"} ×{" "}
              {printed.heightRaw ?? "—"}
              {mismatch
                ? " — the code disagrees, so these are the sizes we show the crew."
                : " — matches the code."}
            </span>
          )}
        </label>

        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              defaultChecked={Boolean(spec.tempered)}
              onChange={(e) => onFlag("tempered", e.target.checked)}
            />
            Tempered
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              defaultChecked={Boolean(spec.egress)}
              onChange={(e) => onFlag("egress", e.target.checked)}
            />
            Egress
          </label>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <label style={{ display: "grid", gap: 2, flex: 1 }}>
            <span className="field-label" style={{ margin: 0 }}>
              U-factor
            </span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              defaultValue={spec.u_factor ?? ""}
              onBlur={(e) => {
                if (e.target.value.trim() !== String(spec.u_factor ?? "")) {
                  onNum("u_factor", e.target.value);
                }
              }}
            />
          </label>
          <label style={{ display: "grid", gap: 2, flex: 1 }}>
            <span className="field-label" style={{ margin: 0 }}>
              SHGC
            </span>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              defaultValue={spec.shgc ?? ""}
              onBlur={(e) => {
                if (e.target.value.trim() !== String(spec.shgc ?? "")) {
                  onNum("shgc", e.target.value);
                }
              }}
            />
          </label>
        </div>
      </div>

      {/* Constructability preflight (#13) and RO-mismatch (#14) — plain
          warning text only, never a reason Confirm below is disabled. */}
      {constructProblems.length > 0 && (
        <p className="warn-text" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          this configuration can&rsquo;t be built as drawn: {constructProblems.join("; ")}.
        </p>
      )}
      {roProblems.length > 0 && (
        <p className="warn-text" style={{ margin: "8px 0 0", fontSize: 12.5 }}>
          the measured rough opening doesn&rsquo;t match this configuration: {roProblems.join("; ")}.
        </p>
      )}

      {!spec.confirmed && (
        <button className="action-btn" style={{ marginTop: 8 }} onClick={onConfirm}>
          Confirm mark #{spec.mark_code}
        </button>
      )}
    </div>
  );
}

/**
 * The job-level flashing switch. Shows the live split (how many openings
 * still need flashing vs are exempt) and flips the whole job in one tap —
 * the escape hatch that makes "default yes everywhere" safe on jobs that
 * turn out not to flash.
 */
function FlashingDefaultRow({
  projectId,
  openings,
}: {
  projectId: string;
  openings: ProjectOpening[];
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const needing = openings.filter((o) => o.needs_flashing === true).length;
  const exempt = openings.filter((o) => o.needs_flashing === false).length;
  const known = needing + exempt > 0;

  const setAll = useMutation({
    mutationFn: (needs: boolean) => setProjectNeedsFlashing(projectId, needs),
    onSuccess: (count, needs) => {
      setNote(
        `${count} opening${count === 1 ? "" : "s"} set to ${needs ? "needs flashing" : "no flashing"}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["openings", projectId] });
    },
    onError: (e) => setNote(formatApiError(e)),
  });

  if (!known) return null;
  return (
    <div className="detail-card" style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="field-label" style={{ margin: 0 }}>Flashing</span>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {needing} need it{exempt > 0 ? ` · ${exempt} exempt` : ""}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            className="button-like"
            disabled={setAll.isPending || needing === 0}
            onClick={() => setAll.mutate(false)}
          >
            This job doesn't flash
          </button>
          <button
            className="button-like"
            disabled={setAll.isPending || exempt === 0}
            onClick={() => setAll.mutate(true)}
          >
            All need flashing
          </button>
        </span>
      </div>
      {note && <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>{note}</p>}
    </div>
  );
}
