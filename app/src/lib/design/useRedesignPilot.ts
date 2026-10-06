import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRealProfile } from "../install/api";
import { signInGeneration, signedInUserId, signInMark, stillSignedInAs, subscribeSignedIn } from "../signedIn";
import { supabase } from "../supabase";

function subscribeConnection(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function connected() {
  return typeof navigator !== "undefined" && navigator.onLine !== false;
}

async function readOwnPilotAdmission(): Promise<boolean> {
  const { data, error } = await supabase.rpc("my_redesign_pilot_access");
  if (error) throw error;
  return data === true;
}

const PILOT_LEASE_MS = 10 * 60_000;

/** An online grant is required once per mount; a brief outage preserves only
 * that same signed-in account's in-memory grant. Nothing is stored on disk. */
export function useRedesignPilotState(): { admitted: boolean; ready: boolean } {
  const uid = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, () => 0);
  const online = useSyncExternalStore(subscribeConnection, connected, () => false);
  const [now, setNow] = useState(() => Date.now());
  const [lease, setLease] = useState<{ uid: string; generation: number; until: number } | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const profile = useQuery({
    queryKey: ["myRealProfile"], queryFn: getRealProfile,
    staleTime: 0, refetchOnMount: "always", retry: false,
  });
  const admission = useQuery({
    queryKey: ["redesignPilot", uid, generation],
    queryFn: async () => {
      const mark = signInMark();
      if (!uid || !stillSignedInAs(mark, uid)) return false;
      const allowed = await readOwnPilotAdmission();
      return stillSignedInAs(mark, uid) && allowed;
    },
    enabled: !!uid && online,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: 15_000,
  });
  useEffect(() => {
    if (!uid || !admission.isFetchedAfterMount || !admission.isSuccess) return;
    if (admission.data === true) {
      setLease({ uid, generation, until: admission.dataUpdatedAt + PILOT_LEASE_MS });
    } else {
      setLease(null);
    }
  }, [uid, generation, admission.isFetchedAfterMount, admission.isSuccess,
    admission.data, admission.dataUpdatedAt]);

  const explicitlyDenied = admission.isFetchedAfterMount && admission.isSuccess
    && admission.data === false;
  const freshGrant = admission.isFetchedAfterMount && admission.isSuccess
    && admission.data === true && now - admission.dataUpdatedAt < PILOT_LEASE_MS;
  const leasedGrant = lease?.uid === uid && lease.generation === generation
    && now < lease.until;
  const profileAllowed = !!uid && profile.isSuccess && profile.isFetchedAfterMount
    && profile.data?.id === uid && profile.data?.role === "owner"
    && !profile.data?.retired_at;
  return {
    admitted: profileAllowed && !explicitlyDenied && (freshGrant || leasedGrant),
    ready: !uid || !online || (profile.isFetchedAfterMount
      && (admission.isFetchedAfterMount || admission.isError)),
  };
}

export function useRedesignPilot(): boolean {
  return useRedesignPilotState().admitted;
}
