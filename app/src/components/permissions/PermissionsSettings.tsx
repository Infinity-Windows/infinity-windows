import { Bell, MapPin, RotateCcw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePermissions } from "../../lib/permissions/usePermissions";
import { openOnboardingWizard } from "../../lib/permissions/wizardBus";
import {
  settingsView,
  type PermissionKind,
  type PermissionStatus,
} from "../../lib/permissions/permissionCore";
import { useT, type TFn } from "../../lib/i18n";

/**
 * Settings section: "Notifications & location". Shows the live status of each
 * permission, a Turn-on button when it's still askable, and clear site-settings
 * guidance when a permission is HARD denied (JS can't re-prompt after denial).
 * Re-opening the full priming wizard is also offered.
 */
export function PermissionsSettings() {
  const t = useT();
  const perms = usePermissions();

  return (
    <section className="perm-settings" aria-label={t("permSettings.ariaLabel")}>
      <div className="perm-settings-head">
        <div>
          <h2 className="perm-settings-title">{t("permSettings.heading")}</h2>
          <p className="muted perm-settings-sub">
            {t("permSettings.subheading")}
          </p>
        </div>
        <button
          type="button"
          className="button-like perm-rewizard"
          onClick={openOnboardingWizard}
        >
          <RotateCcw size={15} aria-hidden /> {t("permSettings.setupGuide")}
        </button>
      </div>

      <div className="perm-rows">
        <PermissionRow
          kind="notifications"
          Icon={Bell}
          name={t("permSettings.kind.notifications")}
          status={perms.notifications}
          onEnable={perms.enableNotifications}
          extraHint={
            perms.notifications === "granted" && perms.pushReason === "ios-not-installed"
              ? t("permSettings.iosHomeScreenHint")
              : undefined
          }
          onDisable={
            perms.notifications === "granted" ? perms.disableDevicePush : undefined
          }
        />
        <PermissionRow
          kind="location"
          Icon={MapPin}
          name={t("permSettings.kind.location")}
          status={perms.location}
          onEnable={perms.enableLocation}
        />
      </div>
    </section>
  );
}

function PermissionRow({
  kind,
  Icon,
  name,
  status,
  onEnable,
  extraHint,
  onDisable,
}: {
  kind: PermissionKind;
  Icon: LucideIcon;
  name: string;
  status: PermissionStatus;
  onEnable: () => Promise<PermissionStatus>;
  /** Optional extra guidance under the row (e.g. the iOS install hint). */
  extraHint?: string;
  /** When provided, shows a "Turn off on this device" action (web push off). */
  onDisable?: () => Promise<void>;
}) {
  const t: TFn = useT();
  const view = settingsView(kind, status, t);

  return (
    <div className="perm-row">
      <span className="perm-row-icon" aria-hidden>
        <Icon size={20} />
      </span>
      <div className="perm-row-main">
        <div className="perm-row-top">
          <span className="perm-row-name">{name}</span>
          <span className={`perm-badge perm-badge-${view.tone}`}>{view.label}</span>
        </div>
        <p className="perm-row-hint muted">{view.hint}</p>
        {extraHint && <p className="perm-row-hint muted">{extraHint}</p>}
        {onDisable && (
          <button
            type="button"
            className="button-like perm-row-off"
            onClick={() => void onDisable()}
            aria-label={t("permSettings.turnOffAria", { name })}
          >
            {t("permSettings.turnOffDevice")}
          </button>
        )}
      </div>
      {view.canRequest && (
        <button
          type="button"
          className="wizard-btn primary perm-row-action"
          onClick={() => void onEnable()}
        >
          {t("permSettings.turnOn")}
        </button>
      )}
    </div>
  );
}
