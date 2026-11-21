/** Owns offline execution and wake-ups, never durable command policy. */
export interface QueueCoordinatorPort {
  online(): boolean;
  recover(): Promise<void>;
  recoverSigner(): Promise<void>;
  execute(forceDue: boolean): Promise<void | boolean>;
  publish(): Promise<void>;
  inspect(): Promise<{ hasPending: boolean; nextRetryAt: number | null }>;
  subscribeAuth(changed: () => void): () => void;
  report(error: unknown): void;
}

export function createQueueCoordinator(port: QueueCoordinatorPort) {
  let started = false, running = false, pending = false, force = false;
  let recovered = false, recoveryPending = true, signerRecovery = false;
  let generation = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dispose: (() => void) | null = null;
  const waiters = new Set<() => void>();
  const settled = () => { for (const done of waiters) done(); waiters.clear(); };
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };

  // Compatibility: a wake during a turn acknowledges the request immediately;
  // it is not a receipt or a promise that this caller's command has been sent.
  async function request(manual = false): Promise<void> {
    // A retiring stage may still finish its durable checkpoint. Its enqueue
    // callbacks must not restart execution after stop.
    if (stopped && running) return;
    if (!port.online() && !recoveryPending && !signerRecovery) { force = false; return; }
    pending = true; force ||= manual;
    if (running) return;
    running = true;
    clearTimer();
    try {
      do {
        pending = false;
        const epoch = generation;
        const forceThisTurn = force;
        force = false;
        if (recoveryPending) { await port.recover(); recoveryPending = false; recovered = true; }
        if (signerRecovery) {
          signerRecovery = false;
          try { await port.recoverSigner(); }
          catch (error) { signerRecovery = true; throw error; }
        }
        if (epoch !== generation) {
          // Recovery can overlap sign-in or StrictMode's stop/start. Offline,
          // there may be no later wake, so publish the current owner's saved
          // punches before ending this turn.
          await port.publish();
          continue;
        }
        if (port.online()) {
          const progressed = await port.execute(forceThisTurn);
          if (progressed && epoch === generation) pending = true;
        }
        await port.publish();
      } while (pending && port.online());
      if (started && port.online()) {
        const epoch = generation;
        const plan = await port.inspect();
        const deadline = plan.hasPending ? Math.min(Date.now() + 30_000, plan.nextRetryAt ?? Infinity) : null;
        if (started && epoch === generation && deadline !== null) {
          timer = setTimeout(() => { timer = null; void request(); }, Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)));
        }
      }
    } catch (error) {
      port.report(error);
      // A storage/inspection failure is not proof of an empty queue.
      if (started && port.online()) timer = setTimeout(() => { timer = null; void request(); }, 30_000);
    } finally {
      running = false;
      if (!port.online()) { pending = false; force = false; }
      if (pending && port.online()) void request(force);
      else settled();
    }
  }

  const wake = () => { if (started) void request(); };
  const offline = () => { clearTimer(); force = false; };
  const visible = () => { if (document.visibilityState === "visible") wake(); };
  function start(): void {
    if (started || typeof window === "undefined") return;
    started = true;
    stopped = false;
    const unsubscribe = port.subscribeAuth(() => {
      generation++; force = false; signerRecovery = true; clearTimer();
      wake();
    });
    window.addEventListener("online", wake);
    window.addEventListener("offline", offline);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", visible);
    dispose = () => {
      unsubscribe();
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", visible);
    };
    recoveryPending ||= !recovered;
    wake();
  }
  function stop(): void {
    started = false; stopped = true; generation++; pending = false; force = false;
    clearTimer(); dispose?.(); dispose = null;
    if (!running) settled();
  }
  return { start, stop, request, idle: () => running
    ? new Promise<void>(resolve => { waiters.add(resolve); }) : Promise.resolve(),
    settle: () => new Promise<void>(resolve => {
    waiters.add(resolve);
    void request().then(() => { if (!running) settled(); });
  }), reconcile: () => {
    recoveryPending ||= !recovered;
    return request();
  }, isRunning: () => running };
}
