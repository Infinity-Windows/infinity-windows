// Log a delivery WITHOUT stickers (owner ask, 2026-08-21 night: the truck
// comes in the morning; the scanner and label printer haven't arrived).
//
// The chooser comes first, and since ADR-0007 both ways in are open to
// whoever's at the tailgate: with QR stickers -> the existing tag flow
// (ticket 20 made this page the one front door for trucks); without -> this
// wizard, which calls create_manual_delivery. That RPC was foreman+ until
// ADR-0007 opened it; what it still refuses is a builder login. The wizard
// collects the skeleton
// (jobs -> sets -> package counts -> crates) and deliberately NOT per-package
// part labels: the boxes' own labels decide that order, so parts get labeled
// later on the package screen with the box in front of you. Labels for every
// created package can be printed later from here (their own serials — never
// recycled blank stickers).
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BackChip } from "../../components/BackChip";
import { StationChip } from "../../components/warehouse/StationChip";
import { listProjects } from "../../lib/api";
import { createManualDelivery, createPlaceholderJob } from "../../lib/storage";
import { STATION_COMING_IN } from "../../lib/warehouse/stations";
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
import { useT } from "../../lib/i18n";

type Stage = "mode" | "jobs" | "sets" | "review" | "done";

export function LogDelivery() {
  const t = useT();
  const navigate = useNavigate();
  // Ticket 20: this page is the ONE front door for trucks, open to whoever's
  // at the tailgate — and since ADR-0007 the hand-entry wizard below is too.
  // There is no rank left on this screen: the tool and the door finally agree.
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [stage, setStage] = useState<Stage>("mode");
  const [label, setLabel] = useState("");
  const [entries, setEntries] = useState<WizardEntry[]>([emptyEntry()]);
  const [result, setResult] = useState<{
    created: number;
    unfiled: number;
    delivery_id: string;
  } | null>(null);
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
      const problems = wizardProblems(entries, t);
      if (problems.length > 0) throw new Error(problems[0]);
      // A job that isn't built yet becomes a real job first (wave 5): the
      // packages land on a NEW- job the office renames, not on a typed name.
      const built = await Promise.all(
        entries.map(async (e) =>
          e.project_id || !e.job_name.trim()
            ? e
            : { ...e, project_id: (await createPlaceholderJob(e.job_name.trim())).id },
        ),
      );
      return createManualDelivery(label, buildDeliveryPayload(built));
    },
    onSuccess: (r) => {
      localStorage.removeItem(DRAFT_KEY);
      setRestoredFrom(null);
      setResult({
        created: r.created,
        unfiled: r.unfiled ?? 0,
        delivery_id: r.delivery_id,
      });
      setStage("done");
    },
  });

  const problems = wizardProblems(entries, t);

  if (stage === "mode") {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">{t("storage.logDelivery.warehouse")}</p>
            <h1>{t("storage.logDelivery.title")}</h1>
          </div>
          <BackChip fallback="/warehouse" label={t("storage.logDelivery.warehouse")} />
        </header>
        <StationChip station={STATION_COMING_IN} />
        <p className="muted">{t("storage.logDelivery.howTracked")}</p>
        <div className="row-gap" style={{ flexDirection: "column", maxWidth: 460 }}>
          <button
            className="primary big"
            onClick={() => navigate("/storage/tag")}
          >
            {t("storage.logDelivery.withStickers")}
          </button>
          {/* Both ways in are open to every crew member (ADR-0007) — the
              person meeting the truck decides how the truck gets tracked. */}
          <button className="button-like big" onClick={() => setStage("jobs")}>
            {t("storage.logDelivery.withoutStickers")}
          </button>
          <p className="muted">{t("storage.logDelivery.withoutStickersHint")}</p>
        </div>
      </div>
    );
  }

  if (stage === "done") {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">{t("storage.logDelivery.warehouse")}</p>
            <h1>{t("storage.logDelivery.loggedTitle")}</h1>
          </div>
          <BackChip fallback="/warehouse" label={t("storage.logDelivery.warehouse")} />
        </header>
        <StationChip station={STATION_COMING_IN} />
        <p>
          {t(
            (result?.created ?? 0) === 1
              ? "storage.logDelivery.standbySaved.one"
              : "storage.logDelivery.standbySaved.many",
            { n: result?.created ?? 0 },
          )}
          {result?.unfiled ? ` ${t("storage.logDelivery.unfiled", { n: result.unfiled })}` : ""}
        </p>
        <p className="muted">{t("storage.logDelivery.whenTruckShowsUp")}</p>
        <div className="row-gap">
          {result?.delivery_id && (
            <Link className="primary big" to={`/storage/d/${result.delivery_id}`}>
              {t("storage.logDelivery.openDelivery")}
            </Link>
          )}
          <Link className="button-like" to="/warehouse">
            {t("storage.logDelivery.backToWarehouse")}
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
            {t("storage.logDelivery.logAnother")}
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
            <p className="home-greeting">{t("storage.logDelivery.reviewGreeting")}</p>
            <h1>{label.trim() || t("storage.logDelivery.handLogged")}</h1>
          </div>
          <BackChip fallback="/warehouse" label={t("storage.logDelivery.warehouse")} />
        </header>
        <StationChip station={STATION_COMING_IN} />
        {entries.map((entry, ei) => {
          const job = projects.data?.find((p) => p.id === entry.project_id);
          return (
            <section key={ei} style={{ marginBottom: 12 }}>
              <h2>
                {job
                  ? (job.job_code ?? job.name)
                  : t("storage.logDelivery.jobNotBuiltYet", { name: entry.job_name.trim() })}
              </h2>
              <ul className="unit-list">
                {entry.sets.map((set, si) => (
                  <li key={si}>{describeSet(set, t)}</li>
                ))}
              </ul>
            </section>
          );
        })}
        {save.isError && <p className="error">{formatApiError(save.error)}</p>}
        {problems.length > 0 && <p className="error">{problems[0]}</p>}
        <div className="row-gap">
          <button className="button-like" onClick={() => setStage("sets")}>
            {t("storage.logDelivery.back")}
          </button>
          <button
            className="primary big"
            disabled={save.isPending || problems.length > 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t("storage.logDelivery.saving") : t("storage.logDelivery.saveDelivery")}
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
            <p className="home-greeting">{t("storage.logDelivery.step1Greeting")}</p>
            <h1>{t("storage.logDelivery.whichJobs")}</h1>
          </div>
          <BackChip fallback="/warehouse" label={t("storage.logDelivery.warehouse")} />
        </header>
        <StationChip station={STATION_COMING_IN} />
        {restoredFrom && (
          <p className="scanner-hint">
            {t("storage.logDelivery.restored.pre")}
            {new Date(restoredFrom).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            {t("storage.logDelivery.restored.mid")}
            <button
              className="link"
              onClick={() => {
                localStorage.removeItem(DRAFT_KEY);
                setRestoredFrom(null);
                setEntries([emptyEntry()]);
                setLabel("");
              }}
            >
              {t("storage.logDelivery.startFresh")}
            </button>
            {t("storage.logDelivery.restored.post")}
          </p>
        )}
        <label className="field-label" htmlFor="delivery-label">
          {t("storage.logDelivery.deliveryName")}
        </label>
        <input
          id="delivery-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("storage.logDelivery.deliveryNamePlaceholder")}
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
              <option value="">{t("storage.logDelivery.jobNotInApp")}</option>
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
                placeholder={t("storage.logDelivery.typeJobName")}
              />
            )}
            {entries.length > 1 && (
              <button
                className="link"
                onClick={() =>
                  setEntries((prev) => prev.filter((_, i) => i !== ei))
                }
              >
                {t("storage.logDelivery.remove")}
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
            {t("storage.logDelivery.anotherJob", { n: entries.length, max: MAX_PROJECTS })}
          </button>
          <button className="primary" onClick={() => setStage("sets")}>
            {t("storage.logDelivery.nextSets")}
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {t("storage.logDelivery.jobNotInAppHint")}
        </p>
      </div>
    );
  }

  // stage === "sets"
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">{t("storage.logDelivery.step2Greeting")}</p>
          <h1>{t("storage.logDelivery.setsOnTruck")}</h1>
        </div>
        <BackChip fallback="/warehouse" label={t("storage.logDelivery.warehouse")} />
      </header>
      <StationChip station={STATION_COMING_IN} />
      <p className="muted">{t("storage.logDelivery.setsExplain")}</p>
      {entries.map((entry, ei) => {
        const job = projects.data?.find((p) => p.id === entry.project_id);
        return (
          <section key={ei} style={{ marginBottom: 16 }}>
            <h2>{job ? (job.job_code ?? job.name) : entry.job_name.trim() || t("storage.logDelivery.problem.jobN", { n: ei + 1 })}</h2>
            {entry.sets.map((set, si) => (
              <div
                key={si}
                className="manual-entry"
                style={{ flexWrap: "wrap", alignItems: "center" }}
              >
                <input
                  value={set.mark}
                  onChange={(e) => patchSet(ei, si, { mark: e.target.value })}
                  placeholder={t("storage.logDelivery.markPlaceholder")}
                  style={{ width: 110 }}
                  aria-label={t("storage.logDelivery.markAria")}
                />
                <select
                  value={set.kind}
                  onChange={(e) =>
                    patchSet(ei, si, { kind: e.target.value as WizardSet["kind"] })
                  }
                >
                  <option value="window">{t("storage.logDelivery.describe.window")}</option>
                  <option value="door">{t("storage.logDelivery.describe.door")}</option>
                </select>
                <label className="field-label" style={{ margin: 0 }}>
                  {t("storage.logDelivery.packages")}
                </label>
                <select
                  value={set.package_count}
                  onChange={(e) =>
                    patchSet(ei, si, { package_count: Number(e.target.value) })
                  }
                  aria-label={t("storage.logDelivery.howManyPackages")}
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
                      {t("storage.logDelivery.identical")}
                    </label>
                    <select
                      value={set.quantity}
                      onChange={(e) =>
                        patchSet(ei, si, { quantity: Number(e.target.value) })
                      }
                      aria-label={t("storage.logDelivery.howManyIdentical")}
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
                      {t("storage.logDelivery.clonesOff")}
                    </button>
                  </>
                ) : (
                  <button
                    className="link"
                    onClick={() => patchSet(ei, si, { quantity: 2 })}
                  >
                    {t("storage.logDelivery.addClones")}
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
                      placeholder={t("storage.logDelivery.crateNamePlaceholder")}
                      style={{ width: 150 }}
                      aria-label={t("storage.logDelivery.crateNameAria")}
                    />
                    <label className="field-label" style={{ margin: 0 }}>
                      {t("storage.logDelivery.piecesInIt")}
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
                      aria-label={t("storage.logDelivery.piecesInCrateAria")}
                    />
                    <button
                      className="link"
                      onClick={() => patchSet(ei, si, { crate: null })}
                    >
                      {t("storage.logDelivery.noCrate")}
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
                    {t("storage.logDelivery.addPiecesInCrate")}
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
                    {t("storage.logDelivery.removeSet")}
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
              {t("storage.logDelivery.anotherSet", { n: entry.sets.length, max: MAX_SETS })}
            </button>
          </section>
        );
      })}
      <div className="row-gap">
        <button className="button-like" onClick={() => setStage("jobs")}>
          {t("storage.logDelivery.back")}
        </button>
        <button className="primary" onClick={() => setStage("review")}>
          {t("storage.logDelivery.nextReview")}
        </button>
      </div>
    </div>
  );
}
