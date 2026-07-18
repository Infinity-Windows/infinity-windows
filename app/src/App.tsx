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
import { ClockProvider } from "./lib/clockContext";
import { ViewAsRoleProvider } from "./lib/viewAsRole";
import { effectiveRole, useViewAsRole } from "./lib/viewAsRoleContext";
import { supabase } from "./lib/supabase";
import { AskInfinity } from "./pages/AskInfinity";
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
import { Costing } from "./pages/Costing";
import { Education } from "./pages/Education";
import { Points } from "./pages/Points";
import { Safety } from "./pages/Safety";
import { Tools } from "./pages/Tools";
import { Supplies } from "./pages/Supplies";
import { Qc } from "./pages/Qc";
import { PinGate } from "./components/PinGate";
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
function RequireRole({ path, children }: { path: RoutePath; children: ReactNode }) {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const view = useViewAsRole();
  if (!ROLE_NAV_V2) return <>{children}</>;
  if (me.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  const role = effectiveRole(me.data?.role, view);
  if (canAccess(role, path)) return <>{children}</>;
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
      <BrowserRouter>
        <ClockProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<RoleLanding />} />
            <Route path="/warehouse" element={<Warehouse />} />
            <Route path="/ask" element={<AskInfinity />} />
            <Route path="/notifications" element={<Notifications />} />
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
              element={<PlansetUpload />}
            />
            <Route
              path="/projects/:projectId/review"
              element={<OpeningReview />}
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
