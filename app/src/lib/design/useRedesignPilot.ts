import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRealProfileForPilot, isProfileReadNetworkFailure } from "../install/api";
import { signInGeneration, signedInUserId, signInMark, stillSignedInAs, subscribeSignedIn } from "../signedIn";
import { signInOnThisPhone, supabase } from "../supabase";
import { forgetOfflinePilotProof, readOfflinePilotProof, rememberOfflinePilotProof } from "./offlinePilotProof";

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

/** A weak-signal request can hang while the browser still reports online.
 * The bounded failure only restores an earlier, login-bound UI choice. */
async function withReadDeadline<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("pilot read timed out")), 7_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A fetch that did not get an authorization answer. A real denial wins even
 * if the browser's network icon happens to say "offline" at that moment. */
function couldNotCheck(error: unknown): boolean {
  const rec = error && typeof error === "object"
    ? error as { status?: unknown; code?: unknown; message?: unknown } : null;
  if (rec?.status === 404 || (typeof rec?.code === "string" && rec.code.startsWith("PGRST30"))) return false;
  return isProfileReadNetworkFailure(error)
    || rec?.message === "pilot read timed out"
    || rec?.message === "waiting_to_renew";
}

const FRESH_MS = 10 * 60_000;

// This subscriber stays installed while the app bundle runs. An initial
// offline boot into the same stored owner session keeps the proof; a sign-out,
// account switch, or new login clears it before another screen can use it.
subscribeSignedIn(() => {
  const uid = signedInUserId();
  const session = signInOnThisPhone();
  if (!uid || session?.user.id !== uid || !readOfflinePilotProof(session)) {
    forgetOfflinePilotProof();
  }
});

/** Only a fresh server yes can create the account-bound offline UI copy. */
export function useRedesignPilotState(): {
  admitted: boolean; ready: boolean; offlineChoice: "new" | null;
  serverChoice: "new" | "classic" | null; pendingProof: boolean;
} {
  const uid = useSyncExternalStore(subscribeSignedIn, signedInUserId, () => null);
  const generation = useSyncExternalStore(subscribeSignedIn, signInGeneration, () => 0);
  const online = useSyncExternalStore(subscribeConnection, connected, () => false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const profile = useQuery({
    queryKey: ["redesignPilotProfile", uid, generation],
    queryFn: async () => {
      const mark = signInMark();
      if (!uid || !stillSignedInAs(mark, uid)) throw new Error("sign in changed");
      const answer = await withReadDeadline(getRealProfileForPilot());
      if (!stillSignedInAs(mark, uid)) throw new Error("sign in changed");
      return answer;
    },
    enabled: !!uid && online,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: 15_000,
  });
  const admission = useQuery({
    queryKey: ["redesignPilot", uid, generation],
    queryFn: async () => {
      const mark = signInMark();
      if (!uid || !stillSignedInAs(mark, uid)) return false;
      const allowed = await withReadDeadline(readOwnPilotAdmission());
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

  // React Query can retain earlier data after a failed refetch. The newest
  // result, not a stale positive answer, determines whether the server spoke.
  const profileAnswered = profile.isFetchedAfterMount && profile.isSuccess
    && profile.dataUpdatedAt >= profile.errorUpdatedAt ? profile.data : null;
  const admissionAnswered = admission.isFetchedAfterMount && admission.isSuccess
    && admission.dataUpdatedAt >= admission.errorUpdatedAt ? admission.data : null;
  const profileError = profile.isFetchedAfterMount && profile.errorUpdatedAt > profile.dataUpdatedAt
    ? profile.error : null;
  const admissionError = admission.isFetchedAfterMount && admission.errorUpdatedAt > admission.dataUpdatedAt
    ? admission.error : null;
  const realProfile = profileAnswered?.kind === "answered" ? profileAnswered.profile : null;
  const profileAllowed = !!uid && realProfile?.id === uid && realProfile.role === "owner"
    && !realProfile.retired_at;
  const profileDenied = profileAnswered?.kind === "answered" && !profileAllowed;
  const profileChoice = profileAllowed
    ? (realProfile?.ui_design === "new" ? "new" : "classic") : null;
  const definitiveDenial = admissionAnswered === false || profileDenied
    || (!!admissionError && !couldNotCheck(admissionError))
    || (!!profileError && !couldNotCheck(profileError));
  const serverVerified = profileAllowed && admissionAnswered === true
    && now - profile.dataUpdatedAt < FRESH_MS && now - admission.dataUpdatedAt < FRESH_MS;
  const proofOnPhone = !!uid && readOfflinePilotProof(signInOnThisPhone(), now);
  const couldNotReach = !online || profileAnswered?.kind === "unreachable"
    || (!!profileError && couldNotCheck(profileError))
    || (!!admissionError && couldNotCheck(admissionError));
  const attempted = profile.isFetchedAfterMount && admission.isFetchedAfterMount;
  const useProof = proofOnPhone && !definitiveDenial && profileChoice !== "classic"
    && (!online || (attempted && couldNotReach));
  const admitted = !definitiveDenial && (serverVerified || useProof);

  useEffect(() => {
    if (!uid || definitiveDenial || profileChoice === "classic"
      || (!proofOnPhone && !serverVerified)) {
      forgetOfflinePilotProof();
      return;
    }
    if (serverVerified && profileChoice === "new"
      && signedInUserId() === uid && signInGeneration() === generation) {
      rememberOfflinePilotProof(signInOnThisPhone(), Math.min(Date.now(), admission.dataUpdatedAt));
    }
  }, [uid, generation, definitiveDenial, profileChoice, proofOnPhone, serverVerified, admission.dataUpdatedAt]);

  return {
    admitted,
    offlineChoice: useProof ? "new" : null,
    serverChoice: serverVerified ? profileChoice : null,
    pendingProof: proofOnPhone && online && !attempted && !definitiveDenial,
    // No provisional Classic settlement while App is still restoring auth.
    ready: !!uid && (admitted || !online || attempted),
  };
}

export function useRedesignPilot(): boolean {
  return useRedesignPilotState().admitted;
}
