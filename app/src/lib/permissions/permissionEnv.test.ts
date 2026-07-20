import { describe, expect, it } from "vitest";
import {
  readLocationStatus,
  readNotificationStatus,
  requestLocation,
  requestNotifications,
  type PermissionEnv,
} from "./permissionEnv";
import type { WizardChoice } from "./permissionCore";

function fakeEnv(over: Partial<PermissionEnv> = {}): PermissionEnv {
  let choice: WizardChoice = "pending";
  return {
    isSecureContext: () => true,
    notificationSupported: () => true,
    getNotificationPermission: () => "default",
    requestNotificationPermission: async () => "granted",
    geolocationSupported: () => true,
    requestGeolocation: async () => "granted",
    queryPermission: async () => "prompt",
    readWizardChoice: () => choice,
    writeWizardChoice: (c) => {
      choice = c;
    },
    ...over,
  };
}

describe("readNotificationStatus", () => {
  it("reports insecure-context first", async () => {
    const env = fakeEnv({ isSecureContext: () => false });
    expect(await readNotificationStatus(env)).toBe("insecure-context");
  });

  it("reports unsupported when the API is missing", async () => {
    const env = fakeEnv({ notificationSupported: () => false });
    expect(await readNotificationStatus(env)).toBe("unsupported");
  });

  it("maps granted / denied / default", async () => {
    expect(
      await readNotificationStatus(fakeEnv({ getNotificationPermission: () => "granted" })),
    ).toBe("granted");
    expect(
      await readNotificationStatus(fakeEnv({ getNotificationPermission: () => "denied" })),
    ).toBe("denied");
    expect(
      await readNotificationStatus(fakeEnv({ getNotificationPermission: () => "default" })),
    ).toBe("prompt");
  });
});

describe("readLocationStatus", () => {
  it("reports insecure-context and unsupported gates", async () => {
    expect(await readLocationStatus(fakeEnv({ isSecureContext: () => false }))).toBe(
      "insecure-context",
    );
    expect(
      await readLocationStatus(fakeEnv({ geolocationSupported: () => false })),
    ).toBe("unsupported");
  });

  it("maps the live permission query, defaulting null to prompt", async () => {
    expect(await readLocationStatus(fakeEnv({ queryPermission: async () => "granted" }))).toBe(
      "granted",
    );
    expect(await readLocationStatus(fakeEnv({ queryPermission: async () => "denied" }))).toBe(
      "denied",
    );
    expect(await readLocationStatus(fakeEnv({ queryPermission: async () => null }))).toBe(
      "prompt",
    );
  });
});

describe("requestNotifications", () => {
  it("does not re-fire once already decided", async () => {
    let called = 0;
    const env = fakeEnv({
      getNotificationPermission: () => "denied",
      requestNotificationPermission: async () => {
        called += 1;
        return "granted";
      },
    });
    expect(await requestNotifications(env)).toBe("denied");
    expect(called).toBe(0);
  });

  it("fires the prompt and maps the result (default → dismissed)", async () => {
    expect(
      await requestNotifications(fakeEnv({ requestNotificationPermission: async () => "granted" })),
    ).toBe("granted");
    expect(
      await requestNotifications(fakeEnv({ requestNotificationPermission: async () => "default" })),
    ).toBe("dismissed");
  });
});

describe("requestLocation", () => {
  it("maps priming outcomes", async () => {
    expect(await requestLocation(fakeEnv({ requestGeolocation: async () => "granted" }))).toBe(
      "granted",
    );
    expect(await requestLocation(fakeEnv({ requestGeolocation: async () => "denied" }))).toBe(
      "denied",
    );
    expect(
      await requestLocation(fakeEnv({ requestGeolocation: async () => "unavailable" })),
    ).toBe("dismissed");
  });

  it("guards insecure context and unsupported", async () => {
    expect(await requestLocation(fakeEnv({ isSecureContext: () => false }))).toBe(
      "insecure-context",
    );
    expect(await requestLocation(fakeEnv({ geolocationSupported: () => false }))).toBe(
      "unsupported",
    );
  });
});
