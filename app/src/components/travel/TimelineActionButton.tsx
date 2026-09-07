import { Phone } from "lucide-react";
import type { TimelineAction } from "../../lib/travel/timeline";
import { DirectionsButton } from "../maps/DirectionsButton";
import { CopyButton } from "./CopyButton";
import { telHref } from "../../lib/travel/links";
import { useT } from "../../lib/i18n";

/** Renders the right one-tap control for a timeline/next-up action. */
export function TimelineActionButton({ action }: { action: TimelineAction | null }) {
  const t = useT();
  if (!action) return null;
  if (action.type === "directions") {
    return <DirectionsButton address={action.address} title={t("travelTimeline.directions")} />;
  }
  if (action.type === "copy") {
    return <CopyButton value={action.value} label={action.label} />;
  }
  const href = telHref(action.phone);
  if (!href) return null;
  return (
    <a className="travel-call" href={href}>
      <Phone size={14} aria-hidden /> <span>{t("travelTimeline.call")}</span>
    </a>
  );
}
