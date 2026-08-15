// Fire-and-forget trigger for the `send-push` edge function. This is how the app
// asks the server to deliver a web push (which lands even when the app is fully
// closed) using the SAME { title, body, tag, url } shape as notifyLocal — so a
// pushed alert renders identically to a local one.
//
// Every call degrades to a silent no-op on failure: a push is a nicety, never a
// blocker for the mutation that triggered it.

import { supabase, supabaseConfigured } from "../supabase";

export interface SendPushInput {
  /** Target these profiles. Omit/empty = broadcast to every subscription. */
  profileIds?: string[];
  title: string;
  body?: string;
  /** Stable id used to dedupe/collapse (mirrors notifyLocal's tag). */
  tag?: string;
  /** Deep link opened on click. */
  url?: string;
  /** Ring as hard as the platform allows (Summon). */
  urgent?: boolean;
}

/**
 * Ask the server to send a web push. Never throws; returns false when it was
 * skipped or failed so callers can ignore it entirely.
 */
export async function sendPush(input: SendPushInput): Promise<boolean> {
  if (!supabaseConfigured) return false;
  try {
    const { error } = await supabase.functions.invoke("send-push", { body: input });
    return !error;
  } catch {
    return false;
  }
}
