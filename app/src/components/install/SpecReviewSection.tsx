// Foreman review + confirm surface for rich per-mark specs. Rendered inside the
// (foreman-gated) OpeningReview page. Each mark's fields are editable with a
// live decoded-size preview; Confirm marks the spec trusted.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  confirmMarkSpec,
  confirmMarkSpecs,
  listMarkSpecs,
  listOpenings,
  updateMarkSpec,
} from "../../lib/install/api";
import { decodeSizeCode, formatSize, type ProjectMarkSpec } from "../../lib/install/specs";
import { MarkDrawing } from "./MarkDrawing";
import { SpecCoverageSummary } from "./SpecCoverageSummary";

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

  // The marks this job actually needs specs for come from its openings, so the
  // coverage check can name the ones that got missed.
  const openings = useQuery({
    queryKey: ["openings", projectId],
    queryFn: () => listOpenings(projectId),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["markSpecs", projectId] });

  const patch = useMutation({
    mutationFn: (args: { id: string; patch: Parameters<typeof updateMarkSpec>[1] }) =>
      updateMarkSpec(args.id, args.patch),
    onSuccess: refresh,
    onError: (e) => setMessage(String(e)),
  });

  const confirmOne = useMutation({
    mutationFn: confirmMarkSpec,
    onSuccess: refresh,
    onError: (e) => setMessage(String(e)),
  });

  const confirmAll = useMutation({
    mutationFn: () => confirmMarkSpecs(projectId),
    onSuccess: refresh,
    onError: (e) => setMessage(String(e)),
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
  const row = (s: ProjectMarkSpec) => (
    <SpecRow
      key={s.id}
      spec={s}
      projectId={projectId}
      onText={(key, value) =>
        patch.mutate({ id: s.id, patch: { [key]: value || null } as SpecPatch })
      }
      onSizeCode={(size_code) => {
        const decoded = decodeSizeCode(size_code);
        patch.mutate({
          id: s.id,
          patch: {
            size_code: size_code || null,
            width_in: decoded?.widthIn ?? null,
            height_in: decoded?.heightIn ?? null,
          },
        });
      }}
      onFlag={(key, value) =>
        patch.mutate({ id: s.id, patch: { [key]: value } as SpecPatch })
      }
      onNum={(key, value) =>
        patch.mutate({ id: s.id, patch: { [key]: num(value) } as SpecPatch })
      }
      onConfirm={() => confirmOne.mutate(s.id)}
    />
  );

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Specs by mark ({rows.length})</h2>
      <p className="muted">
        Full window/door line-item pulled from the specs sheet — shared across
        every opening of that mark. Correct anything the extractor missed, then
        confirm. Editing a size code updates the decoded W×H live. Where the
        extractor found the mark's elevation drawing, it's shown above the
        fields — check the picture matches the mark before confirming.
      </p>
      <SpecCoverageSummary
        openingCodes={(openings.data ?? []).map((o) => o.opening_code)}
        specs={rows}
      />
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
  onText,
  onSizeCode,
  onFlag,
  onNum,
  onConfirm,
}: {
  spec: ProjectMarkSpec;
  projectId: string;
  onText: (key: TextField, value: string) => void;
  onSizeCode: (sizeCode: string) => void;
  onFlag: (key: "tempered" | "egress", value: boolean) => void;
  onNum: (key: "u_factor" | "shgc", value: string) => void;
  onConfirm: () => void;
}) {
  const [sizeCode, setSizeCode] = useState(spec.size_code ?? "");
  const decoded = decodeSizeCode(sizeCode);
  const preview =
    formatSize({
      size_code: sizeCode || null,
      width_in: decoded?.widthIn ?? null,
      height_in: decoded?.heightIn ?? null,
    }) ?? (sizeCode ? "can't decode — will store the raw code" : "—");

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

      {/* The cropped elevation, so the foreman can see the picture matches the
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
            Size code (WWHH) — decoded: <strong>{preview}</strong>
          </span>
          <input
            value={sizeCode}
            placeholder="e.g. 3060"
            onChange={(e) => setSizeCode(e.target.value)}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (spec.size_code ?? "")) onSizeCode(v);
            }}
          />
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

      {!spec.confirmed && (
        <button className="action-btn" style={{ marginTop: 8 }} onClick={onConfirm}>
          Confirm mark #{spec.mark_code}
        </button>
      )}
    </div>
  );
}
