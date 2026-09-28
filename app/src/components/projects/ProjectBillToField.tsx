// "Bills to" on a job's GC card, beside the name the GC sees us as
// (20261030105000, owner decisions Q2/Q3 of 2026-09-25).
//
// Who a job's labor is invoiced to is NOT the job's customer or builder, and
// nothing here reads either: the value is the job's own bill-to, which starts
// as the company default (STG Windows and Doors) and changes only when a
// supervisor or the owner picks another customer from the bill-to list.
//
// Only people who may see it get the card at all (supervisors, the owner, and
// anybody granted "Sees costs"), and only supervisors and the owner get the
// picker. Both are decided again in SQL; this just avoids offering a control
// the database would refuse. useEffectiveRole keeps "view as role" honest: an
// owner previewing a foreman sees no bill-to, exactly like a foreman.
//
// Every change is logged (who and when) by set_project_bill_to, and the card
// shows that log. A database behind the migration shows nothing.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { useLanguage, useT } from "../../lib/i18n";
import { useEffectiveRole } from "../../lib/useEffectiveRole";
import {
  billToCustomersKey,
  canManageBillTo,
  canSeeBillTo,
  getProjectBillTo,
  listBillToCustomers,
  listProjectBillToHistory,
  projectBillToHistoryKey,
  projectBillToKey,
  setProjectBillTo,
  type BillToChange,
} from "../../lib/billTo";

function when(at: string, lang: string): string {
  return new Date(at).toLocaleString(lang, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ProjectBillToField({ projectId }: { projectId: string }) {
  const t = useT();
  const { lang } = useLanguage();
  const queryClient = useQueryClient();
  const { effectiveRole, grants } = useEffectiveRole();
  const canSee = canSeeBillTo(effectiveRole, grants);
  const canManage = canManageBillTo(effectiveRole);
  const [choice, setChoice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const current = useQuery({
    queryKey: projectBillToKey(projectId),
    queryFn: () => getProjectBillTo(projectId),
    enabled: canSee,
  });
  const customers = useQuery({
    queryKey: billToCustomersKey,
    queryFn: listBillToCustomers,
    enabled: canSee && canManage,
  });
  const history = useQuery({
    queryKey: projectBillToHistoryKey(projectId),
    queryFn: () => listProjectBillToHistory(projectId),
    enabled: canSee,
  });

  const save = useMutation({
    mutationFn: (customerId: string) => setProjectBillTo(projectId, customerId),
    onSuccess: async () => {
      setChoice(null);
      setProblem(null);
      setSaved(true);
      // The "projectBillTo" root covers this job AND the export's all-jobs map.
      await queryClient.invalidateQueries({ queryKey: ["projectBillTo"] });
      await queryClient.invalidateQueries({ queryKey: projectBillToHistoryKey(projectId) });
    },
    onError: (e) => {
      setSaved(false);
      setProblem(formatApiError(e));
    },
  });

  if (!canSee || !current.data?.known) return null;

  const row = current.data.row;
  const currentId = row?.bill_to_customer_id ?? "";
  const selected = choice ?? currentId;
  // Retired customers cannot be picked, but a job already on one keeps it and
  // the picker has to be able to show that.
  const options = (customers.data?.rows ?? []).filter(
    (c) => !c.retired_at || c.id === currentId,
  );
  const quickbooksId = row?.customer?.quickbooks_customer_id ?? null;
  const changes: BillToChange[] = history.data ?? [];

  return (
    <div
      data-testid="bill-to-field"
      style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}
    >
      <div className="row-gap" style={{ flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span className="field-label">{t("billto.label")}</span>
        {canManage ? (
          <>
            <select
              aria-label={t("billto.label")}
              value={selected}
              disabled={save.isPending || !customers.isSuccess}
              onChange={(e) => {
                setSaved(false);
                setChoice(e.target.value);
              }}
            >
              {!row && <option value="">{t("billto.notSet")}</option>}
              {options.map((c) => (
                <option key={c.id} value={c.id} disabled={Boolean(c.retired_at)}>
                  {c.retired_at ? `${c.name} (${t("billto.retired")})` : c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button-like"
              disabled={!selected || selected === currentId || save.isPending}
              onClick={() => save.mutate(selected)}
            >
              {t("billto.save")}
            </button>
          </>
        ) : (
          <strong data-testid="bill-to-name">{row?.customer?.name ?? t("billto.notSet")}</strong>
        )}
      </div>

      <p className="muted" style={{ margin: "6px 0 0" }}>
        {quickbooksId ? t("billto.qbId", { id: quickbooksId }) : t("billto.noQbId")}
        {saved ? ` · ${t("billto.saved")}` : ""}
      </p>
      {problem && <p role="alert">{problem}</p>}

      {changes.length === 0 ? (
        <p className="muted" style={{ margin: "4px 0 0" }}>{t("billto.never")}</p>
      ) : (
        <details style={{ marginTop: 4 }}>
          <summary className="muted">
            {t("billto.changed", {
              from: changes[0].from_customer?.name ?? t("billto.notSet"),
              to: changes[0].to_customer?.name ?? "",
              who: changes[0].changer?.display_name ?? t("billto.someone"),
              date: when(changes[0].changed_at, lang),
            })}
          </summary>
          <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {changes.slice(1).map((c) => (
              <li key={c.id}>
                {t("billto.changed", {
                  from: c.from_customer?.name ?? t("billto.notSet"),
                  to: c.to_customer?.name ?? "",
                  who: c.changer?.display_name ?? t("billto.someone"),
                  date: when(c.changed_at, lang),
                })}
              </li>
            ))}
          </ul>
        </details>
      )}

      {canManage && (
        <p style={{ margin: "4px 0 0" }}>
          <Link to="/cost-codes#bill-to">{t("billto.manageList")}</Link>
        </p>
      )}
    </div>
  );
}
