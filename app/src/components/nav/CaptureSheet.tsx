import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Camera,
  FolderOpen,
  Receipt,
  ScanLine,
  Search,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { listProjects } from "../../lib/api";
import { listRecentJobs } from "../../lib/timeclock";
import { listMyPublished } from "../../lib/schedule/api";
import { useClock } from "../../lib/clockContext";
import { useFocusTrap } from "../../lib/useFocusTrap";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface CaptureSheetProps {
  open: boolean;
  onClose: () => void;
}

interface CaptureAction {
  key: string;
  label: string;
  hint: string;
  Icon: LucideIcon;
  /** Build the destination given the selected project (if any). */
  to: (projectId: string | null) => string;
  /** When true, the action is disabled until a project is chosen. */
  needsProject?: boolean;
}

const ACTIONS: CaptureAction[] = [
  {
    key: "photo",
    label: "Take or upload a photo",
    hint: "Attach a progress or install photo",
    Icon: Camera,
    to: (p) => (p ? `/photos?project=${p}&capture=1` : "/photos?capture=1"),
  },
  {
    key: "receipt",
    label: "Add a receipt",
    hint: "Snap or upload a materials receipt",
    Icon: Receipt,
    to: (p) =>
      p ? `/photos?project=${p}&kind=receipt&capture=1` : "/photos?kind=receipt&capture=1",
  },
  // "New daily log" is hidden until /daily-logs ships — it currently lands on a
  // Coming-soon stub, so a primary capture action would dead-end. Re-add this
  // entry once the daily-log page exists:
  // {
  //   key: "daily-log",
  //   label: "New daily log",
  //   hint: "Log today's progress and notes",
  //   Icon: NotebookPen,
  //   to: (p) => (p ? `/daily-logs?project=${p}` : "/daily-logs"),
  // },
  {
    key: "gallery",
    label: "Open gallery",
    hint: "Browse the photo & receipt library",
    Icon: FolderOpen,
    to: (p) => (p ? `/photos?project=${p}` : "/photos"),
  },
  {
    key: "scan",
    label: "Scan a unit",
    hint: "Look up a window by its QR/ID",
    Icon: ScanLine,
    to: () => "/scan",
  },
];

/** Quick-capture bottom sheet opened by the center Capture (+) FAB. */
export function CaptureSheet({ open, onClose }: CaptureSheetProps) {
  const navigate = useNavigate();
  const { profileId, shift } = useClock();
  const [selectedId, setSelectedId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [showList, setShowList] = useState(false);
  const primedRef = useRef(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef, open, onClose);

  const recents = useQuery({
    queryKey: ["recentJobs", profileId],
    queryFn: () => listRecentJobs(profileId!),
    enabled: open && Boolean(profileId),
  });
  const todayISO = todayLocalISO();
  const scheduledToday = useQuery({
    queryKey: ["mySchedule", profileId, todayISO, todayISO],
    queryFn: () => listMyPublished(profileId!, todayISO, todayISO),
    enabled: open && Boolean(profileId),
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    enabled: open,
  });

  useEffect(() => {
    if (!open) {
      setSelectedId("");
      setSearch("");
      setShowList(false);
      primedRef.current = false;
    }
  }, [open]);

  // Default the capture context to today's job — the open shift you're on, or
  // today's published assignment — so captures land on the right job by default.
  useEffect(() => {
    if (!open || primedRef.current) return;
    const todayJob = shift?.project_id ?? scheduledToday.data?.[0]?.project_id ?? null;
    if (todayJob) {
      primedRef.current = true;
      setSelectedId(todayJob);
    }
  }, [open, shift?.project_id, scheduledToday.data]);

  const filtered = useMemo(() => {
    const list = projects.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) =>
      `${p.job_code} ${p.name} ${p.address ?? ""}`.toLowerCase().includes(q),
    );
  }, [projects.data, search]);

  const selected = (projects.data ?? []).find((p) => p.id === selectedId);
  const projectId = selectedId || null;

  const go = (action: CaptureAction) => {
    if (action.needsProject && !projectId) {
      setShowList(true);
      return;
    }
    navigate(action.to(projectId));
    onClose();
  };

  if (!open) return null;

  return (
    <>
      <div className="capture-backdrop overlay-enter" onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        className="capture-sheet sheet-enter"
        role="dialog"
        aria-modal="true"
        aria-label="Quick capture"
      >
        <div className="capture-grip" aria-hidden />
        <div className="capture-head">
          <h2 className="capture-title">Quick capture</h2>
          <button type="button" className="capture-close" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Project context — recent chips + searchable list */}
        <div className="capture-project">
          <p className="capture-project-label">
            {selected ? "Capturing for" : "Which job? (optional)"}
          </p>
          {selected ? (
            <button
              type="button"
              className="capture-project-current"
              onClick={() => {
                setSelectedId("");
                setShowList(true);
              }}
            >
              <strong>{selected.job_code}</strong> · {selected.name}
              <span className="capture-project-change">Change</span>
            </button>
          ) : (
            <>
              {(recents.data?.length ?? 0) > 0 && (
                <div className="capture-chip-row">
                  {(recents.data ?? []).map((r) => (
                    <button
                      key={r.projectId}
                      type="button"
                      className="capture-chip"
                      onClick={() => setSelectedId(r.projectId)}
                    >
                      {r.jobCode || r.name}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="capture-list-toggle"
                onClick={() => setShowList((v) => !v)}
              >
                <Search size={14} aria-hidden /> {showList ? "Hide job list" : "Find a job"}
              </button>
              {showList && (
                <div className="capture-picker">
                  <input
                    className="capture-search"
                    placeholder="Search jobs…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search jobs"
                  />
                  <div className="capture-project-list">
                    {filtered.slice(0, 30).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="capture-project-item"
                        onClick={() => {
                          setSelectedId(p.id);
                          setShowList(false);
                        }}
                      >
                        <span className="capture-project-code">{p.job_code}</span>
                        <span className="capture-project-name">{p.name}</span>
                      </button>
                    ))}
                    {filtered.length === 0 && <p className="muted">No jobs match “{search}”.</p>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="capture-grid">
          {ACTIONS.map((action) => (
            <button
              key={action.key}
              type="button"
              className="capture-tile"
              onClick={() => go(action)}
            >
              <span className="capture-tile-icon">
                <action.Icon size={22} />
              </span>
              <span className="capture-tile-text">
                <span className="capture-tile-label">{action.label}</span>
                <span className="capture-tile-hint">{action.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
