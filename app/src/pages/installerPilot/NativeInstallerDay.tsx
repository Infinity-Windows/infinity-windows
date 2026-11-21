import { closePreviewSession, useWorkdayPreview } from "./workdayPreview";
import { WorkdayJobs } from "../work/WorkdayJobs";
import "../work/work.css";
import { readActivityDone, readPublishedPlan, readPublishedUnitSchedule } from "../../lib/installerWorkflow/sharedPlan";
import { PilotActivityOptions, type PilotOptions } from "./PilotActivityOptions";
import { useLanguage } from "../../lib/i18n";
import { ActivityIcon, activityLabel } from "./workdayActivities";
import "./workdaySimple.css";
import { PILOT_ACTIVITIES } from "../../lib/installerWorkflow/pilotActivities";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Check, ChevronDown, ClipboardList, Clock, Coffee, Play, Square, Tractor, X } from "lucide-react";
import { workdayProjectQuery, type Sandbox } from "../../lib/installerWorkflow/workdayProject";
import { listMarkSpecs, listOpenings } from "../../lib/install/api";
import { mintPunch } from "../../lib/clockPunch";
import { useClock, openClockGlobally } from "../../lib/clockContext";
import { useWork } from "../../lib/customWork/useWork";
import { canEditUnit, finishedStop, markCompleteUnit } from "../../lib/customWork/complete";
import { listWorkUnits, listCrewWorkRecords, listWorkSessions } from "../../lib/customWork/api";
import { localWorkDate, clockText, seconds, type WorkAction, type WorkCommand, type WorkSession, type WorkUnit } from "../../lib/customWork/model";
import { readWorkQueue, WORK_COMMAND_SENT } from "../../lib/customWork/queue";
import { withQueuedUnits } from "../../lib/installerWorkflow/queuedUnits";
import { assignmentUnit, nativeStartPayload, type DayTask } from "../../lib/installerWorkflow/nativeDay";
import { formatApiError } from "../../lib/errors";
import { useTodayTalk, useToolboxToday } from "../../lib/useToolboxGate";
import { ToolboxSignCard } from "../../components/clock/ToolboxSignCard";
import { unitWorkLocked } from "../../lib/work/startDay";
import { openingFullSheetPath } from "../../lib/install/openingRowAction";
import { catalogByMarkFrom, resolveMarkConfig } from "../../lib/modelstudio/fromProject";
import { listStudioUnits } from "../../lib/modelstudio/units";
import { indexSpecsByMark } from "../../lib/install/specs";
import { signInMark, stillSignedInAs } from "../../lib/signedIn";
import { BUILDING_3_PROJECT, currentPlanBlocks, planBoundary, type PlanBlock } from "../../lib/installerWorkflow/jobPlan";
import { building3PreviewDone, building3ProgressBlocks } from "../../lib/installerWorkflow/unitProgress";
import { readUnitState } from "../../lib/installerWorkflow/unitState";
import { unitPicture } from "../../lib/install/unitDefinitionDiagram";
import { UnitKindIcon } from "../../components/install/UnitKindIcon";
import { UnitTile } from "../../components/install/UnitTile";
import { workStartTime } from "../../lib/installerWorkflow/startTime";
import { useWorkdayShiftControls } from "./WorkdayShiftControls";
import { useStoredState } from "../../lib/useStoredState";
import { AgendaUnitDetails } from "../work/AgendaUnitDetails";
import { unitFloor, unitSourceMark, type UnitDetailsWrite } from "../../lib/install/unitDetails";
import { UnitActivityFacts, UnitCompletion, UnitDetailsDialog, UnitDetailsPanel, useProfileNames } from "../../components/install/UnitDetails";
import { reviewedBuilding3Openings } from "./building3Openings";
import { VoiceControl } from "../../components/voice/VoiceControl";
import "../../components/work/installerTaskBoard.css";
import "../../components/work/installerSteel.css";
type Choice = {
    scope: "unit" | "job" | "company";
    activity: string;
};
/** The picker choice a running or stopped session was started from. */
const choiceOf = (session: WorkSession): Choice => session.unit_id
    ? { scope: "unit", activity: session.stage }
    : { scope: session.project_id === null ? "company" : "job", activity: session.description.split(" — ", 1)[0] };
const unitActivities = PILOT_ACTIVITIES[1].names;
const generalActivities = PILOT_ACTIVITIES[0].names;
const company = ["Company delivery", "Container unloading", "Warehouse work", "Equipment / yard", "Training", "Other company work"];
interface Actions {
    sessions: WorkSession[];
    active: WorkSession | null;
    blocked: boolean;
    finishBlocked: boolean;
    error: string;
    start: (c: Choice, id?: string, previousNote?: string) => Promise<void>;
    update: (data: Record<string, unknown>) => Promise<void>;
    /** Saves the viewer as lead of a planned unit activity. Absent in the preview, where nothing is sent. */
    takeLead?: (openingId: string, activity: string) => void;
    completeUnit: (openingId: string, note?: string) => Promise<void>;
    /** Keeps a unit made with no signal in the work queue, ahead of any timer started on it. Absent in the preview. */
    createUnit?: (write: UnitDetailsWrite) => Promise<void>;
}
export function NativeInstallerDay() {
    const [params] = useSearchParams(), project = params.get("project"), planAs = params.get("planAs"), day = params.get("planDate") ?? localWorkDate();
    const simulator = useWorkdayPreview(`standalone:${planAs ?? "self"}:${day}`);
    const previousProject = useRef(project);
    useEffect(() => {
        if (previousProject.current !== project) {
            simulator.stopWork();
            previousProject.current = project;
        }
    }, [project, simulator]);
    const planBlock = params.get("planBlock");
    const planName = params.get("planName")?.trim().slice(0, 80);
    return <WorkdayProject project={project} planAs={planAs} day={day} planBlock={planBlock}
      planName={planName} simulator={simulator} live={params.get("work") === "1"} />;
}

export function WorkdayProject({ project, planAs, day, planBlock, planName, live, embedded = false, jobPicker, simulator }: {
    project: string | null;
    planAs: string | null;
    day: string;
    planBlock: string | null;
    planName?: string;
    live: boolean;
    embedded?: boolean;
    simulator?: ReturnType<typeof useWorkdayPreview>;
    jobPicker?: (name: string) => import("react").ReactNode;
}) {
    const clock = useClock();
    const q = useQuery({ ...workdayProjectQuery(clock.profileId, project), enabled: !!clock.profileId });
    return <div className="pilot-shell native-installer-day">{q.error && !q.data ? <><p role="alert">{formatApiError(q.error)}</p><button onClick={() => void q.refetch()}>Retry project lookup</button></> : !q.data ? <p role="status">Checking sandbox access...</p> : !planAs && day === localWorkDate() && (q.data.isTest || live) ? <LiveDay key={q.data.id} sandbox={q.data} planBlock={planBlock} embedded={embedded} jobPicker={jobPicker}/> : <PreviewDay key={`${q.data.id}:${planAs}:${day}:${planBlock}`} sandbox={q.data} person={planAs ?? q.data.actorId} day={day} planBlock={planBlock} planName={planName} embedded={embedded} jobPicker={jobPicker} simulator={simulator}/>}</div>;
}
function PreviewDay({ sandbox, person, day, planBlock, planName, embedded, jobPicker, simulator }: {
    sandbox: Sandbox;
    person: string;
    day: string;
    planBlock: string | null;
    planName?: string;
    embedded: boolean;
    simulator?: ReturnType<typeof useWorkdayPreview>;
    jobPicker?: (name: string) => import("react").ReactNode;
}) {
    const fallbackSimulator = useWorkdayPreview(`standalone:${person}:${day}`);
    const { sessions, setSessions, unitCompletion, setUnitCompletion, clockState, setClock } = simulator ?? fallbackSimulator;
    const { lang } = useLanguage();
    const es = lang === "es";
    const active = sessions.find(session => !session.ended_at) ?? null;
    const actions: Actions = { sessions, active, blocked: clockState === "break", finishBlocked: clockState === "break", error: "", update: async data => {
        setSessions(old => old.map(session => session.id !== data.id ? session : {
            ...session,
            ...(data.done ? { workday_done_at: String(data.at) } : {}),
            ...(typeof data.machinery_running === "boolean" ? {
                workday_machinery_ms: Number(data.machinery_ms),
                workday_machinery_started_at: data.machinery_running ? String(data.at) : null,
            } : {}),
        }));
    }, completeUnit: async (openingId, note) => {
        const at = Date.now();
        setSessions(old => old.map(session =>
            !session.ended_at && session.project_id === sandbox.id && session.unit_id === openingId
                ? closePreviewSession({ ...session, description: note || session.description }, at, true) : session));
        setUnitCompletion(old => ({ ...old, [openingId]: true }));
    }, start: async (choice, unit) => {
        if (clockState === "break") return;
        if (clockState === "off") setClock("working");
        begin(choice, unit, !!active?.workday_machinery_started_at);
    } };
    function begin(choice: Choice, unit: string | undefined, continueMachinery: boolean) {
        const at = Date.now();
        const session: WorkSession = {
            id: crypto.randomUUID(), profile_id: person, project_id: choice.scope === "company" ? null : sandbox.id,
            unit_id: unit ?? null, shift_id: "preview", stage: choice.scope === "unit" ? choice.activity : "Idle time",
            description: choice.scope === "unit" ? "" : choice.activity, started_at: new Date(at).toISOString(),
            ended_at: null, end_reason: null, delay_reason: "", outcome: null, participation: "install", kind: unit ? "unit" : "idle", revision: 0,
            workday_machinery_started_at: continueMachinery ? new Date(at).toISOString() : null,
        };
        setSessions(old => [...old.map(item => closePreviewSession(item, at)), session]);
    }
    // As on a real shift: a break stops the activity, and Resume starts the same one again.
    const beforeBreak = useRef<{ choice: Choice; unit?: string }>(undefined);
    const toggleBreak = () => {
        if (clockState !== "break") {
            beforeBreak.current = active ? { choice: choiceOf(active), unit: active.unit_id ?? undefined } : undefined;
            return setClock("break");
        }
        setClock("working");
        if (beforeBreak.current) begin(beforeBreak.current.choice, beforeBreak.current.unit, false);
    };
    const clockControls = clockState !== "off" && (
      <section className="wd-preview-clock-actions" aria-label={es ? "Reloj de prueba" : "Preview clock"}>
        <button type="button" className="wd-break" onClick={toggleBreak}>
          {clockState === "break" ? <Play size={15} aria-hidden="true" /> : <Coffee size={15} aria-hidden="true" />}
          {clockState === "break" ? (es ? "Continuar" : "Resume") : (es ? "Descanso" : "Break")}
        </button>
        <button type="button" className="wd-clock-out" onClick={() => setClock("off")}><Square size={15} fill="currentColor" aria-hidden="true" />{es ? "Marcar salida" : "Clock out"}</button>
      </section>
    );
    return <DayView sandbox={sandbox} person={person} day={day} actions={actions} planBlock={planBlock}
      planName={planName} embedded={embedded} jobPicker={jobPicker} clockControls={clockControls} unitCompletion={unitCompletion} previewClock={clockState} preview />;

}
function LiveDay({ sandbox, planBlock, embedded, jobPicker }: {
    sandbox: Sandbox;
    planBlock: string | null;
    embedded: boolean;
    jobPicker?: (name: string) => import("react").ReactNode;
}) {
    const work = useWork(), [, setBusy] = useState(false), [error, setError] = useState("");
    const savingTimer = useRef(false);
    const { lang } = useLanguage();
    // What the person tapped while the Toolbox Talk or clock-in stood in the way.
    // Kept through a reload, so signing the talk still starts it; dropped after
    // half an hour so an old tap never starts a paid timer by surprise.
    const [pendingStart, setPendingStart] = useStoredState<{ choice: Choice; openingId?: string; note?: string } | undefined>(
        `forge:workday-pending-start:${sandbox.id}:${sandbox.actorId}`, undefined, { session: true, maxAgeMs: 30 * 60_000 });
    const talk = useTodayTalk(), signed = useToolboxToday(sandbox.actorId);
    const talkLocked = unitWorkLocked({
        talkExists: talk.isSuccess ? talk.data !== null : null,
        signedToday: signed.isSuccess ? Boolean(signed.data) : null,
    });
    // With the units created on this phone that Forge has not saved yet.
    const openings = useQuery({ queryKey: ["openings", sandbox.id], queryFn: () => listOpenings(sandbox.id),
        select: rows => withQueuedUnits(rows, work.queue, sandbox.id) });
    const queryClient = useQueryClient();
    useEffect(() => {
        // Once a unit made on the phone reaches Forge (or is turned away), read the job's units again.
        const sent = (event: Event) => {
            if ((event as CustomEvent<WorkCommand>).detail?.action === "unit_create")
                void queryClient.invalidateQueries({ queryKey: ["openings", sandbox.id] });
        };
        window.addEventListener(WORK_COMMAND_SENT, sent);
        return () => window.removeEventListener(WORK_COMMAND_SENT, sent);
    }, [queryClient, sandbox.id]);
    // Not `busy`: a tap that is being saved used to disable every tile for a
    // moment, which read as the whole screen refreshing (Matt, 2026-11-20).
    // run() already ignores a second tap while the first is saving.
    const unavailable = work.actionsLoading || work.clock.loading || !!work.queueError || work.user !== sandbox.actorId || work.clock.profileId !== sandbox.actorId;
    // A refused save no longer locks the picker, the unit taps or Mark done:
    // it waits for review while new work is recorded and sent (Matt, 2026-11-20).
    const blocked = unavailable;
    const finishBlocked = unavailable;
    const run = async (fn: () => Promise<void>, isBlocked = blocked) => { if (isBlocked || savingTimer.current)
        return; savingTimer.current = true; setBusy(true); setError(""); const mark = signInMark(); try {
        if (!stillSignedInAs(mark, sandbox.actorId))
            throw new Error("Sign-in changed. Reopen Workday.");
        await fn();
    }
    catch (e) {
        setError(formatApiError(e));
    }
    finally {
        savingTimer.current = false;
        setBusy(false);
    } };
    const finishNote = (note?: string) => !note || !work.active ? undefined
        : work.active.unit_id ? note : `${work.active.description.split(" — ")[0]} — ${note}`;
    const recordStart = async (c: Choice, id: string | undefined, previousNote: string | undefined,
        shiftId: string, projectId: string | null, tappedAt: string, fromClockIn = false) => {
        let task: DayTask | undefined;
        if (c.scope === "unit") {
            const opening = openings.data?.find(o => o.id === id && o.project_id === sandbox.id);
            if (!opening)
                throw new Error("This opening is unavailable. Reload before starting work.");
            const unit = { created_by: sandbox.actorId, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...assignmentUnit(opening, work.units, crypto.randomUUID()) };
            task = { id: `${unit.id}:${c.activity}`, unit, opening, stage: c.activity, assignmentIds: [] };
        }
        const idForSession = crypto.randomUUID();
        const payload = nativeStartPayload({ projectId, shiftId, actorId: sandbox.actorId, active: fromClockIn ? null : work.active, task,
            general: c.scope === "unit" ? undefined : c.activity, id: idForSession, at: tappedAt });
        const commands: { action: WorkAction; data: Record<string, unknown> }[] = [];
        if (task && !work.units.some(unit => unit.id === task.unit.id)) commands.push({ action: "unit", data: { ...task.unit } });
        commands.push({ action: "start", data: { ...payload, finish_note: fromClockIn ? undefined : finishNote(previousNote), preserve_unit_completion: true, workday_from_clock_in: fromClockIn } });
        if (!fromClockIn && work.active?.project_id === projectId && work.active.workday_machinery_started_at)
            commands.push({ action: "workday_activity", data: { id: idForSession, at: tappedAt, machinery_ms: 0, machinery_running: true } });
        await work.commandMany(commands, { background: true });
    };
    const actions: Actions = { sessions: work.sessions, active: work.active, blocked, finishBlocked, error: error || (work.error || work.queueError ? formatApiError(work.error || work.queueError) : ""), update: data => run(() => work.command("workday_activity", data, { background: true })),
        // Not through run(): taking lead is not a timer change and must not wait on one.
        createUnit: write => work.command("unit_create", write as unknown as Record<string, unknown>, { background: true }).then(() => undefined),
        takeLead: (openingId, activity) => void work.command("plan_unit_lead", { project_id: sandbox.id, opening_id: openingId, activity }, { background: true }).catch(() => undefined),
        completeUnit: (openingId, note) => run(async () => {
            const opening = openings.data?.find(o => o.id === openingId && o.project_id === sandbox.id);
            if (!opening) throw new Error("This opening is unavailable. Reload before completing it.");
            const at = new Date().toISOString();
            const unit = {
                created_by: sandbox.actorId, created_at: at, updated_at: at,
                ...assignmentUnit(opening, work.units, crypto.randomUUID()),
            };
            if (!canEditUnit(unit, work.user, sandbox.canEditAllUnits))
                throw new Error("Only the unit record’s author or a foreman can mark the whole unit complete.");
            const completion = { action: "unit", data: markCompleteUnit(unit), intent: "complete-unit" } as const;
            const active = work.active;
            if (active?.project_id === sandbox.id && active.unit_id === unit.id) {
                await work.commandMany([{ action: "stop", data: finishedStop(active, at, note ?? "", "") }, completion], { background: true });
            } else {
                await work.commandMany([completion], { background: true });
            }
        }, finishBlocked), start: (c, id, previousNote) => {
            const tapMs = Date.now();
            return run(async () => {
            const projectId = c.scope === "company" ? null : sandbox.id, shift = work.clock.shift;
            const request = { choice: c, openingId: id, note: previousNote };
            if (work.clock.isOpen || (c.scope === "unit" && !id)) return;
            const target = c.scope === "unit" && work.units.find(unit => unit.opening_id === id && unit.project_id === projectId);
            if (work.active && work.active.project_id === projectId && (
                c.scope === "unit" ? target && work.active.unit_id === target.id && work.active.stage === c.activity
                  : !work.active.unit_id && work.active.description.split(" — ", 1)[0] === c.activity
            )) return;
            if (!shift || shift.project_id !== projectId || shift.status !== "open" || shift.break_started_at) {
                const label = activityLabel(c.activity, lang === "es");
                const openingCode = openings.data?.find(opening => opening.id === id)?.opening_code;
                const autoClockIn = !shift && !!projectId && !signed.refused &&
                    (Boolean(signed.data) || (talk.isSuccess && talk.data === null));
                const actorMark = signInMark();
                setPendingStart(undefined);
                openClockGlobally({
                    punch: autoClockIn ? mintPunch(null, tapMs) : undefined,
                    projectId, costCodeId: null, note: null, mode: null, switchToProject: true, companyWork: c.scope === "company", stayOnPage: true,
                    workdayStart: {
                        autoClockIn,
                        label: openingCode ? `${label} · ${openingCode}` : label,
                        onReady: () => setPendingStart(request),
                        onClockIn: autoClockIn ? async startedShift => {
                            if (!stillSignedInAs(actorMark, sandbox.actorId) || startedShift.profile_id !== sandbox.actorId
                                || startedShift.project_id !== projectId || startedShift.status !== "open" || startedShift.break_started_at)
                                throw new Error("The paid shift no longer matches the selected work.");
                            const startedAt = workStartTime(tapMs, startedShift.clock_in_at);
                            await recordStart(c, id, previousNote, startedShift.id, projectId, startedAt, true);
                        } : undefined,
                    },
                });
                return;
            }
            if (talkLocked || signed.refused) {
                setPendingStart(request);
                const gate = document.getElementById("work-toolbox-signature");
                gate?.scrollIntoView({ block: "nearest" });
                gate?.focus({ preventScroll: true });
                return;
            }
            // The shift's clock-in is stamped by the server and the tap by the phone.
            // A phone a couple of seconds behind puts a start made right after
            // clock-in BEFORE the shift began, and Forge refuses it ("Clock in or
            // resume your job clock", seen 2026-11-20 with a 2.6 s gap). Work on a
            // shift cannot start before the shift does.
            const startedAt = workStartTime(tapMs, shift.clock_in_at);
            await recordStart(c, id, previousNote, shift.id, projectId, startedAt);
        }); } };
    const shift = work.clock.shift;
    useEffect(() => {
        if (!pendingStart || !talkLocked || !shift || work.clock.isOpen) return;
        const gate = document.getElementById("work-toolbox-signature");
        gate?.scrollIntoView({ block: "nearest" });
        gate?.focus({ preventScroll: true });
    }, [pendingStart, shift, talkLocked, work.clock.isOpen]);
    useEffect(() => {
        if (!pendingStart || blocked || talkLocked || signed.refused || work.clock.isOpen) return;
        const projectId = pendingStart.choice.scope === "company" ? null : sandbox.id;
        if (!shift || shift.project_id !== projectId || shift.status !== "open" || shift.break_started_at) return;
        setPendingStart(undefined);
        void actions.start(pendingStart.choice, pendingStart.openingId, pendingStart.note);
    }, [actions, blocked, pendingStart, sandbox.id, shift, signed.refused, talkLocked, work.clock.isOpen]);
    const es = lang === "es";
    const openShift = shift?.status === "open";
    // Break, resume and clock out happen here in the timer, not in the clock sheet.
    // A break stops the running activity (the timecard pauses). Resume starts
    // the same one again, so nobody has to find their unit a second time
    // (Matt, 2026-11-20). Kept through a reload and a long lunch; a new break
    // always replaces it, with nothing when nothing was running.
    const [beforeBreak, setBeforeBreak] = useStoredState<{ choice: Choice; openingId?: string } | undefined>(
        `forge:workday-before-break:${sandbox.id}:${sandbox.actorId}`, undefined, { maxAgeMs: 16 * 60 * 60_000 });
    const shiftControls = useWorkdayShiftControls(es, {
        capture: () => {
            const running = work.active;
            if (!running || (running.project_id !== null && running.project_id !== sandbox.id)) return undefined;
            const openingId = running.unit_id ? work.units.find(unit => unit.id === running.unit_id)?.opening_id : undefined;
            return running.unit_id && !openingId ? undefined : { choice: choiceOf(running), openingId: openingId ?? undefined };
        },
        onBreak: captured => setBeforeBreak(captured as typeof beforeBreak),
        // The start itself waits (pendingStart) until the shift reads as back on the clock.
        onResume: () => { if (beforeBreak) setPendingStart(beforeBreak); setBeforeBreak(undefined); },
    });
    const clockControls = openShift && shiftControls.buttons;
    const toolbox = openShift && talkLocked && talk.data && (shift.project_id === sandbox.id || pendingStart) &&
      <section id="work-toolbox-signature" tabIndex={-1}><ToolboxSignCard profileId={sandbox.actorId} talk={talk.data} /></section>;
    return <DayView sandbox={sandbox} person={sandbox.actorId} day={localWorkDate()} actions={actions} units={work.units}
      planBlock={planBlock} embedded={embedded} jobPicker={jobPicker} clockControls={clockControls} toolbox={<>{shiftControls.panel}{toolbox}</>}/>;
}
function DayView({ sandbox, person, day, actions, preview, previewClock, planBlock, planName, embedded, jobPicker, clockControls, toolbox, units = [], unitCompletion }: {
    sandbox: Sandbox;
    person: string;
    day: string;
    actions: Actions;
    preview?: boolean;
    /** The preview's own pretend clock; a real day reads the person's shift. */
    previewClock?: "off" | "working" | "break";
    unitCompletion?: Record<string, boolean>;
    embedded: boolean;
    clockControls?: import("react").ReactNode;
    toolbox?: import("react").ReactNode;
    jobPicker?: (name: string) => import("react").ReactNode;
    planBlock?: string | null;
    planName?: string;
    units?: WorkUnit[];
}) {
    const [params] = useSearchParams();
    const progressDemo = import.meta.env.DEV && preview && sandbox.id === BUILDING_3_PROJECT && params.get("progressDemo") === "1";
    const { lang, setLang } = useLanguage();
    const es = lang === "es", text = (en: string, spanish: string) => es ? spanish : en;
    const [pilotOptions, setPilotOptions] = useState<Record<string, PilotOptions>>({});
    const [showInventory, setShowInventory] = useState(false);
    const [showActivities, setShowActivities] = useState(false);
    const activityTrigger = useRef<HTMLButtonElement>(null);
    const activityPickerId = useId();
    const inventoryScroll = useRef<HTMLDivElement>(null);
    const [visibleFloor, setVisibleFloor] = useState<string>();
    const detailPanel = useRef<HTMLElement>(null);
    const [createUnit, setCreateUnit] = useState(false);
    const [unitSearch, setUnitSearch] = useState("");
    const [pendingUnits, setPendingUnits] = useState<string[]>([]);
    // Units the person added to an activity today. They used to vanish on a
    // reload unless a timer had been started on them.
    const [addedUnits, setAddedUnits] = useStoredState<Record<string, string[]>>(`forge:workday-added:${sandbox.id}:${person}:${day}`, {});
    const leadStorageKey = `forge:workday-leads:${sandbox.id}:${day}`;
    const [leadChange, setLeadChange] = useState(0);
    const [leadError, setLeadError] = useState("");
    const leadOverrides = useMemo((): Record<string, string> => {
        try { return JSON.parse(localStorage.getItem(leadStorageKey) ?? "{}") ?? {}; }
        catch { return {}; }
    }, [leadStorageKey, leadChange]);
    const [confirmUnit, setConfirmUnit] = useState<string | null>(null);
    // The unit whose details are open in the popup, from the add-unit list.
    const [infoUnit, setInfoUnit] = useState<string>();
    const [choice, setChoice] = useState<Choice | null>(null), [selected, setSelected] = useState<string | null>(null), [notes, setNotes] = useState<Record<string, string>>({}), [now, setNow] = useState(Date.now);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const openings = useQuery({
        queryKey: ["openings", sandbox.id],
        queryFn: () => listOpenings(sandbox.id),
        select: rows => withQueuedUnits(progressDemo ? reviewedBuilding3Openings(rows) : rows,
            preview ? [] : readWorkQueue(person), sandbox.id),
    }), specs = useQuery({ queryKey: ["markSpecs", sandbox.id], queryFn: () => listMarkSpecs(sandbox.id) }), catalog = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits });
    const records = useQuery({ queryKey: ["crewWorkRecords", sandbox.actorId, sandbox.id], queryFn: () => listCrewWorkRecords(sandbox.id), enabled: !embedded }), previewUnits = useQuery({ queryKey: ["installerDayPreviewUnits", sandbox.id], queryFn: () => listWorkUnits(sandbox.id), enabled: !!preview });
    const projectSessions = useQuery({
        queryKey: ["customWorkSessions", sandbox.actorId, sandbox.id],
        queryFn: () => listWorkSessions(sandbox.id),
        refetchInterval: 30000,
    });
    const allUnits = preview ? previewUnits.data ?? [] : units;
    const published = useQuery({
        queryKey: ["publishedInstallerPlan", sandbox.id, sandbox.actorId, person],
        queryFn: () => readPublishedPlan(sandbox.id, person === sandbox.actorId ? undefined : person),
        retry: false,
        refetchInterval: 15000,
    });
    const savedPlans = published.data ?? [];
    const unitSchedule = useQuery({
        queryKey: ["workdayUnitSchedule", sandbox.actorId, sandbox.id, selected],
        queryFn: () => readPublishedUnitSchedule(sandbox.id, selected!),
        enabled: !!selected && selected !== "activity",
        refetchInterval: 15000,
    });
    const otherLeads = useMemo(() => [...new Set((published.data ?? []).flatMap(block =>
        Object.values(block.openingCrew ?? {}).flatMap(roles => roles.leadId && roles.leadId !== person ? [roles.leadId] : [])))].sort(),
        [published.data, person]);
    const leadNames = useProfileNames(otherLeads);
    const marks = useQuery({ queryKey: ["planActivityDone", sandbox.id, sandbox.actorId],
      queryFn: () => readActivityDone(sandbox.id), refetchInterval: 15000 });
    // One reading of every unit on this job, by opening: the same one the Plan
    // and the unit dialog use. It replaced two "done" checks here, one of which
    // ignored the Plan's marks.
    const jobSessions = [...new Map([...(projectSessions.data ?? []), ...actions.sessions].filter(session => session.project_id === sandbox.id)
        .map(session => [session.id, session])).values()];
    const unitStateOf = (blocks: readonly PlanBlock[]) => readUnitState({ sessions: jobSessions, marks: marks.data, units: allUnits, blocks, completeOverride: unitCompletion });
    const isActivityDone = unitStateOf([]).activityDone;
    const sourcePlans = [...savedPlans, ...(progressDemo ? building3ProgressBlocks.filter(sample =>
        !savedPlans.some(block => block.activity === sample.activity && block.start <= sample.start && block.end >= sample.start)) : [])];
    const currentPlans = day === localWorkDate() && new Date(day + "T12:00:00").getDay() !== 0
        && openings.isSuccess && projectSessions.isSuccess && (!preview || previewUnits.isSuccess)
      ? currentPlanBlocks(sourcePlans, day, (id, activity) =>
          openings.data.some(opening => opening.id === id) && !isActivityDone(id, activity))
      : sourcePlans;
    const plans = currentPlans.filter(block => block.installerIds.includes(person) && block.start <= day && block.end >= day);
    const assigned = (embedded ? [] : records.data ?? []).filter(r => r.outcome === "assigned" && r.work_date === day && r.people.some(p => p.profile_id === person && !p.voided_at));
    const preferred = plans.find(block => block.id === planBlock);
    const preferredChoice: Choice | undefined = preferred && { scope: preferred.kind === "unit" ? "unit" : "job", activity: preferred.activity };
    const suggestions: Choice[] = [...plans.map(b => ({ scope: b.kind === "unit" ? "unit" as const : "job" as const, activity: b.activity })), ...assigned.map(r => ({ scope: "unit" as const, activity: r.stage }))];
    const activeChoice = useMemo<Choice | undefined>(() => actions.active &&
        (actions.active.project_id === sandbox.id || actions.active.project_id === null)
        ? { scope: actions.active.unit_id ? "unit" : actions.active.project_id ? "job" : "company",
            activity: actions.active.unit_id ? actions.active.stage : actions.active.description.split(" — ")[0] }
        : undefined, [actions.active, sandbox.id]);
    const [lastActiveChoice, setLastActiveChoice] = useState<Choice>();
    useEffect(() => {
        if (activeChoice) setLastActiveChoice(activeChoice);
    }, [activeChoice]);
    const suggested = suggestions.filter((c, i) => suggestions.findIndex(o => o.scope === c.scope && o.activity === c.activity) === i), picked = choice ?? activeChoice ?? lastActiveChoice ?? preferredChoice ?? suggested[0] ?? { scope: "unit" as const, activity: "RO checked" };
    const value = (c: Choice) => `${c.scope}:${c.activity}`, unitId = (id: string) => preview ? id : allUnits.find(u => u.opening_id === id)?.id;
    const byMark = useMemo(() => catalogByMarkFrom(catalog.data ?? []), [catalog.data]), specIndex = useMemo(() => indexSpecsByMark(specs.data ?? []), [specs.data]);
    const matchesActivity = (session: WorkSession) =>
        session.project_id === (picked.scope === "company" ? null : sandbox.id)
        && (picked.scope === "unit"
            ? !!session.unit_id && session.stage === picked.activity
            : !session.unit_id && session.description.split(" — ")[0] === picked.activity);
    const matches = (session: WorkSession, id?: string) =>
        matchesActivity(session) && (picked.scope !== "unit" || (!!id && session.unit_id === unitId(id)));
    const active = actions.active;
    const running = (id?: string) => !!active && matches(active, id);
    const activitySessions = actions.sessions.filter(session =>
        matchesActivity(session) && (preview || session.id === active?.id || localWorkDate(new Date(session.started_at)) === day));
    const elapsed = (id?: string) => clockText(activitySessions.reduce((total, session) =>
        total + (id === undefined || session.unit_id === unitId(id) ? seconds(session, now) : 0), 0));
    const leadKey = (id: string) => JSON.stringify([picked.activity, id]);
    const unitState = unitStateOf(plans);
    // A lead taken here shows at once from this device's copy and is sent to the Plan.
    const leadFor = (id: string) => leadOverrides[leadKey(id)] ?? unitState.crew(id, picked.activity).leadId;
    const takeLead = (id: string) => {
        try {
            const current = JSON.parse(localStorage.getItem(leadStorageKey) ?? "{}") ?? {};
            localStorage.setItem(leadStorageKey, JSON.stringify({ ...current, [leadKey(id)]: person }));
            setLeadChange(count => count + 1);
            setLeadError("");
            // The lead lives in the Plan, so it is saved there when the Plan has
            // this unit for this activity. A unit the person added themselves
            // has no place in the Plan, and its lead stays on this device.
            if (plans.some(block => block.kind === "unit" && block.activity === picked.activity && block.openingIds.includes(id)))
                actions.takeLead?.(id, picked.activity);
        } catch {
            setLeadError(text("Couldn't save your lead change on this device.", "No se pudo guardar el cambio de responsable en este dispositivo."));
        }
    };
    const isPlanned = (id: string) => plans.some(block => {
        if (block.activity !== picked.activity || block.kind !== "unit") return false;
        if (!block.unitCrewOnly) return block.openingIds.includes(id);
        const roles = block.openingCrew?.[id];
        return roles?.leadId === person || !!roles?.crewIds.includes(person);
    }) || assigned.some(r => r.stage === picked.activity && allUnits.some(u => u.id === r.unit_id && u.opening_id === id));
    const isDone = (opening: { id: string; opening_code: string }) =>
        unitState.done(opening.id, picked.activity)
        || (progressDemo && building3PreviewDone(sandbox.id, picked.activity, opening.opening_code));
    const priority = [...new Set(plans.filter(block => block.kind === "unit" && block.activity === picked.activity)
        .flatMap(block => block.openingIds))];
    const priorityRank = new Map(priority.map((id, index) => [id, index]));
    const ordered = [...(openings.data ?? [])].sort((a, b) =>
        (Number(isPlanned(b.id)) - Number(isPlanned(a.id))) ||
        (priorityRank.get(a.id) ?? priority.length) - (priorityRank.get(b.id) ?? priority.length) ||
        a.opening_code.localeCompare(b.opening_code, undefined, { numeric: true }));
    const opening = ordered.find(o => o.id === selected);
    const showMyUnits = suggested.length > 0 || !preview || embedded || !!params.get("planAs");
    const added = addedUnits[value(picked)] ?? [];
    const matchingUnits = showMyUnits
        ? ordered.filter(o => isPlanned(o.id) || added.includes(o.id) || leadOverrides[leadKey(o.id)] === person
            || running(o.id) || activitySessions.some(session => session.unit_id === unitId(o.id)))
        : ordered;
    // The running unit first, then what is still to do in the Plan's order,
    // then what is done (Matt, 2026-11-20). A unit marked done while its
    // timer runs is still the active one, so it stays first until the next
    // unit is started.
    const tileRank = (o: (typeof ordered)[number]) => running(o.id) ? 0 : isDone(o) ? 2 : 1;
    const visibleUnits = [...matchingUnits].sort((a, b) => tileRank(a) - tileRank(b));
    const availableUnits = showMyUnits ? ordered.filter(o => !visibleUnits.includes(o)) : [];
    const inventory = availableUnits.filter(unit => unit.opening_code.toLowerCase().includes(unitSearch.trim().toLowerCase()));
    const inventoryByFloor = new Map<string, typeof inventory>();
    for (const unit of inventory) {
        const floor = unitFloor(unit) ?? text("Unspecified floor", "Piso sin especificar");
        const group = inventoryByFloor.get(floor) ?? [];
        group.push(unit);
        inventoryByFloor.set(floor, group);
    }
    const unspecified = text("Unspecified floor", "Piso sin especificar");
    const floors = [...inventoryByFloor].sort(([left], [right]) =>
        Number(left === unspecified) - Number(right === unspecified) || right.localeCompare(left, lang, { numeric: true }));
    function unitVisual(opening: (typeof ordered)[number]) {
        const mark = unitSourceMark(opening);
        const resolved = mark ? resolveMarkConfig(mark, specIndex, byMark) : null;
        const diagram = unitPicture(opening.unit_details, resolved, 90, 65);
        return diagram ? <img alt="" src={`data:image/svg+xml,${encodeURIComponent(diagram)}`}/>
          : <UnitKindIcon kind={opening.unit_details?.kind ?? resolved?.kind} size={30}/>;
    }
    useEffect(() => {
        if (selected) detailPanel.current?.scrollIntoView({ block: "nearest" });
    }, [selected]);
    const previewDate = new Date(`${day}T12:00:00`);
    const previewLabel = planName && Number.isFinite(previewDate.getTime())
        ? `${planName} · ${previewDate.toLocaleDateString(lang, { weekday: "short", month: "short", day: "numeric" })}`
        : null;
    const activityNote = (id: string, activity: string, scope: Choice["scope"]) => {
        const options = pilotOptions[`${scope}:${id}:${activity}`];
        return [
            notes[`${id}:${activity}`]?.trim(),
            options?.travelPurpose === "supply-pickup" && "Travel: Supply pickup",
            options?.travelPurpose === "other" && `Travel: ${options.travelOther?.trim() || "Other"}`,
            options?.consultingWith === "gc-owner" && "Consulting with GC / owner",
            options?.consultingWith === "supervisor" && "Consulting with supervisor",
            options?.waitingReason?.trim() && `Waiting / blocked: ${options.waitingReason.trim()}`,
        ].filter(Boolean).join("\n");
    };
    const activeUnitId = active?.unit_id ? ordered.find(o => unitId(o.id) === active.unit_id)?.id : undefined;
    const machineryStarted = active?.workday_machinery_started_at;
    const machineryElapsed = (at: number) => (active?.workday_machinery_ms ?? 0)
        + (machineryStarted ? Math.max(0, at - Date.parse(machineryStarted)) : 0);
    const activeNote = () => active && (active.project_id === sandbox.id || active.project_id === null)
        ? activityNote(activeUnitId ?? "activity", active.unit_id ? active.stage : active.description.split(" — ")[0],
            active.unit_id ? "unit" : active.project_id ? "job" : "company")
        : undefined;
    const start = (id?: string) => {
        setChoice(picked);
        if (running(id)) { setSelected(id ?? "activity"); return; }
        void actions.start(picked, id, activeNote());
    };
    const disabled = actions.blocked || (picked.scope === "unit" && openings.data === undefined);
    const activityGroups: { title: string; scope: Choice["scope"]; names: readonly string[] }[] = [
        { title: text("Unit work", "Trabajo por unidad"), scope: "unit", names: unitActivities },
        { title: text("General job work", "Trabajo general de obra"), scope: "job", names: generalActivities },
        { title: text("Company work", "Trabajo de la empresa"), scope: "company", names: company },
    ];
    const closeActivityPicker = () => {
        setShowActivities(false);
        activityTrigger.current?.focus();
    };
    const choose = (next: Choice) => {
        if (next.scope !== "unit" && (!active || active.unit_id ||
            active.project_id !== (next.scope === "company" ? null : sandbox.id) ||
            active.description.split(" — ", 1)[0] !== next.activity))
          void actions.start(next, undefined, activeNote());
        closeActivityPicker();
        setChoice(next);
        setShowInventory(false);
        setUnitSearch("");
        setPendingUnits([]);
        setSelected(null);
        setLeadError("");
    };
    const clock = useClock(), shift = clock.shift, scope = picked.scope === "company" ? null : sandbox.id;
    const activeOpening = active?.unit_id ? ordered.find(o => unitId(o.id) === active.unit_id) : undefined;
    const activeMatches = !!active && matchesActivity(active);
    const detailOpening = opening;
    const wholeUnitComplete = unitState.complete;
    const detailUnit = detailOpening && allUnits.find(unit => unit.opening_id === detailOpening.id);
    const detailComplete = detailOpening && wholeUnitComplete(detailOpening.id);
    const completionSchedule = detailOpening && unitSchedule.data?.filter(block => block.openingIds.includes(detailOpening.id));
    const finalKey = (block: NonNullable<typeof completionSchedule>[number]) =>
        `${block.end}T${String(planBoundary(block, "end")).padStart(4, "0")}:${block.start}T${String(planBoundary(block, "start")).padStart(4, "0")}`;
    const lastKey = completionSchedule?.map(finalKey).sort().at(-1);
    const lastActivities = new Set(completionSchedule?.filter(block => finalKey(block) === lastKey).map(block => block.activity));
    const canOverride = sandbox.canEditAllUnits && (!preview || person === sandbox.actorId);
    // Paid time is the shift, not the timers: a person can be on the clock with
    // nothing running, or looking at this screen off the clock. Always say
    // which (Matt, 2026-11-20), whatever the timers show.
    const clockStatus = preview ? previewClock ?? "off"
        : shift?.status !== "open" ? "off" : shift.break_started_at ? "break" : "working";
    const clockStatusLabel = (clockStatus === "working" ? text("On the clock", "En turno")
        : clockStatus === "break" ? text("On break", "En descanso") : text("Off the clock", "Fuera de turno"))
        + (preview ? text(" · preview", " · prueba") : "");
    const finalActivity = lastActivities.size === 1 && lastActivities.has(picked.activity);
    const overrideCompletion = !finalActivity && canOverride;
    const canCompleteUnit = unitSchedule.isSuccess && (finalActivity || overrideCompletion)
        && (preview || !detailUnit || canEditUnit(detailUnit, sandbox.actorId, canOverride));
    const remainingActivities = [...new Set(completionSchedule
        ?.filter(block => block.activity !== picked.activity && !isActivityDone(detailOpening?.id ?? "", block.activity))
        .map(block => block.activity))];
    // One running total for machinery, read everywhere it is shown: what each
    // of today's activities has saved, plus the stretch running right now.
    // The switch and "Logged machinery time" both come from it, so they move
    // together while the machine clock runs.
    const machineryTotal = (at: number, include: (session: WorkSession) => boolean = () => true) =>
        actions.sessions.reduce((total, session) =>
            (session.project_id === sandbox.id || session.project_id === null)
                && localWorkDate(new Date(session.started_at)) === day && include(session)
                ? total + (session.workday_machinery_ms ?? 0) + (!session.ended_at && session.workday_machinery_started_at
                    ? Math.max(0, at - Date.parse(session.workday_machinery_started_at)) : 0)
                : total, 0);
    const savedMachineryMs = detailOpening ? machineryTotal(now, session => matches(session, detailOpening.id)) : 0;
    const machineryRunning = !!machineryStarted;
    // Turning the machine on asks first, so nobody starts a machine timer by
    // accident or out of curiosity. The answer is remembered for a day.
    const [machineryConfirmed, setMachineryConfirmed] = useStoredState<boolean>(
        `forge:workday-machinery-confirmed:${person}`, false, { maxAgeMs: 24 * 60 * 60_000 });
    const [askMachinery, setAskMachinery] = useState(false);
    const toggleMachinery = () => {
        if (!active) return;
        const at = Date.now();
        void actions.update({ id: active.id, at: new Date(at).toISOString(), machinery_ms: machineryElapsed(at), machinery_running: !machineryRunning });
    };
    const markDone = () => {
        if (active?.unit_id && !active.workday_done_at) {
            void actions.update({ id: active.id, at: new Date().toISOString(), done: true });
        }
    };
    const detailsKey = `${picked.scope}:${selected}:${picked.activity}`;
    const canFinish = !!activeMatches && (picked.scope !== "unit" || detailOpening?.id === activeOpening?.id);
    const finishingStage = detailOpening && active?.project_id === sandbox.id && active.unit_id === unitId(detailOpening.id)
        ? activityLabel(active.stage, es) : null;
    const infoOpening = infoUnit ? ordered.find(row => row.id === infoUnit) : undefined;
    // The words every unit tile uses for where a unit stands, here and in the Plan.
    const tileStatus = (id: string, done: boolean) => running(id)
        ? <><span className="wd-running-dot" aria-hidden="true"/>{done ? text("Complete", "Terminado") : text("Running", "En curso")}</>
        : done ? <><Check size={13} aria-hidden="true"/>{text("Complete", "Terminado")}</>
        : isPlanned(id) ? text("Planned", "Programado") : text("Unplanned", "Sin programar");
    // As on the Plan's tiles: the lead's first name, or "You".
    const tileLead = (id: string) => {
        const lead = leadFor(id);
        return lead === person ? text("You", "Tú") : lead ? leadNames.data?.get(lead)?.split(/\s+/)[0] : undefined;
    };
    return <div className="installer-task-board workday-simple" lang={lang}>
      <p className="wd-clock-status" data-testid="wd-clock-status" data-state={clockStatus} role="status"><span aria-hidden="true"/>{clockStatusLabel}</p>
      {createUnit && <UnitDetailsDialog title={text("Create unit", "Crear unidad")} onClose={() => setCreateUnit(false)}>
        <UnitDetailsPanel projectId={sandbox.id} createOffline={actions.createUnit} onCreated={id => {
          setAddedUnits(current => ({ ...current, [value(picked)]: [...(current[value(picked)] ?? []), id] }));
          setShowInventory(false);
          setPendingUnits([]);
          setUnitSearch("");
          setSelected(id);
          setCreateUnit(false);
        }} />
      </UnitDetailsDialog>}
      {infoOpening && <AgendaUnitDetails profileId={person} openingRow={infoOpening} onClose={() => setInfoUnit(undefined)}
        unit={{ id: infoOpening.id, label: infoOpening.opening_code, projectId: sandbox.id, activity: picked.activity,
          leadId: leadFor(infoOpening.id), crewIds: unitState.crew(infoOpening.id, picked.activity).crewIds }}
        localSessions={jobSessions.filter(session => !!session.unit_id && unitState.openingOf(session) === infoOpening.id)}
        localUnitComplete={unitState.complete(infoOpening.id) || undefined} />}
      <header className="wd-heading"><div>{/* The job's name is the switch everywhere Workday shows one, this
          page included; it used to keep a separate "Switch job" button under the name (Matt, 2026-11-20). */}
        {jobPicker ? jobPicker(sandbox.job_code)
          : !embedded && (!preview || params.has("planAs")) ? <WorkdayJobs key={sandbox.id} profileId={person} currentJob={sandbox.id}
              previewDate={preview ? day : undefined} jobName={scope ? sandbox.job_code : text("Company work", "Trabajo de la empresa")} />
          : <strong>{scope ? sandbox.job_code : text("Company work", "Trabajo de la empresa")}</strong>}{preview && previewLabel && <small>{previewLabel}</small>}</div><div className="wd-heading-right">{clockControls}<button className="wd-language" onClick={() => setLang(es ? "en" : "es")} aria-label={es ? "Change language to English" : "Cambiar idioma a español"}>{es ? "English" : "Español"}</button></div></header>
      {toolbox}
      {published.isPending && <p role="status">{text("Loading today’s plan…", "Cargando el plan de hoy…")}</p>}
      {published.isError && <p role="alert">{formatApiError(published.error)}</p>}
      {(actions.error || openings.error || records.error) && <p role="alert">{actions.error || formatApiError(openings.error || records.error)}</p>}
      <section className="wd-current" data-running={!!active} aria-label={text("Current activity", "Actividad actual")}>
        <div className="wd-activity-symbol"><ActivityIcon activity={picked.activity}/></div>
        <div className="wd-activity-choice">
          <button ref={activityTrigger} type="button" className="wd-activity-picker"
            aria-label={`${text("Activity", "Actividad")}: ${activityLabel(picked.activity, es)}`}
            data-activity={value(picked)} aria-expanded={showActivities} aria-controls={showActivities ? activityPickerId : undefined}
            disabled={actions.blocked} onClick={() => setShowActivities(open => !open)}
            onKeyDown={event => { if (event.key === "Escape" && showActivities) closeActivityPicker(); }}>
            <span>{activityLabel(picked.activity, es)}</span><ChevronDown size={16} aria-hidden="true"/>
          </button>
          {/* Beside the activity, not under it. While unit work runs there is
              a green dot and the unit's number; a general activity shows no
              dot, its clock is enough (Matt, 2026-11-20). "Running" is kept
              for screen readers. */}
          <span className="wd-current-state" role="status" data-running={!!active && activeMatches || undefined}>{active ? activeMatches
            ? <>{active.unit_id && <i aria-hidden="true" />}<span className="wd-sr-only">{text("Running", "En curso")}</span>{activeOpening && <b>{activeOpening.opening_code}</b>}</>
            : `${text("Still running", "Sigue en curso")}: ${activityLabel(active.unit_id ? active.stage : active.description.split(" — ", 1)[0], es)}${activeOpening ? ` · ${activeOpening.opening_code}` : ""}`
            : picked.scope === "unit" ? text("Tap a unit to start", "Toca una unidad para empezar") : text("Ready to start", "Listo para empezar")}</span>
        </div>
        {/* Always here, for unit work and general activities alike (Matt,
            2026-11-20). Only the machine: grey when idle, green and puffing
            while it runs. Its time is tracked, not shown. */}
        <button type="button" className="wd-machinery" disabled={!active || actions.blocked}
          role="switch" aria-checked={machineryRunning} aria-label={text("Operating machinery", "Operando maquinaria")}
          title={!active ? text("Start an activity first", "Inicia una actividad primero")
            : machineryRunning ? text("Machinery active", "Maquinaria activa") : text("Machinery not active", "Maquinaria inactiva")}
          aria-haspopup={machineryRunning || machineryConfirmed ? undefined : "dialog"}
          onClick={() => {
            if (!active) return;
            if (!machineryRunning && !machineryConfirmed) { setAskMachinery(true); return; }
            toggleMachinery();
          }}>
          <Tractor size={22} aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
        </button>
        <div className="wd-timer"><Clock size={18} aria-hidden="true" /><strong>{elapsed()}</strong>

          {/* Unit work starts by tapping a unit, and choosing a general
              activity starts it. The one case left for a start button is a
              general activity as the first thing of the day, before the clock
              and Toolbox Talk (Matt, 2026-11-20). */}
          {picked.scope !== "unit" && !activeMatches && (preview || shift?.status !== "open")
            && <button className="wd-play" disabled={disabled}
            aria-label={text("Start", "Iniciar") + " " + activityLabel(picked.activity, es)}
            onClick={() => start(undefined)}><Play size={20}/></button>}
        </div>
      </section>
      {askMachinery && <section className="wd-shift-panel" role="alertdialog" aria-label={text("Operating machinery", "Operando maquinaria")}>
        <h3>{text("Are you operating machinery?", "¿Estás operando maquinaria?")}</h3>
        <p>{text("Turn this on only while you are running a machine. It is tracked with your time.", "Actívalo solo mientras operas una máquina. Se registra con tu tiempo.")}</p>
        <div className="wd-shift-choices">
          <button type="button" className="wd-shift-confirm" onClick={() => { setMachineryConfirmed(true); setAskMachinery(false); toggleMachinery(); }}>
            {text("Yes, I am", "Sí")}</button>
          <button type="button" className="wd-shift-cancel" onClick={() => setAskMachinery(false)}>{text("No", "No")}</button>
        </div>
      </section>}
      {showActivities && <section id={activityPickerId} className="wd-activity-tools"
        aria-label={text("Choose activity", "Elegir actividad")}
        onKeyDown={event => { if (event.key === "Escape") closeActivityPicker(); }}>
        {activityGroups.map(group => {
          // Today's planned activities sit in the same list as the rest,
          // first in their group and lightly marked (Matt, 2026-11-20: "keep
          // our planned activities inline with the others, maybe they're just
          // subtly 'activated' because they were planned").
          const plannedHere = suggested.filter(item => item.scope === group.scope).map(item => item.activity);
          const choices = [...new Set([...plannedHere, ...group.names])];
          if (!choices.length) return null;
          return <div key={group.scope} className="wd-activity-tool-group">
            <h3>{group.title}{!!plannedHere.length && <span className="wd-planned-legend"><i aria-hidden="true" />{text("Planned today", "Programado hoy")}</span>}</h3>
            <div className="wd-activity-grid">{choices.map(activity => {
              const item = { scope: group.scope, activity };
              const planned = plannedHere.includes(activity);
              return <button key={activity} type="button" data-choice={value(item)} data-planned={planned || undefined}
                title={planned ? text("Planned today", "Programado hoy") : undefined}
                aria-pressed={value(item) === value(picked)} disabled={actions.blocked} onClick={() => choose(item)}>
                <ActivityIcon activity={activity}/><span>{activityLabel(activity, es)}</span>
              </button>;
            })}</div>
          </div>;
        })}
      </section>}
      {picked.scope === "unit" ? <section aria-label={text("Units", "Unidades")} className="wd-unit-section">
        <div className="wd-unit-tools">
          <h2>{text("Units", "Unidades")}</h2>
          <div className="wd-unit-actions">
          {openings.data && (
          <button type="button" aria-expanded={showInventory} aria-controls={showInventory ? "wd-unit-inventory" : undefined}
            onClick={() => {
              if (showInventory && pendingUnits.length) {
                const key = value(picked);
                setAddedUnits(current => ({ ...current, [key]: [...new Set([...(current[key] ?? []), ...pendingUnits])] }));
              }
              setPendingUnits([]);
              setUnitSearch("");
              setVisibleFloor(undefined);
              setShowInventory(!showInventory);
            }}>{!showInventory ? text("+ Add unit", "+ Agregar unidad")
              : pendingUnits.length === 1 ? text("Add 1 unit", "Agregar 1 unidad")
              : pendingUnits.length > 1 ? text(`Add ${pendingUnits.length} units`, `Agregar ${pendingUnits.length} unidades`)
              : text("Cancel", "Cancelar")}</button>)}
          </div>
        </div>
        {showInventory && <section id="wd-unit-inventory" className="wd-inventory" aria-label={text("Unit inventory", "Inventario de unidades")}>
          <div className="wd-inventory-search">
            <input type="search" aria-label={text("Find unit", "Buscar unidad")} placeholder={text("Find unit", "Buscar unidad")}
              value={unitSearch} onChange={event => { setUnitSearch(event.target.value); setVisibleFloor(undefined); if (inventoryScroll.current) inventoryScroll.current.scrollTop = 0; }} />
            <button type="button" onClick={() => setCreateUnit(true)}>{text("Create unit", "Crear unidad")}</button>
          </div>
          <div className="wd-inventory-body">
            {floors.length > 1 && <nav className="wd-floor-nav" aria-label={text("Jump to floor", "Ir al piso")}>
              {floors.map(([floor], index) => <button key={floor} type="button" aria-label={floor}
                aria-current={(visibleFloor ?? floors[0]?.[0]) === floor ? "location" : undefined}
                onClick={() => {
                  const scroller = inventoryScroll.current;
                  const section = scroller?.children[index];
                  if (!scroller || !section) return;
                  scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
                  setVisibleFloor(floor);
                }}>{floor === unspecified ? "—" : floor.replace(/^Level\s+/i, "L")}</button>)}
            </nav>}
            <div className="wd-inventory-floors" ref={inventoryScroll} onScroll={event => {
              const scroller = event.currentTarget;
              if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
                setVisibleFloor(floors.at(-1)?.[0]);
                return;
              }
              const top = scroller.getBoundingClientRect().top;
              const index = Array.from(scroller.children).findIndex(section => section.getBoundingClientRect().bottom > top + 2);
              setVisibleFloor(floors[index]?.[0]);
            }}>
            {floors.map(([floor, units]) => <section key={floor} aria-label={floor}>
              <h3>{floor}</h3>
              <div className="wd-inventory-grid unit-tiles">{units.map(unit => {
                const done = unitState.done(unit.id, picked.activity);
                const pending = pendingUnits.includes(unit.id);
                return <UnitTile key={unit.id} code={unit.opening_code} picture={unitVisual(unit)} lead={tileLead(unit.id)}
                  crewCount={unitState.crew(unit.id, picked.activity).crewIds.length} done={done} status={tileStatus(unit.id, done)}
                  card={{ "data-selected-unit": pending }}
                  pick={{ "aria-label": `${text("Add unit", "Agregar unidad")} ${unit.opening_code}`, "aria-pressed": pending,
                    onClick: () => setPendingUnits(current => current.includes(unit.id)
                      ? current.filter(id => id !== unit.id) : [...current, unit.id]) }}
                  // Not "Details for unit": that names the timer tiles' button, which opens the activity's notes.
                  info={{ "aria-haspopup": "dialog", "aria-label": `${text("Unit details", "Detalles de la unidad")} ${unit.opening_code}`,
                    onClick: () => setInfoUnit(unit.id) }} />;
              })}</div>
            </section>)}
            </div>
          </div>
          {!inventory.length && <p>{text("No matching units.", "No hay unidades que coincidan.")}</p>}
        </section>}
        <div className="wd-units unit-tiles" data-size="large">{visibleUnits.map(o => {
        const complete = isDone(o);
        return <UnitTile key={o.id} code={o.opening_code} picture={unitVisual(o)} lead={tileLead(o.id)}
          crewCount={unitState.crew(o.id, picked.activity).crewIds.length} done={complete} status={tileStatus(o.id, !!complete)}
          codeExtra={wholeUnitComplete(o.id) && <span className="wd-unit-complete" title={text("Unit complete", "Unidad completa")}><Check size={13} aria-hidden="true" /></span>}
          card={{ className: "wd-unit", "data-running": running(o.id) }}
          pick={{ disabled: running(o.id) ? actions.finishBlocked : disabled, "aria-pressed": running(o.id), onClick: () => start(o.id),
            "aria-label": `${running(o.id) ? text("Running", "En curso") : text("Start", "Iniciar")} ${text("unit", "unidad")} ${o.opening_code} ${activityLabel(picked.activity, es)}` }}
          // On a timer tile the icon opens the activity's details under the grid:
          // the unit, and the notes and fields that go with the work.
          info={{ className: "wd-unit-info", "aria-label": `${text("Details for unit", "Detalles de unidad")} ${o.opening_code}`,
            "aria-expanded": selected === o.id, "aria-controls": selected === o.id ? "workday-activity-details" : undefined,
            onClick: () => { setConfirmUnit(null); setSelected(current => current === o.id ? null : o.id); } }}
          after={running(o.id) && !active?.workday_done_at && <button type="button" className="wd-unit-finish" disabled={actions.blocked}
            aria-label={`${text("Mark activity done for unit", "Marcar actividad terminada en unidad")} ${o.opening_code}`}
            title={text("Mark done", "Marcar terminada")} onClick={markDone}><Check size={19} aria-hidden="true"/></button>}>
          <span className="wd-unit-clock">
            <span className="wd-sr-only">{text("Tracked time", "Tiempo registrado")}: </span>{running(o.id) ? <span className="wd-running-dot" aria-hidden="true"/> : <Play size={13} aria-hidden="true"/>}{elapsed(o.id)}
          </span>
        </UnitTile>;
      })}</div>{!ordered.length ? <p>{text("No openings on this job yet.", "Esta obra aún no tiene aberturas.")}</p>
        : !visibleUnits.length && <p>{text("Add a unit to start.", "Agrega una unidad para empezar.")}</p>}</section> : <button className="wd-details-link" onClick={() => setSelected("activity")}><ClipboardList size={17} aria-hidden="true"/>{text("Details & notes", "Detalles y notas")}</button>}
      {selected && <section ref={detailPanel} id="workday-activity-details" className="native-day-unit-details" aria-label={text("Activity details", "Detalles de actividad")} onKeyDown={e => { if (e.key === "Escape") setSelected(null); }}><div className="native-day-unit-details-header"><div><h2>{activityLabel(picked.activity, es)}</h2>{detailOpening && <p>{text("Unit", "Unidad")} {detailOpening.opening_code}</p>}</div><button aria-label={text("Close details", "Cerrar detalles")} onClick={() => setSelected(null)}><X size={18}/></button></div>{detailOpening && <>
        {/* The same order as the unit dialog in the Plan: the unit, then who is
            on this activity and how far along it is. */}
        <UnitCompletion complete={Boolean(detailComplete)} />
        <UnitDetailsPanel key={detailOpening.id} projectId={sandbox.id} opening={detailOpening} />
        <UnitActivityFacts status={isDone(detailOpening) ? "complete" : unitState.status(detailOpening.id, picked.activity)}
          lastDone={unitState.lastDone(detailOpening.id)}
          leadId={leadFor(detailOpening.id)} crewIds={unitState.crew(detailOpening.id, picked.activity).crewIds} profileId={person}>
          {leadFor(detailOpening.id) !== person && <button type="button" onClick={() => takeLead(detailOpening.id)}>
            {leadFor(detailOpening.id) ? text("Take over lead", "Asumir el mando") : text("Take lead", "Tomar el mando")}</button>}
          {leadError && <small role="alert">{leadError}</small>}
        </UnitActivityFacts>
      </>}
        {savedMachineryMs > 0 && <p className="wd-detail-machinery">{text("Logged machinery time", "Tiempo de maquinaria registrado")} · {clockText(savedMachineryMs / 1000)}</p>}
        <PilotActivityOptions activity={picked.activity} value={pilotOptions[detailsKey] ?? {}} onChange={options => setPilotOptions(old => ({ ...old, [detailsKey]: options }))}/><Fields opening={detailOpening} activity={picked.activity} note={notes[`${selected}:${picked.activity}`] ?? ""} change={note => setNotes(old => ({ ...old, [`${selected}:${picked.activity}`]: note }))}
        saveNote={() => {
          const note = activeNote();
          if (canFinish && active && note) void actions.update({ id: active.id, at: new Date().toISOString(), note });
        }}/><div className="wd-detail-actions">{canFinish && picked.scope === "unit" && !active?.workday_done_at && <button className="wd-finish" disabled={actions.blocked}
        onClick={markDone}>
        <Check size={18}/>{text("Mark activity done", "Marcar actividad terminada")}
      </button>}
      {detailOpening && !detailComplete && (canCompleteUnit && (confirmUnit === detailOpening.id ? <div className="wd-complete-confirm">
          <p role="status">{finishingStage ? text(
            `Complete unit ${detailOpening.opening_code}? This will finish ${finishingStage} and stop its timer.`,
            `¿Completar la unidad ${detailOpening.opening_code}? Se finalizará ${finishingStage} y se detendrá su temporizador.`,
          ) : text(`Complete unit ${detailOpening.opening_code}?`, `¿Completar la unidad ${detailOpening.opening_code}?`)}</p>
          {overrideCompletion && <p>{remainingActivities.length
            ? `${text("Still planned", "Pendiente en el plan")}: ${remainingActivities.map(activity => activityLabel(activity, es)).join(", ")}`
            : text("No other unfinished activities are listed in the plan.", "El plan no muestra otras actividades pendientes.")}</p>}
          <button type="button" onClick={() => setConfirmUnit(null)}>{text("Cancel", "Cancelar")}</button>
          <button type="button" disabled={actions.finishBlocked} onClick={() => {
            setConfirmUnit(null);
            void actions.completeUnit(detailOpening.id, activeNote());
          }}>{text("Confirm completion", "Confirmar finalización")}</button>
        </div> : <button type="button" className="wd-finish" disabled={actions.finishBlocked} onClick={() => setConfirmUnit(detailOpening.id)}>
          <Check size={18}/>{overrideCompletion ? text("Override unit completion", "Forzar finalización de la unidad")
            : text("Mark unit complete", "Marcar unidad completa")}
        </button>))}
      </div>
      {detailOpening && <div className="native-day-links"><Link to={openingFullSheetPath(sandbox.id, detailOpening.id)}>{text("Inspection, measurements & photos", "Inspección, medidas y fotos")}</Link><Link to={`/projects/${sandbox.id}`}>{text("Job map & plans", "Mapa y planos")}</Link></div>}</section>}
    </div>;
}

function Fields({ activity, note, change, opening, saveNote }: {
    activity: string;
    note: string;
    change: (s: string) => void;
    saveNote: () => void;
    opening?: {
        ro_width_in: number | null;
        ro_height_in: number | null;
    };
}) {
    const ref = useRef<HTMLTextAreaElement>(null), notesId = useId();
    const { lang } = useLanguage(), es = lang === "es";
    return <div className="native-day-activity-fields">{activity === "RO checked" && <><label className="native-day-field-row"><span>{es ? "Ancho del vano (pulg)" : "RO width (in)"}</span><input readOnly value={opening?.ro_width_in ?? ""} placeholder={es ? "Sin medir" : "Not measured"}/></label><label className="native-day-field-row"><span>{es ? "Alto del vano (pulg)" : "RO height (in)"}</span><input readOnly value={opening?.ro_height_in ?? ""} placeholder={es ? "Sin medir" : "Not measured"}/></label></>}<div className="native-day-field-row native-day-notes"><label htmlFor={notesId}>{es ? "Notas" : "Notes"}</label><textarea id={notesId} ref={ref} rows={2} value={note} onChange={e => change(e.target.value)} onBlur={saveNote}/><VoiceControl key={activity} fieldRef={ref} compact/></div></div>;
}
