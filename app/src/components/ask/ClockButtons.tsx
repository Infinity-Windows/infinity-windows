import { useState } from "react";
import { useIsRestoring } from "@tanstack/react-query";
import { useFieldT as useT, type TKey } from "./fieldCatalog";
import { openClockGlobally, useClock } from "../../lib/clockContext";
import { queryClient } from "../../lib/queryClient";
import { oneTapFits, runOneTap, type OneTapDeps, type OneTapOutcome } from "../../lib/clockOneTap";
import type { ClockBreakType, ClockButton } from "../../../../supabase/functions/_shared/clockButtons";

/**
 * The one-tap buttons a reply offered (K2.4). Shown only when they fit the
 * person's REAL clock state — the AI cannot see whether a queued clock-out is
 * sitting on this phone, the clock context can. After a tap, the line under
 * the button is the receipt: saved in Forge, saved on this phone, or why
 * nothing happened.
 *
 * NOTHING IS SAID ABOUT THE CLOCK UNTIL IT IS KNOWN. While the shared clock
 * state is still being read — who is signed in, the open shift and this
 * phone's own queued punches (useClock().loading, #644), and the saved copy
 * of the app's data coming back off the phone, which react-query reports as
 * idle rather than loading — `shift` is null because it is not read yet, not
 * because nobody is clocked in. A reply restored when Ask opens lands in
 * exactly that moment, and used to say "You're not clocked in" to a person
 * on the clock. Until then: "Checking your clock…" and no button, the same
 * rule Start day follows (WorkScreen.tsx).
 */
export function ClockButtons({ buttons, deps }: { buttons: ClockButton[]; deps?: OneTapDeps }) {
  const t = useT();
  const clock = useClock();
  const restoring = useIsRestoring();
  const clockKnown = Boolean(clock.profileId) && !clock.loading && !restoring;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<OneTapOutcome | null>(null);
  if (!buttons.length) return null;

  const tap = async (button: ClockButton, breakType: ClockBreakType | null) => {
    if (!clockKnown) return;
    setBusy(true);
    try {
      const result = await runOneTap(button, clock.shift, breakType, deps);
      setOutcome(result);
      if (result.kind === "open_clock") openClockGlobally();
      if (result.kind === "done") {
        clock.refresh();
        // The server paused or resumed this person's unit timers with the
        // break (the sessions trigger): re-read them, as the clock sheet does.
        void queryClient.invalidateQueries({ queryKey: ["myActivePhases"] });
      }
    } finally {
      setBusy(false);
    }
  };

  const outcomeText = (o: OneTapOutcome): string => {
    if (o.kind === "done") return t(`field.button.done.${o.action}.${o.queued ? "queued" : "saved"}` as TKey);
    if (o.kind === "open_clock") return t("field.button.openedClock");
    return t(`field.button.refused.${o.reason}` as TKey);
  };

  if (!clockKnown) {
    return (
      <section className="field-card field-buttons" aria-label={t("field.button.title")} aria-busy="true">
        <p role="status" className="muted">{t("field.button.checking")}</p>
      </section>
    );
  }

  return (
    <section className="field-card field-buttons" aria-label={t("field.button.title")}>
      <div className="field-options">
        {buttons.map((b) => {
          const unfit = oneTapFits(b.action, clock.shift);
          if (unfit?.kind === "refused") {
            return (
              <div key={b.action} className="field-button-unfit">
                <p className="muted">{t(`field.button.refused.${unfit.reason}` as TKey)}</p>
                <button type="button" onClick={() => openClockGlobally()}>{t("field.openClock")}</button>
              </div>
            );
          }
          if (b.action === "start_break" && !b.break_type) {
            // The person did not say which break: offer the two common ones.
            return (
              <span key={b.action} className="field-options">
                <button type="button" className="primary" disabled={busy} onClick={() => void tap(b, "lunch")}>{t("field.button.start_lunch")}</button>
                <button type="button" className="primary" disabled={busy} onClick={() => void tap(b, "rest")}>{t("field.button.start_rest")}</button>
              </span>
            );
          }
          return (
            <button key={b.action} type="button" className="primary" disabled={busy} onClick={() => void tap(b, null)}>
              {t(`field.button.${b.action}` as TKey)}
            </button>
          );
        })}
      </div>
      {outcome && <p role="status" className={outcome.kind === "refused" ? "cw-error" : "muted"}>{outcomeText(outcome)}</p>}
    </section>
  );
}
