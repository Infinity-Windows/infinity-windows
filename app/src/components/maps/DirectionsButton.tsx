import { useState } from "react";
import { Navigation } from "lucide-react";
import { hasStreetAddress } from "../../lib/mapsLinks";
import { MapsChooserSheet } from "./MapsChooserSheet";

/**
 * One-tap "Directions" chip. Renders nothing when there's no real address.
 * Opens the Apple/Google/Waze chooser sheet.
 */
export function DirectionsButton({
  address,
  label = "Directions",
  className = "directions-chip",
  title,
}: {
  address: string | null | undefined;
  label?: string;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!hasStreetAddress(address)) return null;
  const addr = address as string;

  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`Get directions to ${addr}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Navigation size={14} aria-hidden />
        <span>{label}</span>
      </button>
      <MapsChooserSheet
        open={open}
        onClose={() => setOpen(false)}
        address={addr}
        title={title ?? "Get directions"}
      />
    </>
  );
}
