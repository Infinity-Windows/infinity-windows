import { useState } from "react";
import { Navigation } from "lucide-react";
import { directionsDestination, hasStreetAddress } from "../../lib/mapsLinks";
import { useT } from "../../lib/i18n";
import { MapsChooserSheet } from "./MapsChooserSheet";

/**
 * One-tap "Directions" chip. Renders nothing when there is neither an address nor a valid site point.
 * Opens the Apple/Google/Waze chooser sheet.
 */
export function DirectionsButton({
  address,
  latitude,
  longitude,
  label,
  className = "directions-chip",
  title,
}: {
  address: string | null | undefined;
  latitude?: number | null;
  longitude?: number | null;
  label?: string;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const destination = directionsDestination(address, latitude, longitude);
  if (!destination) return null;
  const addr = hasStreetAddress(address) ? address!.trim() : destination;

  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={t("maps.to", { destination: addr })}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Navigation size={14} aria-hidden />
        <span>{label ?? t("maps.directions")}</span>
      </button>
      <MapsChooserSheet
        open={open}
        onClose={() => setOpen(false)}
        address={addr}
        latitude={latitude}
        longitude={longitude}
        title={title ?? "Get directions"}
      />
    </>
  );
}
