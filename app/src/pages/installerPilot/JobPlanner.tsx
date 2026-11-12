import { readSharedPlan, saveSharedPlan, type SharedPlan } from "../../lib/installerWorkflow/sharedPlan";
import { ActivityIcon } from "../../components/projects/ActivityIcon";
import { PlannerJobContext } from "./PlannerJobContext";
import { ArrowLeft, Check, ChevronDown, GripVertical, Info, ListChecks, Pencil, SquareDashed, Trash2, Users, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { useClock } from "../../lib/clockContext";
import { supabase } from "../../lib/supabase";
import { listCrewRecordPeople, listWorkSessions, listWorkUnits } from "../../lib/customWork/api";
import { building3PreviewDone, building3ProgressBlocks, finishedUnitActivities } from "../../lib/installerWorkflow/unitProgress";
import { localWorkDate, type CrewPerson } from "../../lib/customWork/model";
import { listMarkSpecs, listOpenings } from "../../lib/install/api";
import { type ProjectOpening } from "../../lib/install/types";
import { indexSpecsByMark } from "../../lib/install/specs";
import { catalogByMarkFrom, resolveMarkConfig } from "../../lib/modelstudio/fromProject";
import { listStudioUnits, unitSvg } from "../../lib/modelstudio/units";
import { normalizeMarkCode } from "../../lib/fitview/adapter";
import { formatApiError } from "../../lib/errors";
import {
  coversPlanSlot, planBoundary, planDayEnd, PLAN_OPEN, PLAN_CLOSE, PLAN_NOON, PLAN_STEP,
  BUILDING_3_PROJECT, STANDARD_SHIFT_END, readJobPlan, saveJobPlan, shiftPlanDate, type OpeningCrew, type PlanBlock,
} from "../../lib/installerWorkflow/jobPlan";

import "./jobPlanner.css";
import { building3ByMark, reviewedBuilding3Openings } from "./building3Openings";

import { PILOT_ACTIVITIES as ACTIVITIES } from "../../lib/installerWorkflow/pilotActivities";

function bundleKey(block: PlanBlock) {
  const units = [...block.openingIds].sort().map(id => {
    const assignment = block.openingCrew?.[id];
    return [id, assignment?.leadId ?? null, [...(assignment?.crewIds ?? [])].sort()];
  });
  return JSON.stringify([
    block.kind, block.start, block.end, planBoundary(block, "start"), planBoundary(block, "end"),
    block.start === block.end ? null : block.dailyEndMinute ?? PLAN_CLOSE, [...block.installerIds].sort(), units,
  ]);
}

function plannedOpeningCrew(config: WorkConfig): PlanBlock["openingCrew"] {
  if (!config.activity.startsWith("unit:")) return undefined;
  const crew: Record<string, OpeningCrew> = {};
  for (const id of config.openingIds) {
    const roles = config.openingCrew?.[id];
    if (!roles) continue;
    const { leadId } = roles;
    const crewIds = roles.crewIds.filter(person => person !== leadId);
    if (leadId || crewIds.length) crew[id] = { leadId, crewIds };
  }
  return Object.keys(crew).length ? crew : undefined;
}

function blockAssignments(config: WorkConfig, legacyCrew: string[] = []) {
  if (!config.activity.startsWith("unit:")) {
    return { installerIds: config.installerIds, openingIds: [], openingCrew: undefined, unitCrewOnly: undefined };
  }
  const openingCrew = plannedOpeningCrew(config);
  const assigned = Object.values(openingCrew ?? {}).flatMap(({ leadId, crewIds }) => leadId ? [leadId, ...crewIds] : crewIds);
  return {
    installerIds: [...new Set([...legacyCrew, ...assigned])],
    openingIds: config.openingIds,
    openingCrew,
    unitCrewOnly: legacyCrew.length ? undefined : true as const,
  };
}

function FloorIndex({ floors, children }: { floors: string[]; children: (currentFloor: number) => ReactNode }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [currentFloor, setCurrentFloor] = useState(0);

  function updateCurrentFloor(list: HTMLDivElement) {
    const top = list.getBoundingClientRect().top;
    let current = 0;
    for (const [index, section] of Array.from(list.children).entries()) {
      if (section.getBoundingClientRect().top > top + 1) break;
      current = index;
    }
    if (list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 1) {
      current = list.children.length - 1;
    }
    setCurrentFloor(current);
  }

  return <div className="jp-floor-browser">
    <nav aria-label="Jump to floor" className="jp-floor-index">
      {floors.map((floor, index) => <button type="button" key={floor}
        aria-label={`Jump to ${floor}`} aria-current={index === currentFloor ? "location" : undefined}
        onClick={() => {
          const list = listRef.current;
          const group = list?.children[index];
          if (list && group) {
            list.scrollTop += group.getBoundingClientRect().top - list.getBoundingClientRect().top;
            updateCurrentFloor(list);
          }
        }}>{floor.replace("Level ", "L").replace("Unspecified floor", "No floor")}</button>)}
    </nav>
    <div ref={listRef} className="jp-floor-list" onScroll={event => updateCurrentFloor(event.currentTarget)}>
      {children(currentFloor)}
    </div>
  </div>;
}

function positionCrewMenu(menu: HTMLElement, gap = 4) {
  if (!menu.matches(":popover-open")) return;
  const trigger = menu.previousElementSibling?.getBoundingClientRect();
  if (!trigger) return;
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(trigger.left, window.innerWidth - width - 8));
  const below = trigger.bottom + gap;
  const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, trigger.top - height - gap);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function UnitInfo({ mark, lines }: { mark: string; lines: string[] }) {
  const id = useId();
  return <>
    <button type="button" className="jp-unit-info-trigger" popoverTarget={id}
      aria-label={`Details for ${mark}`} title={lines.join("\n")}><Info size={15} /></button>
    <div id={id} popover="auto" className="jp-unit-info" aria-label={`Details for ${mark}`}>
      <strong>{mark}</strong>
      {lines.map(line => <span key={line}>{line}</span>)}
    </div>
  </>;
}

const BUILDING_3_DEMO_CREW = [
  { id: "mock-maya", display_name: "Maya Chen" },
  { id: "mock-eli", display_name: "Eli Parker" },
  { id: "mock-luis", display_name: "Luis Rivera" },
  { id: "mock-nora", display_name: "Nora Bell" },
  { id: "mock-jordan", display_name: "Jordan Brooks" },
];
const CREW_COLORS = ["#72b7ff", "#d7a2ff", "#55d6a2", "#f5b96e", "#f48faf", "#e6d570", "#60d0dd", "#adba80"];
const HOURS = Array.from({ length: 12 }, (_, index) => PLAN_OPEN + index * 60);
const DAY_STEPS = (PLAN_CLOSE - PLAN_OPEN) / PLAN_STEP;
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
type Slot = "am" | "pm" | "day" | "week";
type WorkConfig = { activity: string; installerIds: string[]; openingIds: string[]; openingCrew?: PlanBlock["openingCrew"] };
type Point = { date: string; minute: number };
type Gesture = { x: number; y: number; block: PlanBlock; members: PlanBlock[]; edge: "move" | "start" | "end"; anchor: Point };
function sameValue(left: unknown, right: unknown) {
  const canonical = (block: unknown) => JSON.stringify(block, (_, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value);
  return canonical(left) === canonical(right);
}
type Edit = { members: PlanBlock[]; block: PlanBlock; config: WorkConfig };

function timeLabel(minute: number) {
  const hour = Math.floor(minute / 60);
  return (hour % 12 || 12) + ":" + String(minute % 60).padStart(2, "0") + (hour < 12 ? " AM" : " PM");
}
function activityKey(block: Pick<PlanBlock, "kind" | "activity">) {
  return block.kind + ":" + block.activity;
}
function activityParts(key: string) {
  const separator = key.indexOf(":");
  return { kind: key.slice(0, separator) === "unit" ? "unit" as const : "general" as const, activity: key.slice(separator + 1) };
}
function activityColor(key: string): CSSProperties {
  const keys = ACTIVITIES.flatMap(group => group.names.map(name => group.kind + ":" + name));
  const index = keys.indexOf(key);
  const hash = [...key].reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0);
  return { "--activity-color": `hsl(${index < 0 ? hash % 360 : Math.round(index * 137.508) % 360} 55% 65%)` } as CSSProperties;
}
function isSunday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
}


function dateTime(date: string, minute: number) {
  return date ? `${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}` : "";
}

function dateTimeMinute(value: string) {
  const [hour, minute] = value.slice(11).split(":").map(Number);
  return hour * 60 + minute;
}

function plannedRange(date: string, slot: Slot) {
  if (slot === "week") {
    const weekday = new Date(date + "T00:00:00Z").getUTCDay();
    const monday = shiftPlanDate(date, weekday === 0 ? 1 : weekday === 6 ? 2 : 1 - weekday);
    return { start: monday, end: shiftPlanDate(monday, 4), startMinute: PLAN_OPEN, endMinute: STANDARD_SHIFT_END, dailyEndMinute: STANDARD_SHIFT_END };
  }
  return {
    start: date, end: date,
    startMinute: slot === "pm" ? PLAN_NOON : PLAN_OPEN,
    endMinute: slot === "am" ? PLAN_NOON : STANDARD_SHIFT_END,
  };
}
function toggle(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
}
function DateLabel({ date }: { date: string }) {
  return <>{DATE_FORMAT.format(new Date(date + "T00:00:00Z"))}</>;
}

export function JobPlanner() {
  const { projectId } = useParams();
  const { profileId } = useClock();
  const [params] = useSearchParams();
  const progressDemo = import.meta.env.DEV && projectId === BUILDING_3_PROJECT && params.get("progressDemo") === "1";
  const shared = projectId === BUILDING_3_PROJECT && params.get("sharedPlan") === "1";
  if (shared && projectId && profileId) return <SharedPlanner key={profileId + projectId} project={projectId} account={profileId} />;
  return projectId && profileId
    ? <Planner key={profileId + projectId + progressDemo} project={projectId} account={profileId} progressDemo={progressDemo} />
    : <p className="page">Open a job while signed in to plan work.</p>;
}

function SharedPlanner({ project, account }: { project: string; account: string }) {
  const query = useQuery({
    queryKey: ["sharedInstallerPlan", account, project],
    queryFn: () => readSharedPlan(project),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 10000,
  });
  if (query.isPending) return <p className="page" role="status">Loading shared plan...</p>;
  if (!query.data) return <div className="page">
    <p role="alert">{formatApiError(query.error)}</p>
    <button type="button" onClick={() => void query.refetch()}>Try again</button>
  </div>;
  return <Planner project={project} account={account} progressDemo={false} latestSharedPlan={query.data} />;
}

export function Planner({ project, account, progressDemo, latestSharedPlan, initialBlocks }: {
  project: string; account: string; progressDemo: boolean; latestSharedPlan?: SharedPlan; initialBlocks?: PlanBlock[];
}) {
  const [params] = useSearchParams();
  const currentDate = localWorkDate();
  const today = progressDemo ? "2026-11-09" : currentDate;
  const defaultScheduleDate = isSunday(currentDate) ? shiftPlanDate(currentDate, 1) : currentDate;
  const firstWorkDay = isSunday(today) ? shiftPlanDate(today, 1) : today;
  const [blocks, setBlocks] = useState(() => {
    if (latestSharedPlan) return latestSharedPlan.blocks;
    const saved = readJobPlan(project, account, initialBlocks);
    return progressDemo ? [...saved, ...building3ProgressBlocks.filter(sample =>
      !saved.some(block => block.activity === sample.activity && block.start <= sample.start && block.end >= sample.start))] : saved;
  });
  const [draft, setDraft] = useState<WorkConfig>({ activity: "", installerIds: [], openingIds: [] });
  const [buildBy, setBuildBy] = useState<"activity" | "unit" | null>(null);
  const [bundleActivities, setBundleActivities] = useState<string[]>([]);
  const [startAt, setStartAt] = useState(() => dateTime(defaultScheduleDate, PLAN_OPEN));
  const [endAt, setEndAt] = useState(() => dateTime(defaultScheduleDate, 17 * 60));
  const scheduleDate = startAt.slice(0, 10);
  const crewBatch = useRef<{ key: string; ids: string[] } | null>(null);
  const [assignmentNotice, setAssignmentNotice] = useState<{ message: string } | null>(null);
  useEffect(() => {
    if (!assignmentNotice) return;
    const timeout = window.setTimeout(() => setAssignmentNotice(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [assignmentNotice]);
  const [draftUnit, setDraftUnit] = useState("");
  const [unitsCollapsed, setUnitsCollapsed] = useState(false);
  const unitTableId = useId();
  const activityPopoverId = useId();
  const activityMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = activityMenuRef.current;
    if (buildBy === "activity" && menu && !menu.matches(":popover-open")) {
      const trigger = menu.previousElementSibling;
      if (trigger instanceof HTMLButtonElement) {
        trigger.focus({ preventScroll: true });
        trigger.click();
      }
    }
  }, [buildBy]);
  const [editUnit, setEditUnit] = useState("");
  const crewPopoverId = useId();
  const [selectedBlock, setSelectedBlock] = useState("");
  const [hoveredBundle, setHoveredBundle] = useState("");
  const [focusedBundle, setFocusedBundle] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [error, setError] = useState("");
  const [sharedPlan, setSharedPlan] = useState(latestSharedPlan);
  const [sharedBusy, setSharedBusy] = useState(false);
  const sharedWrite = useRef(false);
  const builderBaseline = useRef<Set<string> | null>(null);
  const building = !!draft.activity || !!draft.openingIds.length;
  useEffect(() => {
    if (!building) builderBaseline.current = null;
    else if (!builderBaseline.current) builderBaseline.current = new Set(blocks.map(block => block.id));
  }, [blocks, building]);

  const [day, setDay] = useState(firstWorkDay);
  const [view, setView] = useState<"overview" | "day">("overview");
  const [preview, setPreview] = useState<PlanBlock | null>(null);
  const gesture = useRef<Gesture | null>(null);
  useEffect(() => {
    if (!latestSharedPlan || !sharedPlan || latestSharedPlan.revision <= sharedPlan.revision || sharedBusy || preview) return;
    setSharedPlan(latestSharedPlan);
    setBlocks(latestSharedPlan.blocks);
    setSelectedBlock(current => latestSharedPlan.blocks.some(block => block.id === current) ? current : "");
  }, [latestSharedPlan, sharedPlan, sharedBusy, preview]);
  const suppressClick = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const overviewScroll = useRef<number | null>(null);
  const composerRef = useRef<HTMLElement>(null);
  const priorityDrag = useRef<{ id: string; pointer: number; x: number; y: number; moved: boolean } | null>(null);
  const [priorityPreview, setPriorityPreview] = useState<{ target: string; shifts: Record<string, { x: number; y: number }> } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openings = useQuery({
    queryKey: ["openings", project],
    queryFn: () => listOpenings(project),
    select: project === BUILDING_3_PROJECT ? reviewedBuilding3Openings : undefined,
  });
  const specs = useQuery({ queryKey: ["markSpecs", project], queryFn: () => listMarkSpecs(project) });
  const catalog = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits });
  const workUnits = useQuery({ queryKey: ["customWorkUnits", account, project], queryFn: () => listWorkUnits(project) });
  const workSessions = useQuery({ queryKey: ["customWorkSessions", account, project], queryFn: () => listWorkSessions(project), refetchInterval: 30000 });
  const workUnitByOpening = useMemo(() => new Map(workUnits.data?.map(unit => [unit.opening_id, unit.id])), [workUnits.data]);
  const finished = useMemo(() => finishedUnitActivities(workSessions.data ?? []), [workSessions.data]);
  const openingCodes = useMemo(() => new Map(openings.data?.map(opening => [opening.id, opening.opening_code])), [openings.data]);
  function isUnitDone(id: string, activity: string, label = openingCodes.get(id) ?? "") {
    return finished(workUnitByOpening.get(id), activity) || (progressDemo && building3PreviewDone(project, activity, label));
  }
  function orderedUnits(ids: string[], activity: string, isDone = (id: string) => isUnitDone(id, activity)) {
    return ids.map(id => {
      const label = openingCodes.get(id) ?? "Unknown unit";
      const done = isDone(id);
      return { id, label, done };
    }).sort((a, b) => Number(a.done) - Number(b.done));
  }
  const specIndex = useMemo(() => indexSpecsByMark(specs.data ?? []), [specs.data]);
  const byMark = useMemo(() => catalogByMarkFrom(catalog.data ?? []), [catalog.data]);
  const people = useQuery({
    queryKey: ["jobPlannerCrew", account, project],
    queryFn: async () => {
      const { data: job, error } = await supabase.from("projects").select("job_code,is_test").eq("id", project).single();
      if (error) throw error;
      if (!job.is_test) return { code: job.job_code, isTest: false, people: await listCrewRecordPeople() };
      const { data, error: rosterError } = await supabase.from("profiles")
        .select("id,display_name,active,role,is_partner,retired_at,access_revoked_at").eq("is_test", true);
      if (rosterError) throw rosterError;
      return { code: job.job_code, isTest: true, people: data as CrewPerson[] };
    },
  });
  const crew = people.data?.people.filter(person =>
    (person.active || people.data.isTest) && !person.retired_at && !person.access_revoked_at && !person.is_partner && person.role === "installer",
  ) ?? [];
  const showDemo = !sharedPlan && import.meta.env.DEV && project === BUILDING_3_PROJECT && people.data?.isTest;
  const roster = showDemo
    ? [...crew, ...BUILDING_3_DEMO_CREW]
    : crew;
  const rosterIds = [...new Set([...roster.map(person => person.id).sort(), ...blocks.flatMap(block => block.installerIds).sort()])];
  const crewColors = new Map(rosterIds.map((id, index) => [id, CREW_COLORS[index % CREW_COLORS.length]]));
  const crewName = (id: string) => (roster.find(person => person.id === id)?.display_name
    ?? openings.data?.find(opening => opening.assigned_to === id)?.assignee?.display_name
    ?? "Assigned installer").replace(/\s*(?:[·–—-]\s*|\(\s*)(?:demo|automation)\b.*$/i, "").trim();
  const crewStyle = (id: string) => ({ "--crew-color": crewColors.get(id) ?? "var(--muted)" }) as CSSProperties;
  const crewChoices = [...new Set([...roster.map(person => person.id), ...(edit?.config.installerIds ?? []), ...draft.installerIds])];
  const overviewDates = Array.from({ length: 14 }, (_, index) => shiftPlanDate(today, index - 2))
    .filter(date => !isSunday(date));
  const dates = view === "day" ? [day] : overviewDates;
  const visible = blocks.filter(block => dates.some(date => coversPlanSlot(block, date, "AM") || coversPlanSlot(block, date, "PM")));
  const activityGroups = ACTIVITIES.map(group => ({
    ...group, choices: [...new Set([...group.names, ...blocks.filter(block => block.kind === group.kind).map(block => block.activity)])],
  }));
  useLayoutEffect(() => {
    if (view !== "overview") { if (scrollRef.current) scrollRef.current.scrollLeft = 0; return; }
    const heading = scrollRef.current?.querySelector<HTMLElement>('[data-date="' + firstWorkDay + '"]');
    if (heading && scrollRef.current) scrollRef.current.scrollLeft = overviewScroll.current ?? heading.offsetLeft;
  }, [view, firstWorkDay]);
  const selectedOpening = params.get("opening");
  const selectedMark = params.get("mark");
  useEffect(() => {
    const matches = openings.data?.filter(opening => opening.id === selectedOpening
      || (selectedMark && normalizeMarkCode(opening.opening_code) === normalizeMarkCode(selectedMark)));
    if (matches?.length === 1) {
      setDraft(current => ({ ...current, openingIds: [matches[0].id] }));
      setDraftUnit(matches[0].id);
    }
  }, [openings.data, selectedOpening, selectedMark]);
  useEffect(() => {
    if (!edit) return;
    composerRef.current?.scrollIntoView({ block: "nearest" });
    closeRef.current?.focus({ preventScroll: true });

  }, [edit?.block.id]);

  async function save(next: PlanBlock[], expected: PlanBlock[] = []) {
    if (sharedPlan) {
      if (sharedWrite.current) return false;
      const original = new Map(blocks.map(block => [block.id, block]));
      const proposed = new Map(next.map(block => [block.id, block]));
      const changed = [...new Set([...original.keys(), ...proposed.keys()])]
        .filter(id => !sameValue(original.get(id), proposed.get(id)));
      const expectedById = new Map(expected.map(block => [block.id, block]));
      for (const id of expectedById.keys()) if (!changed.includes(id)) changed.push(id);
      if (!changed.length) return true;

      sharedWrite.current = true;
      setSharedBusy(true);
      setError("");
      let latest = sharedPlan;
      const confirmed = new Set<string>();
      function confirmChange(key: string, message: string) {
        if (confirmed.has(key)) return true;
        if (!window.confirm(message)) {
          setSharedPlan(latest);
          setBlocks(latest.blocks);
          return false;
        }
        confirmed.add(key);
        return true;
      }
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = new Map(latest.blocks.map(block => [block.id, block]));
          for (const id of changed) {
            const before = expectedById.get(id) ?? original.get(id);
            const remote = current.get(id);
            const replacement = proposed.get(id);
            if (!before && replacement) {
              const baseline = builderBaseline.current ?? original;
              const duplicate = latest.blocks.find(block => !baseline.has(block.id)
                && block.activity.trim().toLowerCase() === replacement.activity.trim().toLowerCase());
              if (duplicate && !confirmChange(`duplicate:${duplicate.id}:${replacement.activity}`,
                `${replacement.activity} was already added to this plan. Add another?`)) return false;
            }
            if (before && !sameValue(remote, before)) {
              if (!remote) {
                if (!replacement) continue;
                setSharedPlan(latest);
                setBlocks(latest.blocks);
                setError("Someone removed this activity. Your edits are still open.");
                return false;
              }
              const moved = remote.start !== before.start || remote.end !== before.end
                || planBoundary(remote, "start") !== planBoundary(before, "start")
                || planBoundary(remote, "end") !== planBoundary(before, "end");
              const changesTime = replacement && (replacement.start !== before.start || replacement.end !== before.end
                || planBoundary(replacement, "start") !== planBoundary(before, "start")
                || planBoundary(replacement, "end") !== planBoundary(before, "end"));
              if (moved && changesTime) {
                const where = `${remote.start} ${timeLabel(planBoundary(remote, "start"))} to ${remote.end} ${timeLabel(planBoundary(remote, "end"))}`;
                if (!confirmChange(JSON.stringify(remote), `Someone moved ${remote.activity} to ${where}. Move it to your selected time?`)) return false;
              }
            }
            if (replacement) {
              if (remote && before) {
                const fields = new Set([...Object.keys(before), ...Object.keys(replacement)] as (keyof PlanBlock)[]);
                const changes = Object.fromEntries([...fields].filter(key =>
                  !sameValue(before[key], replacement[key])).map(key => [key, replacement[key]]));
                current.set(id, { ...remote, ...changes });
              } else current.set(id, replacement);
            } else current.delete(id);
          }
          try {
            const saved = await saveSharedPlan(project, latest.revision, [...current.values()]);
            setSharedPlan(saved);
            setBlocks(saved.blocks);
            return true;
          } catch (cause) {
            if (typeof cause !== "object" || !cause || !("code" in cause) || cause.code !== "40001") throw cause;
            latest = await readSharedPlan(project);
          }
        }
        setSharedPlan(latest);
        setBlocks(latest.blocks);
        setError("The plan is updating quickly. Try saving again.");
        return false;
      } catch (cause) {
        setError(formatApiError(cause));
        return false;
      } finally {
        sharedWrite.current = false;
        setSharedBusy(false);
      }
    }
    try {
      saveJobPlan(project, account, next.filter(block => !building3ProgressBlocks.some(sample => sample.id === block.id)));
      setBlocks(next);
      setError("");
      return true;
    } catch (cause) {
      setError(formatApiError(cause));
      return false;
    }
  }
  function clearDraft() {
    setUnitsCollapsed(false);
    setDraft({ activity: "", installerIds: [], openingIds: [] });
    setDraftUnit("");
    setBundleActivities([]);
    setStartAt(dateTime(defaultScheduleDate, PLAN_OPEN));
    setEndAt(dateTime(defaultScheduleDate, 17 * 60));
    crewBatch.current = null;
    setAssignmentNotice(null);
  }
  function cancelSchedule() {
    clearDraft();
    setBuildBy(null);
  }
  async function schedule() {
    if (!drafted) return;
    const activities = buildBy === "unit" ? bundleActivities : [draft.activity];
    const additions = activities.map(activity => ({ ...drafted, ...activityParts(activity), id: crypto.randomUUID() }));
    if (!await save([...blocks, ...additions])) return;
    clearDraft();
    setBuildBy(null);
    setDay(drafted.start);
    if (!overviewDates.includes(drafted.start)) {
      setView("day");
    } else if (view === "overview") {
      const heading = scrollRef.current?.querySelector<HTMLElement>(`[data-date="${drafted.start}"]`);
      if (heading && scrollRef.current) scrollRef.current.scrollLeft = heading.offsetLeft;
    }
  }
  function isEditing(members: PlanBlock[]) {
    return edit?.members.some(current => members.some(member => member.id === current.id)) ?? false;
  }
  function openDetails(block: PlanBlock, members = [block]) {
    if (isEditing(members)) return;
    setUnitsCollapsed(false);
    crewBatch.current = null;
    setAssignmentNotice(null);
    setError("");
    const trigger = document.activeElement;
    returnFocus.current = trigger instanceof HTMLElement ? trigger : null;
    setEditUnit(block.openingIds[0] ?? "");
    setEdit({ members, block: { ...block, startMinute: planBoundary(block, "start"), endMinute: planBoundary(block, "end") },
      config: { activity: activityKey(block), installerIds: [...block.installerIds], openingIds: [...block.openingIds], openingCrew: block.openingCrew } });
  }
  function closeDetails() {
    setUnitsCollapsed(false);
    crewBatch.current = null;
    setAssignmentNotice(null);
    setError("");
    setEdit(null);
    const trigger = returnFocus.current;
    window.requestAnimationFrame(() => trigger?.focus());
  }
  async function saveDetails() {
    if (!edit) return;
    const { block, config } = edit;
    if (!config.activity || !block.start || !block.end || block.end < block.start
      || isSunday(block.start) || isSunday(block.end)
      || planBoundary(block, "start") < PLAN_OPEN || planBoundary(block, "end") > PLAN_CLOSE
      || planBoundary(block, "start") >= PLAN_CLOSE || planBoundary(block, "end") <= PLAN_OPEN
      || (block.end === block.start && planBoundary(block, "end") <= planBoundary(block, "start"))) {
      setError("Choose Monday through Saturday, between 7 AM and 7 PM, with the end after the start.");
      return;
    }
    const updates = new Map(edit.members.map(member => {
      const legacyCrew = member.kind === "unit" && !member.unitCrewOnly ? member.installerIds : [];
      const updated = edit.members.length === 1 ? { ...block, ...activityParts(config.activity) } : {
        ...member, start: block.start, end: block.end, startMinute: block.startMinute, endMinute: block.endMinute,
      };
      return [member.id, { ...updated, ...blockAssignments(config, legacyCrew) }];
    }));
    if (await save(blocks.map(value => updates.get(value.id) ?? value), edit.members)) closeDetails();
  }
  async function remove(members: PlanBlock[]) {
    const label = members.length === 1 ? members[0].activity : `${members.length} activities`;
    if (!window.confirm(`Delete ${label}?`)) return;
    const ids = new Set(members.map(block => block.id));
    if (await save(blocks.filter(block => !ids.has(block.id)), members)) {
      if (edit?.members.some(block => ids.has(block.id))) closeDetails();
      setSelectedBlock("");
    }
  }
  function span(block: PlanBlock) {
    if (view === "day") {
      return { first: Math.max(0, ((block.start === day ? planBoundary(block, "start") : PLAN_OPEN) - PLAN_OPEN) / PLAN_STEP),
        end: Math.min(DAY_STEPS, (planDayEnd(block, day) - PLAN_OPEN) / PLAN_STEP) };
    }
    const slots = dates.flatMap(date => [coversPlanSlot(block, date, "AM"), coversPlanSlot(block, date, "PM")]);
    return { first: slots.indexOf(true), end: slots.lastIndexOf(true) + 1 };
  }
  function layoutCards(visibleBlocks: PlanBlock[]) {
    const ends: number[] = [];
    const bundles = new Map<string, PlanBlock[]>();
    for (const block of visibleBlocks) {
      const key = bundleKey(block);
      const group = bundles.get(key) ?? [];
      group.push(block);
      bundles.set(key, group);
    }
    const groups = [...bundles.values()].flatMap(group =>
      new Set(group.map(block => block.activity)).size > 1 ? [group] : group.map(block => [block]));
    return groups.map(group => ({ block: group[0], group, ...span(group[0]) }))
      .sort((left, right) => left.first - right.first || left.block.id.localeCompare(right.block.id))
      .map(entry => {
        const free = ends.findIndex(end => end <= entry.first);
        const lane = free < 0 ? ends.length : free;
        ends[lane] = entry.end;
        return { ...entry, lane };
      });
  }
  const action = gesture.current;
  const projectedUpdates = preview && action ? gestureUpdates(preview, action) : null;
  const projected = projectedUpdates ? layoutCards(blocks
    .map(block => projectedUpdates.get(block.id) ?? block)
    .filter(block => dates.some(date => coversPlanSlot(block, date, "AM") || coversPlanSlot(block, date, "PM")))) : [];
  const projectedById = new Map(projected.flatMap(entry => entry.group.map(member => [member.id, entry] as const)));
  const previewEntry = preview && projectedById.get(preview.id);
  const joinsBundle = !!previewEntry?.group.some(member => !projectedUpdates?.has(member.id));
  const entries = layoutCards(visible).map(entry => {
    if (!projectedUpdates || entry.group.some(member => projectedUpdates.has(member.id))) return entry;
    return { ...entry, lane: projectedById.get(entry.block.id)?.lane ?? entry.lane };
  });
  const lanes = Math.max(2, ...entries.map(entry => entry.lane + 1), previewEntry ? previewEntry.lane + 1 : 0);
  const bundleIsOpen = (group: PlanBlock[]) => group.length > 1 && (
    hoveredBundle === group[0].id || focusedBundle === group[0].id || group.some(item => item.id === selectedBlock)
  );
  const rowHeights = Array.from({ length: lanes }, (_, lane) => Math.max(76, ...entries.filter(entry => entry.lane === lane)
    .map(entry => 52 + Math.max(1, entry.block.installerIds.length) * 15 + (entry.block.openingIds.length ? 34 : 0)
      + (entry.group.length > 1 ? 8 + (entry.group.length - 1) * (bundleIsOpen(entry.group) ? 28 : 7) : 0)
      + (entry.group.length > 1 && entry.group.some(item => item.id === selectedBlock) ? 28 : 0))));

  function pointAt(event: PointerEvent<HTMLElement>): Point | null {
    const track = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-planner-track]");
    if (!track) return null;
    const bounds = track.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(.99999, (event.clientX - bounds.left) / bounds.width));
    if (view === "day") return { date: day, minute: PLAN_OPEN + Math.floor(fraction * DAY_STEPS) * PLAN_STEP };
    const index = Math.floor(fraction * dates.length * 2);
    return { date: dates[Math.floor(index / 2)], minute: index % 2 ? PLAN_NOON : PLAN_OPEN };
  }
  function shiftVisibleDate(date: string, offset: number) {
    const direction = Math.sign(offset);
    for (let i = 0; i < Math.abs(offset); i++) {
      date = shiftPlanDate(date, direction);
      if (isSunday(date)) date = shiftPlanDate(date, direction);
    }
    return date;
  }
  function begin(event: PointerEvent<HTMLElement>, block: PlanBlock, edge: Gesture["edge"], members = [block]) {
    if (event.button !== 0) return;
    const anchor = pointAt(event) ?? { date: today, minute: PLAN_OPEN };
    gesture.current = { x: event.clientX, y: event.clientY, block, members, edge, anchor };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }
  function candidate(event: PointerEvent<HTMLElement>): PlanBlock | null {
    const action = gesture.current;
    const point = pointAt(event);
    if (!action || !point) return null;
    const { block, edge, anchor } = action;
    if (edge === "start" || edge === "end") {
      const minute = view === "day"
        ? Math.max(PLAN_OPEN, Math.min(PLAN_CLOSE, planBoundary(block, edge) + point.minute - anchor.minute))
        : edge === "end" ? (point.minute < PLAN_NOON ? PLAN_NOON : STANDARD_SHIFT_END) : point.minute;
      const next = { ...block, [edge]: point.date, [edge + "Minute"]: minute };
      return next.end > next.start || (next.end === next.start && planBoundary(next, "end") > planBoundary(next, "start")) ? next : null;
    }
    if (view === "day") {
      const start = planBoundary(block, "start");
      const end = planBoundary(block, "end");
      const dailyEnd = block.dailyEndMinute ?? end;
      const delta = Math.max(PLAN_OPEN - start, Math.min(PLAN_CLOSE - Math.max(end, dailyEnd), point.minute - anchor.minute));
      return { ...block, startMinute: start + delta, endMinute: end + delta, dailyEndMinute: dailyEnd + delta };
    }
    const offset = (dates.indexOf(point.date) - dates.indexOf(anchor.date)) * 2 + Number(point.minute >= PLAN_NOON) - Number(anchor.minute >= PLAN_NOON);
    const startMinute = planBoundary(block, "start");
    const endMinute = planBoundary(block, "end");
    if (block.start === block.end) {
      const start = shiftVisibleDate(block.start, dates.indexOf(point.date) - dates.indexOf(anchor.date));
      if ((startMinute === PLAN_OPEN && endMinute === PLAN_NOON)
        || (startMinute === PLAN_NOON && endMinute === STANDARD_SHIFT_END)) {
        return { ...block, ...plannedRange(start, point.minute === PLAN_NOON ? "pm" : "am") };
      }
      const shift = (Number(point.minute >= PLAN_NOON) - Number(anchor.minute >= PLAN_NOON)) * (PLAN_NOON - PLAN_OPEN);
      const delta = Math.max(PLAN_OPEN - startMinute, Math.min(PLAN_CLOSE - endMinute, shift));
      return { ...block, start, end: start, startMinute: startMinute + delta, endMinute: endMinute + delta };
    }
    const startPeriod = Number(startMinute >= PLAN_NOON);
    const endPeriod = Number(endMinute > PLAN_NOON);
    const shiftedStart = startPeriod + offset;
    const shiftedEnd = endPeriod + offset;
    return {
      ...block, start: shiftVisibleDate(block.start, Math.floor(shiftedStart / 2)), end: shiftVisibleDate(block.end, Math.floor(shiftedEnd / 2)),
      startMinute: (shiftedStart % 2 + 2) % 2 === startPeriod ? startMinute : startPeriod ? PLAN_OPEN : PLAN_NOON,
      endMinute: (shiftedEnd % 2 + 2) % 2 === endPeriod ? endMinute : endPeriod ? PLAN_NOON : STANDARD_SHIFT_END,
    };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const action = gesture.current;
    if (!action || Math.hypot(event.clientX - action.x, event.clientY - action.y) < 5) return;
    suppressClick.current = true;
    if (event.clientY > window.innerHeight - 48) window.scrollBy(0, 20);
    else if (event.clientY < 48) window.scrollBy(0, -20);
    setPreview(candidate(event));
  }
  function gestureUpdates(next: PlanBlock, { edge, members }: Gesture) {
    return new Map(members.map(member => [member.id, edge === "move" ? {
      ...member, start: next.start, end: next.end, startMinute: next.startMinute,
      endMinute: next.endMinute, dailyEndMinute: next.dailyEndMinute,
    } : {
      ...member, [edge]: next[edge], [edge + "Minute"]: planBoundary(next, edge),
    }]));
  }
  async function finish(event: PointerEvent<HTMLElement>) {
    if (gesture.current && suppressClick.current) {
      const next = candidate(event);
      const action = gesture.current;
      const { edge, members } = action;
      cancelGesture();
      if (!next) return;
      const replacements = gestureUpdates(next, action);
      if (await save(blocks.map(block => replacements.get(block.id) ?? block), members)) {
        if (edge === "move" && view === "overview") setDay(next.start);
        setEdit(current => {
          const updated = current && replacements.get(current.block.id);
          return current && updated ? {
            ...current, block: updated,
            members: current.members.map(member => replacements.get(member.id) ?? member),
          } : current;
        });
      }
      return;
    }
    cancelGesture();
  }
  function cancelGesture() {
    gesture.current = null;
    setPreview(null);
  }
  function resizeHandle(block: PlanBlock, edge: "start" | "end", members?: PlanBlock[]) {
    if (edge === "start" ? block.start < dates[0] : block.end > dates.at(-1)!) return null;
    return <span className={`jp-resize jp-resize-${edge}`}
      onPointerDown={event => begin(event, block, edge, members)}
      onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture} aria-hidden="true" />;
  }
  function activitySelect(value: string, onChange: (value: string) => void, counts: ReactNode) {
    return <>
      <button type="button" className="jp-activity-trigger" popoverTarget={activityPopoverId}
        aria-label={value ? "Change activity: " + activityParts(value).activity : "Choose an activity"}>
        <span>{value ? activityParts(value).activity : "Choose an activity"}</span>
        {counts}
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <div ref={activityMenuRef} id={activityPopoverId} popover="auto" className="jp-activity-menu jp-unit-crew-popover"
        aria-label="Activities" onToggle={event => {
          if (event.newState === "open") positionCrewMenu(event.currentTarget);
        }}>
        {activityGroups.map(group => <section key={group.kind} aria-label={group.label}>
          <h3>{group.label}</h3>
          {group.choices.map(name => {
            const key = group.kind + ":" + name;
            return <button key={key} type="button" aria-pressed={value === key}
              popoverTarget={activityPopoverId} popoverTargetAction="hide" onClick={() => onChange(key)}>
              <ActivityIcon activity={name} /><span>{name}</span>
              {value === key && <Check size={14} aria-hidden="true" />}
            </button>;
          })}
        </section>)}
      </div>
    </>;
  }
  function crewPicks(ids: string[], onChange: (id: string) => void, unavailableId?: string) {
    return <div className="jp-crew-options">{crewChoices.map(id => <button disabled={id === unavailableId} type="button" key={id} aria-pressed={ids.includes(id)}
      style={crewStyle(id)} onClick={() => onChange(id)}><i aria-hidden="true" />{crewName(id)}{ids.includes(id) && <Check size={12} />}</button>)}</div>;
  }
  function unitPicks(config: WorkConfig, onChange: (config: WorkConfig) => void, activeId: string, selectUnit: (id: string) => void) {
    function selectForAssignment(id: string) {
      if (id) setUnitsCollapsed(false);
      crewBatch.current = null;
      setAssignmentNotice(null);
      selectUnit(id);
    }
    const ids = config.openingIds;
    const activity = config.activity.slice("unit:".length);
    const isDone = (id: string) => unitFirst
      ? bundleActivities.length > 0 && bundleActivities.every(key => isUnitDone(id, activityParts(key).activity))
      : isUnitDone(id, activity);
    const queue = orderedUnits(ids, activity, isDone);
    const pending = queue.filter(unit => !unit.done);
    const draggedId = priorityDrag.current?.id;
    const sourceIndex = pending.findIndex(unit => unit.id === draggedId);
    const priorityTarget = priorityPreview?.target;
    const targetIndex = pending.findIndex(unit => unit.id === priorityTarget);
    const direction = Math.sign(targetIndex - sourceIndex);
    function movePriority(id: string, target: string) {
      const from = pending.findIndex(unit => unit.id === id);
      const to = pending.findIndex(unit => unit.id === target);
      if (from < 0 || to < 0 || from === to) return;
      const openingIds = queue.map(unit => unit.id);
      openingIds.splice(from, 1);
      openingIds.splice(to, 0, id);
      onChange({ ...config, openingIds });
    }
    function priorityAt(event: PointerEvent<HTMLButtonElement>, scroll = false) {
      const list = event.currentTarget.parentElement;
      if (!list) return null;
      const bounds = list.getBoundingClientRect();
      if (event.clientY < bounds.top - 12 || event.clientY > bounds.bottom + 12) return null;
      if (scroll && event.clientY > bounds.bottom - 14) list.scrollTop += 10;
      if (scroll && event.clientY < bounds.top + 14) list.scrollTop -= 10;
      const chips = [...list.querySelectorAll<HTMLButtonElement>(".jp-priority-chip")];
      const pendingChips = chips.filter(chip => chip.dataset.priorityUnit);
      // Read the untransformed layout so moving chips cannot change the hit targets.
      const y = event.clientY - bounds.top + list.scrollTop;
      const x = event.clientX - bounds.left;
      const rowTop = (pendingChips.find(chip => y < chip.offsetTop + chip.offsetHeight) ?? pendingChips.at(-1))?.offsetTop;
      const row = pendingChips.filter(chip => chip.offsetTop === rowTop);
      const target = row.find(chip => x < chip.offsetLeft + chip.offsetWidth) ?? row.at(-1);
      const source = event.currentTarget;
      if (!target?.dataset.priorityUnit || target === source) return null;

      const reordered = chips.filter(chip => chip !== source);
      reordered.splice(chips.indexOf(target), 0, source);
      const styles = getComputedStyle(list);
      const columnGap = parseFloat(styles.columnGap) || 0;
      const rowGap = parseFloat(styles.rowGap) || 0;
      const shifts: Record<string, { x: number; y: number }> = {};
      let left = 0;
      let top = 0;
      for (const chip of reordered) {
        if (left > 0 && left + chip.offsetWidth > list.clientWidth) {
          left = 0;
          top += chip.offsetHeight + rowGap;
        }
        if (chip.dataset.chipId) {
          shifts[chip.dataset.chipId] = { x: left - chip.offsetLeft, y: top - chip.offsetTop };
        }
        left += chip.offsetWidth + columnGap;
      }
      return { target: target.dataset.priorityUnit, shifts };
    }
    const rolesByUnit = plannedOpeningCrew(config);
    const active = openings.data?.find(opening => opening.id === activeId && ids.includes(activeId));
    const roles = rolesByUnit?.[activeId] ?? { crewIds: [] };
    const popoverId = crewPopoverId + (config === draft ? "-draft" : "-edit");
    function setRoles(leadId: string | undefined, crewIds: string[]) {
      const selectionKey = (source: string) => JSON.stringify([source, [...ids].sort()]);
      const unassigned = ids.filter(id => !rolesByUnit?.[id]?.leadId && !rolesByUnit?.[id]?.crewIds.length);
      const leadChanged = leadId !== roles.leadId;
      if (crewBatch.current?.key !== selectionKey(activeId)) {
        const source = unassigned.includes(activeId) ? activeId : unassigned[0] ?? activeId;
        crewBatch.current = { key: selectionKey(source), ids: unassigned.length ? unassigned : [source] };
        if (source !== activeId) {
          selectUnit(source);
          if (leadChanged) crewIds = [];
          else {
            leadId = undefined;
            crewIds = crewIds.filter(id => !roles.crewIds.includes(id));
          }
        }
      }
      const nextCrew = { leadId, crewIds: crewIds.filter(id => id !== leadId) };
      const openingCrew = { ...rolesByUnit };
      const { ids: batchIds } = crewBatch.current;
      for (const id of batchIds) openingCrew[id] = nextCrew;
      const message = batchIds.length > 1 && leadId && leadChanged
        ? `Lead assigned to ${batchIds.length} units`
        : batchIds.length > 1 && nextCrew.crewIds.length ? `Crew assigned to ${batchIds.length} units` : "";
      setAssignmentNotice(message ? { message } : null);
      onChange({ ...config, openingCrew });
    }
    const floors = new Map<string, ProjectOpening[]>();
    const detailsFor = (opening: ProjectOpening) => project === BUILDING_3_PROJECT && people.data?.isTest
      ? building3ByMark.get(normalizeMarkCode(opening.opening_code))
      : undefined;
    for (const opening of openings.data ?? []) {
      const floor = detailsFor(opening)?.location.split(" · ")[0] ?? "Unspecified floor";
      const units = floors.get(floor) ?? [];
      units.push(opening);
      floors.set(floor, units);
    }
    const floorGroups = [...floors].sort(([left], [right]) => Number(left === "Unspecified floor") - Number(right === "Unspecified floor") ||
      right.localeCompare(left, undefined, { numeric: true }));
    return <div className="jp-unit-picker-content">
      {queue.length > 0 && <div className="jp-priority" aria-label="Unit priority">
        <div className="jp-priority-list">
          {queue.map(({ id, label, done }) => {
            const shift = priorityPreview?.shifts[id];
            return <button type="button" className="jp-priority-chip" key={id} aria-pressed={activeId === id}
            data-done={done} data-chip-id={id} data-priority-unit={done ? undefined : id}
            style={{ transform: shift ? `translate(${shift.x}px, ${shift.y}px)` : undefined }}
            data-dragging={Boolean(priorityTarget && draggedId === id)}
            data-drop-position={priorityTarget && draggedId === id ? (direction > 0 ? "after" : "before") : undefined}
            title={done ? `${label} complete` : `${label} · Drag to reorder (Alt + Left/Right)`}
            onPointerDown={event => {
              if (done || event.button !== 0) return;
              priorityDrag.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              const drag = priorityDrag.current;
              if (!drag || drag.pointer !== event.pointerId) return;
              if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 5) drag.moved = true;
              if (drag.moved) setPriorityPreview(priorityAt(event, true));
            }}
            onPointerUp={event => {
              const drag = priorityDrag.current;
              if (!drag || drag.pointer !== event.pointerId) return;
              if (drag.moved) {
                suppressClick.current = true;
                movePriority(drag.id, priorityAt(event)?.target ?? "");
              }
              priorityDrag.current = null;
              setPriorityPreview(null);
            }}
            onLostPointerCapture={() => { priorityDrag.current = null; setPriorityPreview(null); }}
            onKeyDown={event => {
              if (done || !event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault();
              const index = pending.findIndex(unit => unit.id === id);
              movePriority(id, pending[index + (event.key === "ArrowLeft" ? -1 : 1)]?.id ?? "");
            }}
            onClick={() => selectForAssignment(activeId === id ? "" : id)}>
            {done ? <Check size={12} aria-hidden="true" /> : <GripVertical size={12} aria-hidden="true" />}{label}
          </button>;
          })}
        </div>
      </div>}
      <small className="jp-assignment-notice" role="status">{assignmentNotice?.message}</small>
      <div id={unitTableId} hidden={unitsCollapsed}>
      <FloorIndex floors={floorGroups.map(([floor]) => floor)}>
          {currentFloor => floorGroups.map(([floor, units], index) => <section key={floor} className="jp-unit-stage"
            aria-label={floor} data-current-floor={index === currentFloor}>
            <h3>{floor} <span>{units.length}</span>
              {units.some(unit => isDone(unit.id)) && <span className="jp-floor-done">
                <Check size={12} aria-hidden="true" />{units.filter(unit => isDone(unit.id)).length} done
              </span>}
              <button type="button" className="jp-select-floor" aria-label={`Select all on ${floor}`}
                disabled={units.every(unit => ids.includes(unit.id))}
                onClick={() => {
                  onChange({ ...config, openingIds: [...new Set([...ids, ...units.map(unit => unit.id)])] });
                  selectForAssignment(units.find(unit => !ids.includes(unit.id))?.id ?? activeId);
                }}>
                <ListChecks size={13} aria-hidden="true" />
                {units.every(unit => ids.includes(unit.id)) ? "All selected" : "Select all"}
              </button>
            </h3>
            <div className="jp-unit-options">{units.map(opening => {
              const diagram = resolveMarkConfig(opening.opening_code, specIndex, byMark);
              const details = detailsFor(opening);
              const selected = ids.includes(opening.id);
              const done = isDone(opening.id);
              const expanded = active?.id === opening.id;
              const assigned = rolesByUnit?.[opening.id];
              const leadFirstName = assigned?.leadId ? crewName(assigned.leadId).split(/\s+/)[0] : "";
              const crewCount = assigned?.crewIds.length ?? 0;
              const info = details
                ? [details.location, details.material, details.catalog, ...details.sizes.map(size => `${details.sizeBasis} · ${size}`)]
                : [opening.label || diagram?.kind || "Details unavailable"];
              return <div className="jp-unit-card" key={opening.id} data-active-unit={expanded} data-selected-unit={selected} data-done={done}>
                <div className="jp-unit-pick">
                <button type="button" aria-pressed={selected} data-included={selected}
                  aria-expanded={expanded} aria-label={`${opening.opening_code}${selected ? " · in activity" : ""}${done ? " · Complete" : ""}`}
                  onClick={() => {
                    if (!selected) onChange({ ...config, openingIds: [...ids, opening.id] });
                    selectForAssignment(expanded ? "" : opening.id);
                  }}>
                  <strong>{opening.opening_code}</strong>
                  <span className="jp-unit-visual">
                  {diagram ? <img alt="" src={`data:image/svg+xml,${encodeURIComponent(unitSvg(diagram, 60, 35))}`} /> : <SquareDashed size={24} />}
                  {!expanded && (leadFirstName || crewCount > 0) && <span className="jp-unit-member-summary"
                    aria-label={[leadFirstName && `Lead: ${leadFirstName}`, crewCount > 0 && `${crewCount} crew`].filter(Boolean).join(", ")}>
                    {leadFirstName && <span>{leadFirstName}</span>}
                    {crewCount > 0 && <span><Users size={11} aria-hidden="true" />{crewCount}</span>}
                  </span>}
                  </span>
                  <small className="jp-unit-status" data-done={done}>{done ? <><Check size={11} aria-hidden="true" /> Complete</> : "Open"}</small>
                </button>
                </div>
                {selected && <button type="button" className="jp-unit-deselect" aria-label={`Deselect ${opening.opening_code}`}
                  onClick={() => {
                    const openingIds = ids.filter(id => id !== opening.id);
                    const openingCrew = Object.fromEntries(Object.entries(rolesByUnit ?? {}).filter(([id]) => id !== opening.id));
                    onChange({ ...config, openingIds, openingCrew });
                    selectForAssignment(expanded ? "" : activeId);
                  }}><X size={14} /></button>}
                <UnitInfo mark={opening.opening_code} lines={info} />
                {expanded && <div className="jp-unit-assign">
                  <button type="button" popoverTarget={popoverId + "-lead"} className="jp-unit-role"
                    aria-label={roles.leadId ? `Lead: ${crewName(roles.leadId)}` : "Lead"}>
                    {roles.leadId ? crewName(roles.leadId) : "Choose lead"}
                  </button>
                  <div id={popoverId + "-lead"} popover="auto" className="jp-unit-crew-popover" role="group" aria-label="Lead installer"
                    onToggle={event => positionCrewMenu(event.currentTarget)}>
                    {[undefined, ...crewChoices.filter(id => !roles.crewIds.includes(id))].map(id => (
                      <button key={id ?? "none"} type="button" aria-pressed={id === roles.leadId}
                        popoverTarget={popoverId + "-lead"} popoverTargetAction="hide"
                        onClick={() => setRoles(id, roles.crewIds)}>{id ? crewName(id) : "No lead"}</button>
                    ))}
                  </div>
                  <button type="button" popoverTarget={popoverId} className="jp-unit-role">
                    {roles.crewIds.length ? `Crew · ${roles.crewIds.length}` : "Choose crew"}
                  </button>
                  <div id={popoverId} popover="auto" className="jp-unit-crew-popover" role="group" aria-label="Crew members"
                    onToggle={event => positionCrewMenu(event.currentTarget)}>
                    {crewChoices.filter(id => id !== roles.leadId).map(id => (
                      <label key={id}><input type="checkbox" checked={roles.crewIds.includes(id)}
                        onChange={() => setRoles(roles.leadId, toggle(roles.crewIds, id))} />{crewName(id)}</label>
                    ))}
                  </div>
                </div>}
              </div>;
            })}</div>
          </section>)}
      </FloorIndex>
      </div>
      {ids.length > 0 && <div className="jp-unit-table-actions">
        <button type="button" aria-controls={unitTableId} aria-expanded={!unitsCollapsed}
          onClick={() => setUnitsCollapsed(current => !current)}>
          {unitsCollapsed ? "Show units" : "Hide units"}
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      </div>}
    </div>;
  }
  function workContent(block: PlanBlock, showTitle = true): ReactNode {
    const queue = orderedUnits(block.openingIds, block.activity);
    const doneCount = queue.filter(unit => unit.done).length;
    const unitDetails = queue.map(({ label, done }) => done ? `${label} (done)` : label);
    function unitChip({ id, label, done }: typeof queue[number], index: number) {
      const diagram = resolveMarkConfig(label, specIndex, byMark);
      return <span className="jp-scope-unit" key={id} title={unitDetails[index]} data-done={done}>
        <span>{done && <Check size={11} aria-hidden="true" />}{label}</span>
        {diagram ? <img alt="" src={`data:image/svg+xml,${encodeURIComponent(unitSvg(diagram, 36, 28))}`} /> : <SquareDashed size={22} aria-hidden="true" />}
      </span>;
    }
    return <span className="jp-card-content">
      {showTitle && <strong className="jp-work-title jp-calendar-label">
        <ActivityIcon activity={block.activity}/>
        <span onPointerEnter={event => {
          const title = event.currentTarget;
          if (event.pointerType === "mouse" && title.scrollWidth > title.clientWidth) {
            (title.nextElementSibling as HTMLElement).showPopover();
          }
        }} onPointerLeave={event => {
          (event.currentTarget.nextElementSibling as HTMLElement).hidePopover();
        }}>{block.activity}</span>
        <span className="jp-title-overflow" popover="manual" aria-hidden="true"
          onToggle={event => positionCrewMenu(event.currentTarget)}>{block.activity}</span>
      </strong>}
      <span className="jp-members">{block.installerIds.length ? block.installerIds.map(id =>
        <span key={id} style={crewStyle(id)}><i aria-hidden="true" />{crewName(id)}</span>) : <span className="jp-unassigned">Crew unassigned</span>}</span>
      {queue.length > 0 && <span className="jp-scope">
        <span className="jp-scope-count" title={unitDetails.join(", ")}>{doneCount > 0 ? `${doneCount}/` : ""}{queue.length} {queue.length === 1 ? "unit" : "units"}</span>
        <span className="jp-scope-units" aria-label={unitDetails.join(", ")}>
          {queue.slice(0, 6).map(unitChip)}
        </span>
          <span className="jp-scope-more" data-count={Math.min(queue.length, 7)}
            onPointerEnter={event => {
              const row = event.currentTarget.lastElementChild as HTMLElement;
              if (event.pointerType === "mouse" && !row.matches(":popover-open")) row.showPopover();
            }}
            onPointerLeave={event => {
              if (event.pointerType === "mouse") (event.currentTarget.lastElementChild as HTMLElement).hidePopover();
            }}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation();
              const row = event.currentTarget.lastElementChild as HTMLElement;
              if (!row.matches(":popover-open")) row.showPopover();
            }}>
            <span aria-label="Show all units">…</span>
            <span className="jp-scope-overflow" popover="auto" onToggle={event => positionCrewMenu(event.currentTarget, 0)}>
              {queue.map(unitChip)}
            </span>
          </span>
      </span>}
    </span>;
  }
  const editingBundle = !!edit && edit.members.length > 1;
  const unitFirst = !edit && buildBy === "unit";
  const bundle = unitFirst ? { ...draft, activity: bundleActivities[0] ?? "unit:" } : draft;
  const draftAssignments = blockAssignments(bundle);
  const builder = edit?.config ?? bundle;
  const builderAssignments = edit ? blockAssignments(builder, edit.block.kind === "unit" && !edit.block.unitCrewOnly ? edit.block.installerIds : []) : draftAssignments;
  const setBuilder = (config: WorkConfig) => edit ? setEdit({ ...edit, config }) : setDraft(unitFirst ? { ...config, activity: "" } : config);
  const endDate = endAt.slice(0, 10);
  const startMinute = dateTimeMinute(startAt);
  const endMinute = dateTimeMinute(endAt);
  const validRange = startAt && endAt && endAt > startAt
    && !isSunday(scheduleDate) && !isSunday(endDate)
    && startMinute >= PLAN_OPEN && startMinute < PLAN_CLOSE
    && endMinute > PLAN_OPEN && endMinute <= PLAN_CLOSE;
  const drafted = (unitFirst ? bundleActivities.length > 0 && draft.openingIds.length > 0 : draft.activity) && validRange ? {
    id: "draft", ...activityParts(bundle.activity), start: scheduleDate, end: endDate, startMinute, endMinute, ...draftAssignments,
  } : null;
  const columnCount = view === "day" ? DAY_STEPS : dates.length * 2;
  const times = Array.from({ length: DAY_STEPS }, (_, index) => PLAN_OPEN + index * PLAN_STEP);
  const slots = view === "day" ? times.map(minute => ({ date: day, minute })) : dates.flatMap(date => [
    { date, minute: PLAN_OPEN }, { date, minute: PLAN_NOON },
  ]);
  const loadError = people.error || openings.error || specs.error || catalog.error;
  return <section className="job-planner" aria-label="Job planner" onPointerDownCapture={() => { suppressClick.current = false; }}
    onClick={event => { if (!(event.target instanceof Element && event.target.closest(".jp-event, .jp-composer"))) setSelectedBlock(""); }}
    onClickCapture={event => { if (event.detail && suppressClick.current) { event.stopPropagation(); suppressClick.current = false; } }}>
    <PlannerJobContext projectId={project} />
    {(error || loadError) && <p role="alert">{error || formatApiError(loadError)}</p>}
    {sharedBusy && <p role="status">Saving plan...</p>}
    <section className="jp-calendar" aria-label="Work calendar" inert={sharedBusy}>
      <section className="jp-composer" ref={composerRef} aria-label={edit ? editingBundle ? "Edit bundle" : "Edit activity" : "Plan an activity"}
        onKeyDown={event => { if (edit && event.key === "Escape" && !event.defaultPrevented) closeDetails(); }}>
        {edit && <h2 className="jp-edit-heading">{editingBundle ? "Edit bundle" : "Edit activity"}</h2>}
        {!edit && !buildBy && <div className="jp-build-choice" role="group" aria-label="Schedule work by">
          <h2>Schedule work by…</h2>
          <button type="button" onClick={() => setBuildBy("activity")}>Activity</button>
          <button type="button" onClick={() => setBuildBy("unit")}>Unit</button>
        </div>}
        {unitFirst && <div className="jp-compose-header jp-unit-builder-heading">
          <h2>By unit</h2>
          <button type="button" className="jp-close-composer" aria-label="Cancel schedule" onClick={cancelSchedule}><X size={16} /></button>
        </div>}
        {(edit || buildBy === "activity") && <div className="jp-compose-header">
          {editingBundle && <span className="jp-edit-bundle-activities">{edit?.members.map(member => member.activity).join(" · ")}</span>}
          {!editingBundle && <div className="jp-compose-selection">
            {activitySelect(builder.activity, activity => {
              setUnitsCollapsed(false);
              if (edit) { setBuilder({ ...builder, activity }); return; }
              setDraft(current => ({ ...current, activity }));
            }, builder.activity && <span className="jp-draft-counts" aria-live="polite">
              {builder.activity.startsWith("unit:") && <span title="Units selected" aria-label={`${builderAssignments.openingIds.length} units selected`}>
                <SquareDashed size={16} aria-hidden="true" />{builderAssignments.openingIds.length}
              </span>}
              <span title="Unique members" aria-label={`${builderAssignments.installerIds.length} unique members`}>
                <Users size={16} aria-hidden="true" />{builderAssignments.installerIds.length}
              </span>
            </span>)}
          </div>}
          {edit && <button type="button" ref={closeRef} className="jp-close-composer" aria-label="Cancel edit"
            onClick={closeDetails}><X size={16} /></button>}
          {!edit && (
            <button type="button" className="jp-close-composer" aria-label="Cancel schedule" onClick={cancelSchedule}>
              <X size={16} />
            </button>
          )}
        </div>}
        {(unitFirst || builder.activity) && <div className="jp-draft">
            {builder.activity.startsWith("unit:") ? (
              <section className="jp-compose-tools" aria-label="Units">
                {unitPicks(builder, setBuilder, edit ? editUnit : draftUnit, edit ? setEditUnit : setDraftUnit)}
              </section>
            ) : (
              <section className="jp-compose-tools" aria-label="Crew">
                {crewPicks(builder.installerIds, id => setBuilder({ ...builder, installerIds: toggle(builder.installerIds, id) }))}
              </section>
            )}
          {unitFirst && draft.openingIds.length > 0 && <section className="jp-bundle-activities" aria-label="Activities for selected units">
            <strong>Activities <small role="status">{bundleActivities.length} selected</small></strong>
            <div>
              {activityGroups.find(group => group.kind === "unit")?.choices.map(name => <button key={name}
                type="button" aria-pressed={bundleActivities.includes("unit:" + name)}
                onClick={() => setBundleActivities(current => toggle(current, "unit:" + name))}>
                <ActivityIcon activity={name} />{name}
              </button>)}
            </div>
          </section>}
          {edit ? <div className="jp-compose-footer jp-edit-footer">
            <div className="jp-time-fields">
              {(["start", "end"] as const).map(edge => {
                const minute = planBoundary(edit.block, edge);
                const hours = String(Math.floor(minute / 60)).padStart(2, "0");
                const minutes = String(minute % 60).padStart(2, "0");
                const date = edit.block[edge];
                return <label key={edge}>{edge === "start" ? "Start" : "End"}
                  <input type="datetime-local" step={900} value={date ? `${date}T${hours}:${minutes}` : ""}
                    onChange={event => {
                      const [nextDate, time] = event.currentTarget.value.split("T");
                      const [hour, minute] = time ? time.split(":").map(Number) : [0, 0];
                      setEdit({ ...edit, block: { ...edit.block, [edge]: nextDate, [`${edge}Minute`]: hour * 60 + minute } });
                    }} />
                </label>;
              })}
            </div>
            <div className="jp-edit-actions">
              <button type="button" onClick={closeDetails}>Cancel</button>
              <button type="button" className="jp-schedule" onClick={saveDetails}>Save changes</button>
            </div>
          </div> : <div className="jp-compose-footer">
            <div className="jp-compose-fields">
              <div className="jp-time-fields">
                <label>Start<input type="datetime-local" value={startAt} onChange={event => {
                  const next = event.currentTarget.value;
                  const nextDate = next.slice(0, 10);
                  if (!endAt || (nextDate !== scheduleDate && endDate === scheduleDate)) {
                    setEndAt(dateTime(nextDate, 17 * 60));
                  }
                  setStartAt(next);
                }} /></label>
                <label>End<input type="datetime-local" value={endAt} onChange={event => {
                  setEndAt(event.currentTarget.value);
                }} /></label>
              </div>
              <div className="jp-create-actions">
                <button type="button" onClick={cancelSchedule}>Cancel</button>
                <button className="jp-schedule" type="button" disabled={!drafted} onClick={schedule}>Schedule</button>
              </div>
              {startAt && endAt && !validRange && <small role="status">
                Choose Monday through Saturday, between 7 AM and 7 PM, with the end after the start.
              </small>}
            </div>
          </div>}
        </div>}
      </section>
      {view === "day" && <div className="jp-calendar-heading">
          <button type="button" className="jp-back-to-calendar" onClick={() => setView("overview")}><ArrowLeft size={14} aria-hidden="true" /> Back to calendar</button>
          <label className="jp-date-picker">Date<input type="date" value={day} onChange={event => { if (event.target.value) setDay(isSunday(event.target.value) ? shiftPlanDate(event.target.value, 1) : event.target.value); }} /></label>
      </div>}
      <div className="jp-scroll" ref={scrollRef} onScroll={event => { if (view === "overview") overviewScroll.current = event.currentTarget.scrollLeft; }}>
        <div className="jp-grid" style={{ gridTemplateColumns: `repeat(${view === "day" ? 12 : dates.length * 2}, ${view === "day" ? "84px" : "100px"})` }}>
          {view === "day" ? <span className="jp-date" data-date={day} data-today={day === today} style={{ gridColumn: "1 / -1" }}><DateLabel date={day} /></span>
          : dates.map(date => <button type="button" key={date} className="jp-date" data-date={date} data-today={date === today} data-weekend={[0, 6].includes(new Date(date + "T00:00:00Z").getUTCDay())}
            onClick={() => { setDay(date); setView("day"); }}><DateLabel date={date} /></button>)}
          {view === "day" ? HOURS.map(minute => <span className="jp-period" key={minute}>{timeLabel(minute)}</span>)
            : dates.flatMap(date => ["AM", "PM"].map(period => <span className="jp-period" data-today={date === today} key={date + period}>{period}</span>))}
          <div className="jp-track" data-planner-track data-mode={view}
            style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`, gridTemplateRows: rowHeights.map(height => height + "px").join(" ") + " minmax(0, 1fr)" }}>
            {slots.map((point, index) => <div className="jp-cell" key={point.date + point.minute} data-today={point.date === today}
              style={{ gridColumn: index + 1, gridRow: "1 / -1" }} aria-hidden="true" />)}
            {entries.map(({ block, group, first, end, lane }) => {
              const placement = { gridColumn: `${first + 1} / ${end + 1}`, gridRow: lane + 1 };
              if (group.length > 1) {
                const selected = group.find(item => item.id === selectedBlock);
                const front = selected ?? block;
                return <article key={block.id} className="jp-event jp-bundled-event" data-plan-block={block.id}
                  aria-label="Bundled activities" data-stack-selected={!!selected} data-stack-open={bundleIsOpen(group)} data-moving={group.some(item => item.id === preview?.id)}
                  onPointerEnter={event => { if (event.pointerType === "mouse") setHoveredBundle(block.id); }}
                  onPointerLeave={event => { if (event.pointerType === "mouse") setHoveredBundle(current => current === block.id ? "" : current); }}
                  onFocus={event => { if (event.target.matches(":focus-visible")) setFocusedBundle(block.id); }}
                  onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedBundle(current => current === block.id ? "" : current); }}
                  style={{ ...activityColor(activityKey(front)), ...placement, "--jp-stack-depth": group.length - 1 } as CSSProperties}>
                  {resizeHandle(block, "start", group)}
                  {resizeHandle(block, "end", group)}
                  {selected && <div className="jp-stack-summary">
                    <button type="button" className="jp-stack-drag" aria-label="Drag to move bundle" title="Drag to move bundle"
                      onPointerDown={event => begin(event, block, "move", group)}
                      onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture}>
                      <GripVertical size={14} aria-hidden="true" /><span>{group.length} activities</span>
                    </button>
                    <button type="button" className="jp-stack-edit" aria-label="Edit bundle" title="Edit bundle"
                      disabled={isEditing(group)} onClick={() => openDetails(selected, group)}>
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                    <button type="button" className="jp-stack-edit" aria-label="Delete bundle" title="Delete bundle"
                      onClick={() => void remove(group)}><Trash2 size={13} aria-hidden="true" /></button>
                  </div>}
                  {group.map((item, index) => {
                    const isFront = item.id === front.id;
                    const frontIndex = group.indexOf(front);
                    const depth = isFront ? group.length - 1 : index - Number(index > frontIndex);
                    return <div key={item.id} className="jp-stack-layer" data-front={isFront}
                      style={{ ...activityColor(activityKey(item)), "--jp-layer-depth": depth, zIndex: depth } as CSSProperties}>
                      <div className="jp-stack-header">
                        <button type="button" className="jp-stack-title jp-calendar-label" aria-pressed={isFront}
                          title={isFront ? undefined : item.activity}
                          onPointerDown={event => begin(event, item, "move")}
                          onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture}
                          onClick={() => setSelectedBlock(item.id)}>
                          <ActivityIcon activity={item.activity} /><span>{item.activity}</span>
                        </button>
                        {selected?.id === item.id && <div className="jp-stack-actions">
                          <button type="button" className="jp-stack-edit" aria-label={"Edit " + item.activity}
                            disabled={isEditing([item])} onClick={() => openDetails(item)}><Pencil size={13} aria-hidden="true" /></button>
                          <button type="button" className="jp-stack-edit" aria-label={"Delete " + item.activity}
                            onClick={() => void remove([item])}><Trash2 size={13} aria-hidden="true" /></button>
                        </div>}
                      </div>
                      {isFront && <div className="jp-event-body jp-stack-body"
                        onClick={() => setSelectedBlock(item.id)}>{workContent(item, false)}</div>}
                    </div>;
                  })}
                </article>;
              }
              return <article key={block.id} data-plan-block={block.id} data-selected={selectedBlock === block.id}
              className="jp-event" data-moving={preview?.id === block.id}
              style={{ ...activityColor(activityKey(block)), ...placement }}>
              {resizeHandle(block, "start")}
              <button type="button" className="job-plan-assignment jp-event-body"
                aria-label={block.activity + " · " + block.installerIds.map(crewName).join(", ")}
                onPointerDown={event => begin(event, block, "move")} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture}
                aria-pressed={selectedBlock === block.id}
                onClick={() => setSelectedBlock(current => current === block.id ? "" : block.id)}>{workContent(block)}</button>
              {selectedBlock === block.id && <div className="jp-event-actions">
                <button type="button" className="jp-event-edit" aria-label={"Edit " + block.activity} disabled={isEditing([block])}
                  onClick={() => openDetails(block)}><Pencil size={14} aria-hidden="true" /></button>
                <button type="button" className="jp-event-edit" aria-label={"Delete " + block.activity}
                  onClick={() => void remove([block])}><Trash2 size={14} aria-hidden="true" /></button>
              </div>}
              {resizeHandle(block, "end")}
            </article>;
            })}
            {preview && previewEntry && previewEntry.first >= 0 && <div className="jp-drop-preview"
              data-joins-bundle={joinsBundle} aria-hidden="true"
              style={{ ...activityColor(activityKey(preview)), gridColumn: `${previewEntry.first + 1} / ${previewEntry.end + 1}`, gridRow: previewEntry.lane + 1 }}>
              <strong>{joinsBundle ? `Joins ${previewEntry.group.length}-activity bundle` :
                previewEntry.group.length > 1 ? `${previewEntry.group.length} activities` : preview.activity}</strong>
            </div>}
          </div>
        </div>
      </div>
    </section>
  </section>;
}
