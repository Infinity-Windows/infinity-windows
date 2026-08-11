import { BackChip } from "../components/BackChip";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isOwner } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { pushToast, toastError } from "../lib/toast";
import {
  budgetHeadline,
  budgetPct,
  formatCents,
  formatMicros,
  loadAiSpendOverview,
  saveAiSpendLimits,
  worstCasePerUserPerDay,
} from "../lib/aiSpend";

/**
 * The AI spend screen. This is a business owner's dashboard, not an ops console:
 * it answers "is this costing me anything, and can it surprise me?" in the first
 * sentence, and then gives an owner the two numbers they can change.
 *
 * The cap itself is enforced in the database, not here — see
 * docs/ai-spend-limits.md. Nothing on this screen is a control; it is a window
 * onto one, so a crew member who reaches the URL can only read.
 */
export function AiSpend() {
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const canOpen = isOwner(effectiveRole);

  const overview = useQuery({
    queryKey: ["aiSpendOverview"],
    queryFn: loadAiSpendOverview,
    enabled: canOpen,
  });

  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");

  // Seed the two editable fields from the server once they arrive, so the boxes
  // always start at the real live values rather than at a guess.
  const limits = overview.data?.limits;
  useEffect(() => {
    if (!limits) return;
    setDaily(String(limits.per_user_daily_calls));
    setMonthly(String(Math.round(limits.monthly_cap_cents / 100)));
  }, [limits]);

  const save = useMutation({
    mutationFn: () =>
      saveAiSpendLimits({
        perUserDailyCalls: Number(daily),
        monthlyCapCents: Math.round(Number(monthly) * 100),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["aiSpendOverview"], data);
      pushToast("Limits saved", "info");
    },
    onError: (e) => toastError(e),
  });

  if (!canOpen) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>AI spend</h1>
          <BackChip fallback="/" label="Home" />
        </header>
        <p className="muted">
          What the assistant costs is the owner's business. Nothing you do is
          being limited by this screen.
        </p>
      </div>
    );
  }

  const data = overview.data;
  const month = data?.month;
  const pct = month ? budgetPct(month) : 0;
  const capped = pct >= 100 && Boolean(limits?.enforced);
  const dirty =
    Boolean(limits) &&
    (Number(daily) !== limits!.per_user_daily_calls ||
      Math.round(Number(monthly) * 100) !== limits!.monthly_cap_cents);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>AI spend</h1>
          <p className="muted" style={{ margin: 0 }}>
            What the assistant costs, and the limits that stop it running away.
          </p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      {overview.isLoading && <p className="muted">Reading the meter…</p>}
      {overview.isError && (
        <p className="muted">
          Couldn't read the spend meter. The limits are still being enforced —
          this screen is only the view.
        </p>
      )}

      {data && month && limits && (
        <>
          {/* The headline: the answer, before any numbers. */}
          <div className="detail-card" style={{ display: "grid", gap: 10 }}>
            <p style={{ margin: 0, fontSize: "1.05rem" }}>
              {budgetHeadline(month, limits.enforced)}
            </p>
            <div
              aria-hidden
              style={{
                height: 10,
                borderRadius: 999,
                background: "rgba(148,163,184,0.25)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, pct)}%`,
                  height: "100%",
                  background: capped
                    ? "#f87171"
                    : pct >= 80
                      ? "#fbbf24"
                      : "#34d399",
                }}
              />
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {formatMicros(month.spent_micros)} of{" "}
              {formatCents(limits.monthly_cap_cents)} this month
              {month.calls > 0 ? ` · ${month.calls} AI calls` : ""}
            </p>
            {capped && (
              <p style={{ margin: 0 }}>
                Crew are not blocked. Every question is being answered from the
                company's own written notes instead of the AI.
              </p>
            )}
          </div>

          {/* The two numbers an owner can change. */}
          <div className="detail-card" style={{ display: "grid", gap: 12 }}>
            <label className="field-label">The limits</label>

            <div style={{ display: "grid", gap: 4 }}>
              <label htmlFor="ai-daily">Questions per person per day</label>
              <input
                id="ai-daily"
                type="number"
                min={0}
                inputMode="numeric"
                value={daily}
                disabled={!data.can_edit}
                onChange={(e) => setDaily(e.target.value)}
              />
              <p className="muted" style={{ margin: 0 }}>
                The heaviest real user asks about 20 a day, so {limits.per_user_daily_calls}{" "}
                leaves plenty of room. It also means one account — even a stolen
                one — can never spend more than{" "}
                {formatMicros(worstCasePerUserPerDay(limits.per_user_daily_calls))} in
                a day.
              </p>
            </div>

            <div style={{ display: "grid", gap: 4 }}>
              <label htmlFor="ai-monthly">Company ceiling for the month ($)</label>
              <input
                id="ai-monthly"
                type="number"
                min={0}
                inputMode="numeric"
                value={monthly}
                disabled={!data.can_edit}
                onChange={(e) => setMonthly(e.target.value)}
              />
              <p className="muted" style={{ margin: 0 }}>
                A busy month of normal use is $17–$115. Above the ceiling, the app
                keeps answering from the company brain and stops paying.
              </p>
            </div>

            <p className="muted" style={{ margin: 0 }}>
              The AI answer path is for {limits.min_role}s and above. Installers
              always get the company brain, which is free and works with no
              signal.
            </p>

            {data.can_edit ? (
              <button
                className="primary"
                disabled={save.isPending || !dirty}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save limits"}
              </button>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Only an owner can change these.
              </p>
            )}
          </div>

          {/* Who is using it. */}
          <div className="detail-card" style={{ display: "grid", gap: 8 }}>
            <label className="field-label">Who's using it this month</label>
            {data.people.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Nobody has used the AI assistant this month.
              </p>
            ) : (
              data.people.map((p) => (
                <div
                  key={p.user_id ?? p.display_name}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "baseline",
                  }}
                >
                  <span>
                    {p.display_name}
                    <span className="muted"> · {p.role}</span>
                  </span>
                  <span className="muted" style={{ textAlign: "right" }}>
                    {formatMicros(p.cost_micros)} · {p.calls} calls
                    {p.calls_today > 0
                      ? ` · ${p.calls_today}/${limits.per_user_daily_calls} today`
                      : ""}
                    {p.blocked > 0 ? ` · ${p.blocked} turned away` : ""}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Where the money went. */}
          {data.functions.length > 0 && (
            <div className="detail-card" style={{ display: "grid", gap: 8 }}>
              <label className="field-label">Where it went</label>
              {data.functions.map((f) => (
                <div
                  key={f.function_name}
                  style={{ display: "flex", justifyContent: "space-between", gap: 12 }}
                >
                  <span>{FUNCTION_LABELS[f.function_name] ?? f.function_name}</span>
                  <span className="muted">
                    {formatMicros(f.cost_micros)} · {f.calls} calls
                  </span>
                </div>
              ))}
            </div>
          )}

          {data.alerts.length > 0 && (
            <div className="detail-card" style={{ display: "grid", gap: 6 }}>
              <label className="field-label">Alerts this month</label>
              {data.alerts.map((a) => (
                <p key={a.level} className="muted" style={{ margin: 0 }}>
                  {a.level === "cap"
                    ? "The ceiling was reached"
                    : "The budget passed 80%"}{" "}
                  on {new Date(a.created_at).toLocaleDateString()}.
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Plain-English names, because "extract-specs" means nothing to an owner. */
const FUNCTION_LABELS: Record<string, string> = {
  ask: "Crew questions (Ask)",
  "extract-specs": "Reading spec sheets",
  "extract-schedule": "Reading window schedules",
  "generate-toolbox-talk": "Safety talks",
  "synthesize-type-tips": "Writing install tips",
  "generate-howto": "Writing how-tos",
  "transcribe-install-memo": "Transcribing voice memos",
  "ingest-knowledge": "Indexing company notes",
};
