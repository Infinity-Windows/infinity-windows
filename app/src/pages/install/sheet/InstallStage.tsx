// STAGE 2 of the unit sheet (S7): the running clock. Four distinct states,
// and only one of them counts — landing on this step is not starting, the
// clock runs when the install actually began (server timestamp first, this
// device's own note of the start as the offline fallback). Moved out of
// OpeningSheet.tsx unchanged; every mutation still lives in the router.
import { useT } from "../../../lib/i18n";
import type { InstallTimerView } from "../../../lib/install/installTimer";
import { SummonPanel } from "../../../components/install/SummonPanel";
import { SheetMore, type SheetMoreProps } from "./SheetMore";

export interface InstallStageProps {
  timer: InstallTimerView;
  startedAt: string | null;
  tips: string[];
  onOpenClock: () => void;
  beginInstallPending: boolean;
  onBeginInstall: () => void;

  summon: {
    projectId: string;
    openingId: string;
    openingCode: string;
    widthIn: number | null;
    heightIn: number | null;
    myProfileId: string | null;
    myName: string | null;
    effectiveRole: string;
  };

  more: Omit<SheetMoreProps, "stage" | "installed">;
}

export function InstallStage({
  timer,
  startedAt,
  tips,
  onOpenClock,
  beginInstallPending,
  onBeginInstall,
  summon,
  more,
}: InstallStageProps) {
  const t = useT();

  return (
    <div className="install-timer">
      {timer.status === "running" || timer.status === "stale" ? (
        <>
          <div className="install-pulse" aria-hidden>
            ●
          </div>
          <p className="next-label" style={{ margin: 0 }}>Installing</p>
          {timer.status === "running" ? (
            <>
              <p className="next-code">
                {timer.minutes}
                <span style={{ fontSize: 28 }}> min</span>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Timer running. Plumb, level, square — then capture it.
              </p>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              This has been open since{" "}
              {startedAt ? new Date(startedAt).toLocaleString() : "a while ago"},
              so the stopwatch stopped counting. Your time still comes from
              your clocked sessions — nothing to type. Carry on and capture
              it.
            </p>
          )}
          {tips.length > 0 && (
            <ol className="tip-list" style={{ textAlign: "left", width: "100%" }}>
              {tips.slice(0, 3).map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ol>
          )}
          {/* A live summon shows HERE too, inline and unfolded — helpers
              answering the ring land on this stage, not the caller's install
              screen, and this is the running install itself, not exceptional
              (sheetStages.showSummonFold only folds Check's copy). */}
          <SummonPanel
            projectId={summon.projectId}
            openingId={summon.openingId}
            openingCode={summon.openingCode}
            widthIn={summon.widthIn}
            heightIn={summon.heightIn}
            myProfileId={summon.myProfileId}
            myName={summon.myName}
            effectiveRole={summon.effectiveRole}
            installRunning
          />
          {/* The stage's one button — "Done — capture it" — is now the
              pinned primary button the router renders above the tab bar
              (installer-os-spec.md S7, item 3); it used to sit right here. */}
        </>
      ) : timer.status === "blocked" ? (
        <>
          <p className="next-label" style={{ margin: 0 }}>Not started</p>
          <p className="muted" style={{ margin: 0 }}>
            Nothing is being timed. Clock in and sign today's toolbox talk,
            then start this window.
          </p>
          <button className="primary big" onClick={onOpenClock}>
            {t("opening.action.clockIn")}
          </button>
        </>
      ) : timer.status === "unknown" ? (
        <p className="muted" style={{ margin: 0 }}>Checking your clock…</p>
      ) : (
        <>
          <p className="next-label" style={{ margin: 0 }}>Ready when you are</p>
          <p className="muted" style={{ margin: 0 }}>
            Nothing is being timed yet. Tap start when you actually begin
            fitting this one.
          </p>
          <button className="primary big" disabled={beginInstallPending} onClick={onBeginInstall}>
            {beginInstallPending ? t("opening.action.starting") : t("opening.action.startTimer")}
          </button>
        </>
      )}

      <SheetMore stage="install" installed={false} {...more} />
    </div>
  );
}
