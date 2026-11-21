import { useLayoutEffect } from "react";
import { restingDesign } from "../../lib/design/design";
import logo from "./forge-steel-logo.jpg";
import "./steel.css";
import "./signedOut.css";

/**
 * The logo block at the top of every screen shown before sign-in (landing,
 * sign-in, invite, new password).
 *
 * These screens sit outside DesignProvider, which needs a signed-in profile
 * to know a person's design, so nothing stamped `data-design` and they kept
 * the old red-on-black look after the app itself moved on (Matt, 2026-11-21).
 * While one of them is on screen this stamps the new design, and puts back
 * whatever was there when it leaves.
 */
export function SignedOutBrand() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.design = "new";
    return () => { root.dataset.design = restingDesign(); };
  }, []);
  return <div className="signin-brand signed-out-brand">
    <img src={logo} alt="Forge Windows and Doors" />
  </div>;
}
