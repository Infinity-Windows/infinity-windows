import { useNavigate } from "react-router-dom";
import { PermissionsSettings } from "../components/permissions/PermissionsSettings";

/** Settings hub. For now it hosts the Notifications & location controls (p1-10). */
export function Settings() {
  const navigate = useNavigate();
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Settings</p>
          <h1>Settings</h1>
        </div>
        <button
          type="button"
          className="back-chip"
          aria-label="Back"
          onClick={() => navigate(-1)}
        >
          ‹
        </button>
      </header>

      <PermissionsSettings />
    </div>
  );
}
