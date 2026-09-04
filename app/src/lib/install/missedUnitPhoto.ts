// The one photo a missed unit is worth: what the crew is actually looking at.
//
// Same bucket and the same "bucket/path" spelling every other attachments row
// uses (photos.ts's signedMedia splits on the first slash to get back to it),
// so the picture shows up on the job feed and on the unit's own sheet without
// a second convention to remember.

import { supabase } from "../supabase";

/** Uploads to install-media and returns the stored `bucket/path` reference. */
export async function uploadMissedUnitPhoto(
  projectId: string,
  photo: Blob,
  contentType?: string,
): Promise<string> {
  const path = `${projectId}/missed/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await supabase.storage.from("install-media").upload(path, photo, {
    contentType: contentType || (photo as File).type || "image/jpeg",
    upsert: true,
  });
  if (error) throw error;
  return `install-media/${path}`;
}
