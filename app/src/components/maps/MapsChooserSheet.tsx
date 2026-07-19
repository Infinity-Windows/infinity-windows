import { useRef } from "react";
import { Copy, MapPin, Navigation, X } from "lucide-react";
import { buildDirectionsUrls } from "../../lib/mapsLinks";
import { pushToast, toastError } from "../../lib/toast";
import { useFocusTrap } from "../../lib/useFocusTrap";

/**
 * One-tap "Get directions" chooser. Lets the user pick Apple Maps, Google Maps,
 * or Waze (or copy the address). Opened from any job card / address.
 */
export function MapsChooserSheet({
  open,
  onClose,
  address,
  title = "Get directions",
}: {
  open: boolean;
  onClose: () => void;
  address: string;
  title?: string;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef, open, onClose);

  if (!open) return null;
  const urls = buildDirectionsUrls(address);

  const openUrl = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
    onClose();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      pushToast("Address copied", "success");
    } catch (e) {
      toastError(e, "Could not copy the address");
    }
  };

  return (
    <>
      <div className="maps-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        className="maps-sheet sheet-enter"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="capture-grip" aria-hidden />
        <div className="maps-head">
          <div className="maps-head-text">
            <h2 className="maps-title">{title}</h2>
            <p className="maps-address">{address}</p>
          </div>
          <button type="button" className="capture-close" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="maps-options">
          <button type="button" className="maps-option" onClick={() => openUrl(urls.apple)}>
            <Navigation size={18} aria-hidden />
            <span>Apple Maps</span>
          </button>
          <button type="button" className="maps-option" onClick={() => openUrl(urls.google)}>
            <MapPin size={18} aria-hidden />
            <span>Google Maps</span>
          </button>
          <button type="button" className="maps-option" onClick={() => openUrl(urls.waze)}>
            <Navigation size={18} aria-hidden />
            <span>Waze</span>
          </button>
          <button type="button" className="maps-option muted-option" onClick={copy}>
            <Copy size={18} aria-hidden />
            <span>Copy address</span>
          </button>
        </div>
      </div>
    </>
  );
}
