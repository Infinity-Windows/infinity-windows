import { useState } from "react";
import { useLocation } from "react-router-dom";
import { ScanLine } from "lucide-react";
import { ScanSheet } from "../warehouse/ScanSheet";

/**
 * One Scan button on every warehouse screen (warehouse redesign wave 2,
 * ADR-0008's sibling): the sheet it opens reads the sticker's state and leads
 * with the verb that follows it, so there is no Scan *page* to go and find.
 * Floats at the bottom-left, opposite the Ask button, only inside the
 * warehouse section — the same route test SectionAura uses for the hue.
 */
export function ScanFab() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const inWarehouse = /^\/(warehouse|storage|pkg|unit|supplies|takeoffs)/.test(pathname);
  if (!inWarehouse || pathname === "/scan") return null;
  return (
    <>
      <button type="button" className="scan-fab" aria-label="Scan a sticker or a box" onClick={() => setOpen(true)}>
        <ScanLine size={18} aria-hidden="true" />
        <span className="scan-fab-label">Scan</span>
      </button>
      {open ? <ScanSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}
