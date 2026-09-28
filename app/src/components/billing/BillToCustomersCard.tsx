// The bill-to list: the companies Forge invoices for its labor
// (20261034000000, owner decision Q1 of 2026-09-25). Lives on the Cost codes
// page because that is the company-wide list supervisors and the owner already
// run; the Cost page opens only at owner rank, and supervisors manage this.
//
// Names must match QuickBooks exactly: the Friday invoice script matches the
// QuickBooks id first and the name second, and the export writes the name as
// typed here. A customer is retired, never deleted — old exports and a job's
// change log keep naming it. The default (every new job starts on it) cannot
// be retired; the server refuses that too.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import {
  billToCustomersKey,
  listBillToCustomers,
  saveBillToCustomer,
  setBillToCustomerRetired,
  type BillToCustomer,
} from "../../lib/billTo";

interface Draft {
  name: string;
  billingEmail: string;
  quickbooksCustomerId: string;
}

const EMPTY: Draft = { name: "", billingEmail: "", quickbooksCustomerId: "" };

const draftOf = (c: BillToCustomer): Draft => ({
  name: c.name,
  billingEmail: c.billing_email ?? "",
  quickbooksCustomerId: c.quickbooks_customer_id ?? "",
});

function DraftFields({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const t = useT();
  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(0, 1fr)" }}>
      <input
        aria-label={t("billtoList.name")}
        placeholder={t("billtoList.namePlaceholder")}
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
      />
      <input
        type="email"
        aria-label={t("billtoList.email")}
        placeholder={t("billtoList.email")}
        value={draft.billingEmail}
        onChange={(e) => onChange({ ...draft, billingEmail: e.target.value })}
      />
      <input
        inputMode="numeric"
        aria-label={t("billtoList.qbId")}
        placeholder={t("billtoList.qbIdPlaceholder")}
        value={draft.quickbooksCustomerId}
        onChange={(e) => onChange({ ...draft, quickbooksCustomerId: e.target.value })}
      />
    </div>
  );
}

export function BillToCustomersCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);

  const list = useQuery({ queryKey: billToCustomersKey, queryFn: listBillToCustomers });

  const refresh = async () => {
    setProblem(null);
    await queryClient.invalidateQueries({ queryKey: billToCustomersKey });
    // A rename or a new QuickBooks id changes what every job page and the
    // export say, so their reads go stale with the list.
    await queryClient.invalidateQueries({ queryKey: ["projectBillTo"] });
    await queryClient.invalidateQueries({ queryKey: ["projectBillToHistory"] });
  };

  const add = useMutation({
    mutationFn: () => saveBillToCustomer({ id: null, ...adding }),
    onSuccess: async () => {
      setAdding(EMPTY);
      await refresh();
    },
    onError: (e) => setProblem(formatApiError(e)),
  });

  const save = useMutation({
    mutationFn: (id: string) => saveBillToCustomer({ id, ...draft }),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
    onError: (e) => setProblem(formatApiError(e)),
  });

  const retire = useMutation({
    mutationFn: (c: BillToCustomer) => setBillToCustomerRetired(c.id, !c.retired_at),
    onSuccess: refresh,
    onError: (e) => setProblem(formatApiError(e)),
  });

  // A database behind the migration has no list; say nothing rather than
  // offer buttons that cannot work.
  if (list.data && !list.data.known) return null;

  const busy = add.isPending || save.isPending || retire.isPending;
  const rows = list.data?.rows ?? [];

  return (
    <section id="bill-to" className="detail-card" style={{ marginTop: 16 }} data-testid="bill-to-list">
      <h2 style={{ margin: "0 0 4px" }}>{t("billtoList.heading")}</h2>
      <p className="muted" style={{ margin: "0 0 8px" }}>{t("billtoList.help")}</p>

      {list.isLoading && <p className="muted">{t("billtoList.loading")}</p>}
      {list.isError && <p role="alert">{formatApiError(list.error)}</p>}
      {problem && <p role="alert">{problem}</p>}

      <ul className="unit-list work-list">
        {rows.map((c) => (
          <li key={c.id} className="find-row" style={{ flexWrap: "wrap", gap: 8 }}>
            {editing === c.id ? (
              <div style={{ display: "grid", gap: 6, flex: 1, minWidth: 0 }}>
                <DraftFields draft={draft} onChange={setDraft} />
                <div className="row-gap">
                  <button
                    className="button-like qc-pass"
                    disabled={busy || !draft.name.trim()}
                    onClick={() => save.mutate(c.id)}
                  >
                    {t("billtoList.save")}
                  </button>
                  <button className="button-like" onClick={() => setEditing(null)}>
                    {t("billtoList.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {c.name}
                    {c.is_default && (
                      <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", marginLeft: 6 }}>
                        {t("billtoList.default")}
                      </span>
                    )}
                    {c.retired_at && (
                      <span className="muted" style={{ fontSize: 11, textTransform: "uppercase", marginLeft: 6 }}>
                        {t("billtoList.retired")}
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {c.quickbooks_customer_id
                      ? t("billto.qbId", { id: c.quickbooks_customer_id })
                      : t("billto.noQbId")}
                    {c.billing_email ? ` · ${c.billing_email}` : ""}
                  </div>
                </div>
                <div className="row-gap" style={{ marginLeft: "auto" }}>
                  <button
                    className="button-like"
                    disabled={busy}
                    onClick={() => {
                      setProblem(null);
                      setEditing(c.id);
                      setDraft(draftOf(c));
                    }}
                  >
                    {t("billtoList.edit")}
                  </button>
                  {!c.is_default && (
                    <button className="button-like" disabled={busy} onClick={() => retire.mutate(c)}>
                      {c.retired_at ? t("billtoList.bringBack") : t("billtoList.retire")}
                    </button>
                  )}
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
        <span className="field-label">{t("billtoList.add")}</span>
        <DraftFields draft={adding} onChange={setAdding} />
        <button className="primary" disabled={busy || !adding.name.trim()} onClick={() => add.mutate()}>
          {add.isPending ? t("billtoList.adding") : t("billtoList.addButton")}
        </button>
      </div>
    </section>
  );
}
