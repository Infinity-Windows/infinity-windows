import { listMyInstalls } from "../install/installOutbox";
import { pendingPhotoEntries } from "../offline/outbox";
import { stableId } from "../offline/stableId";
import { signedInUserId } from "../signedIn";

/** Include photos still inside an install that has not reached the upload
 * queue. Both queues use the same stable media ID, so a handoff is counted
 * once even if a reload catches it between durable writes. */
export async function pendingWorkPhotos(): Promise<{ count: number; oldestAt: number | null }> {
  const viewer = signedInUserId();
  if (!viewer) return { count: 0, oldestAt: null };
  // One damaged IndexedDB store must not hide healthy photos in the other.
  const [uploadRead, installRead] = await Promise.allSettled([pendingPhotoEntries(), listMyInstalls()]);
  if (signedInUserId() !== viewer) return { count: 0, oldestAt: null };
  const uploads = uploadRead.status === "fulfilled" ? uploadRead.value : [];
  const installs = installRead.status === "fulfilled" ? installRead.value : [];
  const photos = new Map(uploads.map((photo) => [photo.id, photo.createdAt]));
  for (const install of installs) {
    if (install.status !== "pending" || install.step === "media_done") continue;
    const taken = Date.parse(install.payload.createdAt);
    for (let index = 0; index < install.payload.media.length; index++) {
      const media = install.payload.media[index];
      if (media.kind !== "photo") continue;
      const id = media.clientId || await stableId(`${install.payload.clientKey}:media:${index}`);
      const savedAt = Number.isFinite(taken) ? taken : Date.now();
      photos.set(id, Math.min(photos.get(id) ?? savedAt, savedAt));
    }
  }
  return {
    count: photos.size,
    oldestAt: photos.size ? Math.min(...photos.values()) : null,
  };
}
