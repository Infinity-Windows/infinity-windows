import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { persister, queryClient, shouldPersistQuery } from "./lib/queryClient";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useParams,
} from "react-router-dom";
import { Layout } from "./components/Layout";
import { supabase } from "./lib/supabase";
import { CycleCount } from "./pages/CycleCount";
import { Home } from "./pages/Home";
import { Labels } from "./pages/Labels";
import { LocationDetail } from "./pages/LocationDetail";
import { ProjectDetail } from "./pages/ProjectDetail";
import { Projects } from "./pages/Projects";
import { Receive } from "./pages/Receive";
import { Scan } from "./pages/Scan";
import { Search } from "./pages/Search";
import { SignIn } from "./pages/SignIn";
import { WindowDetail } from "./pages/WindowDetail";
import { OpeningReview } from "./pages/install/OpeningReview";
import { OpeningSheet } from "./pages/install/OpeningSheet";
import { PlansetUpload } from "./pages/install/PlansetUpload";
import { ProjectMap } from "./pages/install/ProjectMap";
import { TypeBrainCard } from "./pages/install/TypeBrainCard";
import { CatalogImport } from "./pages/CatalogImport";
import { Crew } from "./pages/Crew";
import { MyWork } from "./pages/MyWork";
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
import { ensureMyProfile, getMyProfile } from "./lib/install/api";
import { isLeadLike } from "./lib/install/types";
import { useQuery } from "@tanstack/react-query";
import "./index.css";

/** Role-biased landing: installers open into their work; leads see warehouse/command Home. */
function RoleLanding() {
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  if (me.isLoading) return null;
  if (me.data && !isLeadLike(me.data.role)) {
    return <Navigate to="/my-work" replace />;
  }
  return <Home />;
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

  if (!ready) return null;
  if (!session) return <SignIn />;

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
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<RoleLanding />} />
            <Route path="/scan" element={<Scan />} />
            <Route path="/receive" element={<Receive />} />
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
              element={<OpeningSheet />}
            />
            <Route path="/brain/:typeId" element={<TypeBrainCard />} />
            <Route path="/catalog" element={<CatalogImport />} />
            <Route path="/crew" element={<Crew />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/my-work" element={<MyWork />} />
            <Route path="/review" element={<MemoReview />} />
            <Route path="/training" element={<Training />} />
            <Route path="/clock" element={<TimeClock />} />
            <Route path="/costing" element={<Costing />} />
            <Route path="/learn" element={<Education />} />
            <Route path="/points" element={<Points />} />
            <Route path="/safety" element={<Safety />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/supplies" element={<Supplies />} />
            <Route path="/qc" element={<Qc />} />
            <Route path="/w/:windowId" element={<WindowDetail />} />
            <Route path="/loc/:address" element={<LocationDetail />} />
            <Route path="/labels" element={<Labels />} />
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
      </BrowserRouter>
      </PinGate>
    </PersistQueryClientProvider>
  );
}
