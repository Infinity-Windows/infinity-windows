import { useState } from "react";
import { Link } from "react-router-dom";
import { createProject, setProjectModes, setProjectTest } from "../../lib/api";
import { getRealProfile, listOpenings, listMarkSpecs, registerCustomMark, updateMarkSpec, assignOpeningToInstaller } from "../../lib/install/api";
import { buildCustomMarkRegistrationPayload } from "../../lib/modelstudio/customMarks";
import { supabase } from "../../lib/supabase";
import { signInMark, stillSignedInAs } from "../../lib/signedIn";
import { formatApiError } from "../../lib/errors";

const CODE = "FORGE-TRAIN-1103";
const NAME = "TEST — Forge installer workday · Nov 3";
const MARKS = [
  { code: "12", kind: "window", widthIn: 36, heightIn: 60, style: "Sample fixed window", operation: "Fixed" },
  { code: "13", kind: "window", widthIn: 48, heightIn: 60, style: "Sample sliding window", operation: "XO" },
  { code: "14", kind: "window", widthIn: 36, heightIn: 48, style: "Sample casement window", operation: "Casement" },
  { code: "15", kind: "door", widthIn: 36, heightIn: 80, style: "Sample swing door", operation: "Door" },
  { code: "16", kind: "door", widthIn: 72, heightIn: 80, style: "Sample sliding door", operation: "XO" },
  { code: "17", kind: "window", widthIn: 48, heightIn: 48, style: "Sample fixed window", operation: "Fixed" },
  { code: "18", kind: "door", widthIn: 96, heightIn: 80, style: "Sample sliding door", operation: "OX" },
] as const;

export function PracticeProjectSetup() {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const [error, setError] = useState(""), [projectId, setProjectId] = useState("");
  const setup = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const mark = signInMark(), actor = await getRealProfile();
      if (actor?.role !== "owner") throw new Error("Owner access is required to establish this practice project.");
      const assertOwner = () => { if (!stillSignedInAs(mark, actor.id)) throw new Error("Sign-in changed. Reopen setup before continuing."); };
      assertOwner();
      const { data: crew, error: crewError } = await supabase.from("profiles").select("id,display_name,role,is_test,retired_at,access_revoked_at").eq("is_test", true).eq("role", "installer").is("retired_at", null).is("access_revoked_at", null);
      if (crewError) throw crewError;
      if (crew?.length !== 1) throw new Error("Choose the intended QA installer first: setup requires exactly one current test installer.");
      const installer = crew[0];
      const { data: existing, error: lookupError } = await supabase.from("projects").select("id,name,is_test,deleted_at,status").eq("job_code", CODE).maybeSingle();
      if (lookupError) throw lookupError;
      if (existing && (existing.name !== NAME || existing.deleted_at || existing.status !== "active")) throw new Error("That project code is already in use or archived. No existing job was changed.");
      setStatus(existing ? "Resuming the sample project" : "Creating the sample project");
      assertOwner();
      const project = existing ?? await createProject({ jobCode: CODE, name: NAME, notes: "Disposable Forge installer-workday practice project. Synthetic planned unit configurations only; no customer site or warranty instructions. Archive after review.", readyState: "ready", stories: 1 });
      setProjectId(project.id);
      assertOwner(); await setProjectTest(project.id, true);
      const { data: sandbox, error: sandboxError } = await supabase.rpc("is_sandbox_project", { p_project_id: project.id });
      if (sandboxError) throw sandboxError;
      if (sandbox !== true) throw new Error("The project was created, but sandbox registration needs repair. No units were added.");
      assertOwner(); await setProjectModes(project.id, ["data", "tracking"]);
      let openings = await listOpenings(project.id);
      for (const sample of MARKS) {
        assertOwner(); setStatus(`Establishing unit ${sample.code}`);
        const payload = buildCustomMarkRegistrationPayload(project.id, { ...sample, wMm: sample.widthIn * 25.4, hMm: sample.heightIn * 25.4 });
        let opening = openings.find(o => o.opening_code === sample.code);
        if (!opening) {
          await registerCustomMark(project.id, payload);
          openings = await listOpenings(project.id);
          opening = openings.find(o => o.opening_code === sample.code);
        }
        if (!opening) throw new Error(`Unit ${sample.code} could not be verified after saving.`);
        const specs = await listMarkSpecs(project.id);
        const spec = specs.find(s => s.mark_code === sample.code);
        if (!spec) throw new Error(`Unit ${sample.code} exists but its planned specification needs repair. The project has been retained.`);
        if (spec.style == null) { assertOwner(); await updateMarkSpec(spec.id, { style: sample.style, operation: sample.operation }); }
        if (opening.assigned_to && opening.assigned_to !== installer.id) throw new Error(`Unit ${sample.code} was reassigned. Its assignment was not overwritten.`);
        if (!opening.assigned_to) { assertOwner(); await assignOpeningToInstaller(opening.id, installer.id, Number(sample.code) - 11); }
      }
      const saved = await listOpenings(project.id);
      if (MARKS.some(m => !saved.some(o => o.opening_code === m.code && o.assigned_to === installer.id))) throw new Error("Some unit assignments were not confirmed. Keep this project for review.");
      setStatus(`Ready · 7 real openings assigned to ${installer.display_name}. No timers or completion records were created.`);
    } catch (e) { setError(formatApiError(e)); }
    finally { setBusy(false); }
  };
  return <main className="page"><h1>Establish installer practice project</h1><p>{CODE} · {NAME}</p><p>Seven sample openings, 12–18: fixed/sliding/casement windows, a swing door and sliding doors. Planned sizes go in their specs; RO measurements stay empty. Reuses the existing QA installer and marks the new job as testing.</p><button disabled={busy} onClick={() => void setup()}>{busy ? "Establishing…" : "Create practice project & units"}</button>{status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}{projectId && <p><Link to={`/projects/${projectId}`}>Open real project</Link>{" · "}<Link to={`/installer-day?project=${projectId}`}>Open Steel workday</Link></p>}</main>;
}
