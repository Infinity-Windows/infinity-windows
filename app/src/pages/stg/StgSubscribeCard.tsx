// Wave S, S6 (STRETCH, shipped partial). The table + self-service RPCs
// (create_calendar_feed_token / revoke_calendar_feed_token,
// 20260953000000_calendar_feed_tokens.sql) are live; no edge function
// serves the actual iCal feed yet, because that half needs config/secrets
// this sandbox has no live Supabase project to verify against. Rather than
// hand out a link that would 404 the moment a calendar app tried it, this
// card shows the affordance and says plainly that it isn't ready — the
// spec's own explicit fallback for exactly this situation. Deliberately
// does not call either RPC: there is nothing useful to do with a token
// while nothing can redeem one yet.
import { Copy } from "lucide-react";

export function StgSubscribeCard() {
  return (
    <div className="detail-card" style={{ marginTop: 16 }}>
      <p style={{ fontWeight: 650, margin: "0 0 4px" }}>Subscribe from your own calendar</p>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
        See your install windows and deliveries in your phone or work calendar automatically.
      </p>
      <button type="button" className="button-like" disabled aria-disabled="true">
        <Copy size={14} aria-hidden style={{ marginRight: 6 }} />
        Copy subscribe link
      </button>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
        Coming shortly — we&apos;ll let you know when this is ready.
      </p>
    </div>
  );
}
