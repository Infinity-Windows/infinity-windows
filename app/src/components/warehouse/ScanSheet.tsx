// The scan sheet (warehouse redesign wave 2, owner call 2026-09-06): one
// camera, one sheet, and the sheet reads what was scanned and leads with the
// verb that follows it. Expected → Arrive. Loose → Put away, or "Put with the
// rest of window 16" when the app already knows where the unit's other pieces
// sit. Stored → Move, Check out. A conex poster scanned FIRST turns the sheet
// into put-away mode: everything scanned next goes into that box (Odoo's
// scan-the-bin pattern, Homebox's QR-per-location). Keep scanning to select
// several; the verbs then apply to all of them.
//
// No sticker? The person can type the six-character code off the label or
// pick the piece by job → window → part — the maker's own "#16 2/3" is a
// unique ID on a job, so a hand confirmation is as real as a scan.
//
// Every write goes through the offline wrappers (a yard is a dead zone) and
// shows the app's Undo toast when it reached the server.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects, listProjectsAnyStatus } from "../../lib/api";
import { formatApiError } from "../../lib/errors";
import { parseQr, type QrPayload } from "../../lib/qr";
import { playErrorTone, playSuccessTone } from "../../lib/sound";
import { pushToast } from "../../lib/toast";
import { showUndoToast } from "../../lib/undoToast";
import { Scanner } from "../Scanner";
import { placeWhere, toLocationsById } from "../../lib/warehouse/containment";
import { unitHref } from "../../lib/warehouse/materialsScope";
import { receiveMintedOffline, storePackagesOffline, writeToast } from "../../lib/warehouse/offlineWrites";
import { scanVerbs, verbsForMany, type ScanVerb } from "../../lib/warehouse/scanVerbs";
import {
  getContainerBySerial,
  getPackageByShortCode,
  getPackageBySerial,
  listActivePackages,
  listContainers,
  listMovementsForPackages,
  packageTitle,
  partLabel,
  undoMovement,
  type StorageContainer,
  type StoragePackage,
} from "../../lib/storage";

type Step = "scan" | "box" | "hand";

/** A stable empty list, so a loading cache is not a new array every render. */
const NO_ROWS: StoragePackage[] = [];

export function ScanSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const packages = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const containers = useQuery({ queryKey: ["storageContainers"], queryFn: listContainers });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const projectsAll = useQuery({ queryKey: ["projectsAll"], queryFn: listProjectsAnyStatus });

  const [pickedIds, setPickedIds] = useState<string[]>([]);
  /** Rows the cache does not hold (a blank sticker, a package fetched by serial). */
  const [extra, setExtra] = useState<Map<string, StoragePackage>>(new Map());
  const [box, setBox] = useState<StorageContainer | null>(null);
  const [step, setStep] = useState<Step>("scan");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Lock the page underneath while the sheet is up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const all = packages.data ?? NO_ROWS;
  const byId = useMemo(() => {
    const m = new Map<string, StoragePackage>();
    for (const p of all) m.set(p.id, p);
    for (const [id, p] of extra) if (!m.has(id)) m.set(id, p);
    return m;
  }, [all, extra]);
  const containersById = useMemo(
    () => new Map((containers.data ?? []).map((c) => [c.id, c])),
    [containers.data],
  );
  const jobCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsAll.data ?? []) m.set(p.id, p.job_code);
    return m;
  }, [projectsAll.data]);
  const picked = pickedIds.map((id) => byId.get(id)).filter((p): p is StoragePackage => Boolean(p));
  const verbs: ScanVerb[] =
    picked.length === 1 ? scanVerbs(picked[0], all, containersById) : verbsForMany(picked);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    void qc.invalidateQueries({ queryKey: ["unitMovements"] });
  };

  const feedback = (ok: boolean) => {
    if (ok) playSuccessTone();
    else playErrorTone();
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [40, 40, 40]);
  };

  /** Undo the latest put-away of each package, when the server wrote one. */
  const undoStores = async (ids: string[]) => {
    const lines = await listMovementsForPackages(ids);
    const latest = new Map<string, string>();
    for (const l of lines) {
      if (!l.package_id || latest.has(l.package_id)) continue;
      if (l.event === "stored" && !l.undoes) latest.set(l.package_id, l.id);
    }
    for (const id of latest.values()) await undoMovement(id);
    refresh();
  };

  const store = async (rows: StoragePackage[], into: StorageContainer) => {
    setBusy(true);
    setMsg(null);
    try {
      // Expected packages arrive first — a box scanned at the tailgate is
      // both "it's here" and "it lives here".
      const expected = rows.filter((p) => p.status === "minted").map((p) => p.id);
      if (expected.length > 0) await receiveMintedOffline(expected);
      const r = await storePackagesOffline(
        rows.map((p) => ({ id: p.id, status: p.status, container_id: p.container_id })),
        into.id,
      );
      refresh();
      feedback(true);
      const ids = rows.map((p) => p.id);
      const done = `${rows.length === 1 ? "1 package" : `${rows.length} packages`} put in ${into.name}.`;
      if (r.queued) pushToast(writeToast(r, done));
      else showUndoToast({ message: done, undo: () => undoStores(ids) });
      setPickedIds([]);
      setStep("scan");
    } catch (e) {
      feedback(false);
      setMsg(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const arrive = async (rows: StoragePackage[]) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await receiveMintedOffline(rows.map((p) => p.id));
      refresh();
      feedback(true);
      pushToast(writeToast(r, `${rows.length === 1 ? "Arrived." : `${rows.length} arrived.`} Now put ${rows.length === 1 ? "it" : "them"} away.`));
    } catch (e) {
      feedback(false);
      setMsg(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const addPackage = async (p: StoragePackage) => {
    if (box && p.status !== "blank") {
      await store([p], box);
      return;
    }
    setExtra((m) => (m.has(p.id) ? m : new Map(m).set(p.id, p)));
    setPickedIds((ids) => (ids.includes(p.id) ? ids : [...ids, p.id]));
    feedback(true);
  };

  const handlePayload = async (payload: QrPayload) => {
    setMsg(null);
    try {
      if (payload.kind === "packageSerial" || payload.kind === "windowCode") {
        // A typed six-character code parses as the OLD unit chain's
        // "windowCode" (lib/qr.ts) — it is the same hand-writable alphabet the
        // package sticker stamps beside its serial, so look it up as a package.
        const query = payload.kind === "packageSerial" ? payload.serial : payload.code;
        const cached =
          payload.kind === "packageSerial"
            ? all.find((p) => p.serial === payload.serial)
            : all.find((p) => (p.short_code ?? "").toUpperCase() === payload.code);
        const p =
          cached ??
          (payload.kind === "packageSerial"
            ? await getPackageBySerial(payload.serial)
            : await getPackageByShortCode(payload.code));
        if (!p) {
          feedback(false);
          setMsg(`No package found for ${query}.`);
          return;
        }
        await addPackage(p);
        return;
      }
      if (payload.kind === "containerSerial") {
        const cached = (containers.data ?? []).find((c) => c.serial === payload.serial);
        const c = cached ?? (await getContainerBySerial(payload.serial));
        if (!c) {
          feedback(false);
          setMsg(`No box found for ${payload.serial}.`);
          return;
        }
        if (picked.length > 0) {
          // Scanned the box LAST: everything selected goes in.
          await store(picked, c);
        } else {
          setBox(c);
          feedback(true);
        }
        return;
      }
      feedback(false);
      setMsg(
        payload.kind === "location" || payload.kind === "locationSerial"
          ? "That's a slot label. Scan a package sticker or a box poster."
          : "That's an old unit label — stickers replaced these. Scan the sticker instead.",
      );
    } catch (e) {
      feedback(false);
      setMsg(formatApiError(e));
    }
  };

  const run = async (verb: ScanVerb) => {
    if (picked.length === 0) return;
    switch (verb.id) {
      case "tag":
        onClose();
        navigate("/storage/tag");
        return;
      case "arrive":
        await arrive(picked);
        return;
      case "put_with_rest": {
        const c = verb.containerId ? containersById.get(verb.containerId) : null;
        if (c) await store(picked, c);
        return;
      }
      case "put_away":
      case "move":
      case "back_in":
        setStep("box");
        return;
      case "check_out":
        onClose();
        navigate(`/storage/out?ids=${picked.map((p) => p.id).join(",")}`);
        return;
      case "fix": {
        const p = picked[0];
        const mark = p.package_marks?.[0]?.mark_code;
        onClose();
        if (p.project_id && mark) navigate(`${unitHref({ projectId: p.project_id }, mark)}?piece=${p.id}`);
        else if (!p.project_id && p.pending_job_name && p.mfr_mark)
          navigate(`${unitHref({ projectId: null, pendingName: p.pending_job_name }, p.mfr_mark)}&piece=${p.id}`);
        else navigate(`/pkg/${p.serial}`);
        return;
      }
    }
  };

  const locationsById = useMemo(() => toLocationsById([]), []);
  const title = (p: StoragePackage) => packageTitle(p, jobCode);
  const where = (p: StoragePackage) =>
    p.status === "minted"
      ? "expected — not arrived yet"
      : p.status === "checked_out"
        ? "out on a job"
        : p.status === "blank"
          ? "blank sticker — not on a package yet"
          : placeWhere(p, containersById, locationsById);

  return (
    <div className="scan-sheet" role="dialog" aria-modal="true" aria-label="Scan">
      <div className="scan-sheet-top">
        <span>{box ? `Putting away into ${box.name}` : picked.length > 0 ? `${picked.length} selected` : "Scanning"}</span>
        <div style={{ display: "flex", gap: 6 }}>
          {box ? (
            <button type="button" onClick={() => setBox(null)}>
              Leave box
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </div>
      {box ? (
        <div className="scan-sheet-box">
          Scan stickers — each one goes straight into <b>{box.name}</b>. Scan another poster to switch boxes.
        </div>
      ) : null}
      <div className="scan-sheet-camera">
        <Scanner onScan={(p) => void handlePayload(p)} hint="Point at any sticker or box poster" />
      </div>

      <div className="scan-panel">
        <div className="scan-panel-grab" />
        {msg ? <p className="scan-msg">{msg}</p> : null}

        {step === "box" ? (
          <>
            <div className="scan-panel-title">Which box?</div>
            <div className="scan-panel-sub">
              {picked.length === 1 ? title(picked[0]) : `${picked.length} packages`} — tap where {picked.length === 1 ? "it" : "they"} go
            </div>
            <div className="scan-boxes">
              {(containers.data ?? [])
                .filter((c) => c.active)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => {
                  const n = all.filter((p) => p.container_id === c.id && p.status === "stored").length;
                  return (
                    <button key={c.id} type="button" className="scan-box" disabled={busy} onClick={() => void store(picked, c)}>
                      <b>{c.name}</b>
                      <span>
                        {c.kind ?? "conex"} · {n} inside
                      </span>
                    </button>
                  );
                })}
            </div>
            <button type="button" className="button-like" style={{ marginTop: 10 }} onClick={() => setStep("scan")}>
              Back
            </button>
          </>
        ) : step === "hand" ? (
          <HandPick
            all={all}
            projects={projects.data ?? []}
            onPick={(p) => {
              void addPackage(p);
              setStep("scan");
            }}
            onBack={() => setStep("scan")}
          />
        ) : picked.length === 0 ? (
          <>
            <div className="scan-panel-title">{box ? `Scan what goes into ${box.name}` : "Scan a sticker to see what to do next"}</div>
            <div className="scan-panel-sub">Scan a box poster first and everything after it goes into that box.</div>
            <HandEntry onPayload={(p) => void handlePayload(p)} onPick={() => setStep("hand")} />
          </>
        ) : (
          <>
            {picked.length === 1 ? (
              <>
                <div className="scan-panel-title">{title(picked[0])}</div>
                <div className="scan-panel-sub">
                  {partLabel(picked[0]) ?? "no part number on label"} · {where(picked[0])} · {picked[0].short_code ?? picked[0].serial}
                </div>
              </>
            ) : (
              <>
                <div className="scan-panel-title">{picked.length} packages selected</div>
                <div className="scan-picked">
                  {picked.map((p) => (
                    <span key={p.id} className="chip">
                      {p.short_code ?? p.serial}
                      <button type="button" aria-label={`Remove ${p.short_code ?? p.serial}`} onClick={() => setPickedIds((ids) => ids.filter((x) => x !== p.id))}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </>
            )}
            <div className="scan-verbs">
              {verbs.map((v, i) => (
                <button key={v.id} type="button" className={`scan-verb ${i === 0 ? "scan-verb--primary" : ""}`} disabled={busy} onClick={() => void run(v)}>
                  <span>{v.label}</span>
                  {v.hint ? <small>{v.hint}</small> : null}
                </button>
              ))}
              {verbs.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  These are in different states — scan them in smaller groups.
                </p>
              ) : null}
            </div>
            <div className="scan-panel-sub" style={{ marginTop: 10 }}>
              Keep scanning to select several. <button type="button" className="link" onClick={() => setPickedIds([])}>Clear</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** No sticker? Type the code off the label. */
function HandEntry({ onPayload, onPick }: { onPayload: (p: QrPayload) => void; onPick: () => void }) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const submit = () => {
    const payload = parseQr(text.trim());
    if (payload) {
      setBad(false);
      setText("");
      onPayload(payload);
    } else setBad(true);
  };
  return (
    <div className="scan-hand">
      <div className="field-label">No sticker? Type or pick</div>
      <div className="row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Code on the label, e.g. AB7QLM or PKG-000214"
          aria-label="Code"
          autoCapitalize="characters"
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button type="button" className="button-like" onClick={submit}>
          Go
        </button>
      </div>
      {bad ? <p className="scan-msg">Not a code we know. Six letters and digits, or PKG- / CTR- and a number.</p> : null}
      <button type="button" className="button-like" onClick={onPick}>
        Pick it by job and window…
      </button>
    </div>
  );
}

/** Job → window → piece. The maker's "#16 2/3" is a unique ID on a job. */
function HandPick({
  all,
  projects,
  onPick,
  onBack,
}: {
  all: StoragePackage[];
  projects: { id: string; job_code: string; name: string }[];
  onPick: (p: StoragePackage) => void;
  onBack: () => void;
}) {
  const [job, setJob] = useState("");
  const [mark, setMark] = useState("");
  const marks = useMemo(() => {
    const s = new Set<string>();
    for (const p of all) if (p.project_id === job) for (const m of p.package_marks ?? []) s.add(m.mark_code);
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [all, job]);
  const pieces = useMemo(
    () =>
      all
        .filter((p) => p.project_id === job && (p.package_marks ?? []).some((m) => m.mark_code === mark))
        .sort((a, b) => (a.part_index ?? 99) - (b.part_index ?? 99)),
    [all, job, mark],
  );
  return (
    <div className="scan-hand">
      <div className="field-label">Pick the piece</div>
      <select value={job} onChange={(e) => { setJob(e.target.value); setMark(""); }} aria-label="Job">
        <option value="">Job…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>
      {job ? (
        <select value={mark} onChange={(e) => setMark(e.target.value)} aria-label="Window">
          <option value="">Window…</option>
          {marks.map((m) => (
            <option key={m} value={m}>
              Window {m}
            </option>
          ))}
        </select>
      ) : null}
      {mark ? (
        <div className="pieces">
          {pieces.map((p) => (
            <button key={p.id} type="button" onClick={() => onPick(p)}>
              {p.part_index ?? "?"} of {p.part_total ?? "?"}
              {p.part_type ? ` · ${p.part_type}` : ""} · {p.short_code ?? p.serial}
            </button>
          ))}
          {pieces.length === 0 ? <p className="muted">No pieces tagged to window {mark} yet.</p> : null}
        </div>
      ) : null}
      <button type="button" className="button-like" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
