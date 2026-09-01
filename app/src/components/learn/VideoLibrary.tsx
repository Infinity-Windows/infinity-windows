// The Learn tab's video library (owner spec): each lesson is a window type
// with a title, the video itself (uploaded or YouTube), and two drop-down
// transcripts — "Transcript Summary" to review the video, "Transcript
// Full" to read along. Supervisors author everything; installers watch.
//
// Wave Q adds the quiz half: a supervisor generates a summary + 5-question
// quiz from the transcript (Generate), reviews it as a draft, and Approves
// & publishes it — only then do crews see a "Take the quiz" button on the
// card. Scoring happens server-side (submit_video_quiz); this file never
// carries a correct answer anywhere near an installer's screen.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listWindowTypes } from "../../lib/api";
import { getMyProfile } from "../../lib/install/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import {
  learningVideoUrl,
  listLearningVideos,
  saveLearningVideo,
  uploadLearningVideo,
  youtubeEmbedUrl,
  type LearningVideo,
} from "../../lib/learnVideos";
import {
  approveVideoQuiz,
  buildAnswers,
  generateVideoQuiz,
  getVideoQuizForAuthor,
  listVideoQuiz,
  myAttemptCount,
  saveVideoQuizDraft,
  shuffleQuiz,
  submitVideoQuiz,
  transcribeLearningVideo,
  type QuizQuestionFull,
  type QuizQuestionPublic,
  type ShuffledQuestion,
  type SubmitVideoQuizResponse,
} from "../../lib/videoQuiz";

function Player({ video }: { video: LearningVideo }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (video.video_path) {
      learningVideoUrl(video.video_path)
        .then((u) => live && setSignedUrl(u))
        .catch(() => live && setSignedUrl(null));
    }
    return () => {
      live = false;
    };
  }, [video.video_path]);

  const embed = video.youtube_url ? youtubeEmbedUrl(video.youtube_url) : null;
  if (embed) {
    return (
      <iframe
        className="learn-video-frame"
        src={embed}
        title={video.title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    );
  }
  if (video.video_path) {
    return signedUrl ? (
      <video className="learn-video-frame" src={signedUrl} controls preload="metadata" />
    ) : (
      <p className="muted">Loading video…</p>
    );
  }
  return <p className="muted">No video attached.</p>;
}

export function VideoLibrary({ canAuthor }: { canAuthor: boolean }) {
  const qc = useQueryClient();
  const videos = useQuery({ queryKey: ["learningVideos"], queryFn: listLearningVideos });
  const types = useQuery({ queryKey: ["windowTypes"], queryFn: listWindowTypes });
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const [editing, setEditing] = useState<LearningVideo | "new" | null>(null);

  const typeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of types.data ?? []) m.set(t.id, t.name || t.type_code);
    return m;
  }, [types.data]);

  return (
    <div>
      {canAuthor && (
        <button className="button-like active-pill" onClick={() => setEditing("new")}>
          Add training video
        </button>
      )}
      {videos.isError && <p className="error">{formatApiError(videos.error)}</p>}

      <div className="home-projects" style={{ marginTop: 8 }}>
        {(videos.data ?? []).map((v) => (
          <div key={v.id} className="project-card" style={{ padding: 12 }}>
            <div className="home-project-head">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{v.title}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {v.window_type_id
                    ? typeName.get(v.window_type_id) ?? "Window type"
                    : v.topic ?? "General"}
                </div>
              </div>
              {canAuthor && (
                <button className="button-like studio-mini" onClick={() => setEditing(v)}>
                  ✎ Edit
                </button>
              )}
            </div>
            <Player video={v} />
            {v.summary && (
              <details>
                <summary className="tcx-label">Transcript Summary</summary>
                <p className="learn-transcript">{v.summary}</p>
              </details>
            )}
            {v.transcript && (
              <details>
                <summary className="tcx-label">Transcript Full</summary>
                <p className="learn-transcript">{v.transcript}</p>
              </details>
            )}
            <TakeQuizCard
              videoId={v.id}
              profileId={me.data?.id ?? null}
              clearanceTypeName={v.grants_clearance ? typeName.get(v.grants_clearance) ?? null : null}
            />
          </div>
        ))}
        {(videos.data ?? []).length === 0 && !videos.isLoading && (
          <p className="muted">
            No training videos yet{canAuthor ? " — add the first one." : "."}
          </p>
        )}
      </div>

      {editing && (
        <VideoForm
          initial={editing === "new" ? null : editing}
          types={(types.data ?? []).map((t) => ({ id: t.id, name: t.name || t.type_code }))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["learningVideos"] });
          }}
        />
      )}
    </div>
  );
}

function VideoForm({
  initial,
  types,
  onClose,
  onSaved,
}: {
  initial: LearningVideo | null;
  types: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [windowTypeId, setWindowTypeId] = useState(initial?.window_type_id ?? "");
  const [topic, setTopic] = useState(initial?.topic ?? "");
  const [youtube, setYoutube] = useState(initial?.youtube_url ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [transcript, setTranscript] = useState(initial?.transcript ?? "");
  const [grantsClearance, setGrantsClearance] = useState(initial?.grants_clearance ?? "");

  const youtubeBad = youtube.trim() !== "" && !youtubeEmbedUrl(youtube);

  const save = useMutation({
    mutationFn: async (retire?: boolean) => {
      let videoPath = initial?.video_path ?? null;
      if (file) videoPath = await uploadLearningVideo(file);
      return saveLearningVideo({
        id: initial?.id ?? null,
        title,
        windowTypeId: windowTypeId || null,
        topic: topic || null,
        videoPath,
        youtubeUrl: youtube || null,
        summary: summary || null,
        transcript: transcript || null,
        active: !retire,
        grantsClearance: grantsClearance || null,
      });
    },
    onSuccess: (_v, retire) => {
      pushToast(retire ? "Video removed from Learn." : "Training video saved.");
      onSaved();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const hasSource = Boolean(file || initial?.video_path || (youtube.trim() && !youtubeBad));

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0, fontWeight: 700 }}>
          {initial ? `Edit ${initial.title}` : "New training video"}
        </p>
        <label className="field-label">Title</label>
        <input
          placeholder="Installing the XO slider"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <label className="field-label">Window type</label>
        <select value={windowTypeId} onChange={(e) => setWindowTypeId(e.target.value)}>
          <option value="">General / other (name it below)</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        {!windowTypeId && (
          <input
            placeholder="Topic, e.g. Corner window sets"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        )}
        <label className="field-label">Video — upload a file…</label>
        <input
          type="file"
          accept="video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <label className="field-label">…or paste a YouTube address</label>
        <input
          placeholder="https://youtu.be/…"
          value={youtube}
          onChange={(e) => setYoutube(e.target.value)}
        />
        {youtubeBad && <p className="error">That doesn't look like a YouTube address.</p>}
        <label className="field-label">Transcript Summary (for reviewing the video)</label>
        <textarea
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <label className="field-label">Transcript Full (to read along)</label>
        <textarea
          rows={6}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
        />
        <label className="field-label">Passing this quiz clears the installer for…</label>
        <select value={grantsClearance} onChange={(e) => setGrantsClearance(e.target.value)}>
          <option value="">Nothing — this video just teaches</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>

        {initial && <QuizAuthoring video={initial} title={title} transcript={transcript} onTranscribed={setTranscript} />}

        <div className="row-gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <button
            className="button-like active-pill"
            disabled={!title.trim() || !hasSource || save.isPending}
            onClick={() => save.mutate(false)}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {initial && (
            <button
              className="button-like"
              style={{ color: "var(--danger, #f87171)" }}
              disabled={save.isPending}
              onClick={() => save.mutate(true)}
            >
              Remove
            </button>
          )}
          <button className="button-like" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The Generate / Transcribe / Approve block, shown only once a video has
 * been saved (a draft/quiz needs a real video id to attach to — save the
 * video first, then reopen it to build its quiz).
 */
function QuizAuthoring({
  video,
  title,
  transcript,
  onTranscribed,
}: {
  video: LearningVideo;
  title: string;
  transcript: string;
  onTranscribed: (t: string) => void;
}) {
  const qc = useQueryClient();
  const quiz = useQuery({
    queryKey: ["videoQuiz", video.id],
    queryFn: () => getVideoQuizForAuthor(video.id),
  });

  const refetchAll = () => {
    void qc.invalidateQueries({ queryKey: ["videoQuiz", video.id] });
    void qc.invalidateQueries({ queryKey: ["learningVideos"] });
    void qc.invalidateQueries({ queryKey: ["videoQuizPublic", video.id] });
  };

  const transcribeM = useMutation({
    mutationFn: () => transcribeLearningVideo(video.id),
    onSuccess: (res) => {
      if (res.transcript) {
        onTranscribed(res.transcript);
        pushToast("Transcribed — review it below, then Generate.");
      } else {
        pushToast(res.note ?? "Nothing came back to transcribe.", "error");
      }
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const generateM = useMutation({
    mutationFn: async () => {
      const res = await generateVideoQuiz(video.id, title, transcript);
      if (!res.generation) return res;
      await saveVideoQuizDraft(video.id, res.generation.summary, res.generation.questions);
      return res;
    },
    onSuccess: (res) => {
      if (res.generation) {
        pushToast("Draft summary and quiz generated — review below, then Approve & publish.");
        refetchAll();
      } else {
        pushToast(res.note ?? "Nothing was generated.", "error");
      }
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const approveM = useMutation({
    mutationFn: () => approveVideoQuiz(video.id),
    onSuccess: () => {
      pushToast("Quiz approved — crews can take it now.");
      refetchAll();
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const q = quiz.data;
  const hasDraft = Boolean(q && q.draft_questions && q.draft_questions.length === 5);
  const canTranscribe = Boolean(video.video_path) && !transcript.trim();

  return (
    <div className="detail-card" style={{ marginTop: 10 }}>
      <p className="field-label" style={{ marginTop: 0 }}>Quiz</p>
      {quiz.isError && <p className="error">{formatApiError(quiz.error)}</p>}

      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        {canTranscribe && (
          <button
            className="button-like"
            disabled={transcribeM.isPending}
            onClick={() => transcribeM.mutate()}
          >
            {transcribeM.isPending ? "Transcribing…" : "Transcribe"}
          </button>
        )}
        <button
          className="button-like active-pill"
          disabled={!transcript.trim() || generateM.isPending}
          onClick={() => generateM.mutate()}
        >
          {generateM.isPending ? "Generating…" : "Generate summary & quiz"}
        </button>
        {hasDraft && (
          <button
            className="button-like active-pill"
            disabled={approveM.isPending}
            onClick={() => approveM.mutate()}
          >
            {approveM.isPending ? "Publishing…" : "Approve & publish"}
          </button>
        )}
      </div>

      {q && q.status === "approved" && (
        <p className="ok" style={{ fontSize: 13 }}>
          Approved and live for crews. Generating again makes a new draft — crews keep seeing
          this quiz until you Approve & publish it.
        </p>
      )}
      {q && q.status === "draft" && hasDraft && (
        <p className="muted" style={{ fontSize: 13 }}>
          Draft only — crews can't see this until you Approve & publish it.
        </p>
      )}

      {hasDraft && q && (
        <div>
          <p className="field-label">Draft summary</p>
          <p style={{ margin: "4px 0" }}>{q.draft_summary}</p>
          <p className="field-label">Draft questions</p>
          <ol style={{ paddingLeft: 18, margin: 0 }}>
            {q.draft_questions.map((question: QuizQuestionFull, i: number) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <div>{question.q}</div>
                <ul style={{ paddingLeft: 18, margin: "2px 0" }}>
                  {question.choices.map((c, ci) => (
                    <li key={ci} style={ci === question.correct_idx ? { fontWeight: 700 } : undefined}>
                      {c}
                      {ci === question.correct_idx ? " ✓" : ""}
                    </li>
                  ))}
                </ul>
                <div className="muted" style={{ fontSize: 12 }}>{question.why}</div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- crew-facing

/** One question at a time, no feedback until submit — nothing here can leak
 * a correct answer because QuizQuestionPublic never carries one. */
function AnsweringView({
  videoId,
  questions,
  onDone,
}: {
  videoId: string;
  questions: ShuffledQuestion[];
  onDone: (queued: boolean, data: SubmitVideoQuizResponse | null) => void;
}) {
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<Map<number, number>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const current = questions[index];
  const picked = picks.get(current.originalIndex);

  const pick = (choiceIdx: number) => {
    setPicks((prev) => new Map(prev).set(current.originalIndex, choiceIdx));
  };

  const advance = async () => {
    if (index + 1 < questions.length) {
      setIndex((i) => i + 1);
      return;
    }
    setSubmitting(true);
    try {
      const answers = buildAnswers(picks, questions.length);
      const { queued, data } = await submitVideoQuiz(videoId, answers);
      onDone(queued, data);
    } catch (e) {
      pushToast(formatApiError(e), "error");
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p className="muted">Question {index + 1} of {questions.length}</p>
      <div className="detail-card"><p>{current.q}</p></div>
      <div className="action-list">
        {current.choices.map((c, ci) => (
          <button
            key={ci}
            className={picked === ci ? "action-btn primary" : "action-btn"}
            disabled={submitting}
            onClick={() => pick(ci)}
          >
            {c.text}
          </button>
        ))}
      </div>
      {picked != null && (
        <button className="primary big" disabled={submitting} onClick={advance}>
          {submitting
            ? "Submitting…"
            : index + 1 < questions.length
              ? "Next"
              : "Turn it in"}
        </button>
      )}
    </div>
  );
}

/** After a scored submit: walk the same 5 questions again, this time with
 * the server's own verdict — the ONLY point in this flow where correct_idx
 * ever exists on the client, because it only exists after scoring. */
function ReviewView({
  questions,
  data,
  clearanceTypeName,
  onFinished,
}: {
  questions: ShuffledQuestion[];
  data: SubmitVideoQuizResponse;
  clearanceTypeName: string | null;
  onFinished: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [toasted, setToasted] = useState(false);
  const current = questions[index];
  const result = data.results[current.originalIndex];
  const atEnd = index + 1 >= questions.length;

  useEffect(() => {
    if (!atEnd || toasted) return;
    setToasted(true);
    if (data.points_awarded > 0) {
      pushToast(`+${data.points_awarded} points added.`, "success");
    }
    if (data.cleared) {
      const who = clearanceTypeName ?? "this window type";
      pushToast(`You're cleared for ${who} — dispatch can now assign you.`, "success");
    }
  }, [atEnd, toasted, data, clearanceTypeName]);

  return (
    <div>
      <p className="muted">Question {index + 1} of {questions.length}</p>
      <div className="detail-card"><p>{current.q}</p></div>
      <div className="action-list">
        {current.choices.map((c, ci) => {
          const isCorrect = ci === result.correct_idx;
          return (
            <button key={ci} className="action-btn" disabled>
              {c.text}
              {isCorrect ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      <p className={result.correct ? "ok" : "error"}>
        {result.correct ? "Correct." : "Not quite."} {result.why}
      </p>
      {!atEnd ? (
        <button className="primary big" onClick={() => setIndex((i) => i + 1)}>Next</button>
      ) : (
        <div className="quiz-done">
          <p className="next-code" style={{ margin: 0 }}>{data.score}/{questions.length}</p>
          <p className={data.passed ? "ok" : "muted"}>
            {data.passed ? "Passed." : "Not a pass this time — 4 of 5 to pass."}
          </p>
          <button className="primary big" onClick={onFinished}>
            {data.passed ? "Done" : "Retake"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The video card's quiz entry point: nothing when there's no approved quiz,
 * a "Take the quiz" button otherwise, and the flow above once tapped. */
function TakeQuizCard({
  videoId,
  profileId,
  clearanceTypeName,
}: {
  videoId: string;
  profileId: string | null;
  clearanceTypeName: string | null;
}) {
  const quiz = useQuery({
    queryKey: ["videoQuizPublic", videoId],
    queryFn: () => listVideoQuiz(videoId),
  });
  const [phase, setPhase] = useState<"idle" | "answering" | "reviewing" | "queued">("idle");
  const [questions, setQuestions] = useState<ShuffledQuestion[]>([]);
  const [result, setResult] = useState<SubmitVideoQuizResponse | null>(null);

  const start = async (raw: QuizQuestionPublic[]) => {
    const seed = profileId ? await myAttemptCount(videoId, profileId) : 0;
    setQuestions(shuffleQuiz(raw, seed));
    setPhase("answering");
  };

  if (quiz.isLoading || !quiz.data || quiz.data.length === 0) return null;

  if (phase === "idle") {
    return (
      <button className="button-like active-pill" style={{ marginTop: 8 }} onClick={() => void start(quiz.data!)}>
        Take the quiz
      </button>
    );
  }

  if (phase === "answering") {
    return (
      <AnsweringView
        videoId={videoId}
        questions={questions}
        onDone={(queued, data) => {
          if (queued || !data) {
            setPhase("queued");
            pushToast("Saved on this phone — your quiz result will send when you're back in signal.");
            return;
          }
          setResult(data);
          setPhase("reviewing");
        }}
      />
    );
  }

  if (phase === "reviewing" && result) {
    return (
      <ReviewView
        questions={questions}
        data={result}
        clearanceTypeName={clearanceTypeName}
        onFinished={() => {
          setPhase("idle");
          setResult(null);
          void quiz.refetch();
        }}
      />
    );
  }

  if (phase === "queued") {
    return (
      <p className="muted" style={{ marginTop: 8 }}>
        Quiz saved — it'll send when you're back in signal, and your score will show here after.
      </p>
    );
  }

  return null;
}
