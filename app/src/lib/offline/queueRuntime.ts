import { createQueueCoordinator } from "./queueCoordinator";
import { subscribeSignedIn } from "../signedIn";
import { logOfflineEvent } from "./telemetry";

type Plan = { hasPending: boolean; nextRetryAt: number | null };
interface GeneralLane {
  recover(): Promise<void>;
  recoverSigner(): Promise<void>;
  execute(force: boolean): Promise<void>;
  publish(): Promise<void>;
  inspect(): Promise<Plan>;
}
interface InstallLane {
  execute(): Promise<boolean>;
  publish(): void;
  inspect(): Promise<Plan>;
}
let general: GeneralLane | undefined;
let installs: InstallLane | undefined;

/** Two concrete durable lanes, one scheduler. Registration creates no timers. */
export const queueCoordinator = createQueueCoordinator({
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  subscribeAuth: subscribeSignedIn,
  recover: async () => { await general?.recover(); },
  recoverSigner: async () => { await general?.recoverSigner(); },
  execute: async force => {
    // Existing core preserves toolbox/clock-before-media priority. Installs
    // yield after a durable stage, so the next turn checks those commands again.
    await general?.execute(force);
    return (await installs?.execute()) ?? false;
  },
  publish: async () => { await general?.publish(); installs?.publish(); },
  inspect: async () => {
    const plans = await Promise.all([general?.inspect(), installs?.inspect()]);
    const retry = plans.reduce((due, p) => Math.min(due, p?.nextRetryAt ?? Infinity), Infinity);
    return { hasPending: plans.some(p => p?.hasPending), nextRetryAt: Number.isFinite(retry) ? retry : null };
  },
  report: error => logOfflineEvent({ type: "queue", scope: "outbox", message: `Queue stopped before finishing: ${error instanceof Error ? error.message : "unknown error"}` }),
});
export function registerGeneralLane(lane: GeneralLane): void { general = lane; }
export function registerInstallLane(lane: InstallLane): void { installs = lane; }
