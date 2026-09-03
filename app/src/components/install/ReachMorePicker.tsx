// Reach more people (job-level-summons slice 4): a job-level call for hands
// rings the crew already clocked into that job by default. This opt-in picker
// is how the summoner adds anyone else — someone on the clock on a DIFFERENT
// job (shown with the job they're on, so you know who you're pulling), or,
// through the search, anyone at all even off the clock.
//
// Controlled: the chosen extra ids live on the parent (CallForHandsPanel), so
// the same list feeds the push. This component only decides who's offered and
// toggles membership; the audience math (dedupe, drop the caller) is
// callForHandsTargets, tested on its own.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listClockedInAnywhere } from "../../lib/install/summons";
import { listProfiles } from "../../lib/install/api";
import { useT } from "../../lib/i18n";

export function ReachMorePicker({
  callerId,
  sameJobIds,
  selected,
  onChange,
}: {
  callerId: string | null;
  sameJobIds: readonly string[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const [term, setTerm] = useState("");

  const clockedIn = useQuery({
    queryKey: ["clockedInAnywhere"],
    queryFn: listClockedInAnywhere,
    refetchInterval: 30_000,
  });
  // Only fetch the full roster once the summoner is actually searching — the
  // default list is the clocked-in crew, and a search is the only reason to
  // reach an off-the-clock name.
  const q = term.trim().toLowerCase();
  const profiles = useQuery({
    queryKey: ["profilesAll"],
    queryFn: listProfiles,
    enabled: q.length > 0,
  });

  // Already getting the call: the same-job crew (the default audience) and the
  // caller. They are not offered here — adding them changes nothing.
  const already = useMemo(() => {
    const s = new Set<string>(sameJobIds);
    if (callerId) s.add(callerId);
    return s;
  }, [sameJobIds, callerId]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = (id: string) => {
    if (selectedSet.has(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  const elsewhere = (clockedIn.data ?? []).filter((p) => !already.has(p.profileId));
  const clockedInIds = useMemo(
    () => new Set((clockedIn.data ?? []).map((p) => p.profileId)),
    [clockedIn.data],
  );
  // Search hits: anyone by name, minus who's already offered above and the
  // same-job crew and the caller.
  const searchHits =
    q.length === 0
      ? []
      : (profiles.data ?? [])
          .filter(
            (p) =>
              !already.has(p.id) &&
              !clockedInIds.has(p.id) &&
              (p.display_name ?? "").toLowerCase().includes(q),
          )
          .slice(0, 8);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of clockedIn.data ?? []) {
      m.set(p.profileId, p.displayName ?? t("callhands.reach.someone"));
    }
    for (const p of profiles.data ?? []) {
      m.set(p.id, p.display_name ?? t("callhands.reach.someone"));
    }
    return m;
  }, [clockedIn.data, profiles.data, t]);

  return (
    <div className="detail-card" style={{ marginTop: 8, textAlign: "left" }}>
      <span className="field-label" style={{ margin: 0 }}>
        {t("callhands.reach.title")}
      </span>
      <p className="muted" style={{ margin: "4px 0 8px", fontSize: 12.5 }}>
        {t("callhands.reach.hint")}
      </p>

      {/* The people already chosen, as removable chips. */}
      {selected.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <span className="field-label" style={{ margin: 0 }}>
            {t("callhands.reach.chosen", { count: selected.length })}
          </span>
          <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 6 }}>
            {selected.map((id) => (
              <button
                key={id}
                className="button-like active-pill studio-mini"
                onClick={() => toggle(id)}
              >
                {nameById.get(id) ?? t("callhands.reach.someone")} ✕
              </button>
            ))}
          </div>
        </div>
      )}

      <span className="field-label" style={{ margin: "4px 0 0", display: "block" }}>
        {t("callhands.reach.onClockNow")}
      </span>
      {elsewhere.length === 0 ? (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
          {t("callhands.reach.nobodyElse")}
        </p>
      ) : (
        <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none" }}>
          {elsewhere.map((p) => (
            <li
              key={p.profileId}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{p.displayName ?? t("callhands.reach.someone")}</strong>{" "}
                {p.jobCode && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {t("callhands.reach.onJob", { job: p.jobCode })}
                  </span>
                )}
              </span>
              <button
                className={
                  selectedSet.has(p.profileId)
                    ? "button-like active-pill studio-mini"
                    : "button-like studio-mini"
                }
                onClick={() => toggle(p.profileId)}
              >
                {selectedSet.has(p.profileId)
                  ? t("callhands.reach.remove")
                  : t("callhands.reach.add")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        type="text"
        placeholder={t("callhands.reach.search")}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        style={{ width: "100%", marginTop: 8 }}
        aria-label={t("callhands.reach.search")}
      />
      {searchHits.length > 0 && (
        <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none" }}>
          {searchHits.map((p) => (
            <li
              key={p.id}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{p.display_name}</strong>{" "}
                <span className="muted" style={{ fontSize: 12 }}>
                  {t("callhands.reach.offClock")}
                </span>
              </span>
              <button
                className={
                  selectedSet.has(p.id)
                    ? "button-like active-pill studio-mini"
                    : "button-like studio-mini"
                }
                onClick={() => toggle(p.id)}
              >
                {selectedSet.has(p.id)
                  ? t("callhands.reach.remove")
                  : t("callhands.reach.add")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
