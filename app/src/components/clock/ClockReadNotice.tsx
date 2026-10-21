import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";
import "../../lib/i18n/clockReadCatalog";
import type { ClockReadState } from "../../lib/clockReadState";

export function ClockReadNotice({ state, onRetry, savedOffClock = false, onNavigate }: {
  state: ClockReadState;
  onRetry: () => void;
  savedOffClock?: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const saved = state.status === "saved";
  return (
    <section className="card" role="status" data-testid="clock-read-notice" aria-busy={state.checking}
      style={{ padding: 16, overflowWrap: "anywhere", width: "100%", minWidth: 0 }}>
      <h3 style={{ margin: "0 0 8px" }}>
        {t(saved ? "clockRead.saved" : state.checking ? "clockRead.checking" : "clockRead.unavailable")}
      </h3>
      <p className="muted">{t(saved ? savedOffClock ? "clockRead.savedOffBody" : "clockRead.savedBody"
        : state.checking ? "clockRead.checkingBody" : "clockRead.body")}</p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="button-like" disabled={state.checking} onClick={onRetry}>
          {t(state.checking ? "clockRead.checking" : "clockRead.retry")}
        </button>
        {!saved && !state.checking && <Link to="/diagnostics" onClick={onNavigate}>{t("clockRead.diagnostics")}</Link>}
      </div>
    </section>
  );
}
