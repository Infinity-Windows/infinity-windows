import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  confirmInstallMemo,
  getMyProfile,
  listMemosToConfirm,
} from "../lib/install/api";
import { MEMO_TOPICS, type InstallEvent, type MemoTopics } from "../lib/install/types";

function MemoRow({ event, onDone }: { event: InstallEvent; onDone: () => void }) {
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
        {event.created_at.slice(0, 10)} · AI-filled from your voice memo — fix
        anything, then confirm.
      </p>
      {MEMO_TOPICS.map((t) => (
        <div key={t.key}>
          <label className="field-label">{t.prompt}</label>
          <input
            value={fields[t.key] ?? ""}
            onChange={(e) =>
              setFields({ ...fields, [t.key]: e.target.value || null })
            }
          />
        </div>
      ))}
      <button
        className="primary big"
        disabled={confirm.isPending}
        onClick={() => confirm.mutate()}
      >
        {confirm.isPending ? "Saving…" : "Confirm memo"}
      </button>
    </li>
  );
}

export function MemoReview() {
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
          <h1>Review AI memos</h1>
          <p className="muted" style={{ margin: 0 }}>
            Confirm fields so the brain gets smarter.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="My work">‹</Link>
      </header>
      <p className="muted">
        The AI split your voice memos into fields. A quick confirm makes the
        brain smarter for the next installer.
      </p>
      <ul className="unit-list">
        {(memos.data ?? []).map((e) => (
          <MemoRow key={e.id} event={e} onDone={refresh} />
        ))}
        {memos.data?.length === 0 && (
          <p className="muted">Nothing to review — all caught up.</p>
        )}
      </ul>
    </div>
  );
}
