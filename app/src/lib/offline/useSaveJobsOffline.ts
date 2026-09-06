// The hook behind "Save for offline": run the job pack for one or many jobs,
// one after another, and know what is already saved on this phone. Lives in
// lib/ rather than beside the component so the component file exports only
// components (fast refresh) and so the "ago" label is a pure function with a
// test.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TFn } from "../i18n";
import { prefetchJobPack } from "../queryClient";
import { readSavedJobs, recordSavedJob, type JobPackResult, type SavedJobRecord } from "./jobPack";

/** "just now", "12 min ago", "3 h ago", "2 d ago" — in the crew's language. PURE. */
export function agoLabel(t: TFn, at: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return t("offline.justNow");
  if (minutes < 60) return t("offline.minAgo", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("offline.hoursAgo", { n: hours });
  return t("offline.daysAgo", { n: Math.round(hours / 24) });
}

export type SaveRun =
  | { phase: "idle" }
  | { phase: "saving"; done: number; total: number; jobIndex: number; jobCount: number }
  | { phase: "done"; results: JobPackResult[] }
  | { phase: "error" };

/**
 * Save one or many jobs, one after another, and know what is already saved.
 * `projectIds` is read at tap time, so a list that is still loading when the
 * component mounts is fine.
 */
export function useSaveJobsOffline(projectIds: readonly string[]) {
  const [run, setRun] = useState<SaveRun>({ phase: "idle" });
  const [saved, setSaved] = useState<Record<string, SavedJobRecord>>(() => readSavedJobs());
  const ids = useRef(projectIds);
  ids.current = projectIds;
  const busy = useRef(false);

  // Another screen may have saved a job since this one mounted.
  useEffect(() => {
    setSaved(readSavedJobs());
  }, []);

  const start = useCallback(async () => {
    if (busy.current) return;
    const targets = [...new Set(ids.current)];
    if (targets.length === 0) return;
    busy.current = true;
    const results: JobPackResult[] = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        setRun({ phase: "saving", done: 0, total: 0, jobIndex: i, jobCount: targets.length });
        const result = await prefetchJobPack(targets[i], (p) =>
          setRun({ phase: "saving", done: p.done, total: p.total, jobIndex: i, jobCount: targets.length }),
        );
        recordSavedJob(result);
        results.push(result);
        setSaved(readSavedJobs());
      }
      setRun({ phase: "done", results });
    } catch {
      // Only the code failing to load gets here (the runner itself never
      // throws): a phone with no signal at all. Say so; keep what was saved.
      setRun({ phase: "error" });
      setSaved(readSavedJobs());
    } finally {
      busy.current = false;
    }
  }, []);

  return { run, saved, start };
}

