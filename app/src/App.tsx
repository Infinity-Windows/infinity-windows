import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
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
import "./index.css";

const queryClient = new QueryClient();

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return null;
  if (!session) return <SignIn />;

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/scan" element={<Scan />} />
            <Route path="/receive" element={<Receive />} />
            <Route path="/search" element={<Search />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<ProjectDetail />} />
            <Route path="/w/:windowId" element={<WindowDetail />} />
            <Route path="/loc/:address" element={<LocationDetail />} />
            <Route path="/labels" element={<Labels />} />
            <Route path="/count" element={<CycleCount />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
