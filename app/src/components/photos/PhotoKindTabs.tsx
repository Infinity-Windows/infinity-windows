import { Camera, Receipt as ReceiptIcon } from "lucide-react";
import { useT } from "../../lib/i18n";

/**
 * Photos | Receipts — the two things a job's pictures can be, side by side.
 *
 * Receipts were only ever reachable by typing ?kind=receipt into the address
 * bar, which meant that on a phone they were not reachable at all: a foreman
 * who wanted to see what the crew had bought for a job had no door to walk
 * through. This is that door, and it is the SAME control on the Photos page
 * and on the job hub's Photos tab, so the two never drift apart.
 *
 * The tablist/tab shape is the app's own segmented-control convention (the
 * timecard's range tabs, the vehicles filter, the scheduling view switch), and
 * role="tab" rather than a plain button keeps these two out of every existing
 * `getByRole("button")` on these screens.
 *
 * Deliberately NO counts on the segments. The feed runs one query at a time —
 * photos OR receipts, never both — so a count next to the tab you are not
 * looking at would mean firing the other query on every visit to make a number
 * nobody asked for, and showing a stale or empty one until it lands.
 */
export function PhotoKindTabs({
  kind,
  onChange,
}: {
  kind: "photo" | "receipt";
  onChange: (next: "photo" | "receipt") => void;
}) {
  const t = useT();
  return (
    <div className="photos-kind" role="tablist" aria-label={t("photos.kind.aria")}>
      <button
        type="button"
        role="tab"
        aria-selected={kind === "photo"}
        className={kind === "photo" ? "photos-kind-tab is-active" : "photos-kind-tab"}
        onClick={() => onChange("photo")}
      >
        <Camera size={15} aria-hidden /> {t("photos.kind.photos")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={kind === "receipt"}
        className={kind === "receipt" ? "photos-kind-tab is-active" : "photos-kind-tab"}
        onClick={() => onChange("receipt")}
      >
        <ReceiptIcon size={15} aria-hidden /> {t("photos.kind.receipts")}
      </button>
    </div>
  );
}
