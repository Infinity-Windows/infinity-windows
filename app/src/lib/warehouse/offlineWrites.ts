// Warehouse writes that survive a conex (ticket 10).
//
// A conex is a metal box with no bars. Nobody walks outside to make the app
// happy — they do the work and skip the scan, and then the record is gone
// forever. So the six writes somebody makes standing inside one try the
// server first and fall back to the outbox when the failure was the network.
//
// The distinction matters: a REAL rejection ("that container is inactive",
// "pick a reason") must surface immediately, because queueing it would just
// fail forever in the dead-letter and the person would never learn they were
// wrong. Only "no signal" queues. isNetworkError draws that line and is the
// same one the install flow uses.
//
// To the person holding the crate the work IS done, so callers report success
// either way and say "not sent yet" when it queued.

import { isNetworkError } from "../offline/outbox-core";
import {
  enqueueBindPackage,
  enqueueCheckoutPackages,
  enqueueMoveContainer,
  enqueueStagePackages,
  enqueueReceiveMinted,
  enqueueSetPackageArea,
  enqueueStorePackages,
  enqueueTakeSupply,
} from "../offline/outbox";
import {
  bindPackage,
  checkoutPackages,
  moveContainer,
  receiveMintedPackages,
  setPackageArea,
  stagePackages,
  storePackages,
  type StoragePackage,
} from "../storage";
import { takeSupply } from "../ops";

/** What happened: it reached the server, or it is waiting for signal. */
export interface WriteResult {
  /** How many rows the server said it touched; the queued count when offline. */
  count: number;
  /** True when this is sitting in the outbox rather than done on the server. */
  queued: boolean;
}

/**
 * A fresh idempotency key, in the uuid shape the database column expects.
 *
 * The hand-rolled fallback is not decoration: crypto.randomUUID is missing on
 * older phone browsers and on any page served without https, and a key that
 * isn't uuid-shaped would be rejected by the RPC — which would turn a browser
 * quirk into "this crew can't log supplies at all".
 */
function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function attempt(
  send: () => Promise<number>,
  queue: () => Promise<unknown>,
  optimisticCount: number,
): Promise<WriteResult> {
  try {
    const count = await send();
    return { count, queued: false };
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await queue();
    return { count: optimisticCount, queued: true };
  }
}

/** Check packages into a container; queues when there is no signal. */
/**
 * What the phone believed about one package at the moment somebody ticked it.
 *
 * This takes ROWS and not ids on purpose (warehouse audit F2). A queued
 * check-in used to carry only "put these in Conex 7", so when it finally went
 * up — ten minutes later, out of the conex — it set the package back to stored
 * on top of whatever had happened in between. A checkout made one minute ago
 * lost to a tap made ten minutes ago, and nobody was told. Asking for the row
 * means the note travels with the write, and a caller cannot forget to send it
 * without the build failing.
 */
export interface CheckInBelief {
  id: string;
  status: string;
  container_id: string | null;
}

/** The note, keyed by package, exactly as store_packages reads it. */
export function checkInNote(
  packages: CheckInBelief[],
): Record<string, { status: string; container: string | null }> {
  const note: Record<string, { status: string; container: string | null }> = {};
  for (const p of packages) note[p.id] = { status: p.status, container: p.container_id };
  return note;
}

/** Confirm pre-labeled packages off the truck; queues when there is no
 * signal — the yard is the dead zone. The server counts an already-received
 * package without a second history line, so a resend is not a second truck. */
export function receiveMintedOffline(packageIds: string[]): Promise<WriteResult> {
  return attempt(
    () => receiveMintedPackages(packageIds),
    () => enqueueReceiveMinted({ packageIds }),
    packageIds.length,
  );
}

/** Point at where in the box a package sits; queues when there is no signal —
 * areas get set standing INSIDE the box, which is exactly where the bars are
 * not. A resend lands on the same pointer, so twice is once. */
export function setPackageAreaOffline(
  packageId: string,
  area: string | null,
): Promise<WriteResult> {
  return attempt(
    () => setPackageArea(packageId, area).then(() => 1),
    () => enqueueSetPackageArea({ packageId, area }),
    1,
  );
}

export function storePackagesOffline(
  packages: CheckInBelief[],
  containerId: string,
): Promise<WriteResult> {
  const packageIds = packages.map((p) => p.id);
  return attempt(
    // Online needs no note. The note answers "is this still true after sitting
    // in a queue", and a write that never sat in a queue has nothing to ask.
    () => storePackages(packageIds, containerId),
    () => enqueueStorePackages(packageIds, containerId, checkInNote(packages)),
    packages.length,
  );
}

/** Check packages out to a job; queues when there is no signal. */
export function checkoutPackagesOffline(
  packageIds: string[],
  reason: string,
  projectId: string,
): Promise<WriteResult> {
  return attempt(
    () => checkoutPackages(packageIds, reason, projectId),
    () => enqueueCheckoutPackages({ packageIds, reason, projectId }),
    packageIds.length,
  );
}

/** Everything the tag screen sends, exactly as lib/storage takes it. */
export type TagInput = Parameters<typeof bindPackage>[0];

/** A tag, plus the bound package when the server was the one that answered. */
export interface TagResult extends WriteResult {
  /**
   * The row the server returned, or null when this only reached the phone.
   * There is no honest way to fake it: the serial, the bound_at and the
   * short code are the database's to write, so a screen that needs a serial
   * for a queued tag has to use the one it already had in hand.
   */
  package: StoragePackage | null;
}

/**
 * Tag a package: bind a blank sticker to a job. Queues when there is no signal.
 *
 * The bound row comes back through the closure because `attempt` speaks in
 * counts. That is on purpose — it keeps the queue-or-throw decision in ONE
 * place for all six warehouse writes. A second copy of those four lines is
 * how the two halves drift apart, and this rule is the whole feature.
 */
export async function bindPackageOffline(input: TagInput): Promise<TagResult> {
  let bound: StoragePackage | null = null;
  const r = await attempt(
    async () => {
      bound = await bindPackage(input);
      return 1;
    },
    () => enqueueBindPackage(input),
    1, // one sticker, one package — the count a tag can ever have
  );
  return { ...r, package: bound };
}

/**
 * What the phone believed about one package at the moment somebody ticked it
 * for setting aside.
 *
 * Rows, not ids, for exactly the reason check-in takes rows (F2): a queued
 * set-aside used to carry only "put these on BLACK22's shelf", so when it
 * finally went up — ten minutes later, out of the conex — it recorded the
 * package on that bay on top of whatever had happened in between. Asking for
 * the row means the note travels with the write and a caller cannot forget it
 * without the build failing.
 *
 * `location_id` is optional because rows read from a database the shelf-column
 * migration has not reached simply lack the key; a missing key reads as "on no
 * shelf", which is what those rows meant.
 */
export interface SetAsideBelief {
  id: string;
  status: string;
  container_id: string | null;
  location_id?: string | null;
}

/** The note, keyed by package, exactly as stage_packages reads it. */
export function setAsideNote(
  packages: SetAsideBelief[],
): Record<string, { status: string; container: string | null; location: string | null }> {
  const note: Record<
    string,
    { status: string; container: string | null; location: string | null }
  > = {};
  for (const p of packages) {
    note[p.id] = {
      status: p.status,
      container: p.container_id,
      location: p.location_id ?? null,
    };
  }
  return note;
}

/** Set packages aside on a job's own bay; queues when there is no signal. */
export function stagePackagesOffline(
  packages: SetAsideBelief[],
  projectId: string,
): Promise<WriteResult> {
  const packageIds = packages.map((p) => p.id);
  return attempt(
    // Online needs no note, same as check-in: the note answers "is this still
    // true after sitting in a queue", and a write that never sat in a queue
    // has nothing to ask.
    () => stagePackages(packageIds, projectId),
    () => enqueueStagePackages(packageIds, projectId, setAsideNote(packages)),
    packages.length,
  );
}

/**
 * Move a container, everything inside going with it. Queues with no signal.
 *
 * The count is the container, not its riders: the screen already knows how
 * many packages ride along and says so itself, and inventing a package count
 * here would be a second answer to the same question.
 */
export function moveContainerOffline(input: {
  containerId: string;
  parentContainerId?: string | null;
  locationId?: string | null;
}): Promise<WriteResult> {
  return attempt(
    async () => {
      await moveContainer(input);
      return 1;
    },
    () => enqueueMoveContainer(input),
    1,
  );
}

/** What a queued supply take carries — the take, plus the key that guards it. */
interface KeyedTake {
  supplyId: string;
  projectId: string;
  qty: number;
  clientId: string;
}

/**
 * Log a supply take; queues when there is no signal.
 *
 * The key is made HERE, once, before the first try — not inside the outbox
 * (warehouse audit F1). This write is the one that tries the server first and
 * only queues if that throws, and a lost answer looks exactly like a dead
 * connection from in here: the server subtracted, we never heard, and we
 * queue. If the queued copy carried a brand-new key the server would count it
 * as a second take and on hand would drop twice. One key, both paths.
 */
export function takeSupplyOffline(input: {
  supplyId: string;
  projectId: string;
  qty: number;
}): Promise<WriteResult> {
  const keyed: KeyedTake = { ...input, clientId: newClientId() };
  return attempt(
    async () => {
      await takeSupply(keyed);
      return keyed.qty;
    },
    () => enqueueTakeSupply(keyed),
    keyed.qty,
  );
}

/** The line a screen shows after a write — honest about where it got to. */
export function writeToast(r: WriteResult, done: string): string {
  return r.queued ? `${done} — not sent yet, no signal in here.` : done;
}

/**
 * The line the tag screen shows, which needs its own words.
 *
 * Every other warehouse write means the same thing whether it landed or
 * queued; only where it got to changes. Tagging does not. "Sticker is now
 * permanent" is a fact about the database — bind_package refuses a second
 * bind forever after — so a tag still sitting on the phone must not claim it.
 *
 * The queued line says where the write got to and stops there. It does NOT
 * say the sticker is "not permanent yet", which was the first attempt: to
 * the person holding the roll that reads as "this one is still free", and
 * CONTEXT.md is blunt about why that is the worst thing this screen could
 * say — a sticker is bound to one package for its whole life and is never
 * reused, "a reused sticker would make every earlier record point at the
 * wrong physical thing". There is nothing to act on either way. A queued tag
 * cannot be edited or called back from any screen in the app, so the honest
 * middle is to name the state and the fact that it sends itself.
 */
export function tagToast(serial: string, queued: boolean): string {
  return queued
    ? `${serial} assigned — saved on this phone and not sent yet. ` +
        "It goes up on its own when you have signal."
    : `${serial} assigned — sticker is now permanent.`;
}
