import { createContext, createElement, useContext, useState, type ReactNode, type SetStateAction } from "react";
import type { WorkSession } from "../../lib/customWork/model";

export function closePreviewSession(session: WorkSession, at: number, done = false): WorkSession {
  if (session.ended_at) return session;
  const machineryStart = session.workday_machinery_started_at;
  return {
    ...session,
    ended_at: new Date(at).toISOString(),
    outcome: done || session.workday_done_at ? "finished" : "partial",
    workday_machinery_started_at: null,
    workday_machinery_ms: (session.workday_machinery_ms ?? 0)
      + (machineryStart ? Math.max(0, at - Date.parse(machineryStart)) : 0),
  };
}

type Preview = {
  sessions: WorkSession[];
  unitCompletion: Record<string, boolean>;
  clockState: "off" | "working" | "break";
};
const emptyPreview: Preview = { sessions: [], unitCompletion: {}, clockState: "off" };
const PreviewContext = createContext<{
  states: Record<string, Preview>;
  update: (key: string, change: (current: Preview) => Preview) => void;
} | null>(null);

export function WorkdayPreviewProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<Record<string, Preview>>({});
  const update = (key: string, change: (current: Preview) => Preview) =>
    setStates(old => ({ ...old, [key]: change(old[key] ?? emptyPreview) }));
  return createElement(PreviewContext.Provider, { value: { states, update } }, children);
}

export function useWorkdayPreview(key: string) {
  const store = useContext(PreviewContext);
  if (!store) throw new Error("Workday preview requires its provider.");
  const { sessions, unitCompletion, clockState } = store.states[key] ?? emptyPreview;
  function set<K extends keyof Preview>(field: K, next: SetStateAction<Preview[K]>) {
    store!.update(key, current => ({
      ...current,
      [field]: typeof next === "function" ? next(current[field]) : next,
    }));
  }
  const setSessions = (next: SetStateAction<Preview["sessions"]>) => set("sessions", next);
  const setUnitCompletion = (next: SetStateAction<Preview["unitCompletion"]>) => set("unitCompletion", next);

  function stopWork(at = Date.now()) {
    setSessions(previous => previous.map(session => closePreviewSession(session, at)));
  }

  function setClock(state: "off" | "working" | "break") {
    const at = Date.now();
    if (state !== "working") stopWork(at);
    set("clockState", state);
  }

  return { sessions, setSessions, unitCompletion, setUnitCompletion, clockState, stopWork, setClock };
}
