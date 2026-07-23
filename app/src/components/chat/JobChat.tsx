import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import {
  listMessages,
  listRoster,
  sendMessage,
  type ChatMessage,
  type ChatRoster,
} from "../../lib/chat/api";
import { resolveMentions, splitMentionSegments } from "../../lib/chat/mentions";
import { resolvePushRecipients } from "../../lib/chat/recipients";
import { useRealtimeMessages } from "../../lib/chat/useRealtimeMessages";
import { sendPush } from "../../lib/permissions/pushServer";
import { getMyProfile } from "../../lib/install/api";
import { toastError } from "../../lib/toast";
import { EmptyState, QueryError, SkeletonList } from "../ui/States";

const EMPTY_ROSTER: ChatRoster = {
  members: [],
  assignedCrewIds: [],
  supervisorOwnerIds: [],
};

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** Detect the @-token currently being typed just before the caret. */
function activeMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = before.match(/(?:^|\s)@([\p{L}\p{N}'-]*)$/u);
  if (!m) return null;
  const query = m[1] ?? "";
  return { start: caret - query.length - 1, query };
}

/**
 * The per-job group chat: a live, text-only thread for the installers + foreman
 * on the job, plus supervisors/owners. Assigned crew get a push on every
 * message; supervisors/owners are pushed only when @-mentioned by name.
 */
export function JobChat({
  projectId,
  jobLabel,
}: {
  projectId: string;
  jobLabel: string;
}) {
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [body, setBody] = useState("");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");

  useRealtimeMessages(projectId);

  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const messages = useQuery({
    queryKey: ["projectMessages", projectId],
    queryFn: () => listMessages(projectId),
  });
  const rosterQuery = useQuery({
    queryKey: ["chatRoster", projectId],
    queryFn: () => listRoster(projectId),
  });
  const roster = rosterQuery.data ?? EMPTY_ROSTER;

  const myId = me.data?.id ?? null;
  const isMember = useMemo(
    () => (myId ? roster.members.some((m) => m.id === myId) : false),
    [roster.members, myId],
  );

  const mentionMatches = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery.toLowerCase();
    return roster.members
      .filter((m) => (m.display_name ?? "").toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionOpen, mentionQuery, roster.members]);

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.data?.length]);

  const send = useMutation({
    mutationFn: async (text: string) => {
      const mentionedIds = resolveMentions(text, roster.members);
      const saved = await sendMessage(projectId, text, mentionedIds);
      const recipients = resolvePushRecipients({
        assignedCrewIds: roster.assignedCrewIds,
        supervisorOwnerIds: roster.supervisorOwnerIds,
        mentionedIds,
        authorId: myId,
      });
      if (recipients.length > 0) {
        const authorName = me.data?.display_name ?? "New message";
        void sendPush({
          profileIds: recipients,
          title: `${authorName} · ${jobLabel}`,
          body: text.length > 140 ? `${text.slice(0, 139)}…` : text,
          tag: `chat-${projectId}`,
          url: `/projects/${projectId}?tab=chat`,
        });
      }
      return saved;
    },
    onMutate: async (text: string) => {
      await queryClient.cancelQueries({ queryKey: ["projectMessages", projectId] });
      const previous = queryClient.getQueryData<ChatMessage[]>([
        "projectMessages",
        projectId,
      ]);
      const optimistic: ChatMessage = {
        id: `optimistic-${Date.now()}`,
        project_id: projectId,
        author_id: myId ?? "me",
        author_name: me.data?.display_name ?? "You",
        body: text,
        mentions: resolveMentions(text, roster.members),
        created_at: new Date().toISOString(),
      };
      queryClient.setQueryData<ChatMessage[]>(
        ["projectMessages", projectId],
        [...(previous ?? []), optimistic],
      );
      return { previous };
    },
    onError: (error, _text, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["projectMessages", projectId], context.previous);
      }
      toastError(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["projectMessages", projectId],
      });
    },
  });

  const submit = () => {
    const text = body.trim();
    if (!text || send.isPending) return;
    setBody("");
    setMentionOpen(false);
    send.mutate(text);
  };

  const onBodyChange = (value: string, caret: number) => {
    setBody(value);
    const active = activeMention(value, caret);
    if (active) {
      setMentionOpen(true);
      setMentionQuery(active.query);
    } else {
      setMentionOpen(false);
    }
  };

  const pickMention = (displayName: string | null) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? body.length;
    const active = activeMention(body, caret);
    const name = displayName ?? "";
    if (!active) {
      setBody((b) => `${b}@${name} `);
    } else {
      const next =
        body.slice(0, active.start) + `@${name} ` + body.slice(caret);
      setBody(next);
    }
    setMentionOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const list = messages.data ?? [];

  return (
    <div className="chat">
      {messages.isLoading ? (
        <SkeletonList rows={4} />
      ) : messages.isError ? (
        <QueryError
          error={messages.error}
          onRetry={() => messages.refetch()}
          label="Couldn't load the chat"
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare size={22} />}
          title="No messages yet"
          message={
            isMember
              ? "Start the conversation for this job below."
              : "Messages for this job will appear here."
          }
        />
      ) : (
        <div className="chat-thread" ref={listRef} role="log" aria-live="polite">
          {list.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              roster={roster}
              mine={myId != null && msg.author_id === myId}
            />
          ))}
        </div>
      )}

      {isMember ? (
        <div className="chat-composer">
          {mentionOpen && mentionMatches.length > 0 && (
            <ul className="chat-mention-menu" role="listbox">
              {mentionMatches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="chat-mention-option"
                    onClick={() => pickMention(m.display_name)}
                  >
                    <span>{m.display_name ?? "Unknown"}</span>
                    {!m.assigned && <span className="muted"> · supervisor</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="chat-composer-row">
            <textarea
              ref={inputRef}
              className="chat-input"
              value={body}
              rows={2}
              placeholder="Message the crew… use @name to mention"
              aria-label="Message the crew"
              onChange={(e) => onBodyChange(e.target.value, e.target.selectionStart ?? 0)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "Escape") setMentionOpen(false);
              }}
            />
            <button
              type="button"
              className="action-btn primary chat-send"
              disabled={!body.trim() || send.isPending}
              onClick={submit}
            >
              {send.isPending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      ) : (
        <p className="muted chat-readonly-note">
          You&apos;re not on this job&apos;s crew, so you can&apos;t post here.
        </p>
      )}
    </div>
  );
}

function MessageRow({
  message,
  roster,
  mine,
}: {
  message: ChatMessage;
  roster: ChatRoster;
  mine: boolean;
}) {
  const segments = useMemo(
    () => splitMentionSegments(message.body, roster.members),
    [message.body, roster.members],
  );
  return (
    <div className={mine ? "chat-msg chat-msg-mine" : "chat-msg"}>
      <div className="chat-msg-head">
        <span className="chat-msg-author">
          {message.author_name ?? "Someone"}
        </span>
        <span className="chat-msg-time muted">{timeLabel(message.created_at)}</span>
      </div>
      <p className="chat-msg-body">
        {segments.map((seg, i): ReactNode =>
          seg.mentionId ? (
            <span key={i} className="chat-mention">
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </p>
    </div>
  );
}
