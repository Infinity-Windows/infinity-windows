// /scan used to be its own page: a camera, a typed box, and a sentence about
// window labels. It is the scan sheet now (wave 2) — the same sheet every
// warehouse screen's Scan button opens — kept at this address so old
// bookmarks and the hardware-scanner wedge still land somewhere that works.
import { useNavigate } from "react-router-dom";
import { ScanSheet } from "../components/warehouse/ScanSheet";

export function Scan() {
  const navigate = useNavigate();
  return <ScanSheet onClose={() => navigate("/warehouse")} />;
}
