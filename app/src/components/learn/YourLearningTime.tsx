// The bottom of the Learn page (Learning time, L4): what the app has recorded
// about YOU, said to you, on the same screen that records it.
//
// This is not a nicety. The company is about to read a table of how long each
// person spent learning, and a measure somebody cannot see is a measure they
// cannot argue with. So the person being measured gets the same number first,
// and one plain sentence saying why it is kept and what it does not count.
//
// It says nothing at all if the read fails or the database has not had the
// migration yet: a crew member opening the glossary must never be shown an
// error about telemetry they did not ask for.

import { useQuery } from "@tanstack/react-query";
import { useT } from "../../lib/i18n";
import { formatLearningTime, getMyLearningTime } from "../../lib/learningTime";

export function YourLearningTime({ profileId }: { profileId?: string }) {
  const t = useT();
  const mine = useQuery({
    queryKey: ["myLearningTime", profileId],
    queryFn: () => getMyLearningTime(profileId!),
    enabled: Boolean(profileId),
  });

  const data = mine.data;
  const nothingYet = !data || (data.weekSeconds === 0 && data.videosFinished === 0);

  return (
    <footer className="learn-time-footer">
      <p className="learn-time-line">
        <strong>{t("learn.time.yours")}</strong>{" "}
        {mine.isError || nothingYet ? (
          t("learn.time.none")
        ) : (
          <>
            {t("learn.time.week", { time: formatLearningTime(data.weekSeconds) })}
            {data.videosFinished > 0 && (
              <>
                {" · "}
                {data.videosFinished === 1
                  ? t("learn.time.lessonsOne")
                  : t("learn.time.lessonsMany", { count: data.videosFinished })}
              </>
            )}
          </>
        )}
      </p>
      <p className="muted learn-time-why">{t("learn.time.why")}</p>
    </footer>
  );
}
