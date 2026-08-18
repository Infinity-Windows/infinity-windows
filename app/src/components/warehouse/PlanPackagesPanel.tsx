// Plan a window's packages and mint its labels (ticket 15, ADR-0005).
//
// The foreman's side of the merge: declare "window 16 arrives as 4 packages"
// and four stickers exist — already bound to job + window + part — before the
// truck does. Receiving becomes sticking a label on, and the typing that
// wrong data comes from never happens at a tailgate.
//
// Lives on the job page's Warehouse tab, foreman+. The blank-roll path stays
// on /storage for everything unplanned.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { Explain } from "../ui/Explain";
import {
  listActivePackages,
  mintMarkPackages,
  type StoragePackage,
} from "../../lib/storage";
import { downloadPdf, packageLabelsPdf } from "../../lib/labels";
import { listScheduledMarks } from "../../lib/warehouse/warehouseCards";
import { bindLine, markPlanRow } from "../../lib/warehouse/markPlan";

export function PlanPackagesPanel({
  projectId,
  jobCode,
}: {
  projectId: string;
  jobCode: string | null;
}) {
  const qc = useQueryClient();
  const marks = useQuery({
    queryKey: ["scheduledMarks", [projectId]],
    queryFn: () => listScheduledMarks([projectId]),
  });
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const [counts, setCounts] = useState<Record<string, string>>({});

  const mint = useMutation({
    mutationFn: (input: { markCode: string; total: number }) =>
      mintMarkPackages({ projectId, markCode: input.markCode, total: input.total }),
    onSuccess: (minted, input) => {
      if (minted.length === 0) {
        pushToast(`Window ${input.markCode} already has all ${input.total} labels.`, "info");
        return;
      }
      pushToast(
        `${minted.length} label${minted.length === 1 ? "" : "s"} minted for window ${input.markCode}.`,
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
    .map((m) => markPlanRow(packages.data ?? [], projectId, m.mark_code))
    .sort((a, b) => a.markCode.localeCompare(b.markCode, undefined, { numeric: true }));

  const mintedRows = (packages.data ?? []).filter(
    (p) => p.project_id === projectId && p.status === "minted",
  );

  return (
    <section className="detail-card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Plan packages & labels</h2>
        {mintedRows.length > 0 && (
          <button className="action-btn" onClick={() => void printLabels(mintedRows)}>
            Print all on-the-way labels ({mintedRows.length})
          </button>
        )}
      </div>
      <Explain id="wh-plan-packages">
        Say how many packages a window arrives as, and the labels exist before
        the truck does — already carrying the job, the window and &ldquo;2 of
        4&rdquo;. At the truck, receiving is sticking the label on and tapping
        Arrived. If the maker&rsquo;s own label says a different count, the
        maker wins — burn the wrong stickers and mint the right number.
      </Explain>

      {rows.length === 0 && (
        <p className="muted">
          No windows on this job&rsquo;s schedule yet — they come from the
          plans at spec review.
        </p>
      )}

      <div className="home-projects">
        {rows.map((r) => {
          const typed = counts[r.markCode] ?? "";
          const n = Number(typed);
          const valid = typed.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 20;
          return (
            <div key={r.markCode} className="project-card home-project">
              <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>Window {r.markCode}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {r.totalsDisagree
                      ? "labels disagree on the count — settle that first"
                      : r.declared == null
                        ? "no package count declared yet"
                        : `arrives as ${r.declared} · ${r.here} here` +
                          (r.onTheWay > 0 ? ` · ${r.onTheWay} on the way` : "")}
                  </div>
                </div>
                <div className="row-gap" style={{ alignItems: "center" }}>
                  <input
                    inputMode="numeric"
                    placeholder={r.declared != null ? String(r.declared) : "How many?"}
                    value={typed}
                    onChange={(e) =>
                      setCounts({ ...counts, [r.markCode]: e.target.value })
                    }
                    style={{ width: 90 }}
                    aria-label={`How many packages for window ${r.markCode}`}
                  />
                  <button
                    className="button-like active-pill"
                    disabled={!valid || r.totalsDisagree || mint.isPending}
                    onClick={() => mint.mutate({ markCode: r.markCode, total: n })}
                  >
                    Mint
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
