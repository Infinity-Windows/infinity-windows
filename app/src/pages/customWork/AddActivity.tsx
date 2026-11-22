// A foreman adds an activity for a person, or puts units on one that exists
// (Matt, 2026-11-21: "we just need a way to add an activity for a person. it
// needs a job, and activity, and in and out time", with units and whether the
// activity was finished on each). The rules are the server's
// (save_crew_activity, 20261130210000): the time must sit inside that person's
// clocked hours on the job, and several units share the time evenly, one
// activity per unit.

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { JobSearchSelect } from "../../components/JobSearchSelect";
import { UnitKindIcon } from "../../components/install/UnitKindIcon";
import { UnitTile } from "../../components/install/UnitTile";
import { listMarkSpecs, listOpenings } from "../../lib/install/api";
import { indexSpecsByMark } from "../../lib/install/specs";
import type { Profile, ProjectOpening } from "../../lib/install/types";
import { unitFloor, unitSourceMark } from "../../lib/install/unitDetails";
import { unitPicture } from "../../lib/install/unitDefinitionDiagram";
import { catalogByMarkFrom, resolveMarkConfig } from "../../lib/modelstudio/fromProject";
import { listStudioUnits } from "../../lib/modelstudio/units";
import { readUnitState } from "../../lib/installerWorkflow/unitState";
import { formatApiError } from "../../lib/errors";
import { isMissingFunction } from "../../lib/schemaErrors";
import { clockText, type WorkAction, type WorkSession } from "../../lib/customWork/model";
import type { WorkStore } from "../../lib/customWork/useWork";
import { assignmentUnit } from "../../lib/installerWorkflow/nativeDay";
import { PILOT_ACTIVITIES } from "../../lib/installerWorkflow/pilotActivities";
// The unit list is the Workday's "Add unit" inventory: the same floors, the
// same tiles (Matt, 2026-11-21: "the same table and view concept of units as
// we show on the plan and workday").
import "../installerPilot/workdaySimple.css";

const UNIT_ACTIVITIES: readonly string[] = PILOT_ACTIVITIES.find(group => group.kind === "unit")!.names;
/** Now, or `hoursAgo` before it, as a datetime-local value in this device's zone. */
const localNow = (hoursAgo = 0) => {
  const date = new Date(Date.now() - hoursAgo * 3600000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function AddActivity({ work, jobs, people, job: startJob, existing, onClose }: {
  work: WorkStore;
  jobs: { id: string; job_code: string; name: string }[];
  people: Profile[];
  job?: string;
  /** Set to put units on this activity instead of adding a new one. */
  existing?: WorkSession;
  onClose: () => void;
}) {
  const [person, setPerson] = useState("");
  const [job, setJob] = useState(existing?.project_id ?? startJob ?? "");
  const [activity, setActivity] = useState(existing && existing.kind === "unit" ? existing.stage : "");
  const [started, setStarted] = useState(() => localNow(1));
  const [ended, setEnded] = useState(() => localNow());
  const [note, setNote] = useState("");
  const [find, setFind] = useState("");
  const floorScroll = useRef<HTMLDivElement>(null);
  const [visibleFloor, setVisibleFloor] = useState<string>();
  // Opening id → whether the activity was finished on it.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unitWork = Boolean(existing) || UNIT_ACTIVITIES.includes(activity);
  const openings = useQuery({
    queryKey: ["customWorkCrewOpenings", work.user, job],
    queryFn: () => listOpenings(job),
    enabled: unitWork && !!job && !!work.user,
  });
  // The same query keys the Plan and Workday use, so the pictures are already here after either.
  const specs = useQuery({ queryKey: ["markSpecs", job], queryFn: () => listMarkSpecs(job), enabled: unitWork && !!job });
  const catalog = useQuery({ queryKey: ["studioUnits"], queryFn: listStudioUnits, enabled: unitWork });
  const specIndex = useMemo(() => indexSpecsByMark(specs.data ?? []), [specs.data]);
  const byMark = useMemo(() => catalogByMarkFrom(catalog.data ?? []), [catalog.data]);
  const unitState = readUnitState({ sessions: work.sessions, units: work.units });
  const shown = (openings.data ?? []).filter(opening =>
    !find.trim() || opening.opening_code.toLowerCase().includes(find.trim().toLowerCase()));
  const byFloor = new Map<string, ProjectOpening[]>();
  for (const opening of shown) {
    const floor = unitFloor(opening) ?? "Unspecified floor";
    byFloor.set(floor, [...(byFloor.get(floor) ?? []), opening]);
  }
  const floors = [...byFloor].sort(([left], [right]) =>
    Number(left === "Unspecified floor") - Number(right === "Unspecified floor") || right.localeCompare(left, undefined, { numeric: true }));
  function picture(opening: ProjectOpening) {
    const mark = unitSourceMark(opening);
    const resolved = mark ? resolveMarkConfig(mark, specIndex, byMark) : null;
    const diagram = unitPicture(opening.unit_details, resolved, 90, 65);
    return diagram ? <img alt="" src={`data:image/svg+xml,${encodeURIComponent(diagram)}`} />
      : <UnitKindIcon kind={opening.unit_details?.kind ?? resolved?.kind} size={30} />;
  }
  const picked = (openings.data ?? []).filter(opening => opening.id in chosen);
  const seconds = existing
    ? Math.round((Date.parse(existing.ended_at!) - Date.parse(existing.started_at)) / 1000)
    : Math.round((Date.parse(ended) - Date.parse(started)) / 1000);

  async function save() {
    setError("");
    try {
      if (!existing && !person) throw new Error("Choose who did the work.");
      if (!job) throw new Error("Choose the job.");
      if (!activity) throw new Error("Choose an activity.");
      if (!existing && !(seconds > 0)) throw new Error("The out time must be after the in time.");
      if (unitWork && !picked.length) throw new Error("Choose at least one unit.");
      setBusy(true);
      // A unit nobody has worked yet has no work record; make it the way the
      // Workday does on a first start, in the same save.
      const commands: { action: WorkAction; data: Record<string, unknown> }[] = [];
      const units = picked.map(opening => {
        const unit = assignmentUnit(opening, work.units, crypto.randomUUID());
        if (!work.units.some(known => known.id === unit.id))
          commands.push({ action: "unit", data: { ...unit, created_by: work.user, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
        return { unit_id: unit.id, finished: chosen[opening.id] };
      });
      commands.push({ action: "crew_activity", data: existing
        ? { replace_id: existing.id, revision: existing.revision, activity, units }
        : { profile_id: person, project_id: job, activity, note, units: unitWork ? units : [],
            started_at: new Date(started).toISOString(), ended_at: new Date(ended).toISOString() } });
      await work.commandMany(commands);
      onClose();
    } catch (error) {
      setError(isMissingFunction(error)
        ? "Forge needs a server update before activities can be added here."
        : formatApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="cw-card cw-correction cw-add-activity" aria-label={existing ? "Set units" : "Add an activity"}>
    <h3>{existing ? "Units on this activity" : "Add an activity"}</h3>
    {!existing && <>
      <label>
        Person
        <select value={person} onChange={event => setPerson(event.target.value)}>
          <option value="">Choose a person</option>
          {people.map(profile => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}
        </select>
      </label>
      <div className="cw-add-job">
        <JobSearchSelect jobs={jobs} value={job} label="Job" allLabel="Choose a job"
          onChange={id => { setJob(id); setChosen({}); }} />
      </div>
    </>}
    <label className={existing ? "cw-correction-wide" : undefined}>
      Activity
      <select value={activity} onChange={event => setActivity(event.target.value)}>
        <option value="">Choose an activity</option>
        {PILOT_ACTIVITIES.filter(group => !existing || group.kind === "unit").map(group =>
          <optgroup key={group.kind} label={group.label}>
            {group.names.map(name => <option key={name}>{name}</option>)}
          </optgroup>)}
      </select>
    </label>
    {!existing && <>
      <label>
        Note
        <input value={note} onChange={event => setNote(event.target.value)} maxLength={4000} />
      </label>
      <label>
        In
        <input type="datetime-local" value={started} max={ended} onChange={event => setStarted(event.target.value)} />
      </label>
      <label>
        Out
        <input type="datetime-local" value={ended} min={started} onChange={event => setEnded(event.target.value)} />
      </label>
      <p className="muted cw-correction-wide">The time has to be inside the hours this person was clocked in on this job.</p>
    </>}
    {unitWork && <fieldset className="cw-correction-wide cw-add-units">
      <legend>Units</legend>
      {!job ? <p className="muted">Choose the job to see its units.</p>
        : openings.isLoading ? <p role="status">Loading units…</p>
        : openings.isError ? <p role="alert">{formatApiError(openings.error)}</p>
        : <>
          <div className="wd-inventory-search cw-add-find">
            <input type="search" value={find} placeholder="Find unit" aria-label="Find unit"
              onChange={event => { setFind(event.target.value); setVisibleFloor(undefined); if (floorScroll.current) floorScroll.current.scrollTop = 0; }} />
          </div>
          <div className="wd-inventory-body">
          {/* Jump to a floor, and show which one the list is on: the Workday's own control. */}
          {floors.length > 1 && <nav className="wd-floor-nav" aria-label="Jump to floor">
            {floors.map(([floor], index) => <button key={floor} type="button" aria-label={floor}
              aria-current={(visibleFloor ?? floors[0]?.[0]) === floor ? "location" : undefined}
              onClick={() => {
                const scroller = floorScroll.current;
                const section = scroller?.children[index];
                if (!scroller || !section) return;
                scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
                setVisibleFloor(floor);
              }}>{floor === "Unspecified floor" ? "—" : floor.replace(/^Level\s+/i, "L")}</button>)}
          </nav>}
          <div className="wd-inventory-floors" ref={floorScroll} onScroll={event => {
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
              <div className="wd-inventory-grid unit-tiles">{units.map(opening => {
                const selected = opening.id in chosen;
                // Three different things, told apart on the tile (Matt, 2026-11-21):
                // chosen for this save, this activity already finished on the
                // unit, and the unit complete as a whole.
                const complete = unitState.complete(opening.id);
                const activityDone = !complete && Boolean(activity) && unitState.activityDone(opening.id, activity);
                return <UnitTile key={opening.id} code={opening.opening_code} picture={picture(opening)} done={complete}
                  codeExtra={complete ? <Check size={12} aria-label="Unit complete" /> : undefined}
                  status={selected ? "Selected" : complete ? "Unit complete" : activityDone ? `${activity} finished` : undefined}
                  card={{ "data-selected-unit": selected, "data-activity-done": activityDone }}
                  pick={{ "aria-label": `Add unit ${opening.opening_code}`, "aria-pressed": selected,
                    onClick: () => setChosen(current => {
                      const next = { ...current };
                      if (selected) delete next[opening.id];
                      else next[opening.id] = true;
                      return next;
                    }) }} />;
              })}</div>
            </section>)}
          </div>
          </div>
          {!shown.length && <p className="muted">No matching units.</p>}
          <p className="cw-add-legend" aria-hidden="true">
            <span data-key="selected">Selected</span>
            <span data-key="activity">{activity || "Activity"} finished</span>
            <span data-key="complete">Unit complete</span>
          </p>
          {/* Each chosen unit says whether the activity was finished on it; tap to change. */}
          {picked.length > 0 && <div className="cw-add-chosen" aria-label="Chosen units">
            {picked.map(opening => <button type="button" key={opening.id} aria-pressed={chosen[opening.id]}
              aria-label={`${opening.opening_code}: ${chosen[opening.id] ? "finished" : "not finished"}`}
              onClick={() => setChosen(current => ({ ...current, [opening.id]: !current[opening.id] }))}>
              {chosen[opening.id] && <Check size={13} aria-hidden="true" />}{opening.opening_code}
              <span>{chosen[opening.id] ? "Finished" : "Not finished"}</span>
            </button>)}
          </div>}
          {picked.length > 1 && seconds > 0 && <p className="muted">
            {picked.length} units share the time evenly: {clockText(Math.round(seconds / picked.length))} each.
          </p>}
        </>}
    </fieldset>}
    {error && <p role="alert" className="cw-correction-wide">{error}</p>}
    <div className="cw-actions cw-correction-wide">
      <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="cw-correction-save" onClick={() => void save()} disabled={busy}>
        {busy ? "Saving…" : existing ? "Save units" : "Add activity"}
      </button>
    </div>
  </section>;
}
