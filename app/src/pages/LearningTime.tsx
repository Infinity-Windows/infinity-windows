// Learning time, the owner's view (L3). "How long they spend in the learning
// tab and on what item" — one line per person, most time first, with the
// lessons they watched underneath.
//
// TWO NUMBERS THAT LOOK ALIKE AND ARE NOT. The person's total is the time the
// Learn page itself was open; the breakdown under it is the SAME minutes named
// more precisely (a glossary term is time on the Glossary tab). They are shown
// as an inside-of, never as a sum, and the page says so out loud — a table
// whose parts add up to more than its total is a table nobody trusts twice.
//
// AND ON EVERY LESSON, the percentage sits beside the verdict. "Finished" can
// be had by dragging to the last second, so an owner reading "finished · 4%"
// knows exactly what they are looking at. See videoWatch.ts.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BackChip } from "../components/BackChip";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { useT } from "../lib/i18n";
import { formatLearningTime } from "../lib/learningTime";
import {
  foldByPerson,
  listLearningTime,
  listLearningVideoWatches,
  type LearningRange,
  type LearningVideoRow,
  type PersonLearning,
} from "../lib/learningTimeReport";
import { watchPercent } from "../lib/videoWatch";

const RANGES: LearningRange[] = ["week", "four-weeks", "all"];

/** A day a person would recognise, or nothing at all for a missing stamp. */
function dayLabel(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function LearningTime() {
  const t = useT();
  const [range, setRange] = useState<LearningRange>("week");
  const [byName, setByName] = useState(false);

  const time = useQuery({
    queryKey: ["learningTimeReport", range],
    queryFn: () => listLearningTime(range),
  });
  const videos = useQuery({
    queryKey: ["learningVideoReport", range],
    queryFn: () => listLearningVideoWatches(range),
  });

  const people = useMemo(
    () => foldByPerson(time.data ?? [], videos.data ?? []),
    [time.data, videos.data],
  );
  const ordered = useMemo(
    () =>
      byName
        ? [...people].sort((a, b) => a.displayName.localeCompare(b.displayName))
        : people,
    [people, byName],
  );

  const loading = time.isLoading || videos.isLoading;
  const failed = time.isError ? time.error : videos.isError ? videos.error : null;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{t("ltime.section")}</p>
          <h1>{t("ltime.title")}</h1>
        </div>
        <BackChip fallback="/" label={t("ltime.back")} />
      </header>

      <p className="muted">{t("ltime.blurb")}</p>

      <nav className="hub-tabs" aria-label={t("ltime.range.aria")}>
        {RANGES.map((r) => (
          <button
            key={r}
            className={range === r ? "hub-tab active" : "hub-tab"}
            onClick={() => setRange(r)}
          >
            {r === "week"
              ? t("ltime.range.week")
              : r === "four-weeks"
                ? t("ltime.range.fourWeeks")
                : t("ltime.range.all")}
          </button>
        ))}
      </nav>

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0 12px" }}>
        <button className="button-like" onClick={() => setByName((v) => !v)}>
          {byName ? t("ltime.sort.name") : t("ltime.sort.time")}
        </button>
      </div>

      {failed && (
        <QueryError
          error={failed}
          label={t("ltime.loadError")}
          onRetry={() => {
            void time.refetch();
            void videos.refetch();
          }}
        />
      )}
      {loading && <SkeletonList rows={4} />}

      {!loading && !failed && ordered.length === 0 && (
        <EmptyState title={t("ltime.empty.title")} message={t("ltime.empty.body")} />
      )}

      {!loading &&
        !failed &&
        ordered.map((person) => (
          <PersonCard key={person.profileId} person={person} />
        ))}
    </div>
  );
}

function PersonCard({ person }: { person: PersonLearning }) {
  const t = useT();
  const kinds: { kind: string; label: string }[] = [
    { kind: "term", label: t("ltime.kind.term") },
    { kind: "quiz", label: t("ltime.kind.quiz") },
    { kind: "sequence", label: t("ltime.kind.sequence") },
    { kind: "video", label: t("ltime.kind.video") },
  ];
  const parts = kinds.filter((k) => (person.byKind[k.kind] ?? 0) > 0);

  return (
    <div className="project-card" style={{ padding: 12, marginBottom: 10 }}>
      <div className="home-project-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{person.displayName}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {person.lastSeenAt
              ? t("ltime.last", { when: dayLabel(person.lastSeenAt) })
              : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="next-code" style={{ margin: 0 }}>
            {formatLearningTime(person.totalSeconds)}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{t("ltime.inLearn")}</div>
        </div>
      </div>

      {parts.length > 0 && (
        <>
          <div className="data-chips">
            {parts.map((k) => (
              <span key={k.kind} className="data-chip">
                {k.label} <strong>{formatLearningTime(person.byKind[k.kind])}</strong>
              </span>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
            {t("ltime.breakdownNote")}
          </p>
        </>
      )}

      {person.videos.length > 0 && (
        <>
          <p className="field-label" style={{ marginTop: 12 }}>{t("ltime.lessons")}</p>
          <ul className="unit-list">
            {person.videos.map((v) => (
              <VideoLine key={v.videoId} row={v} />
            ))}
          </ul>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            {t("ltime.watchNote")}
          </p>
        </>
      )}
    </div>
  );
}

function VideoLine({ row }: { row: LearningVideoRow }) {
  const t = useT();
  const known = row.durationSeconds !== null && row.durationSeconds > 0;
  const overall = watchPercent(row.unionSeconds, row.durationSeconds);
  const best = watchPercent(row.bestSeconds, row.durationSeconds);

  return (
    <li>
      <strong>{row.videoTitle}</strong>
      <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
        {t("ltime.timesWatched", { count: row.timesWatched })}
        {" · "}
        {known
          ? `${t("ltime.percentAll", { percent: overall })} · ${t("ltime.percentBest", { percent: best })}`
          : t("ltime.lengthUnknown", { time: formatLearningTime(row.unionSeconds) })}
        {" · "}
        {row.completed ? (
          <span className="ok">{t("ltime.finished")}</span>
        ) : (
          t("ltime.notFinished")
        )}
        {row.lastWatchedAt ? ` · ${t("ltime.last", { when: dayLabel(row.lastWatchedAt) })}` : ""}
      </p>
    </li>
  );
}
