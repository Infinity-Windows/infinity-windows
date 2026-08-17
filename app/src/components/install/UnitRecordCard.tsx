// The unit Record (CONTEXT.md): everything the field saved on this window,
// read back — every install round with its media, memo and grade, the
// session timeline, the flashing photo. Visible to every role: raw facts
// about one window are the job's history, not a comparison. AI content is
// always labelled as AI. Media is signed lazily, only once opened.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listProfiles } from "../../lib/install/api";
import type { OpeningPhase } from "../../lib/install/phases";
import {
  buildTimeline,
  filledTopics,
  groupRounds,
  listInstallMedia,
  listOpeningInstallEvents,
  listOpeningRedos,
  signedPhasePhoto,
  type RecordRound,
} from "../../lib/install/record";
import { listOpeningSessions } from "../../lib/install/sessions";

function shortStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function UnitRecordCard({
  openingId,
  flashing,
}: {
  openingId: string;
  flashing: OpeningPhase | null;
}) {
  const [open, setOpen] = useState(false);

  // Cheap always-on probe: does this window have a story yet? Rounds exist
  // on installed windows AND on sent-back ones — history matters most there.
  const events = useQuery({
    queryKey: ["recordEvents", openingId],
    queryFn: () => listOpeningInstallEvents(openingId),
  });

  const sessions = useQuery({
    queryKey: ["openingSessions", openingId],
    queryFn: () => listOpeningSessions(openingId),
    enabled: open,
  });
  const redos = useQuery({
    queryKey: ["openingRedos", openingId],
    queryFn: () => listOpeningRedos(openingId),
    enabled: open,
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: listProfiles,
    enabled: open,
    staleTime: 300_000,
  });
  const media = useQuery({
    queryKey: ["recordMedia", openingId, (events.data ?? []).length],
    queryFn: () => listInstallMedia((events.data ?? []).map((e) => e.id)),
    enabled: open && (events.data?.length ?? 0) > 0,
  });
  const flashPhoto = useQuery({
    queryKey: ["phasePhoto", flashing?.id, flashing?.photo_path],
    queryFn: () => signedPhasePhoto(flashing?.photo_path ?? ""),
    enabled: open && Boolean(flashing?.photo_path),
  });

  const hasStory =
    (events.data?.length ?? 0) > 0 || (sessions.data?.length ?? 0) > 0;
  if (!events.isLoading && !hasStory) return null;

  const nameOf = (id: string) =>
    (profiles.data ?? []).find((p) => p.id === id)?.display_name;
  const rounds = groupRounds(events.data ?? [], media.data ?? []);
  const timeline = buildTimeline(sessions.data ?? [], redos.data ?? [], nameOf);

  return (
    <div className="detail-card">
      {!open ? (
        <button className="button-like" onClick={() => setOpen(true)}>
          📖 Record — everything saved on this window
        </button>
      ) : (
        <>
          <span className="field-label">Record</span>
          <p className="muted" style={{ margin: "2px 0 8px", fontSize: 12.5 }}>
            Read straight from what the crew saved — nothing here is typed twice.
          </p>

          {rounds.map((r) => (
            <RoundBlock key={r.event.id} round={r} many={rounds.length > 1} />
          ))}

          {flashing?.status === "submitted" && (
            <div style={{ marginTop: 10 }}>
              <span className="field-label">Flashing</span>
              <p className="muted" style={{ margin: "2px 0 4px", fontSize: 12.5 }}>
                Done{flashing.minutes != null ? ` · ${flashing.minutes}m` : ""}
              </p>
              {flashPhoto.data && (
                <img
                  src={flashPhoto.data}
                  alt="Finished flashing"
                  style={{ maxWidth: "100%", borderRadius: 8, maxHeight: 240 }}
                />
              )}
            </div>
          )}

          {timeline.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <span className="field-label">Timeline</span>
              <ul className="unit-list" style={{ marginTop: 4 }}>
                {timeline.map((row, i) => (
                  <li
                    key={i}
                    className="muted"
                    style={{
                      fontSize: 12.5,
                      color: row.kind === "block" ? "#fbbf24" : undefined,
                    }}
                  >
                    {shortStamp(row.at)} · {row.text}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            className="button-like"
            style={{ marginTop: 10 }}
            onClick={() => setOpen(false)}
          >
            Close record
          </button>
        </>
      )}
    </div>
  );
}

function RoundBlock({ round, many }: { round: RecordRound; many: boolean }) {
  const e = round.event;
  const topics = filledTopics(e);
  const photos = round.media.filter((m) => m.kind === "photo" && m.signedUrl);
  const video = round.media.find((m) => m.kind === "video" && m.signedUrl);
  const memo = round.media.find((m) => m.kind === "voice_memo" && m.signedUrl);

  return (
    <div
      style={{
        marginTop: 8,
        paddingTop: 8,
        borderTop: "1px solid rgba(128,128,128,0.25)",
      }}
    >
      <p style={{ margin: 0, fontSize: 13 }}>
        {many && <strong>Round {round.number} — </strong>}
        {e.voided_at ? (
          <span style={{ color: "#fbbf24" }}>
            sent back: “{e.void_reason ?? "no reason recorded"}”
            {e.voider?.display_name ? ` (${e.voider.display_name})` : ""}
          </span>
        ) : (
          <span className="ok">{many ? "current" : "Installed"}</span>
        )}
        <span className="muted">
          {" · "}
          {shortStamp(e.created_at)}
          {e.installer ? ` · ${e.installer}` : ""}
          {e.minutes != null ? ` · ${e.minutes}m` : ""}
          {e.quality_grade != null
            ? ` · self-graded ${"★".repeat(e.quality_grade)}`
            : ""}
        </span>
      </p>

      {photos.length > 0 && (
        <div className="row-gap" style={{ marginTop: 6, flexWrap: "wrap" }}>
          {photos.map((m) => (
            <a key={m.id} href={m.signedUrl!} target="_blank" rel="noreferrer">
              <img
                src={m.signedUrl!}
                alt="Install"
                style={{ height: 84, borderRadius: 6 }}
              />
            </a>
          ))}
        </div>
      )}
      {video && (
        <video
          controls
          preload="metadata"
          src={video.signedUrl!}
          style={{ maxWidth: "100%", borderRadius: 8, marginTop: 6, maxHeight: 240 }}
        />
      )}
      {memo && (
        <div style={{ marginTop: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Voice memo</span>
          <audio controls preload="none" src={memo.signedUrl!} style={{ width: "100%" }} />
        </div>
      )}

      {topics.length > 0 && (
        <ul className="unit-list" style={{ marginTop: 6 }}>
          {topics.map((t) => (
            <li key={t.prompt} style={{ fontSize: 12.5 }}>
              <span className="muted">{t.prompt}:</span> {t.text}
            </li>
          ))}
        </ul>
      )}

      {(e.photo_findings?.length ?? 0) > 0 && (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
          <strong>AI noticed (from the photos):</strong>{" "}
          {e.photo_findings!.join(" · ")}
        </p>
      )}

      {e.transcript_raw && (
        <details style={{ marginTop: 6 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
            Raw transcript (AI-transcribed — the memo above is the split)
          </summary>
          <p className="muted" style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
            {e.transcript_raw}
          </p>
        </details>
      )}
    </div>
  );
}
