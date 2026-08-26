// One destruction vocabulary (ticket 22). Four patterns share the app —
// Remove (openings, hide + put back), Delete (packages/deliveries,
// permanent), Burn (minted labels), Break up (crates) — and used to each
// speak for themselves. The rule now: a soft hide's button says "Remove"; a
// permanent one says "Delete forever" no matter which specialty verb (burn,
// break up) actually fires underneath — that verb belongs in the plain-words
// body text next to it, not the button. This component is for the in-page
// red confirm cards specifically. A plain `window.confirm()` guarding a
// danger-styled button (ContainerDetail's sweep, DeliveriesList's delete) is
// a different, simpler pattern and stays as it is — its OK button is browser
// chrome, not something this component's wording rule can reach anyway.

import type { ReactNode } from "react";

export interface ConfirmDangerProps {
  /** Plain words explaining what happens — the specialty verb (burn, break
   * up) lives here, not on the button. */
  children: ReactNode;
  /**
   * The button's resting label is "Delete forever" for every permanent
   * action; pass a pending-state label ("Deleting…", "Burning…") while the
   * mutation is in flight so the caller's own progress language still shows.
   */
  confirmText: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
  /** Below the confirm/cancel row — a refusal error, for instance. */
  footer?: ReactNode;
}

export function ConfirmDanger({
  children,
  confirmText,
  onConfirm,
  onCancel,
  disabled,
  footer,
}: ConfirmDangerProps) {
  return (
    <div className="detail-card" style={{ borderLeft: "3px solid var(--danger)", marginTop: 8 }}>
      <p style={{ margin: 0, fontSize: 14 }}>{children}</p>
      <div className="row-gap" style={{ marginTop: 8 }}>
        <button
          className="button-like"
          style={{ background: "var(--danger)", color: "var(--ink)" }}
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirmText}
        </button>
        <button className="button-like" onClick={onCancel}>
          Keep it
        </button>
      </div>
      {footer}
    </div>
  );
}
