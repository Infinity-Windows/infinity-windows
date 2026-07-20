import { Bell, MapPin, RotateCcw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePermissions } from "../../lib/permissions/usePermissions";
import { openOnboardingWizard } from "../../lib/permissions/wizardBus";
import {
  settingsView,
  type PermissionKind,
  type PermissionStatus,
} from "../../lib/permissions/permissionCore";

/**
 * Settings section: "Notifications & location". Shows the live status of each
 * permission, a Turn-on button when it's still askable, and clear site-settings
 * guidance when a permission is HARD denied (JS can't re-prompt after denial).
 * Re-opening the full priming wizard is also offered.
 */
export function PermissionsSettings() {
  const perms = usePermissions();

  return (
    <section className="perm-settings" aria-label="Notifications and location">
      <div className="perm-settings-head">
        <div>
          <h2 className="perm-settings-title">Notifications &amp; location</h2>
          <p className="muted perm-settings-sub">
            Control the alerts and location access this app can use.
          </p>
        </div>
        <button
          type="button"
          className="button-like perm-rewizard"
          onClick={openOnboardingWizard}
        >
          <RotateCcw size={15} aria-hidden /> Setup guide
        </button>
      </div>

      <div className="perm-rows">
        <PermissionRow
          kind="notifications"
          Icon={Bell}
          name="Notifications"
          status={perms.notifications}
          onEnable={perms.enableNotifications}
        />
        <PermissionRow
          kind="location"
          Icon={MapPin}
          name="Location"
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
}: {
  kind: PermissionKind;
  Icon: LucideIcon;
  name: string;
  status: PermissionStatus;
  onEnable: () => Promise<PermissionStatus>;
}) {
  const view = settingsView(kind, status);

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
      </div>
      {view.canRequest && (
        <button
          type="button"
          className="wizard-btn primary perm-row-action"
          onClick={() => void onEnable()}
        >
          Turn on
        </button>
      )}
    </div>
  );
}
