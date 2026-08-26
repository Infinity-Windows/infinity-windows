// The warehouse day recap (owner pick 26): "Today — 63 checked in, 41
// stored, 3 checked out, 2 still missing from Tech Ridge truck" — the day's
// story, read off the movement log rather than typed by anyone. Count-first
// W2 style (.wh-count numbers), stage-chip colors where a stage is named —
// the same four tokens the stage-chip pills already use, referenced
// directly rather than wrapped in a pill, so the card reads as one sentence.
import { Fragment } from "react";
import { EmptyState } from "../ui/States";
import { isRecapQuiet, type DayRecap } from "../../lib/warehouse/dayRecap";

interface Part {
  key: string;
  count: number;
  label: string;
  colorVar: string;
}

export function DayRecapCard({ recap }: { recap: DayRecap }) {
  if (isRecapQuiet(recap)) {
    return (
      <section className="wh-day-recap">
        <h2>Today</h2>
        <EmptyState title="Quiet so far — nothing moved today." />
      </section>
    );
  }

  const parts: Part[] = [
    recap.checkedIn > 0
      ? { key: "in", count: recap.checkedIn, label: "checked in", colorVar: "var(--stage-arrived)" }
      : null,
    recap.stored > 0
      ? { key: "stored", count: recap.stored, label: "stored", colorVar: "var(--stage-stored)" }
      : null,
    recap.checkedOut > 0
      ? { key: "out", count: recap.checkedOut, label: "checked out", colorVar: "var(--stage-out)" }
      : null,
    ...recap.missingByDelivery.map((m) => ({
      key: `missing-${m.label}`,
      count: m.count,
      label: `still missing from ${m.label}`,
      colorVar: "var(--stage-expected)",
    })),
  ].filter((p): p is Part => p !== null);

  return (
    <section className="wh-day-recap">
      <div className="detail-card wh-card">
        <h2 style={{ margin: "0 0 6px" }}>Today</h2>
        <p style={{ margin: 0 }}>
          {parts.map((p, i) => (
            <Fragment key={p.key}>
              {i > 0 ? ", " : ""}
              <span className="wh-count" style={{ color: p.colorVar }}>
                {p.count}
              </span>{" "}
              {p.label}
            </Fragment>
          ))}
          .
        </p>
      </div>
    </section>
  );
}
