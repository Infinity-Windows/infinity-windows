// Wave Z, Z5: the card statement on the Receipts page.
//
// One question runs this whole section: which charges has nobody handed in a
// receipt for? Everything else — the import, the mapping step, the auto-match —
// exists to make that list trustworthy.
//
// THE MAPPING STEP IS THE DESIGN. Nobody here knows what columns any given
// export uses, so the app reads the header row, offers a guess, and a person
// confirms it before a single row is imported. The confirmed mapping is
// remembered per filename pattern so next month is one tap.
//
// No bank credentials are involved anywhere. The handoff is a file.
//
// English throughout, like the rest of the office screens (Costing, the
// receipts table): the crew never opens this.

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Upload } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import { listProfiles } from "../../lib/install/api";
import { askForReceipt } from "../../lib/receiptsChase";
import {
  importBankTransactions,
  ignoreBankTransaction,
  listBankImports,
  listBankTransactions,
  matchBankTransaction,
  undoBankImport,
  unmatchBankTransaction,
  formatSignedCents,
  type BankTransaction,
} from "../../lib/bank";
import {
  openingMapping,
  parseDelimited,
  rememberMapping,
  toBankRows,
  undatedRows,
  unreadableRows,
  type BankFieldMapping,
  type ParsedFile,
} from "../../lib/bankImport";
import { proposeMatches, withoutReceipts } from "../../lib/bankMatch";
import { listReceipts } from "../../lib/receipts";

/** Only the COLUMN questions. `purchasesAreNegative` is the fifth question the
 * mapping step asks and it is a checkbox, not a header picker, so it stays out
 * of this list — and out of the `mapping[field.key]` lookup below, which has to
 * stay a string. */
type ColumnField = Exclude<keyof BankFieldMapping, "purchasesAreNegative">;

const FIELDS: { key: ColumnField; label: string; required?: boolean }[] = [
  { key: "postedOn", label: "Date", required: true },
  { key: "amount", label: "Amount", required: true },
  { key: "description", label: "Description" },
  { key: "cardholder", label: "Cardholder" },
  { key: "externalId", label: "Bank's own id" },
];

/**
 * The first readable charge, as it WOULD import. Shown beside the sign
 * checkbox, because "purchases are negative in this file" is a question about
 * the file that a person can only answer by seeing the answer: a purchase must
 * read positive here, a refund negative.
 */
function previewAmount(parsed: ParsedFile, mapping: BankFieldMapping): string {
  const first = toBankRows(parsed, mapping)[0];
  return first ? formatSignedCents(first.amount_cents) : "—";
}

export function BankImportSection() {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<{ file: string; parsed: ParsedFile } | null>(null);
  const [mapping, setMapping] = useState<BankFieldMapping | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [chased, setChased] = useState<Set<string>>(new Set());

  const transactions = useQuery({
    queryKey: ["bankTransactions"],
    queryFn: listBankTransactions,
  });
  const imports = useQuery({ queryKey: ["bankImports"], queryFn: listBankImports });
  // The whole receipt feed, NOT the office table's filtered view: a statement
  // covers whatever the card covered, and matching against "August only"
  // because that filter happens to be set would quietly leave real pairs
  // unmatched and the charge sitting in "No receipt yet".
  const allReceipts = useQuery({
    queryKey: ["receipts-office", {}],
    queryFn: () => listReceipts({}),
  });
  const crew = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["bankTransactions"] });
    void qc.invalidateQueries({ queryKey: ["bankImports"] });
    void qc.invalidateQueries({ queryKey: ["receipts-office"] });
  };

  const openFile = async (file: File) => {
    setMessage(null);
    const text = await file.text();
    const parsed = parseDelimited(text);
    if (parsed.headers.length === 0) {
      setMessage("That file had no header row to read.");
      return;
    }
    setPending({ file: file.name, parsed });
    setMapping(openingMapping(file.name, parsed));
  };

  const doImport = useMutation({
    mutationFn: async () => {
      if (!pending || !mapping) return;
      const rows = toBankRows(pending.parsed, mapping);
      if (rows.length === 0) throw new Error("None of those rows had an amount this app could read.");
      const batch = await importBankTransactions(rows, pending.file);
      rememberMapping(pending.file, mapping);
      return batch;
    },
    onSuccess: (batch) => {
      const landed = batch?.rowCount ?? 0;
      setMessage(
        landed === 0
          ? "Nothing new — every one of those charges was already here."
          : `${landed} new charge${landed === 1 ? "" : "s"} imported.`,
      );
      setPending(null);
      setMapping(null);
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  // Charges nobody has handed a receipt in for, and the receipts nobody has
  // attached to a charge — the two sides the auto-match pairs up.
  const open = useMemo(
    () => withoutReceipts(transactions.data ?? []),
    [transactions.data],
  );
  const matchedReceiptIds = useMemo(
    () => new Set((transactions.data ?? []).map((t) => t.receiptId).filter(Boolean) as string[]),
    [transactions.data],
  );
  const proposals = useMemo(
    () =>
      proposeMatches(
        open.map((t) => ({
          id: t.id,
          amountCents: t.amountCents,
          postedOn: t.postedOn,
          vendorGuess: t.vendorGuess,
          description: t.description,
        })),
        (allReceipts.data ?? [])
          .filter((r) => !matchedReceiptIds.has(r.id))
          .map((r) => ({
            id: r.id,
            amountCents: r.amountCents,
            purchasedOn: r.purchasedOn,
            vendor: r.vendor,
          })),
      ),
    [open, allReceipts.data, matchedReceiptIds],
  );

  const acceptAll = useMutation({
    mutationFn: async () => {
      for (const p of proposals) {
        await matchBankTransaction(p.transactionId, p.receiptId);
      }
    },
    onSuccess: () => {
      setMessage(`Matched ${proposals.length} charge${proposals.length === 1 ? "" : "s"}.`);
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  const setAside = useMutation({
    mutationFn: (id: string) => ignoreBankTransaction(id, true),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const unmatch = useMutation({
    mutationFn: (id: string) => unmatchBankTransaction(id),
    onSuccess: refresh,
    onError: (e) => setMessage(formatApiError(e)),
  });

  const undo = useMutation({
    mutationFn: (id: string) => undoBankImport(id),
    onSuccess: () => {
      setMessage("Import taken back. Charges somebody had already matched were kept.");
      refresh();
    },
    onError: (e) => setMessage(formatApiError(e)),
  });

  /** The crew member whose name is on the card line, when one matches. */
  const cardholderProfile = (txn: BankTransaction) => {
    const name = (txn.cardholder ?? "").trim().toLowerCase();
    if (!name) return null;
    return (
      (crew.data ?? []).find((p) => p.display_name.trim().toLowerCase() === name) ?? null
    );
  };

  const chase = async (txn: BankTransaction) => {
    const who = cardholderProfile(txn);
    if (!who) return;
    await askForReceipt(who.id, txn);
    setChased((s) => new Set(s).add(txn.id));
  };

  return (
    <section style={{ margin: "24px 0" }}>
      <div className="row-between">
        <h2>
          <Landmark size={18} aria-hidden /> Company card
        </h2>
        <button
          type="button"
          className="action-btn"
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={16} aria-hidden /> Import bank transactions
        </button>
      </div>
      <p className="muted">
        Export the card statement and drop the file here. Nothing connects to a
        bank — the file is the handoff, and every import can be taken back.
      </p>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/plain"
        style={{ display: "none" }}
        aria-label="Bank statement file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
          e.target.value = "";
        }}
      />

      {message && <p className="muted">{message}</p>}

      {pending && mapping && (
        <div className="detail-card">
          <h3>Which column is which?</h3>
          <p className="muted">
            {pending.file} — {pending.parsed.rows.length} rows. Check these before
            importing; we remember your answer for files named like this one.
          </p>
          {FIELDS.map((field) => (
            <div key={field.key}>
              <label className="field-label" htmlFor={`bank-map-${field.key}`}>
                {field.label}
                {field.required ? "" : " (optional)"}
              </label>
              <select
                id={`bank-map-${field.key}`}
                value={mapping[field.key] ?? ""}
                onChange={(e) =>
                  setMapping({ ...mapping, [field.key]: e.target.value || null })
                }
              >
                <option value="">— none —</option>
                {pending.parsed.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {/* The fifth question, and the one no header answers. Chase, Amex and
              most card exports write a purchase as a NEGATIVE number, because
              they are describing the balance. Read that way round, every charge
              imports negative, no receipt can ever equal it (an amount cannot
              be negative), and the auto-match proposes nothing — forever, with
              nothing on screen to explain it. Guessed from the file, confirmed
              by a person, remembered with the rest of the mapping. */}
          <label className="row-gap" style={{ alignItems: "center", margin: "8px 0" }}>
            <input
              type="checkbox"
              checked={mapping.purchasesAreNegative === true}
              onChange={(e) =>
                setMapping({ ...mapping, purchasesAreNegative: e.target.checked })
              }
            />
            <span>Purchases are negative numbers in this file</span>
          </label>
          {mapping.amount && (
            <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
              First charge reads as{" "}
              <strong>{previewAmount(pending.parsed, mapping)}</strong>. A purchase
              should look positive here; a refund negative.
            </p>
          )}
          {unreadableRows(pending.parsed, mapping) > 0 && (
            <p className="warn-text">
              {unreadableRows(pending.parsed, mapping)} row(s) have no amount this
              app can read and will be skipped. If that is all of them, the
              Amount column is wrong.
            </p>
          )}
          {/* A bad Date column is quieter than a bad Amount column and does more
              damage: the rows still import, so nothing looks wrong, but every
              charge lands dateless and auto-matching — which needs the date to
              place a charge in the ±3-day window — proposes nothing at all,
              with no reason given. Say it here, while the import can still be
              cancelled. */}
          {undatedRows(pending.parsed, mapping) > 0 && (
            <p className="warn-text">
              {undatedRows(pending.parsed, mapping)} row(s) have no date this app
              can read. They will still import, but matching them to receipts
              needs the date — so check the Date column before you go on.
            </p>
          )}
          <div className="row-gap">
            <button
              type="button"
              className="action-btn"
              disabled={doImport.isPending || !mapping.amount}
              onClick={() => doImport.mutate()}
            >
              {doImport.isPending ? "Importing…" : "Import"}
            </button>
            <button
              type="button"
              className="button-like"
              onClick={() => {
                setPending(null);
                setMapping(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {proposals.length > 0 && (
        <div className="row-gap" style={{ margin: "8px 0" }}>
          <button
            type="button"
            className="action-btn"
            disabled={acceptAll.isPending}
            onClick={() => acceptAll.mutate()}
          >
            {acceptAll.isPending
              ? "Matching…"
              : `Match ${proposals.length} charge${proposals.length === 1 ? "" : "s"} to receipts`}
          </button>
        </div>
      )}

      <h3>No receipt yet</h3>
      {open.length === 0 ? (
        <p className="muted">
          Every charge on file has a receipt against it, or has been set aside.
        </p>
      ) : (
        <ul className="unit-list">
          {open.map((txn) => {
            const who = cardholderProfile(txn);
            return (
              <li key={txn.id} className="opening-review-row">
                <div className="wh-row">
                  <div className="wh-row-main">
                    <span className="wh-row-title">
                      {formatSignedCents(txn.amountCents)} · {txn.vendorGuess ?? txn.description ?? "Unknown"}
                    </span>
                    <span className="wh-row-sub">
                      {txn.postedOn ?? "No date"}
                      {txn.cardholder ? ` · ${txn.cardholder}` : " · no cardholder on the line"}
                      {txn.cardholder && !who ? " (nobody on the roster by that name)" : ""}
                    </span>
                  </div>
                  <div className="wh-actions">
                    {who && (
                      <button
                        type="button"
                        className="button-like"
                        disabled={chased.has(txn.id)}
                        onClick={() => void chase(txn)}
                      >
                        {chased.has(txn.id) ? "Asked" : "Ask for it"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button-like"
                      disabled={setAside.isPending}
                      onClick={() => setAside.mutate(txn.id)}
                    >
                      No receipt needed
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {(transactions.data ?? []).some((t) => t.status === "matched") && (
        <>
          <h3>Matched</h3>
          <ul className="unit-list">
            {(transactions.data ?? [])
              .filter((t) => t.status === "matched")
              .map((txn) => (
                <li key={txn.id} className="opening-review-row">
                  <div className="wh-row">
                    <div className="wh-row-main">
                      <span className="wh-row-title">
                        {formatSignedCents(txn.amountCents)} · {txn.vendorGuess ?? txn.description ?? "Unknown"}
                      </span>
                      <span className="wh-row-sub">
                        {txn.postedOn ?? "No date"} · paid on company card
                      </span>
                    </div>
                    <div className="wh-actions">
                      <button
                        type="button"
                        className="button-like"
                        disabled={unmatch.isPending}
                        onClick={() => unmatch.mutate(txn.id)}
                      >
                        Wrong receipt
                      </button>
                    </div>
                  </div>
                </li>
              ))}
          </ul>
        </>
      )}

      {(imports.data ?? []).length > 0 && (
        <>
          <h3>Imports</h3>
          <ul className="unit-list">
            {(imports.data ?? []).map((batch) => (
              <li key={batch.id} className="opening-review-row">
                <div className="wh-row">
                  <div className="wh-row-main">
                    <span className="wh-row-title">{batch.filename ?? "Statement"}</span>
                    <span className="wh-row-sub">
                      {new Date(batch.importedAt).toLocaleDateString()} · {batch.rowCount} charges
                      {batch.importerName ? ` · ${batch.importerName}` : ""}
                      {batch.undoneAt ? " · taken back" : ""}
                    </span>
                  </div>
                  <div className="wh-actions">
                    {!batch.undoneAt && (
                      <button
                        type="button"
                        className="button-like"
                        disabled={undo.isPending}
                        onClick={() => undo.mutate(batch.id)}
                      >
                        Undo this import
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
