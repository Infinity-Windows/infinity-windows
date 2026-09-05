import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { listProjectsAnyStatus } from "./lib/api";
import { isTrackingOnly } from "./lib/jobModes";
import {
  persister,
  prefetchWarehousePack,
  queryClient,
  shouldPersistQueryState,
} from "./lib/queryClient";
import {
  useLocation,
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
import { gcTokenFromPath } from "./lib/gcToken";
import { authErrorFromHash, isRecoveryLanding } from "./lib/passwordReset";
import { SetNewPassword } from "./components/SetNewPassword";
import { ViewAsRoleProvider } from "./lib/viewAsRole";
import { useEffectiveRole } from "./lib/useEffectiveRole";
import { supabase } from "./lib/supabase";
import { rememberSignedIn } from "./lib/signedIn";
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
import { JobHistory } from "./pages/JobHistory";
import { Receive } from "./pages/Receive";
import { Scan } from "./pages/Scan";
import { ContainerDetail } from "./pages/storage/ContainerDetail";
import { TagPackages } from "./pages/storage/TagPackages";
import { LogDelivery } from "./pages/storage/LogDelivery";
import { DeliveryDetail } from "./pages/storage/DeliveryDetail";
import { RewriteSet } from "./pages/storage/RewriteSet";
import { DeliveriesList } from "./pages/storage/DeliveriesList";
import { JobMaterials } from "./pages/storage/JobMaterials";
import { CheckoutPackages } from "./pages/storage/CheckoutPackages";
import { StuckWrites } from "./pages/StuckWrites";
import { Suggestions } from "./pages/Suggestions";
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
import { TypeBrainCard } from "./pages/install/TypeBrainCard";
import { CatalogImport } from "./pages/CatalogImport";
import { Crew } from "./pages/Crew";
import { CrewAccess } from "./pages/CrewAccess";
import { GcPage } from "./pages/GcPage";
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
import { Receipts } from "./pages/Receipts";
import { Education } from "./pages/Education";
import { Photos } from "./pages/Photos";
import { Points } from "./pages/Points";
import { Safety } from "./pages/Safety";
import { ToolboxHistory } from "./pages/ToolboxHistory";
import { Supplies } from "./pages/Supplies";
import { Qc } from "./pages/Qc";
import { PinGate } from "./components/PinGate";
import { LanguageProvider } from "./lib/i18n";
import { FirstRunLanguagePicker } from "./components/LanguagePicker";
import { ensureMyProfile } from "./lib/install/api";
import "./index.css";
import { DataHub } from "./pages/DataHub";
import { StgApp } from "./pages/stg/StgApp";
import { useIsPartnerUser } from "./lib/stg";
import { AccountBuilders } from "./pages/AccountBuilders";

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
  const { effectiveRole: role, isLoading, grants } = useEffectiveRole();
  if (!ROLE_NAV_V2) return <>{children}</>;
  if (isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  // `minRole` routes are detail pages with no registry entry, so no money grant
  // can open one — Wave Z's grant only ever unlocks a named money destination.
  const allowed = minRole
    ? roleRank(role) >= roleRank(minRole)
    : canAccess(role, path ?? "", grants);
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

/**
 * THE WALL #5 (20260950000000_partner_wall.sql): a partner (builder/GC
 * login) redirects to /stg for every OTHER path. Server-side RLS is the
 * real wall — every crew table is unreadable to a partner regardless of
 * what renders here — this is manners: it stops the crew shell (Layout,
 * its nav, its bottom bar) from ever mounting for a partner at all, rather
 * than mounting it and having every query inside it come back empty.
 * Wraps the Layout ROUTE itself (not something inside it), so the redirect
 * fires before Layout — and the nav it draws — ever renders.
 */
function RequirePartnerElsewhere({ children }: { children: ReactNode }) {
  const isPartner = useIsPartnerUser();
  if (isPartner.isLoading) {
    return <div className="page"><p className="muted">Loading…</p></div>;
  }
  if (isPartner.data) return <Navigate to="/stg" replace />;
  return <>{children}</>;
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
 * A data-only guard for the per-window routes (standard-tracking-jobs slice 2).
 * A tracking-only job has no openings, no 3D model, no flash runs and no Studio,
 * so those URLs must not reach a feature the job doesn't have — pasted, bookmarked
 * or arrived at by a stale link. It sends them back to the job's hub, where the
 * tracking tab set (ProjectDetail) is the only way in. Reads the same cached
 * `projectsAll` list ProjectDetail uses; while the mode is unknown it holds a
 * brief loader rather than flashing the feature or wrongly redirecting, and if
 * the job isn't in the list at all it fails open (renders the child) so a
 * legitimate data job is never blocked by a cold cache.
 */
function RequireDataJob({ children }: { children: ReactNode }) {
  const { projectId = "" } = useParams();
  const projects = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });
  if (projects.isLoading) {
    return <div className="page"><p className="muted">Loading…</p></div>;
  }
  const project = projects.data?.find((p) => p.id === projectId);
  if (project && isTrackingOnly(project.allowed_modes)) {
    return <Navigate to={`/projects/${projectId}`} replace />;
  }
  return <>{children}</>;
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

// Wave H (H2): the GC's link, read at IMPORT TIME from the address the browser
// actually opened. A general contractor has no account here and never will, so
// his page is decided before the router, before the session, and before the
// splash — the same reasoning that puts the crew invite's `?join=` code ahead
// of everything, and for a stronger reason: an invite ends in an account, and
// this never does. On GitHub Pages the deep path reaches the app at all only
// because 404.html is a byte-copy of index.html (vite.config.ts).
const GC_TOKEN =
  typeof window !== "undefined"
    ? gcTokenFromPath(window.location.pathname, import.meta.env.BASE_URL)
    : null;


/** Stamps data-section on <html> from the route, driving the section auras
 *  (owner picks 8 + 15): warehouse steel, install coral, office violet,
 *  learn green. Wayfinding by hue — the tint, not a repaint. */
function SectionAura() {
  const { pathname } = useLocation();
  useEffect(() => {
    const section = /^\/(warehouse|storage|pkg)/.test(pathname)
      ? "warehouse"
      : /^\/(projects|install|studio|summon)/.test(pathname)
        ? "install"
        : /^\/(scheduling|my-schedule|timecards|heartbeat|team|admin|issues|travel)/.test(pathname)
          ? "office"
          : /^\/(learn|points|toolbox|safety)/.test(pathname)
            ? "learn"
            : null;
    if (section) document.documentElement.dataset.section = section;
    else delete document.documentElement.dataset.section;
  }, [pathname]);
  return null;
}

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
  /** The GC link this load came from, if any. Read once, at import time. */
  const [gcToken] = useState<string | null>(() => GC_TOKEN);

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
      // This is the ONE place the app asks who is signed in. Everywhere that
      // only wants a name on a record — the photo shutter above all — reads
      // lib/signedIn instead of making its own auth call, because an auth call
      // in the middle of a tap is a network round trip, and on a token that has
      // gone stale offline it is a long one that answers "nobody".
      rememberSignedIn(data.session);
      setSession(data.session);
      setReady(true);
      onSignedIn(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      rememberSignedIn(s);
      setSession(s);
      onSignedIn(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Wave H (H2): the GC's page, ahead of EVERYTHING — ahead of the "Connecting…"
  // splash, not only ahead of sign-in. The splash waits on getSession(), which
  // is a question about a person who does not have an account; a builder tapping
  // a link from a text message would sit there for it, and on a bad connection
  // sit there for a while. He is not signing in, so he does not wait for the
  // answer. Everything this page shows comes from the gc-link edge function on
  // the service role; the token grants no table access at all.
  if (gcToken) return <GcPage token={gcToken} />;

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
          // Key AND status — a query still in flight must not be written to
          // disk, because its dehydrated form carries a promise that cannot
          // survive JSON and takes the whole cache down with it on the next
          // launch. See shouldPersistQueryState.
          shouldDehydrateQuery: (query) =>
            shouldPersistQueryState(query.queryKey, query.state.status),
        },
      }}
    >
      <LanguageProvider>
      {/* The first-login language choice sits above everything — even the PIN
          gate — so a new crew member picks their language before the app asks
          for anything else. It renders nothing once a choice exists. */}
      <FirstRunLanguagePicker />
      <PinGate>
      <ViewAsRoleProvider>
      <BrowserRouter basename={routerBasename(import.meta.env.BASE_URL)}>
        <ClockProvider>
        <SectionAura />
        <Routes>
          {/* A partner's whole app — outside the crew Layout entirely, so no
              crew chrome (nav, bottom bar, values strip) can ever mount for
              a builder login. Reachable by crew too (nothing forbids it),
              but every read inside it is a partner-only projection RPC that
              rejects a non-partner caller server-side (S3). */}
          <Route path="/stg/*" element={<StgApp />} />
          <Route element={<RequirePartnerElsewhere><Layout /></RequirePartnerElsewhere>}>
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
            <Route
              path="/account/builders"
              element={<RequireRole path="/account/builders"><AccountBuilders /></RequireRole>}
            />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/stuck" element={<StuckWrites />} />
            <Route path="/suggestions" element={<Suggestions />} />
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
            {/* The Storage hub merged into /warehouse (ticket 18) — its
                container tiles, minting, new-container and posters tools all
                live there now, still lead-gated exactly as they were here.
                This address just forwards old links/bookmarks, same bare
                pattern as /search below: no RequireRole, because a redirect
                has nothing of its own left to guard.

                Everything else here stays open on purpose. Installers tag,
                check out and check arrivals themselves — from the warehouse
                page's "Coming in" and "Going out" sections, both of which stay
                open to everyone precisely so no lock takes tagging away from
                whoever is at the truck (S3). And ONE container's page is the
                far end of "where is it": the Find bar on the warehouse page
                hands an installer an "Open Conex 7" button, and
                store_packages / move_container ask only that you are signed
                in. Since ADR-0007 that page's Edit and Archive are open to
                every crew member too, which is the same line
                save_storage_container now draws server-side; the one action
                still gated inside it is the sweep-delete. */}
            <Route path="/storage" element={<Navigate to="/warehouse" replace />} />
            <Route path="/storage/log-delivery" element={<LogDelivery />} />
            <Route path="/storage/d/:id" element={<DeliveryDetail />} />
            {/* Wave R: the one "Rewrite this set" editor, reachable from
                both doors (the ledger's set-level edit and the tailgate's
                "Edit set…") — no RequireRole, same as its siblings above.
                Since ADR-0007 rewrite_set itself is open to any crew member;
                what the server still refuses is the "Start this set over"
                path, which is delete_packages. */}
            <Route path="/storage/rewrite-set" element={<RewriteSet />} />
            <Route path="/storage/deliveries" element={<DeliveriesList />} />
            <Route path="/warehouse/materials" element={<JobMaterials />} />
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
            <Route path="/jobs/history" element={<JobHistory />} />
            <Route path="/projects/:projectId" element={<ProjectDetail />} />
            {/* Bare /map bookmarks and links → the merged Maps tab. Same
                machinery as the /install/:projectId legacy redirects below:
                ?tab=map is the address ProjectDetail already treats as a
                legacy deep link, landing on the merged tab's Sheets view. */}
            <Route
              path="/projects/:projectId/map"
              element={<LegacyInstallRedirect suffix="?tab=map" />}
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
              element={<RequireDataJob><OpeningSheetRoute /></RequireDataJob>}
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
                <RequireDataJob>
                  <RequireRole minRole="supervisor">
                    <Suspense fallback={<div className="page"><p className="muted">Loading the Studio…</p></div>}>
                      <StudioJobRoute />
                    </Suspense>
                  </RequireRole>
                </RequireDataJob>
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
                //
                // Deliberately NOT wrapped in RequireDataJob: it isn't in slice
                // 2's route-guard list, it's only ever reached from the (hidden
                // on a tracking job) Maps Interactive tab, and — the real reason
                // — the guard warms the projectsAll cache, which on a trace →
                // Submit → map hop makes MapsInteractive mount before the
                // invalidated outline refetch lands, dropping the north rose it
                // reads once at mount (wave-n-true-north.spec).
                <RequireRole minRole="supervisor">
                  <MapsTrace />
                </RequireRole>
              }
            />
            {/* The phone-friendly job model viewer (Studio 100x #27) is
                installer-open ON PURPOSE — same line ContainerViewer draws
                for a container's shell: it is the map, not the pen. Studio
                itself stays supervisor+ and desktop-only, above. */}
            <Route
              path="/projects/:projectId/model"
              element={<RequireDataJob><JobModelViewer /></RequireDataJob>}
            />
            {/* Flashing ahead of the crew is any installer's job — no gate
                beyond being signed in; the server enforces the clock rules. A
                tracking-only job has no openings to flash, so it's guarded. */}
            <Route
              path="/projects/:projectId/flash-run"
              element={<RequireDataJob><FlashRun /></RequireDataJob>}
            />
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
            <Route
              path="/receipts"
              element={<RequireRole path="/receipts"><Receipts /></RequireRole>}
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

            {/* Two real Horizon-menu destinations survive here; the eight
                stub siblings that used to share this block (daily logs,
                completed installs, milestones, First Pane, conditions,
                contacts, profile, public site) never got a menu row of their
                own and only ever rendered a "Coming soon" placeholder — dead
                ends, cut in the ticket-24 sweep. Unknown paths fall through to
                the catch-all below and land on home, same as any other typo'd
                address. */}
            <Route path="/photos" element={<Photos />} />
            <Route path="/toolbox-history" element={<ToolboxHistory />} />

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
      </LanguageProvider>
    </PersistQueryClientProvider>
  );
}
