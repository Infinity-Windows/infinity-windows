import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState, type ReactNode } from "react";
import { persister, queryClient, shouldPersistQuery } from "./lib/queryClient";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { Layout } from "./components/Layout";
import { getMyProfile } from "./lib/install/api";
import { canAccess, roleRank, ROLE_NAV_V2, type RoutePath } from "./lib/nav";
import type { CrewRole } from "./lib/install/types";
import { ClockProvider } from "./lib/clockContext";
import { ViewAsRoleProvider } from "./lib/viewAsRole";
import { effectiveRole, useViewAsRole } from "./lib/viewAsRoleContext";
import { supabase } from "./lib/supabase";
import { AskInfinity } from "./pages/AskInfinity";
import { Knowledge } from "./pages/Knowledge";
import { CycleCount } from "./pages/CycleCount";
import { Home } from "./pages/Home";
import { Labels } from "./pages/Labels";
import { Landing } from "./pages/Landing";
import { Notifications } from "./pages/Notifications";
import { Team } from "./pages/Team";
import { Warehouse } from "./pages/Warehouse";
import { LocationDetail } from "./pages/LocationDetail";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Projects } from "./pages/Projects";
import { Receive } from "./pages/Receive";
import { Scan } from "./pages/Scan";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { WindowDetail } from "./pages/WindowDetail";
import { OpeningReview } from "./pages/install/OpeningReview";
import { OpeningSheetRoute } from "./pages/install/OpeningSheet";
import { PlansetUpload } from "./pages/install/PlansetUpload";
import { ProjectMap } from "./pages/install/ProjectMap";
import { TypeBrainCard } from "./pages/install/TypeBrainCard";
import { CatalogImport } from "./pages/CatalogImport";
import { Crew } from "./pages/Crew";
import { MyWork } from "./pages/MyWork";
import { Issues } from "./pages/Issues";
import { Service } from "./pages/Service";
import { Heartbeat } from "./pages/Heartbeat";
import { Analytics } from "./pages/Analytics";
import { MemoReview } from "./pages/MemoReview";
import { Training } from "./pages/Training";
import { Admin } from "./pages/Admin";
import { TimeClock } from "./pages/TimeClock";
import { Timecard } from "./pages/Timecard";
import { Scheduling } from "./pages/Scheduling";
import { MySchedule } from "./pages/MySchedule";
import { CostCodes } from "./pages/CostCodes";
import { Costing } from "./pages/Costing";
import { Education } from "./pages/Education";
import { Photos } from "./pages/Photos";
import { Points } from "./pages/Points";
import { Safety } from "./pages/Safety";
import { Tools } from "./pages/Tools";
import { Supplies } from "./pages/Supplies";
import { Qc } from "./pages/Qc";
import { PinGate } from "./components/PinGate";
import { ComingSoon } from "./pages/ComingSoon";
import { ensureMyProfile } from "./lib/install/api";
import "./index.css";

/**
 * Role-aware landing: installers land on My Work, foremen on the Infinity day
 * Home, and supervisors/owners on the cross-project Heartbeat (their pulse of
 * every active job). View-as aware via effectiveRole; the loading state renders
 * a neutral placeholder so we never flash the wrong landing before the profile
 * resolves.
 */
function RoleLanding() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const view = useViewAsRole();
  if (!ROLE_NAV_V2) return <Home />;
  if (me.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  const rank = roleRank(effectiveRole(me.data?.role, view));
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
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const view = useViewAsRole();
  if (!ROLE_NAV_V2) return <>{children}</>;
  if (me.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  const role = effectiveRole(me.data?.role, view);
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

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [entered, setEntered] = useState(false);
  const [signInMode, setSignInMode] = useState<
    "signin" | "signup" | "request"
  >("signin");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (data.session) void ensureMyProfile().catch(() => {});
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) void ensureMyProfile().catch(() => {});
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
    return <SignIn initialMode={signInMode} />;
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
      <BrowserRouter
        basename={(import.meta.env.BASE_URL || "/").replace(/\/$/, "") || undefined}
      >
        <ClockProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<RoleLanding />} />
            <Route path="/warehouse" element={<Warehouse />} />
            <Route path="/ask" element={<AskInfinity />} />
            <Route
              path="/knowledge"
              element={<RequireRole path="/knowledge"><Knowledge /></RequireRole>}
            />
            <Route path="/notifications" element={<Notifications />} />
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
            <Route
              path="/receive"
              element={<RequireRole path="/receive"><Receive /></RequireRole>}
            />
            <Route path="/search" element={<Search />} />
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
              path="/admin"
              element={<RequireRole path="/admin"><Admin /></RequireRole>}
            />
            <Route
              path="/analytics"
              element={<RequireRole path="/analytics"><Analytics /></RequireRole>}
            />
            <Route path="/my-work" element={<MyWork />} />
            <Route path="/review" element={<MemoReview />} />
            <Route
              path="/training"
              element={<RequireRole path="/training"><Training /></RequireRole>}
            />
            <Route path="/clock" element={<TimeClock />} />
            <Route
              path="/timecard"
              element={<RequireRole path="/timecard"><Timecard /></RequireRole>}
            />
            <Route
              path="/scheduling"
              element={<RequireRole path="/scheduling"><Scheduling /></RequireRole>}
            />
            <Route
              path="/my-schedule"
              element={<RequireRole path="/my-schedule"><MySchedule /></RequireRole>}
            />
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
            <Route path="/tools" element={<Tools />} />
            <Route
              path="/supplies"
              element={<RequireRole path="/supplies"><Supplies /></RequireRole>}
            />
            <Route
              path="/qc"
              element={<RequireRole path="/qc"><Qc /></RequireRole>}
            />
            <Route path="/w/:windowId" element={<WindowDetail />} />
            <Route path="/loc/:address" element={<LocationDetail />} />
            <Route
              path="/labels"
              element={<RequireRole path="/labels"><Labels /></RequireRole>}
            />
            <Route path="/count" element={<CycleCount />} />

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
            <Route
              path="/toolbox-history"
              element={<ComingSoon title="Toolbox talk history" />}
            />
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
