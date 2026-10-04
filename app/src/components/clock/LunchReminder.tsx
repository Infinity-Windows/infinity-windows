import { useEffect, useState } from "react";
import { UtensilsCrossed } from "lucide-react";
import { lunchReminder } from "../../lib/lunchReminder";
import { notifyLocal } from "../../lib/permissions/notifyLocal";
import { signInGeneration } from "../../lib/signedIn";
import { useT } from "../../lib/i18n";
import type { TimeShift } from "../../lib/timeclock";
export function LunchReminder({
  shift,
  onOpen,
}: {
  shift: TimeShift | null;
  onOpen: () => void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 10_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const due = lunchReminder(shift, now);
  const tag = due?.tag;
  useEffect(() => {
    if (tag)
      void notifyLocal({
        title: t("lunch.title"),
        body: t("lunch.body"),
        tag,
        url: "/clock",
      });
  }, [tag, t]);
  if (!due || !shift) return null;
  return (
    <div className="lunch-reminder" role="status">
      <UtensilsCrossed size={22} aria-hidden />
      <div>
        <strong>{t("lunch.title")}</strong>
        <p>{t("lunch.body")}</p>
      </div>
      <button className="primary" onClick={onOpen}
        data-focus-return-key={`clock-lunch:${shift.profile_id}:${signInGeneration()}:${shift.id}`}>
        {t("lunch.open")}
      </button>
    </div>
  );
}
