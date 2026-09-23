// The React half of lib/appTraining.ts: who is signed in right now, and the
// signed media for one walkthrough — both built so that a SWITCH of account on
// a shared phone leaves nothing of the previous person's media behind.
//
// RLS rechecks new requests, but a signed link already issued to an owner
// remains a bearer token for its lifetime. A shared phone must therefore drop
// its player and cached catalog when a different person signs in:
//   - every read is keyed by the signed-in user id,
//   - a change of id bumps a generation that throws away late answers,
//   - blob: URLs are revoked, and the player is remounted from scratch.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { signTrainingMedia, type TrainingMedia, type TrainingVideo } from "./appTraining";

export interface SignedInUser {
  /** False until the auth client has said who is here (or that nobody is). */
  ready: boolean;
  userId: string | null;
}

/**
 * The signed-in user id, from the auth client's own event stream — no network
 * call. supabase-js emits INITIAL_SESSION to every new subscriber, then every
 * sign-in, sign-out and token refresh after it.
 */
export function useSignedInUserId(): SignedInUser {
  const [state, setState] = useState<SignedInUser>({ ready: false, userId: null });
  useEffect(() => {
    let alive = true;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      const userId = session?.user?.id ?? null;
      // Same person, same object: a token refresh must not remount the player
      // in the middle of a video.
      setState((prev) => (prev.ready && prev.userId === userId ? prev : { ready: true, userId }));
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);
  return state;
}

/** navigator.onLine, kept current. Only ever used to choose WORDS ("you're
 * offline" rather than "couldn't load") — never to decide whether to try. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export type MediaState =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; media: TrainingMedia };

/**
 * Sign one walkthrough's files for the person signed in now. `retry()` signs
 * again — after a failure, or when an hour-old link has expired mid-sitting.
 *
 * Any answer that arrives after the user, the video or the attempt has moved
 * on is dropped, and its blob URL revoked, so a slow signature for the
 * previous account can never land in the next account's player.
 */
export function useTrainingMedia(
  video: Pick<TrainingVideo, "id" | "videoPath" | "captionsPath" | "posterPath"> | null,
  userId: string | null,
): { state: MediaState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<MediaState>({ status: "loading" });
  const videoId = video?.id ?? null;
  const videoPath = video?.videoPath ?? null;
  const captionsPath = video?.captionsPath ?? null;
  const posterPath = video?.posterPath ?? null;

  useEffect(() => {
    if (!videoId || !videoPath || !userId) return;
    let current = true;
    let blobUrl: string | null = null;
    // Aborting stops the signing wait and the caption download the moment the
    // user, the video or the attempt moves on — nothing keeps running for a
    // player that no longer exists.
    const controller = new AbortController();
    setState({ status: "loading" });
    signTrainingMedia({ videoPath, captionsPath, posterPath }, undefined, { signal: controller.signal }).then(
      (media) => {
        if (!current) {
          if (media.captionsUrl) URL.revokeObjectURL(media.captionsUrl);
          return;
        }
        blobUrl = media.captionsUrl;
        setState({ status: "ready", media });
      },
      (error: unknown) => {
        if (current) setState({ status: "error", error });
      },
    );
    return () => {
      current = false;
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setState({ status: "loading" });
    };
  }, [videoId, videoPath, captionsPath, posterPath, userId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
