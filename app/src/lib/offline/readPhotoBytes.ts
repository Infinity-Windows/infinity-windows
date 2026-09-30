import { SendTookTooLongError } from "./outbox-core";

export const PHOTO_BYTE_READ_TIMEOUT_MS = 45_000;

/** Read a saved iPhone photo without letting a stalled IndexedDB Blob hold the queue. */
export async function readPhotoBytes(
  blob: Blob,
  signal?: AbortSignal,
  timeoutMs = PHOTO_BYTE_READ_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  if (signal?.aborted) throw new SendTookTooLongError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TypeError("Saved photo could not be read yet: local read timed out")), timeoutMs);
    onAbort = () => reject(new SendTookTooLongError());
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const bytes = await Promise.race([blob.arrayBuffer(), stop]);
    if (signal?.aborted) throw new SendTookTooLongError();
    return bytes;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
