// Log a delivery WITHOUT stickers (owner ask, 2026-08-21 night: the truck
// comes in the morning; the scanner and label printer haven't arrived).
//
// The chooser comes first: with QR stickers -> the existing tag flow;
// without -> this wizard. The wizard collects the skeleton (jobs -> sets ->
// package counts -> crates) and deliberately NOT per-package part labels:
// the boxes' own labels decide that order, so parts get labeled later on
// the package screen with the box in front of you. Labels for every created
// package can be printed later from here (their own serials — never
// recycled blank stickers).
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { listProjects } from "../../lib/api";
import { createManualDelivery } from "../../lib/storage";
import {
  DRAFT_KEY,
  MAX_CLONES,
  MAX_PACKAGES,
  MAX_PROJECTS,
  MAX_SETS,
  buildDeliveryPayload,
  describeSet,
  emptyEntry,
  emptySet,
  parseDraft,
  serializeDraft,
  wizardProblems,
  type WizardEntry,
  type WizardSet,
} from "../../lib/warehouse/deliveryWizard";
import { formatApiError } from "../../lib/install/errors";

type Stage = "mode" | "jobs" | "sets" | "review" | "done";

export function LogDelivery() {
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [stage, setStage] = useState<Stage>("mode");
  const [label, setLabel] = useState("");
  const [entries, setEntries] = useState<WizardEntry[]>([emptyEntry()]);
  const [result, setResult] = useState<{ created: number; pending: number } | null>(
    null,
  );
  const [restoredFrom, setRestoredFrom] = useState<string | null>(null);

  // The checkpoint (owner ask): every change autosaves on the device, a
  // refresh picks the list right back up, and a real save clears it.
  useEffect(() => {
    const draft = parseDraft(localStorage.getItem(DRAFT_KEY));
    if (draft) {
      setLabel(draft.label);
      setEntries(draft.entries);
      setStage("jobs");
      setRestoredFrom(draft.savedAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (stage === "jobs" || stage === "sets" || stage === "review") {
      localStorage.setItem(
        DRAFT_KEY,
        serializeDraft(label, entries, new Date().toISOString()),
      );
    }
  }, [label, entries, stage]);

  const patchEntry = (ei: number, patch: Partial<WizardEntry>) =>
    setEntries((prev) => prev.map((e, i) => (i === ei ? { ...e, ...patch } : e)));
  const patchSet = (ei: number, si: number, patch: Partial<WizardSet>) =>
    setEntries((prev) =>
      prev.map((e, i) =>
        i === ei
          ? { ...e, sets: e.sets.map((s, j) => (j === si ? { ...s, ...patch } : s)) }
          : e,
      ),
    );

  const save = useMutation({
    mutationFn: async () => {
      const problems = wizardProblems(entries);
      if (problems.length > 0) throw new Error(problems[0]);
      return createManualDelivery(label, buildDeliveryPayload(entries));
    },
    onSuccess: (r) => {
      localStorage.removeItem(DRAFT_KEY);
      setRestoredFrom(null);
      setResult({ created: r.created, pending: r.pending });
      setStage("done");
    },
  });

  const problems = wizardProblems(entries);

  if (stage === "mode") {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">Warehouse</p>
            <h1>Log a delivery</h1>
          </div>
          <BackChip fallback="/warehouse" label="Warehouse" />
        </header>
        <p className="muted">How will this truck be tracked?</p>
        <div className="row-gap" style={{ flexDirection: "column", maxWidth: 460 }}>
          <button
            className="primary big"
            onClick={() => navigate("/storage/tag")}
          >
            With QR stickers — scan and tag at the tailgate
          </button>
          <button className="button-like big" onClick={() => setStage("jobs")}>
            Without stickers — enter it by hand
          </button>
          <p className="muted">
            Entering by hand still creates every package with its own ID — you
            can print their labels whenever the printer shows up.
          </p>
        </div>
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">Warehouse</p>
            <h1>Delivery logged</h1>
          </div>
          <BackChip fallback="/warehouse" label="Warehouse" />
        </header>
        <p>
          {result?.created ?? 0} package{(result?.created ?? 0) === 1 ? "" : "s"}{" "}
          created.
          {result?.pending
            ? ` ${result.pending} set${result.pending === 1 ? "" : "s"} are waiting on jobs that aren't built yet — a supervisor has it on the Issues list.`
            : ""}
        </p>
        <p className="muted">
          Part labels (frame, glass, hardware…) get assigned on each package's
          screen once you can see how the boxes are actually marked. Labels
          print from each package or container screen when the printer arrives.
        </p>
        <div className="row-gap">
          <Link className="button-like" to="/warehouse">
            Back to the warehouse
          </Link>
          <button
            className="button-like"
            onClick={() => {
              setEntries([emptyEntry()]);
              setLabel("");
              setResult(null);
              setStage("jobs");
            }}
          >
            Log another delivery
          </button>
        </div>
      </div>
    );
  }

  if (stage === "review") {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">Log a delivery · review</p>
            <h1>{label.trim() || "Hand-logged delivery"}</h1>
          </div>
          <BackChip fallback="/warehouse" label="Warehouse" />
        </header>
        {entries.map((entry, ei) => {
          const job = projects.data?.find((p) => p.id === entry.project_id);
          return (
            <section key={ei} style={{ marginBottom: 12 }}>
              <h2>
                {job
                  ? (job.job_code ?? job.name)
                  : `${entry.job_name.trim()} (job not built yet — a supervisor will get it)`}
              </h2>
              <ul className="unit-list">
                {entry.sets.map((set, si) => (
                  <li key={si}>{describeSet(set)}</li>
                ))}
              </ul>
            </section>
          );
        })}
        {save.isError && <p className="error">{formatApiError(save.error)}</p>}
        {problems.length > 0 && <p className="error">{problems[0]}</p>}
        <div className="row-gap">
          <button className="button-like" onClick={() => setStage("sets")}>
            Back
          </button>
          <button
            className="primary big"
            disabled={save.isPending || problems.length > 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save the delivery"}
          </button>
        </div>
      </div>
    );
  }

  if (stage === "jobs") {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">Log a delivery · step 1 of 3</p>
            <h1>Which jobs are on this truck?</h1>
          </div>
          <BackChip fallback="/warehouse" label="Warehouse" />
        </header>
        {restoredFrom && (
          <p className="scanner-hint">
            Picked your unsaved delivery back up (from{" "}
            {new Date(restoredFrom).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            ) — keep going, or{" "}
            <button
              className="link"
              onClick={() => {
                localStorage.removeItem(DRAFT_KEY);
                setRestoredFrom(null);
                setEntries([emptyEntry()]);
                setLabel("");
              }}
            >
              start fresh
            </button>
            .
          </p>
        )}
        <label className="field-label" htmlFor="delivery-label">
          Delivery name (optional)
        </label>
        <input
          id="delivery-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Tech Ridge truck, Aug 22"
          style={{ maxWidth: 420 }}
        />
        {entries.map((entry, ei) => (
          <div key={ei} className="manual-entry" style={{ alignItems: "center" }}>
            <select
              value={entry.project_id ?? ""}
              onChange={(e) =>
                patchEntry(ei, {
                  project_id: e.target.value || null,
                })
              }
            >
              <option value="">— job not in the app yet —</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.job_code ?? p.name}
                </option>
              ))}
            </select>
            {!entry.project_id && (
              <input
                value={entry.job_name}
                onChange={(e) => patchEntry(ei, { job_name: e.target.value })}
                placeholder="Type the job's name"
              />
            )}
            {entries.length > 1 && (
              <button
                className="link"
                onClick={() =>
                  setEntries((prev) => prev.filter((_, i) => i !== ei))
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <div className="row-gap" style={{ marginTop: 8 }}>
          <button
            className="button-like"
            disabled={entries.length >= MAX_PROJECTS}
            onClick={() => setEntries((prev) => [...prev, emptyEntry()])}
          >
            + Another job ({entries.length}/{MAX_PROJECTS})
          </button>
          <button className="primary" onClick={() => setStage("sets")}>
            Next: the sets
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          A job that isn't in the app yet doesn't stop the unload — type its
          name, keep going, and a supervisor gets an Issue to build it.
        </p>
      </div>
    );
  }

  // stage === "sets"
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Log a delivery · step 2 of 3</p>
          <h1>Sets on the truck</h1>
        </div>
        <BackChip fallback="/warehouse" label="Warehouse" />
      </header>
      <p className="muted">
        A set is everything for one window or door — its frame, glass,
        hardware. Count its packages; if some pieces ride in a crate, say how
        many and name the crate. Six identical windows? Turn on Clones and
        say how many — every unit gets the same packages and crate pieces.
        Which box is which part gets labeled later, when you can read the
        boxes.
      </p>
      {entries.map((entry, ei) => {
        const job = projects.data?.find((p) => p.id === entry.project_id);
        return (
          <section key={ei} style={{ marginBottom: 16 }}>
            <h2>{job ? (job.job_code ?? job.name) : entry.job_name.trim() || `Job ${ei + 1}`}</h2>
            {entry.sets.map((set, si) => (
              <div
                key={si}
                className="manual-entry"
                style={{ flexWrap: "wrap", alignItems: "center" }}
              >
                <input
                  value={set.mark}
                  onChange={(e) => patchSet(ei, si, { mark: e.target.value })}
                  placeholder="Mark, e.g. 16"
                  style={{ width: 110 }}
                  aria-label="Mark"
                />
                <select
                  value={set.kind}
                  onChange={(e) =>
                    patchSet(ei, si, { kind: e.target.value as WizardSet["kind"] })
                  }
                >
                  <option value="window">Window</option>
                  <option value="door">Door</option>
                </select>
                <label className="field-label" style={{ margin: 0 }}>
                  Packages
                </label>
                <select
                  value={set.package_count}
                  onChange={(e) =>
                    patchSet(ei, si, { package_count: Number(e.target.value) })
                  }
                  aria-label="How many packages"
                >
                  {Array.from({ length: MAX_PACKAGES }, (_, n) => (
                    <option key={n + 1} value={n + 1}>
                      {n + 1}
                    </option>
                  ))}
                </select>
                {set.quantity > 1 ? (
                  <>
                    <label className="field-label" style={{ margin: 0 }}>
                      Identical
                    </label>
                    <select
                      value={set.quantity}
                      onChange={(e) =>
                        patchSet(ei, si, { quantity: Number(e.target.value) })
                      }
                      aria-label="How many identical"
                    >
                      {Array.from({ length: MAX_CLONES - 1 }, (_, n) => (
                        <option key={n + 2} value={n + 2}>
                          ×{n + 2}
                        </option>
                      ))}
                    </select>
                    <button
                      className="link"
                      onClick={() => patchSet(ei, si, { quantity: 1 })}
                    >
                      Clones off
                    </button>
                  </>
                ) : (
                  <button
                    className="link"
                    onClick={() => patchSet(ei, si, { quantity: 2 })}
                  >
                    + Clones (identical units)
                  </button>
                )}
                {set.crate ? (
                  <>
                    <input
                      value={set.crate.name}
                      onChange={(e) =>
                        patchSet(ei, si, {
                          crate: { ...set.crate!, name: e.target.value },
                        })
                      }
                      placeholder="Crate name, e.g. Crate 1"
                      style={{ width: 150 }}
                      aria-label="Crate name"
                    />
                    <label className="field-label" style={{ margin: 0 }}>
                      Pieces in it
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={set.crate.pieces}
                      onChange={(e) =>
                        patchSet(ei, si, {
                          crate: { ...set.crate!, pieces: Number(e.target.value) },
                        })
                      }
                      style={{ width: 70 }}
                      aria-label="Pieces in the crate"
                    />
                    <button
                      className="link"
                      onClick={() => patchSet(ei, si, { crate: null })}
                    >
                      No crate
                    </button>
                  </>
                ) : (
                  <button
                    className="link"
                    onClick={() =>
                      patchSet(ei, si, {
                        crate: { name: "Crate 1", pieces: 1, part_type: "glass" },
                      })
                    }
                  >
                    + Pieces in a crate
                  </button>
                )}
                {entry.sets.length > 1 && (
                  <button
                    className="link"
                    onClick={() =>
                      patchEntry(ei, {
                        sets: entry.sets.filter((_, j) => j !== si),
                      })
                    }
                  >
                    Remove set
                  </button>
                )}
              </div>
            ))}
            <button
              className="button-like"
              disabled={entry.sets.length >= MAX_SETS}
              onClick={() =>
                patchEntry(ei, { sets: [...entry.sets, emptySet()] })
              }
            >
              + Another set ({entry.sets.length}/{MAX_SETS})
            </button>
          </section>
        );
      })}
      <div className="row-gap">
        <button className="button-like" onClick={() => setStage("jobs")}>
          Back
        </button>
        <button className="primary" onClick={() => setStage("review")}>
          Next: review
        </button>
      </div>
    </div>
  );
}
