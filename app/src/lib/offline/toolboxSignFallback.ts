// A toolbox talk signature filed the way the app filed one before
// sign_toolbox_talk existed (20261033000000): one insert into
// toolbox_completions. Only for a database the migration has not reached yet
// — the app can land on phones first, and the backend deploy is its own
// workflow — so the crew can still sign while it catches up. Loaded only
// then (outboxHandlers.ts, toolbox_sign).
//
// A resend must still be one row. The signature's path is made from its
// client id (lib/toolboxSign.ts), so it is the key: a row already carrying it
// is the one this signature made. A lookup that could not be asked is
// retried — never answered with a blind insert.

import { supabase } from "../supabase";

export async function fileSignatureDirectly(s: {
  profileId: string;
  talkId: string | null;
  typedName: string;
  signaturePath: string;
  pdfPath: string | null;
  talkSnapshot: string | null;
  signedAt: string | null;
}): Promise<unknown> {
  const found = await supabase
    .from("toolbox_completions")
    .select("*")
    .eq("profile_id", s.profileId)
    .eq("signature_path", s.signaturePath)
    .limit(1)
    .maybeSingle();
  if (found.error) throw found.error;
  if (found.data) return found.data;
  const made = await supabase
    .from("toolbox_completions")
    .insert({
      talk_id: s.talkId,
      profile_id: s.profileId,
      typed_name: s.typedName,
      signature_path: s.signaturePath,
      pdf_path: s.pdfPath,
      talk_snapshot: s.talkSnapshot,
      signed_at: s.signedAt,
    })
    .select("*")
    .single();
  if (made.error) throw made.error;
  return made.data;
}
