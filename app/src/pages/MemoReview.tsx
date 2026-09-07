import { BackChip } from "../components/BackChip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  confirmInstallMemo,
  getMyProfile,
  listMemosToConfirm,
} from "../lib/install/api";
import { MEMO_TOPICS, type InstallEvent, type MemoTopics } from "../lib/install/types";
import { useT, type TKey } from "../lib/i18n";

// MEMO_TOPICS is shared with OpeningSheet.tsx and TypeBrainCard.tsx (both
// out of this sweep's scope) and its own `prompt` strings are English-only —
// this maps each topic's key to a translated label for THIS screen only,
// without touching the shared constant or its other two callers.
const TOPIC_KEY: Record<keyof MemoTopics, TKey> = {
  difficulty: "memoReview.topic.difficulty",
  went_well: "memoReview.topic.wentWell",
  went_poorly: "memoReview.topic.wentPoorly",
  obstacles: "memoReview.topic.obstacles",
  tools_helped: "memoReview.topic.toolsHelped",
  time_vs_estimate: "memoReview.topic.timeVsEstimate",
  safety_notes: "memoReview.topic.safetyNotes",
  do_again: "memoReview.topic.doAgain",
};

function MemoRow({ event, onDone }: { event: InstallEvent; onDone: () => void }) {
  const t = useT();
  const [fields, setFields] = useState<Partial<MemoTopics>>({
    difficulty: event.difficulty,
    went_well: event.went_well,
    went_poorly: event.went_poorly,
    obstacles: event.obstacles,
    tools_helped: event.tools_helped,
    time_vs_estimate: event.time_vs_estimate,
    safety_notes: event.safety_notes,
    do_again: event.do_again,
  });
  const confirm = useMutation({
    mutationFn: () => confirmInstallMemo(event.id, fields),
    onSuccess: onDone,
  });

  return (
    <li className="detail-card">
      <p className="muted" style={{ marginTop: 0 }}>
        {t("memoReview.aiFilled", { date: event.created_at.slice(0, 10) })}
      </p>
      {MEMO_TOPICS.map((topic) => (
        <div key={topic.key}>
          <label className="field-label">{t(TOPIC_KEY[topic.key])}</label>
          <input
            value={fields[topic.key] ?? ""}
            onChange={(e) =>
              setFields({ ...fields, [topic.key]: e.target.value || null })
            }
          />
        </div>
      ))}
      <button
        className="primary big"
        disabled={confirm.isPending}
        onClick={() => confirm.mutate()}
      >
        {confirm.isPending ? t("memoReview.saving") : t("memoReview.confirmMemo")}
      </button>
    </li>
  );
}

export function MemoReview() {
  const t = useT();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const memos = useQuery({
    queryKey: ["memosToConfirm", me.data?.id],
    queryFn: () => listMemosToConfirm(me.data!.id),
    enabled: Boolean(me.data?.id),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["memosToConfirm"] });
    queryClient.invalidateQueries({ queryKey: ["typeBrain"] });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{t("memoReview.title")}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {t("memoReview.subtitle")}
          </p>
        </div>
        <BackChip fallback="/" label={t("memoReview.myWork")} />
      </header>
      <p className="muted">{t("memoReview.explain")}</p>
      <ul className="unit-list">
        {(memos.data ?? []).map((e) => (
          <MemoRow key={e.id} event={e} onDone={refresh} />
        ))}
        {memos.data?.length === 0 && (
          <p className="muted">{t("memoReview.allCaughtUp")}</p>
        )}
      </ul>
    </div>
  );
}
