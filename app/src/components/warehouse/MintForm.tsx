// Sticker batches get a real form (warehouse ticket 09). Serials are
// permanent — a fat-fingered 500 pollutes the numbering forever — so the
// count deserves an actual input with the rule stated, not a browser prompt
// that phones render badly and demos make look broken.
//
// Moved here from the Storage hub when it merged into /warehouse (ticket 18).

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { downloadPdf, packageLabelsPdf } from "../../lib/labels";
import { mintPackages } from "../../lib/storage";

export function MintForm({
  onClose,
  onMinted,
}: {
  onClose: () => void;
  onMinted: (n: number) => void;
}) {
  const [count, setCount] = useState("50");
  const n = parseInt(count, 10);
  const invalid = !Number.isFinite(n) || n < 1 || n > 500;

  const mint = useMutation({
    mutationFn: async () => {
      const rows = await mintPackages(n);
      const pdf = await packageLabelsPdf(rows);
      downloadPdf(
        pdf,
        `package-stickers-${rows[0]?.serial}-${rows[rows.length - 1]?.serial}.pdf`,
      );
      return rows.length;
    },
    onSuccess: (made) => {
      pushToast(`${made} blank stickers ready to print.`);
      onMinted(made);
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>Print blank stickers</p>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
          Each sticker gets a permanent serial the moment it prints — batches
          are 1&ndash;500 at a time.
        </p>
        <label className="field-label">How many</label>
        <input
          type="number"
          min={1}
          max={500}
          inputMode="numeric"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          autoFocus
        />
        {invalid && count.trim() !== "" && (
          <p className="error" style={{ fontSize: 12, margin: "4px 0 0" }}>
            Pick a number from 1 to 500.
          </p>
        )}
        <div className="row-gap" style={{ marginTop: 10 }}>
          <button
            className="button-like active-pill"
            disabled={invalid || mint.isPending}
            onClick={() => mint.mutate()}
          >
            {mint.isPending ? "Printing…" : `Print ${invalid ? "" : n} stickers`}
          </button>
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
