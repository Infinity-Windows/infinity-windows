// React binding for the permission adapter. Thin on purpose: all the decision
// logic lives in the pure core (permissionCore.ts) and the adapter readers
// (permissionEnv.ts); this hook just holds the live statuses in state, refreshes
// them, and exposes opt-in request actions. The confirmation notification on a
// successful notifications opt-in is fired here so enabling isn't a dead end.

import { useCallback, useEffect, useState } from "react";
import {
  browserPermissionEnv,
  readLocationStatus,
  readNotificationStatus,
  requestLocation,
  requestNotifications,
  type PermissionEnv,
} from "./permissionEnv";
import type { PermissionStatus, WizardChoice } from "./permissionCore";
import { notifyLocal } from "./notifyLocal";
import { disablePush, enablePush } from "./pushSubscribe";
import type { PushDecision } from "./pushCore";

export interface PermissionsState {
  notifications: PermissionStatus;
  location: PermissionStatus;
  ready: boolean;
  /**
   * Why the last web-push attempt was skipped (e.g. "ios-not-installed" to show
   * the home-screen hint), or null when subscribed / not yet attempted. Local
   * notifications work regardless of this.
   */
  pushReason: PushDecision["reason"] | null;
  refresh: () => Promise<void>;
  enableNotifications: () => Promise<PermissionStatus>;
  enableLocation: () => Promise<PermissionStatus>;
  /** Turn OFF web push on this device (unsubscribe + drop the server row). */
  disableDevicePush: () => Promise<void>;
  setWizardChoice: (choice: WizardChoice) => void;
}

export function usePermissions(env: PermissionEnv = browserPermissionEnv): PermissionsState {
  const [notifications, setNotifications] = useState<PermissionStatus>("prompt");
  const [location, setLocation] = useState<PermissionStatus>("prompt");
  const [ready, setReady] = useState(false);
  const [pushReason, setPushReason] = useState<PushDecision["reason"] | null>(null);

  const refresh = useCallback(async () => {
    const [n, l] = await Promise.all([
      readNotificationStatus(env),
      readLocationStatus(env),
    ]);
    setNotifications(n);
    setLocation(l);
    setReady(true);
    // If notifications are already granted, keep the push subscription fresh
    // (idempotent upsert). This also re-registers after a subscription expiry
    // when no client was open at rotation time. Degrades silently.
    if (n === "granted") {
      void enablePush().then((r) => setPushReason(r.ok ? null : r.reason));
    }
  }, [env]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enableNotifications = useCallback(async () => {
    const status = await requestNotifications(env);
    setNotifications(status);
    if (status === "granted") {
      // Prove the delivery path immediately so enabling isn't a dead end.
      void notifyLocal({
        title: "Notifications are on",
        body: "We'll let you know when something needs you.",
        tag: "welcome-notifications",
      });
      // Then subscribe to web push so alerts arrive even when the app is fully
      // closed. Skips silently when unsupported; surfaces the iOS install hint.
      const r = await enablePush();
      setPushReason(r.ok ? null : r.reason);
    }
    return status;
  }, [env]);

  const enableLocation = useCallback(async () => {
    const status = await requestLocation(env);
    setLocation(status);
    return status;
  }, [env]);

  const disableDevicePush = useCallback(async () => {
    await disablePush();
    setPushReason(null);
  }, []);

  const setWizardChoice = useCallback(
    (choice: WizardChoice) => env.writeWizardChoice(choice),
    [env],
  );

  return {
    notifications,
    location,
    ready,
    pushReason,
    refresh,
    enableNotifications,
    enableLocation,
    disableDevicePush,
    setWizardChoice,
  };
}
