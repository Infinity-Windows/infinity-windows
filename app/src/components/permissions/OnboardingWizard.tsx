import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bell, Check, MapPin, Sparkles, X } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { usePermissions } from "../../lib/permissions/usePermissions";
import {
  isHardDenied,
  nextStep,
  summarizeEnabled,
  type PermissionStatus,
  type WizardStep,
} from "../../lib/permissions/permissionCore";

interface OnboardingWizardProps {
  open: boolean;
  onClose: () => void;
}

/** Short human status line under a permission step, reflecting the OS result. */
function statusLine(status: PermissionStatus): { text: string; tone: string } | null {
  switch (status) {
    case "granted":
      return { text: "Enabled — you're all set.", tone: "ok" };
    case "denied":
      return {
        text: "Blocked. You can re-enable it later in your browser's site settings.",
        tone: "warn",
      };
    case "unsupported":
      return { text: "Not supported on this device.", tone: "muted" };
    case "insecure-context":
      return { text: "Needs a secure (https) connection.", tone: "muted" };
    case "dismissed":
      return { text: "No problem — you can turn it on later.", tone: "muted" };
    default:
      return null;
  }
}

/**
 * First-run onboarding wizard that PRIMES each permission (explains the value
 * in-app) before ever firing the real OS prompt — so a "Not now" never burns a
 * permission. Focus-trapped, Escape-closable, keyboard operable, and safe to
 * dismiss at any point. Re-openable from Settings.
 */
export function OnboardingWizard({ open, onClose }: OnboardingWizardProps) {
  const perms = usePermissions();
  const [step, setStep] = useState<WizardStep>("welcome");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open, onClose);

  const refresh = perms.refresh;
  // Reset to the first step and re-read live status each time it opens.
  useEffect(() => {
    if (open) {
      setStep("welcome");
      setBusy(false);
      void refresh();
    }
  }, [open, refresh]);

  const titleId = "onboarding-wizard-title";
  const advance = () => {
    const next = nextStep(step);
    if (next) setStep(next);
  };

  // Dismissing before the end persists "not-now"; finishing persists "completed".
  const dismiss = () => {
    perms.setWizardChoice("not-now");
    onClose();
  };
  const finish = () => {
    perms.setWizardChoice("completed");
    onClose();
  };

  const enableNotifications = async () => {
    setBusy(true);
    await perms.enableNotifications();
    setBusy(false);
  };
  const enableLocation = async () => {
    setBusy(true);
    await perms.enableLocation();
    setBusy(false);
  };

  const notifLine = statusLine(perms.notifications);
  const locLine = statusLine(perms.location);
  const notifActed = perms.notifications !== "prompt";
  const locActed = perms.location !== "prompt";

  const doneSummary = useMemo(
    () => summarizeEnabled(perms.notifications, perms.location),
    [perms.notifications, perms.location],
  );

  if (!open) return null;

  return (
    <>
      <div className="wizard-backdrop overlay-enter" onClick={dismiss} aria-hidden />
      <div
        ref={dialogRef}
        className="wizard-card sheet-enter"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button type="button" className="wizard-close" aria-label="Close" onClick={dismiss}>
          <X size={20} />
        </button>

        <ol className="wizard-progress" aria-hidden>
          {(["welcome", "notifications", "location", "done"] as WizardStep[]).map((s) => (
            <li key={s} className={`wizard-dot${s === step ? " active" : ""}`} />
          ))}
        </ol>

        {step === "welcome" && (
          <div className="wizard-step">
            <span className="wizard-icon">
              <Sparkles size={26} />
            </span>
            <h2 id={titleId} className="wizard-title">
              Welcome to Infinity Windows
            </h2>
            <p className="wizard-body">
              Two quick options can make your day smoother: alerts for things that
              need you, and accurate location for clock-ins. You choose — nothing
              turns on without your say-so.
            </p>
            <div className="wizard-actions">
              <button type="button" className="wizard-btn primary" onClick={advance}>
                Get started
              </button>
              <button type="button" className="wizard-btn ghost" onClick={dismiss}>
                Skip for now
              </button>
            </div>
          </div>
        )}

        {step === "notifications" && (
          <div className="wizard-step">
            <span className="wizard-icon">
              <Bell size={26} />
            </span>
            <h2 id={titleId} className="wizard-title">
              Stay in the loop
            </h2>
            <p className="wizard-body">
              Get alerted for schedule changes, timecard approvals, and today's
              toolbox talk — right on your device.
            </p>
            {notifLine && (
              <p className={`wizard-status wizard-status-${notifLine.tone}`} role="status">
                {notifLine.text}
              </p>
            )}
            <div className="wizard-actions">
              {notifActed ? (
                <button type="button" className="wizard-btn primary" onClick={advance}>
                  Continue
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="wizard-btn primary"
                    onClick={enableNotifications}
                    disabled={busy}
                  >
                    {busy ? "Requesting…" : "Enable notifications"}
                  </button>
                  <button type="button" className="wizard-btn ghost" onClick={advance}>
                    Not now
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {step === "location" && (
          <div className="wizard-step">
            <span className="wizard-icon">
              <MapPin size={26} />
            </span>
            <h2 id={titleId} className="wizard-title">
              Accurate clock-ins
            </h2>
            <p className="wizard-body">
              Allow location for accurate clock-in/out stamps and on-site
              reminders. It's only captured at punches — never in the background.
            </p>
            {locLine && (
              <p className={`wizard-status wizard-status-${locLine.tone}`} role="status">
                {locLine.text}
              </p>
            )}
            <div className="wizard-actions">
              {locActed ? (
                <button type="button" className="wizard-btn primary" onClick={advance}>
                  Continue
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="wizard-btn primary"
                    onClick={enableLocation}
                    disabled={busy}
                  >
                    {busy ? "Requesting…" : "Enable location"}
                  </button>
                  <button type="button" className="wizard-btn ghost" onClick={advance}>
                    Not now
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="wizard-step">
            <span className="wizard-icon">
              <Check size={26} />
            </span>
            <h2 id={titleId} className="wizard-title">
              You're all set
            </h2>
            <p className="wizard-body">{doneSummary}</p>
            <ul className="wizard-recap">
              <li>
                <Bell size={16} aria-hidden />
                <span>Notifications</span>
                <strong className={perms.notifications === "granted" ? "on" : "off"}>
                  {perms.notifications === "granted"
                    ? "On"
                    : isHardDenied(perms.notifications)
                      ? "Blocked"
                      : "Off"}
                </strong>
              </li>
              <li>
                <MapPin size={16} aria-hidden />
                <span>Location</span>
                <strong className={perms.location === "granted" ? "on" : "off"}>
                  {perms.location === "granted"
                    ? "On"
                    : isHardDenied(perms.location)
                      ? "Blocked"
                      : "Off"}
                </strong>
              </li>
            </ul>
            <div className="wizard-actions">
              <button type="button" className="wizard-btn primary" onClick={finish}>
                Done
              </button>
              <Link to="/settings" className="wizard-btn ghost" onClick={finish}>
                Change later in Settings
              </Link>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
