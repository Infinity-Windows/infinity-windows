import { BackChip } from "../components/BackChip";
import { BuildIdentityCard } from "../components/BuildIdentityCard";
import { PermissionsSettings } from "../components/permissions/PermissionsSettings";

/** Settings hub. For now it hosts the Notifications & location controls (p1-10). */
export function Settings() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Settings</p>
          <h1>Settings</h1>
        </div>
        <BackChip label="Back" />
      </header>

      <PermissionsSettings />
      <BuildIdentityCard />
    </div>
  );
}
