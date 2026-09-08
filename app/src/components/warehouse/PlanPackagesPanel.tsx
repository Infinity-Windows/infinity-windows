// Plan a window's packages and mint its labels (ticket 15, ADR-0005).
//
// Declare "window 16 arrives as 4 packages" and four stickers exist — already
// bound to job + window + part — before the truck does. Receiving becomes
// sticking a label on, and the typing that wrong data comes from never
// happens at a tailgate.
//
// Lives on the job page's Warehouse tab, open to every crew member since
// ADR-0007: mint_mark_packages is one of the eighteen that opened, and the
// person who plans the labels is usually the person meeting the truck. Burn
// is the exception on this panel and stays foreman+, because it ENDS a serial
// and burn_packages refuses below foreman on the server — a live burn button
// in front of that refusal reads as a broken app. The blank-roll path stays
// on /storage for everything unplanned.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { Explain } from "../ui/Explain";
import {
  burnPackages,
  listActivePackages,
  mintMarkPackages,
  type StoragePackage,
} from "../../lib/storage";
import { downloadPdf, packageLabelsPdf } from "../../lib/labels";
import { listScheduledMarks } from "../../lib/warehouse/warehouseCards";
import { bindLine, markPlanRow } from "../../lib/warehouse/markPlan";
import { listMarkSpecs } from "../../lib/install/api";
import { indexSpecsByMark } from "../../lib/install/specs";
import { listStudioUnits } from "../../lib/modelstudio/units";
import { catalogByMarkFrom, resolveMarkConfig } from "../../lib/modelstudio/fromProject";
import { isForemanPlus } from "../../lib/install/types";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import { useT } from "../../lib/i18n";

export function PlanPackagesPanel({
  projectId,
  jobCode,
}: {
  projectId: string;
  jobCode: string | null;
}) {
  const t = useT();
  const qc = useQueryClient();
  // The only rank left on this panel: burning is a door that ends something.
  const { effectiveRole } = useEffectiveRole();
  const canBurn = isForemanPlus(effectiveRole);
  const marks = useQuery({
    queryKey: ["scheduledMarks", [projectId]],
    queryFn: () => listScheduledMarks([projectId]),
  });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  // Package-count prefill (ticket 11): the SAME catalog-beats-spec
  // resolution signatureSync uses, read-only here — nothing this panel does
  // ever writes a config, it only asks "what does this mark look like" to
  // suggest a starting "arrives as N" count.
  const specs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    enabled: Boolean(projectId),
  });
  const units = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits });
  const specIndex = useMemo(() => indexSpecsByMark(specs.data ?? []), [specs.data]);
  const catalogByMark = useMemo(() => catalogByMarkFrom(units.data ?? []), [units.data]);
  const [counts, setCounts] = useState<Record<string, string>>({});
  // Burn mode (ticket 16): pick the labels that die, confirm once, loudly.
  const [burning, setBurning] = useState<Set<string>>(new Set());
  const [burnMode, setBurnMode] = useState(false);

  const burn = useMutation({
    mutationFn: () => burnPackages([...burning]),
    onSuccess: (n) => {
      pushToast(t(n === 1 ? "planPackages.burned.one" : "planPackages.burned.many", { n }));
      setBurning(new Set());
      setBurnMode(false);
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const mint = useMutation({
    mutationFn: (input: { markCode: string; total: number }) =>
      mintMarkPackages({ projectId, markCode: input.markCode, total: input.total }),
    onSuccess: (minted, input) => {
      if (minted.length === 0) {
        pushToast(t("planPackages.alreadyHasAll", { mark: input.markCode, total: input.total }), "info");
        return;
      }
      pushToast(
        t(minted.length === 1 ? "planPackages.minted.one" : "planPackages.minted.many", {
          n: minted.length,
          mark: input.markCode,
        }),
      );
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
      // Straight to paper: minting without printing leaves stickers that
      // exist only in the record, which is a hunt at the truck.
      void printLabels(minted);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  async function printLabels(rows: StoragePackage[]) {
    const pdf = await packageLabelsPdf(
      rows.map((p) => ({
        serial: p.serial,
        short_code: p.short_code,
        bindLine: bindLine(
          jobCode,
          (p.package_marks ?? [])[0]?.mark_code ?? "?",
          p.part_index ?? null,
          p.part_total ?? null,
        ),
      })),
    );
    downloadPdf(pdf, `labels-${jobCode ?? projectId}.pdf`);
  }

  const rows = (marks.data ?? [])
    .map((m) =>
      markPlanRow(
        packages.data ?? [],
        projectId,
        m.mark_code,
        resolveMarkConfig(m.mark_code, specIndex, catalogByMark),
      ),
    )
    .sort((a, b) => a.markCode.localeCompare(b.markCode, undefined, { numeric: true }));

  const mintedRows = (packages.data ?? []).filter(
    (p) => p.project_id === projectId && p.status === "minted",
  );

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>{t("planPackages.title")}</h2>
        {mintedRows.length > 0 && (
          <div className="row-gap">
            <button className="action-btn" onClick={() => void printLabels(mintedRows)}>
              {t("planPackages.printAll", { n: mintedRows.length })}
            </button>
            {canBurn && (
              <button
                className="action-btn"
                onClick={() => {
                  setBurnMode((v) => !v);
                  setBurning(new Set());
                }}
              >
                {burnMode ? t("planPackages.cancelBurn") : t("planPackages.burnLabels")}
              </button>
            )}
          </div>
        )}
      </div>
      <Explain id="wh-plan-packages">{t("planPackages.explain")}</Explain>

      {canBurn && burnMode && (
        <div
          className="detail-card"
          style={{ borderLeft: "3px solid var(--danger)", margin: "10px 0" }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>{t("planPackages.burnKills")}</p>
          <p className="muted" style={{ margin: "4px 0 8px", fontSize: 13 }}>
            {t("planPackages.burnExplain")}
          </p>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {mintedRows.map((p) => {
              const mark = (p.package_marks ?? [])[0]?.mark_code ?? "?";
              const part =
                p.part_index != null && p.part_total != null
                  ? ` · ${t("storage.tag.ofTotal", { index: p.part_index, total: p.part_total })}`
                  : "";
              const on = burning.has(p.id);
              return (
                <button
                  key={p.id}
                  className={on ? "button-like active-pill" : "button-like"}
                  onClick={() => {
                    const next = new Set(burning);
                    if (on) next.delete(p.id);
                    else next.add(p.id);
                    setBurning(next);
                  }}
                >
                  W{mark}{part}
                </button>
              );
            })}
          </div>
          {burning.size > 0 && (
            <button
              className="button-like"
              style={{ marginTop: 8, background: "var(--danger)", color: "var(--ink)" }}
              disabled={burn.isPending}
              onClick={() => burn.mutate()}
            >
              {burn.isPending
                ? t("planPackages.burning")
                : t(burning.size === 1 ? "planPackages.burnN.one" : "planPackages.burnN.many", { n: burning.size })}
            </button>
          )}
        </div>
      )}

      {rows.length === 0 && <p className="muted">{t("planPackages.noWindows")}</p>}

      <div className="home-projects">
        {rows.map((r) => {
          // Prefilled from the model until the foreman actually types
          // something — the moment they do (even clearing the box), the
          // mark is "touched" and the suggestion note stops showing. No
          // resolved config → suggestedCount is null → typed starts blank,
          // today's behavior exactly.
          const touched = r.markCode in counts;
          const typed = touched
            ? counts[r.markCode]
            : r.suggestedCount != null
              ? String(r.suggestedCount)
              : "";
          const n = Number(typed);
          const valid = typed.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 20;
          const showSuggestion = !touched && r.suggestedCount != null;
          return (
            <div key={r.markCode} className="project-card home-project">
              <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{t("warehouse.card.window", { mark: r.markCode })}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {r.totalsDisagree
                      ? t("planPackages.disagree")
                      : r.declared == null
                        ? t("planPackages.noCountYet")
                        : t("planPackages.arrivesAs", { declared: r.declared, here: r.here }) +
                          (r.onTheWay > 0 ? ` · ${t("planPackages.onTheWay", { n: r.onTheWay })}` : "")}
                  </div>
                </div>
                <div className="row-gap" style={{ alignItems: "center" }}>
                  <span style={{ display: "grid", gap: 2 }}>
                    <input
                      inputMode="numeric"
                      placeholder={r.declared != null ? String(r.declared) : t("planPackages.howMany")}
                      value={typed}
                      onChange={(e) =>
                        setCounts({ ...counts, [r.markCode]: e.target.value })
                      }
                      style={{ width: 90 }}
                      aria-label={t("planPackages.howManyAria", { mark: r.markCode })}
                    />
                    {showSuggestion && (
                      <span className="muted" style={{ fontSize: 10.5 }}>
                        {t("planPackages.suggestedFromModel")}
                      </span>
                    )}
                  </span>
                  <button
                    className="button-like active-pill"
                    disabled={!valid || r.totalsDisagree || mint.isPending}
                    onClick={() => mint.mutate({ markCode: r.markCode, total: n })}
                  >
                    {t("planPackages.mint")}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
