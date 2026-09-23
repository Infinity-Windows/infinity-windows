import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { queryClient } from "./queryClient";

/** The auth subject is the display boundary. A cached profile may still belong
 * to the previous person after another tab signs in; it is not proof of who is
 * using this screen now. Keep offline data, but refresh this profile query. */
export function useAskSessionActor(): string | null {
  const [actorId, setActorId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let observed: string | null | undefined;
    const observe = (next: string | null) => {
      if (!alive || observed === next) return;
      observed = next;
      setActorId(next);
      // Supabase auth callbacks stay synchronous. A profile refresh can call
      // auth again, so start it after the callback releases the auth lock.
      if (next) queueMicrotask(() => {
        if (alive && observed === next) void queryClient.invalidateQueries({ queryKey: ["myRealProfile"], exact: true });
      });
    };
    const boot = generation;
    void supabase.auth.getSession().then(({ data }) => {
      if (alive && generation === boot) observe(data.session?.user.id ?? null);
    }).catch(() => { if (alive && generation === boot) observe(null); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      generation += 1;
      observe(session?.user.id ?? null);
    });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);
  return actorId;
}
