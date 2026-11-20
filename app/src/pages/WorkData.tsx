import { useSyncExternalStore } from "react";
import { useLanguage } from "../lib/i18n";
import { signInGeneration, subscribeSignedIn } from "../lib/signedIn";
import { DataComparison } from "./dataReview/DataComparison";

function subscribeNetwork(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** The Data route is restricted to real owners by RequireRealOwner. */
export function WorkData() {
  const es = useLanguage().lang === "es";
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, signInGeneration);
  const online = useSyncExternalStore(subscribeNetwork, () => navigator.onLine, () => false);
  if (!online) return <div className="page">
    <h1>{es ? "Datos" : "Data"}</h1>
    <p>{es ? "Conéctate a Internet para ver los informes." : "Connect to the internet to view reports."}</p>
  </div>;
  return <DataComparison key={generation} />;
}
