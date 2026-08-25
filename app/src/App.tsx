import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import type { Session } from "@supabase/supabase-js";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  persister,
  prefetchWarehousePack,
  queryClient,
  shouldPersistQuery,
} from "./lib/queryClient";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { Layout } from "./components/Layout";
import { canAccess, roleRank, ROLE_NAV_V2, type RoutePath } from "./lib/nav";
import type { CrewRole } from "./lib/install/types";
import { ClockProvider, useClock } from "./lib/clockContext";
import { routerBasename } from "./lib/pwa/basePaths";
import { authErrorFromHash, isRecoveryLanding } from "./lib/passwordReset";
import { SetNewPassword } from "./components/SetNewPassword";
import { ViewAsRoleProvider } from "./lib/viewAsRole";
import { useEffectiveRole } from "./lib/useEffectiveRole";
import { supabase } from "./lib/supabase";
import { AskInfinity } from "./pages/AskInfinity";
import { AskMisses } from "./pages/AskMisses";
import { Knowledge } from "./pages/Knowledge";
import { AiSpend } from "./pages/AiSpend";
import { Home } from "./pages/Home";
import { Labels } from "./pages/Labels";
import { Landing } from "./pages/Landing";
import { Notifications } from "./pages/Notifications";
import { Team } from "./pages/Team";
import { Warehouse } from "./pages/Warehouse";
import { LocationDetail } from "./pages/LocationDetail";
import { ContainerViewer } from "./pages/storage/ContainerViewer";
import { Takeoffs } from "./pages/Takeoffs";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Projects } from "./pages/Projects";
import { Receive } from "./pages/Receive";
import { Scan } from "./pages/Scan";
import { StorageHub } from "./pages/storage/StorageHub";
import { ContainerDetail } from "./pages/storage/ContainerDetail";
import { TagPackages } from "./pages/storage/TagPackages";
import { LogDelivery } from "./pages/storage/LogDelivery";
import { CheckoutPackages } from "./pages/storage/CheckoutPackages";
import { StuckWrites } from "./pages/StuckWrites";
import { ArrivePackages } from "./pages/storage/ArrivePackages";
import { PackageSheet } from "./pages/storage/PackageSheet";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { OpeningReview } from "./pages/install/OpeningReview";
import { OpeningSheetRoute } from "./pages/install/OpeningSheet";
import { MapsTrace } from "./pages/install/MapsTrace";
const StudioList = lazy(() =>
  import("./pages/install/StudioList").then((m) => ({ default: m.StudioList })),
)
const StudioJobRoute = lazy(() =>
  import("./pages/install/StudioList").then((m) => ({ default: m.StudioJobRoute })),
)
const StudioProjectRoute = lazy(() =>
  import("./pages/install/StudioList").then((m) => ({ default: m.StudioProjectRoute })),
);
import { FlashRun } from "./pages/install/FlashRun";
import { JobModelViewer } from "./pages/install/JobModelViewer";
import { PlansetUpload } from "./pages/install/PlansetUpload";
import { ProjectMap } from "./pages/install/ProjectMap";
import { TypeBrainCard } from "./pages/install/TypeBrainCard";
import { CatalogImport } from "./pages/CatalogImport";
import { Crew } from "./pages/Crew";
import { CrewAccess } from "./pages/CrewAccess";
import { JoinCrew } from "./pages/JoinCrew";
import { readCodeFromUrl } from "../../supabase/functions/_shared/crewInvites";
import { MyWork } from "./pages/MyWork";
import { Issues } from "./pages/Issues";
import { Service } from "./pages/Service";
import { Heartbeat } from "./pages/Heartbeat";
import { Analytics } from "./pages/Analytics";
import { MemoReview } from "./pages/MemoReview";
import { Admin } from "./pages/Admin";
import { Timecard } from "./pages/Timecard";
import { TeamTimecards } from "./pages/TeamTimecards";
import { Scheduling } from "./pages/Scheduling";
import { MySchedule } from "./pages/MySchedule";
import { Travel } from "./pages/Travel";
import { TripDetail } from "./pages/TripDetail";
import { Vehicles } from "./pages/Vehicles";
import { VehicleDetail } from "./pages/VehicleDetail";
import { FleetMap } from "./pages/FleetMap";
import { CostCodes } from "./pages/CostCodes";
import { Costing } from "./pages/Costing";
import { Education } from "./pages/Education";
import { Photos } from "./pages/Photos";
import { Points } from "./pages/Points";
import { Safety } from "./pages/Safety";
import { ToolboxHistory } from "./pages/ToolboxHistory";
import { Supplies } from "./pages/Supplies";
import { Qc } from "./pages/Qc";
import { PinGate } from "./components/PinGate";
import { ComingSoon } from "./pages/ComingSoon";
import { ensureMyProfile } from "./lib/install/api";
import "./index.css";
import { DataHub } from "./pages/DataHub";

/**
 * Role-aware landing: installers land on My Work, foremen on the Infinity day
 * Home, and supervisors/owners on the cross-project Heartbeat (their pulse of
 * every active job). View-as aware via effectiveRole; the loading state renders
 * a neutral placeholder so we never flash the wrong landing before the profile
 * resolves.
 */
function RoleLanding() {
  const { effectiveRole: role, isLoading } = useEffectiveRole();
  if (!ROLE_NAV_V2) return <Home />;
  if (isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  const rank = roleRank(role);
  if (rank >= 2) return <Heartbeat />;
  if (rank >= 1) return <Home />;
  return <MyWork />;
}

/**
 * Route-level access guard. minRole comes from the same NAV registry (via the
 * route path), so nav visibility and route access can never drift. Uses the
 * effective (possibly previewed) role for presentation; server mutations still
 * run as the real user.
 */
function RequireRole({
  path,
  minRole,
  children,
}: {
  /** Registry path whose minRole gates access (nav-driven routes). */
  path?: RoutePath;
  /** Explicit role floor for detail routes not in the nav registry. */
  minRole?: CrewRole;
  children: ReactNode;
}) {
  const { effectiveRole: role, isLoading } = useEffectiveRole();
  if (!ROLE_NAV_V2) return <>{children}</>;
  if (isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  const allowed = minRole
    ? roleRank(role) >= roleRank(minRole)
    : canAccess(role, path ?? "");
  if (allowed) return <>{children}</>;
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Restricted</p>
          <h1>Not available for your role</h1>
        </div>
      </header>
      <p className="muted">
        This area is for a different role. If you think you need access, ask your
        supervisor.
      </p>
      <Link to="/" className="button-like">Back to home</Link>
    </div>
  );
}

/** Legacy /install/:projectId/* bookmarks → unified /projects/:id hub. */
function LegacyInstallRedirect({ suffix = "" }: { suffix?: string }) {
  const { projectId = "" } = useParams();
  return <Navigate to={`/projects/${projectId}${suffix}`} replace />;
}

function LegacyInstallOpeningRedirect() {
  const { projectId = "", openingId = "" } = useParams();
  return (
    <Navigate to={`/projects/${projectId}/opening/${openingId}`} replace />
  );
}

/** The Studio left the job tabs (owner ask) — old links land on the new home. */
function LegacyStudioRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={`/studio/j/${id}`} replace />;
}

/**
 * /clock used to be its own page with a second, weaker clock-in flow (hard
 * toolbox-talk gate, no offline support, breaks always logged as "other").
 * Push-notification deep links and old bookmarks still point here, so the
 * route has to keep working — it just opens the one real clock sheet (the
 * same bottom sheet the nav Clock tab and Home's clock card use) and lands
 * on the normal home screen behind it, instead of a page of its own.
 */
function ClockRoute() {
  const { openClock } = useClock();
  useEffect(() => {
    openClock();
  }, [openClock]);
  return <Navigate to="/" replace />;
}

// The landing hash, read at IMPORT TIME — before the supabase client's async
// URL detection strips it. This is how a cold load knows it came from a
// password-reset email (type=recovery) or from an expired link (error_code).
const LANDING_HASH = typeof window !== "undefined" ? window.location.hash : "";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  // Password recovery: true when this load came from a reset email, or when
  // supabase fires PASSWORD_RECOVERY after picking the tokens out of the URL.
  const [recovery, setRecovery] = useState(() => isRecoveryLanding(LANDING_HASH));
  // An expired/used reset link lands with an error hash and no session —
  // surface it on the sign-in screen instead of booting as if nothing happened.
  const [landingNotice] = useState(() => authErrorFromHash(LANDING_HASH));
  const [ready, setReady] = useState(false);
  // A landing notice (expired reset link) skips the splash — the person came
  // here to fix their password, so land them on the sign-in screen that says so.
  const [entered, setEntered] = useState(() => landingNotice != null);
  const [signInMode, setSignInMode] = useState<"signin" | "request">("signin");

  /**
   * An invite code arriving as `?join=…` on the app's root URL.
   *
   * Read once, from the URL the browser actually opened, and NOT via the router
   * — the whole point of putting the code in a query on the root is that it
   * works on a static host with no rewrite rules, where a deep path like `/join`
   * would be GitHub's 404 page instead of the app. A new hire tapping the only
   * code he will ever be sent must not land on a blank screen.
   */
  const [joinCode, setJoinCode] = useState<string | null>(() =>
    readCodeFromUrl(window.location.search),
  );
  /** They have a code but no link — the text got mangled, so they type it. */
  const [joining, setJoining] = useState(false);

  // Take the code out of the address bar once it has been picked up, so a
  // refresh (or a screenshot of the URL) does not re-offer it, and so the code
  // stops sitting in browser history.
  useEffect(() => {
    if (!joinCode) return;
    const clean = window.location.pathname + window.location.hash;
    window.history.replaceState(null, "", clean);
  }, [joinCode]);

  useEffect(() => {
    // The warehouse pack is pulled here, at sign-in, and not on the warehouse
    // page (D9): it used to fire from that page's own mount, at the same
    // instant as the queries it was supposed to be ahead of, which bought
    // nobody anything. Somebody who signs in at the shop and drives to a conex
    // now has the answers on the phone before they lose signal. Quiet and
    // non-blocking by design — it never rejects, and a miss just leaves the
    // cache holding whatever it already had.
    const onSignedIn = (s: Session | null) => {
      if (!s) return;
      void ensureMyProfile().catch(() => {});
      void prefetchWarehousePack();
    };
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      onSignedIn(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession(s);
      onSignedIn(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) {
    return (
      <div className="page" style={{ padding: 24, textAlign: "center" }}>
        <p className="muted">Connecting…</p>
      </div>
    );
  }
  // Someone redeeming an invite has no session yet, by definition, so this sits
  // ahead of the landing/sign-in screens rather than on a route inside the
  // authenticated app.
  if (joinCode || joining) {
    return (
      <JoinCrew
        code={joinCode}
        onGiveUp={() => {
          setJoinCode(null);
          setJoining(false);
        }}
      />
    );
  }

  // Landed here from a password-reset email with a live session: the ONE job
  // is picking the new password. Everything else waits behind it.
  if (recovery && session) {
    return (
      <SetNewPassword
        onDone={() => {
          setRecovery(false);
          // Drop the spent tokens/hash from the address bar and history.
          window.history.replaceState(null, "", window.location.pathname);
        }}
      />
    );
  }

  if (!session) {
    if (!entered) {
      return (
        <Landing
          onSignIn={() => {
            setSignInMode("signin");
            setEntered(true);
          }}
          onRequest={() => {
            setSignInMode("request");
            setEntered(true);
          }}
        />
      );
    }
    return (
      <SignIn
        initialMode={signInMode}
        initialNotice={landingNotice}
        onHaveInviteCode={() => setJoining(true)}
      />
    );
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: persister!,
        maxAge: 1000 * 60 * 60 * 24 * 7,
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => shouldPersistQuery(query.queryKey),
        },
      }}
    >
      <PinGate>
      <ViewAsRoleProvider>
      <BrowserRouter basename={routerBasename(import.meta.env.BASE_URL)}>
        <ClockProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<RoleLanding />} />
            <Route path="/warehouse" element={<Warehouse />} />
            {/* One list per hub number: /warehouse/on-hand, /putaway, /staged,
                /damaged. Anything else redirects back to the hub. */}
            <Route path="/ask" element={<AskInfinity />} />
            <Route
              path="/ask-misses"
              element={
                <RequireRole minRole="foreman">
                  <AskMisses />
                </RequireRole>
              }
            />
            <Route
              path="/knowledge"
              element={<RequireRole path="/knowledge"><Knowledge /></RequireRole>}
            />
            <Route
              path="/ai-spend"
              element={<RequireRole path="/ai-spend"><AiSpend /></RequireRole>}
            />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/stuck" element={<StuckWrites />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/team"
              element={<RequireRole path="/team"><Team /></RequireRole>}
            />
            <Route
              path="/issues"
              element={<RequireRole path="/issues"><Issues /></RequireRole>}
            />
            <Route
              path="/service"
              element={<RequireRole path="/service"><Service /></RequireRole>}
            />
            <Route
              path="/heartbeat"
              element={<RequireRole path="/heartbeat"><Heartbeat /></RequireRole>}
            />
            <Route path="/scan" element={<Scan />} />
            {/* The container hub is foreman+ (D6). The registry floor alone
                does not lock a route — this wrapper does — and /storage was
                open to anyone who typed the address while the warehouse page
                kept the same tools to leads.

                Everything else here stays open on purpose. Installers tag,
                check out and check arrivals themselves — from the warehouse
                page's "Coming in" and "Going out" sections, both of which stay
                open to everyone precisely so this lock does not take tagging
                away from whoever is at the truck (S3). And ONE container's
                page is the far end of "where is it": the Find bar on the
                warehouse page hands an installer an "Open Conex 7" button, and
                store_packages / move_container ask only that you are signed
                in. The lead-only actions on that page (Edit, Archive) are
                gated inside it, which is the same line save_storage_container
                draws server-side. */}
            <Route
              path="/storage"
              element={<RequireRole path="/storage"><StorageHub /></RequireRole>}
            />
            <Route path="/storage/log-delivery" element={<LogDelivery />} />
            <Route path="/storage/tag" element={<TagPackages />} />
            <Route path="/storage/out" element={<CheckoutPackages />} />
            <Route path="/storage/arrive" element={<ArrivePackages />} />
            <Route path="/storage/c/:id" element={<ContainerDetail />} />
            {/* The 3D viewer is installer-open ON PURPOSE — it is the map,
                not the pen. The Studio editor stays supervisor+. */}
            <Route path="/warehouse/3d/:id" element={<ContainerViewer />} />
            <Route path="/takeoffs" element={<Takeoffs />} />
            <Route path="/pkg/:serial" element={<PackageSheet />} />
            <Route
              path="/receive"
              element={<RequireRole path="/receive"><Receive /></RequireRole>}
            />
            <Route path="/search" element={<Navigate to="/warehouse" replace />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<ProjectDetail />} />
            <Route
              path="/projects/:projectId/map"
              element={<ProjectMap />}
            />
            <Route
              path="/projects/:projectId/upload"
              element={
                <RequireRole minRole="foreman">
                  <PlansetUpload />
                </RequireRole>
              }
            />
            <Route
              path="/projects/:projectId/review"
              element={
                <RequireRole minRole="foreman">
                  <OpeningReview />
                </RequireRole>
              }
            />
            <Route
              path="/projects/:projectId/opening/:openingId"
              element={<OpeningSheetRoute />}
            />
            <Route
              path="/data"
              element={
                <RequireRole path="/data">
                  <DataHub />
                </RequireRole>
              }
            />
            <Route
              path="/studio"
              element={
                <RequireRole path="/studio">
                  <Suspense fallback={<div className="page"><p className="muted">Loading the Studio…</p></div>}>
                    <StudioList />
                  </Suspense>
                </RequireRole>
              }
            />
            <Route
              path="/studio/j/:projectId"
              element={
                <RequireRole minRole="supervisor">
                  <Suspense fallback={<div className="page"><p className="muted">Loading the Studio…</p></div>}>
                    <StudioJobRoute />
                  </Suspense>
                </RequireRole>
              }
            />
            <Route
              path="/studio/p/:id"
              element={
                <RequireRole minRole="supervisor">
                  <Suspense fallback={<div className="page"><p className="muted">Loading the Studio…</p></div>}>
                    <StudioProjectRoute />
                  </Suspense>
                </RequireRole>
              }
            />
            <Route
              path="/projects/:id/model-studio"
              element={<LegacyStudioRedirect />}
            />
            <Route
              path="/projects/:projectId/trace-model"
              element={
                // The 3D model is the whole crew's reference; EDITING it is an
                // owner/supervisor call (stories design doc) — foremen and
                // installers view, never reshape.
                <RequireRole minRole="supervisor">
                  <MapsTrace />
                </RequireRole>
              }
            />
            {/* The phone-friendly job model viewer (Studio 100x #27) is
                installer-open ON PURPOSE — same line ContainerViewer draws
                for a container's shell: it is the map, not the pen. Studio
                itself stays supervisor+ and desktop-only, above. */}
            <Route path="/projects/:projectId/model" element={<JobModelViewer />} />
            {/* Flashing ahead of the crew is any installer's job — no gate
                beyond being signed in; the server enforces the clock rules. */}
            <Route path="/projects/:projectId/flash-run" element={<FlashRun />} />
            <Route path="/brain/:typeId" element={<TypeBrainCard />} />
            <Route
              path="/catalog"
              element={<RequireRole path="/catalog"><CatalogImport /></RequireRole>}
            />
            <Route
              path="/crew"
              element={<RequireRole path="/crew"><Crew /></RequireRole>}
            />
            <Route
              path="/access"
              element={<RequireRole path="/access"><CrewAccess /></RequireRole>}
            />
            <Route
              path="/admin"
              element={<RequireRole path="/admin"><Admin /></RequireRole>}
            />
            <Route
              path="/analytics"
              element={<RequireRole path="/analytics"><Analytics /></RequireRole>}
            />
            <Route path="/my-work" element={<MyWork />} />
            <Route path="/review" element={<MemoReview />} />
            <Route path="/training" element={<Navigate to="/learn" replace />} />
            <Route path="/clock" element={<ClockRoute />} />
            <Route
              path="/timecard"
              element={<RequireRole path="/timecard"><Timecard /></RequireRole>}
            />
            <Route
              path="/team-timecards"
              element={<RequireRole path="/team-timecards"><TeamTimecards /></RequireRole>}
            />
            <Route
              path="/scheduling"
              element={<RequireRole path="/scheduling"><Scheduling /></RequireRole>}
            />
            <Route
              path="/vehicles"
              element={<RequireRole path="/vehicles"><Vehicles /></RequireRole>}
            />
            <Route
              path="/vehicles/map"
              element={
                <RequireRole minRole="supervisor">
                  <FleetMap />
                </RequireRole>
              }
            />
            <Route
              path="/vehicles/:vehicleId"
              element={
                <RequireRole minRole="supervisor">
                  <VehicleDetail />
                </RequireRole>
              }
            />
            <Route
              path="/my-schedule"
              element={<RequireRole path="/my-schedule"><MySchedule /></RequireRole>}
            />
            <Route
              path="/travel"
              element={<RequireRole path="/travel"><Travel /></RequireRole>}
            />
            <Route path="/travel/:tripId" element={<TripDetail />} />
            <Route
              path="/cost-codes"
              element={<RequireRole path="/cost-codes"><CostCodes /></RequireRole>}
            />
            <Route
              path="/costing"
              element={<RequireRole path="/costing"><Costing /></RequireRole>}
            />
            <Route path="/learn" element={<Education />} />
            <Route path="/points" element={<Points />} />
            <Route path="/safety" element={<Safety />} />
            <Route
              path="/supplies"
              element={<RequireRole path="/supplies"><Supplies /></RequireRole>}
            />
            <Route
              path="/qc"
              element={<RequireRole path="/qc"><Qc /></RequireRole>}
            />
            <Route path="/loc/:address" element={<LocationDetail />} />
            <Route
              path="/labels"
              element={<RequireRole path="/labels"><Labels /></RequireRole>}
            />

            {/* Horizon-menu stub destinations → shared "Coming soon" page.
                Role gating still flows from the NAV registry via RequireRole. */}
            <Route path="/photos" element={<Photos />} />
            <Route
              path="/daily-logs"
              element={
                <RequireRole path="/daily-logs">
                  <ComingSoon title="Daily logs" />
                </RequireRole>
              }
            />
            <Route
              path="/completed-installs"
              element={<ComingSoon title="Completed installs" />}
            />
            <Route path="/milestones" element={<ComingSoon title="Milestones" />} />
            <Route path="/first-pane" element={<ComingSoon title="First Pane" />} />
            <Route path="/toolbox-history" element={<ToolboxHistory />} />
            <Route
              path="/conditions"
              element={
                <RequireRole path="/conditions">
                  <ComingSoon title="Conditions" />
                </RequireRole>
              }
            />
            <Route
              path="/contacts"
              element={
                <RequireRole path="/contacts">
                  <ComingSoon title="Contacts" />
                </RequireRole>
              }
            />
            <Route path="/profile" element={<ComingSoon title="Profile" />} />
            <Route path="/public-site" element={<ComingSoon title="Public site" />} />

            {/* Legacy install routes → unified hub */}
            <Route path="/install" element={<Navigate to="/projects" replace />} />
            <Route
              path="/install/brain/:typeId"
              element={<TypeBrainCard />}
            />
            <Route
              path="/install/:projectId"
              element={<LegacyInstallRedirect suffix="?tab=map" />}
            />
            <Route
              path="/install/:projectId/upload"
              element={<LegacyInstallRedirect suffix="/upload" />}
            />
            <Route
              path="/install/:projectId/review"
              element={<LegacyInstallRedirect suffix="/review" />}
            />
            <Route
              path="/install/:projectId/opening/:openingId"
              element={<LegacyInstallOpeningRedirect />}
            />

            {/* Unknown paths → home (keeps launcher tiles safe as modules land) */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </ClockProvider>
      </BrowserRouter>
      </ViewAsRoleProvider>
      </PinGate>
    </PersistQueryClientProvider>
  );
}
