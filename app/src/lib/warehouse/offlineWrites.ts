// Warehouse writes that survive a conex (ticket 10).
//
// A conex is a metal box with no bars. Nobody walks outside to make the app
// happy — they do the work and skip the scan, and then the record is gone
// forever. So the three writes somebody makes standing inside one try the
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
  enqueueCheckoutPackages,
  enqueueStorePackages,
  enqueueTakeSupply,
} from "../offline/outbox";
import { checkoutPackages, storePackages } from "../storage";
import { takeSupply } from "../ops";

/** What happened: it reached the server, or it is waiting for signal. */
export interface WriteResult {
  /** How many rows the server said it touched; the queued count when offline. */
  count: number;
  /** True when this is sitting in the outbox rather than done on the server. */
  queued: boolean;
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
export function storePackagesOffline(
  packageIds: string[],
  containerId: string,
): Promise<WriteResult> {
  return attempt(
    () => storePackages(packageIds, containerId),
    () => enqueueStorePackages(packageIds, containerId),
    packageIds.length,
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

/** Log a supply take; queues when there is no signal. */
export function takeSupplyOffline(input: {
  supplyId: string;
  projectId: string;
  qty: number;
}): Promise<WriteResult> {
  return attempt(
    async () => {
      await takeSupply(input);
      return input.qty;
    },
    () => enqueueTakeSupply(input),
    input.qty,
  );
}

/** The line a screen shows after a write — honest about where it got to. */
export function writeToast(r: WriteResult, done: string): string {
  return r.queued ? `${done} — not sent yet, no signal in here.` : done;
}
