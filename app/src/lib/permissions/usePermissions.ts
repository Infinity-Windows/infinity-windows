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

export interface PermissionsState {
  notifications: PermissionStatus;
  location: PermissionStatus;
  ready: boolean;
  refresh: () => Promise<void>;
  enableNotifications: () => Promise<PermissionStatus>;
  enableLocation: () => Promise<PermissionStatus>;
  setWizardChoice: (choice: WizardChoice) => void;
}

export function usePermissions(env: PermissionEnv = browserPermissionEnv): PermissionsState {
  const [notifications, setNotifications] = useState<PermissionStatus>("prompt");
  const [location, setLocation] = useState<PermissionStatus>("prompt");
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const [n, l] = await Promise.all([
      readNotificationStatus(env),
      readLocationStatus(env),
    ]);
    setNotifications(n);
    setLocation(l);
    setReady(true);
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
    }
    return status;
  }, [env]);

  const enableLocation = useCallback(async () => {
    const status = await requestLocation(env);
    setLocation(status);
    return status;
  }, [env]);

  const setWizardChoice = useCallback(
    (choice: WizardChoice) => env.writeWizardChoice(choice),
    [env],
  );

  return {
    notifications,
    location,
    ready,
    refresh,
    enableNotifications,
    enableLocation,
    setWizardChoice,
  };
}
