// Synthetic browser fixture only. Mount the real Data page and authority
// provider; all network reads are intercepted by the dedicated spec.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkData } from "../../src/pages/WorkData";
import { ViewAsRoleProvider } from "../../src/lib/viewAsRole";
import { useViewAsRole, type ViewAsRoleValue } from "../../src/lib/viewAsRoleContext";
import { DesignContext } from "../../src/lib/design/context";
import { LanguageContext } from "../../src/lib/i18n/context";
import { CATALOG } from "../../src/lib/i18n/catalog";
import { translate, type Lang } from "../../src/lib/i18n/translate";
import * as auth from "../../src/lib/signedIn";
import "../../src/index.css";
auth.rememberSignedIn({ user: { id: "00000000-0000-4000-8000-0000000000e2" } });
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
let preview: ViewAsRoleValue;
export function PreviewProbe() { preview = useViewAsRole(); return null; }
const fixture = { qc, auth, preview: () => preview };
declare global { interface Window { dataTotalsFixture: typeof fixture } }
window.dataTotalsFixture = fixture;
export function Harness() {
  const [lang, setLang] = useState<Lang>("en");
  return <QueryClientProvider client={qc}><BrowserRouter><ViewAsRoleProvider><PreviewProbe />
    <DesignContext.Provider value={{ design: "new", choice: "new", masterOn: true, setChoice: () => {} }}>
      <LanguageContext.Provider value={{ lang, t: (key, vars) => translate(CATALOG, lang, key, vars), setLang, needsChoice: false }}>
        <style>{`html,body,#root{margin:0;min-width:0;width:100%}*,*::before,*::after{box-sizing:border-box}.data-fixture-language{margin:12px}`}</style>
        <button className="data-fixture-language" onClick={() => setLang(lang === "en" ? "es" : "en")}>EN/ES</button>
        <Routes><Route path="/e2e/support/data-totals.html" element={<WorkData />} />
          <Route path="/summary" element={<div>Summary destination<Link to="/e2e/support/data-totals.html">Return to Data</Link></div>} />
        </Routes>
      </LanguageContext.Provider>
    </DesignContext.Provider>
  </ViewAsRoleProvider></BrowserRouter></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
