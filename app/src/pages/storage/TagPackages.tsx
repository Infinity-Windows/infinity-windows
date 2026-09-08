// Tag at the truck: stick a blank license-plate sticker on a package, tap
// it here (or scan it), and bind it — job (defaults to the last one used,
// so ten BLACK22 crates in a row are one tap each), category chip, optional
// marks off the job schedule, optional note. Binding is one-time forever.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects } from "../../lib/api";
import { listMarkSpecs } from "../../lib/install/api";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { BackChip } from "../../components/BackChip";
import { StationChip } from "../../components/warehouse/StationChip";
import { Scanner } from "../../components/Scanner";
import type { QrPayload } from "../../lib/qr";
import { subscribeSynced } from "../../lib/offline/outbox";
import {
  bindPackageOffline,
  receiveMintedOffline,
  writeToast,
} from "../../lib/warehouse/offlineWrites";
import { Explain } from "../../components/ui/Explain";
import { addProjectMark, listScheduledMarks } from "../../lib/warehouse/warehouseCards";
import { useScanWedge } from "../../lib/warehouse/scanWedge";
import { STATION_OFF_TRUCK } from "../../lib/warehouse/stations";
import {
  categoryLabel,
  CATEGORY_LABELS,
  defaultDeliveryLabel,
  ensureDelivery,
  listActivePackages,
  listBlankPackages,
  partTypeLabel,
  PART_TYPES,
  type PackageCategory,
  type PartType,
  type StoragePackage,
  setMarkPartTotal,
} from "../../lib/storage";
import {
  buildLines,
  existingParts,
  lineLabel,
  type TagLine,
} from "../../lib/warehouse/tagBatch";
import { useT, type TFn } from "../../lib/i18n";

const LAST_JOB_KEY = "infinity.storage.lastJob";
/** The job dropdown's value for company stock. Not a uuid on purpose. */
const BONEYARD = "__boneyard__";

/**
 * Stickers this phone has already spent, so the roll stops offering them.
 *
 * The roll is drawn from the server's list of blank stickers, and a tag made
 * with no signal never reaches the server — so the sticker somebody just stuck
 * on a crate kept sitting in the roll, and the screen went on calling it free
 * for the rest of the session. Two ways that ends badly, and the second is the
 * one that cannot be undone: the screen contradicts its own toast, and the
 * same sticker gets tagged twice to two different packages. Which tap wins is
 * then decided by the order the queue drains. Binding is permanent —
 * CONTEXT.md: a sticker belongs to one package for that package's whole life,
 * and "a reused sticker would make every earlier record point at the wrong
 * physical thing".
 *
 * WHY A KEY ON THIS PHONE, and not the outbox itself. The outbox is the truth
 * about what is still waiting, but nothing it exports today can be asked
 * "which packages have a tag in the queue" — a screen gets counts by category
 * (getCounts), a change notification (subscribe), a sent notification
 * (subscribeSynced), and the dead letters (listFailed). Counts cannot name a
 * sticker: they lump all six warehouse ops into one number. The clean version
 * of this is a pending-entries-by-op reader on lib/offline/outbox.ts; until
 * that exists the page has to keep its own note, and localStorage is what
 * survives the trip this note has to survive: a remount, a tab switch, and the
 * app being closed and reopened standing inside a conex.
 *
 * The two records can only disagree once the write leaves the queue, and both
 * ways are safe:
 *   - it went up — the server stops calling that sticker blank, so the next
 *     good read of the roll drops it from this note too (the prune below).
 *   - it died in the dead letter — the sticker stays off the roll, which is
 *     right: a human is looking at it on Stuck writes, and a retry from there
 *     still binds it. Hiding one printed sticker costs a reprint. Offering a
 *     spent one costs a trail that lies.
 */
const SPENT_STICKERS_KEY = "infinity.storage.spentStickers";

interface SpentSticker {
  /** The package it was bound to — what the roll is matched against. */
  id: string;
  /** Read off the sticker before the write, so a queued tag can still name it. */
  serial: string;
  /** What the pill prints: the short code when the sticker carries one. */
  code: string;
  /** True while the tag is still sitting on this phone, unsent. */
  queued: boolean;
}

function isSpentSticker(v: unknown): v is SpentSticker {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.serial === "string" &&
    typeof o.code === "string" &&
    typeof o.queued === "boolean"
  );
}

function readSpent(): SpentSticker[] {
  try {
    const raw = localStorage.getItem(SPENT_STICKERS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isSpentSticker) : [];
  } catch {
    return [];
  }
}

/** Save the note and hand it back, so callers can set state from one call. */
function writeSpent(list: SpentSticker[]): SpentSticker[] {
  try {
    localStorage.setItem(SPENT_STICKERS_KEY, JSON.stringify(list));
  } catch {
    // A full disk is not a reason to start offering a spent sticker again:
    // the list still holds for this run, it just won't survive a reload.
  }
  return list;
}

/** The line above the spent pills. Says where the write got to, nothing more. */
function waitingLine(n: number, t: TFn): string {
  return t(n === 1 ? "storage.tag.waitingLine.one" : "storage.tag.waitingLine.many", { n });
}

export function TagPackages() {
  const t = useT();
  // Pick 30: a desk-mounted hardware scanner routes straight to the package
  // or container it reads, same as the camera flow — a second input path
  // alongside the camera Scanner already on this page, not a replacement.
  useScanWedge();
  const qc = useQueryClient();
  const blanks = useQuery({ queryKey: ["storageBlanks"], queryFn: listBlankPackages });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  // Pre-labeled packages (ticket 15): minted at planning, confirmed here at
  // the truck. Same query the warehouse page uses, so it is usually a cache hit.
  const actives = useQuery({ queryKey: ["storagePackages"], queryFn: listActivePackages });
  const [arriving, setArriving] = useState<Set<string>>(new Set());
  const receive = useMutation({
    mutationFn: () => receiveMintedOffline([...arriving]),
    onSuccess: (r) => {
      pushToast(
        writeToast(r, t(r.count === 1 ? "storage.tag.received.one" : "storage.tag.received.many", { n: r.count })),
      );
      setArriving(new Set());
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const [scanning, setScanning] = useState(false);
  const [projectId, setProjectId] = useState<string>(
    () => localStorage.getItem(LAST_JOB_KEY) ?? "",
  );
  const [category, setCategory] = useState<PackageCategory | null>("windows");
  // The worksheet (owner spec, 2026-08-18): declare the window once and tag
  // its pieces as one batch. Everything shared lives up here — the job, the
  // category, the window number, how many pieces — and everything per-piece
  // lives on its line. The count is a string so the field can be emptied
  // while retyping without the worksheet collapsing.
  const [countText, setCountText] = useState("1");
  const [markCode, setMarkCode] = useState("");
  const [lines, setLines] = useState<TagLine[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [tagged, setTagged] = useState(0);
  // Seeded from the phone, so a remount or a cold start in a conex still knows
  // which stickers this phone has already spent.
  const [spent, setSpent] = useState<SpentSticker[]>(readSpent);

  // One delivery group per truck: created lazily, reused after.
  useEffect(() => {
    void (async () => {
      try {
        const d = await ensureDelivery(defaultDeliveryLabel(new Date()));
        setDeliveryId(d.id);
      } catch {
        /* delivery grouping is a nice-to-have — binding works without it */
      }
    })();
  }, []);

  // Job list defaults to the remembered one; validate it still exists.
  useEffect(() => {
    if (!projects.data) return;
    if (
      projectId &&
      projectId !== BONEYARD &&
      !projects.data.some((p) => p.id === projectId)
    ) {
      setProjectId("");
    }
  }, [projects.data, projectId]);

  // Drop a sticker from the note the moment the server stops calling it blank
  // — that is the server saying the tag landed, and the roll can carry it from
  // there. Only a read that actually came back counts: with no signal the
  // query keeps its last data (or none), so nothing is pruned on a failed
  // read and no spent sticker comes back to the roll.
  const blankRows = blanks.data;
  useEffect(() => {
    if (!blankRows || spent.length === 0) return;
    const stillBlank = new Set(blankRows.map((b) => b.id));
    const kept = spent.filter((s) => stillBlank.has(s.id));
    if (kept.length !== spent.length) setSpent(writeSpent(kept));
  }, [blankRows, spent]);

  // The prune above only runs on a read that came back, and standing on this
  // screen nothing asks for one. So when the drainer says it sent something,
  // read the blank list again — without this the "not sent yet" line below
  // outlives the write it describes. Same wiring the clock uses.
  useEffect(
    () =>
      subscribeSynced(() => {
        void qc.invalidateQueries({ queryKey: ["storageBlanks"] });
      }),
    [qc],
  );

  const spentIds = useMemo(() => new Set(spent.map((s) => s.id)), [spent]);
  /** The free roll: what the server calls blank, minus what this phone spent. */
  const roll = useMemo(
    () => (blankRows ?? []).filter((b) => !spentIds.has(b.id)),
    [blankRows, spentIds],
  );
  const waiting = useMemo(() => spent.filter((s) => s.queued), [spent]);

  const specs = useQuery({
    queryKey: ["markSpecs", projectId],
    queryFn: () => listMarkSpecs(projectId),
    // The Boneyard is not a job; asking the spec table about it is noise.
    enabled: Boolean(projectId) && projectId !== BONEYARD,
  });
  // The REAL schedule — project_marks, the list the server checks tags
  // against. Specs are a subset (a hand-added window has no spec yet), so the
  // suggestions and the not-on-schedule check both read from here.
  const scheduled = useQuery({
    queryKey: ["scheduledMarks", [projectId]],
    queryFn: () => listScheduledMarks([projectId]),
    enabled: Boolean(projectId) && projectId !== BONEYARD,
  });
  const markOptions = useMemo(() => {
    const fromSchedule = (scheduled.data ?? []).map((m) => m.mark_code);
    const fromSpecs = (specs.data ?? []).map((s) => s.mark_code);
    return [...new Set([...fromSchedule, ...fromSpecs])].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
  }, [scheduled.data, specs.data]);

  // The wall gets a door (owner report, 2026-08-18): a typed window that is
  // not on the schedule used to bounce off the server with nothing saying how
  // to fix it — ZZTEST had zero marks, so EVERY tag there was refused.
  const markTyped = markCode.trim().toUpperCase();
  const markUnscheduled =
    Boolean(projectId) &&
    projectId !== BONEYARD &&
    markTyped !== "" &&
    scheduled.isSuccess &&
    !(scheduled.data ?? []).some((m) => m.mark_code === markTyped);
  const addMark = useMutation({
    mutationFn: () => addProjectMark(projectId, markTyped),
    onSuccess: () => {
      pushToast(t("storage.tag.addedToSchedule", { mark: markTyped }));
      void qc.invalidateQueries({ queryKey: ["scheduledMarks"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const boneyard = projectId === BONEYARD;
  const count = Math.min(20, Math.max(1, parseInt(countText, 10) || 1));

  // The late package (the missed fourth box, the add-on ordered later): when
  // the typed window already has parts, these lines CONTINUE its numbering and
  // every older label's "of N" grows to match on submit.
  const growth = useMemo(
    () =>
      boneyard || !markCode.trim() || !projectId
        ? null
        : existingParts(actives.data ?? [], projectId, markCode, lines.length),
    [actives.data, projectId, markCode, boneyard, lines.length],
  );

  // Rebuild the worksheet when the count or the continuation point changes.
  // Stickers auto-assign from the roll — the codes are random, nobody picks
  // (owner) — and piece types already chosen survive a rebuild by position.
  const startIndex = (growth?.maxIndex ?? 0) + 1;
  useEffect(() => {
    setLines((prev) => {
      const fresh = buildLines(count, roll, startIndex);
      return fresh.map((l, i) => ({
        ...l,
        partType: prev[i]?.partType ?? null,
        mfrMark: prev[i]?.mfrMark ?? "",
        // A sticker somebody swapped by hand survives too, as long as it is
        // still free.
        sticker:
          prev[i]?.sticker && !spentIds.has(prev[i].sticker.id)
            ? prev[i].sticker
            : l.sticker,
      }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, startIndex, blankRows, spentIds]);

  const selected = lines.find((l) => l.key === selectedKey) ?? null;
  const partTotal = growth ? growth.newTotal : Math.max(count, lines.length);

  const patchLine = (key: string, patch: Partial<TagLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const removeLine = (key: string) => {
    // Removing box 2 keeps boxes 1 and 3 wearing their printed numbers — the
    // worksheet matches paper, it never renumbers it.
    setLines((prev) => prev.filter((l) => l.key !== key));
    if (selectedKey === key) setSelectedKey(null);
  };

  const linesReady = lines.filter((l) => l.sticker != null);
  const canSubmit =
    Boolean(projectId) &&
    linesReady.length > 0 &&
    (boneyard || markCode.trim() !== "") &&
    linesReady.length === lines.length;

  const submit = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error(t("storage.tag.pickJobFirst"));
      const mark = markCode.trim().toUpperCase();

      // Growing the count is one deliberate act, done BEFORE any bind so the
      // new labels and the old ones never disagree. Online-only (a foreman
      // decision, like minting) — if it fails, nothing has been tagged yet.
      if (growth && growth.oldTotal !== growth.newTotal) {
        await setMarkPartTotal({ projectId, markCode: mark, total: growth.newTotal });
      }

      // One bind per line, sequential, each offline-capable on its own — the
      // same per-package write everything else already trusts.
      const done: { line: TagLine; serial: string; queued: boolean }[] = [];
      for (const line of lines) {
        if (!line.sticker) continue;
        const sticker = line.sticker;
        const r = await bindPackageOffline({
          packageId: sticker.id,
          projectId: boneyard ? null : projectId,
          boneyard,
          category,
          note: note || null,
          marks: boneyard || !mark ? [] : [mark],
          deliveryId,
          partIndex: line.partIndex,
          partTotal,
          partType: (line.partType as PartType | null) ?? null,
          mfrMark: line.mfrMark.trim() || null,
        });
        done.push({
          line,
          serial: r.package?.serial ?? sticker.serial,
          queued: r.queued,
        });
        // Spoken for either way — written down before any invalidate, because
        // offline that invalidate cannot refetch and re-serves the same roll.
        setSpent((prev) =>
          prev.some((s) => s.id === sticker.id)
            ? prev
            : writeSpent([
                ...prev,
                {
                  id: sticker.id,
                  serial: r.package?.serial ?? sticker.serial,
                  code: sticker.short_code ?? sticker.serial,
                  queued: r.queued,
                },
              ]),
        );
      }
      return done;
    },
    onSuccess: (done) => {
      // Pick 25 looked for an undo toast here (tagging a blank is exactly
      // the kind of tap it targets) and stopped: bind_package has no
      // inverse RPC, and this wave adds no migrations. Skipped on purpose —
      // see the pick 25 PR body.
      localStorage.setItem(LAST_JOB_KEY, projectId);
      const queued = done.filter((d) => d.queued).length;
      const mark = markCode.trim();
      const forMark = mark ? t("storage.tag.forMark", { mark }) : "";
      pushToast(
        queued > 0
          ? t(done.length === 1 ? "storage.tag.tagged.queuedOne" : "storage.tag.tagged.queuedMany", {
              n: done.length,
              forMark,
              queued,
            })
          : t(done.length === 1 ? "storage.tag.tagged.sentOne" : "storage.tag.tagged.sentMany", {
              n: done.length,
              forMark,
            }),
      );
      setTagged((n) => n + done.length);
      // The next window: category and the count usually repeat down a truck;
      // the window number and the piece picks never do.
      setMarkCode("");
      setLines([]);
      setSelectedKey(null);
      setNote("");
      void qc.invalidateQueries({ queryKey: ["storageBlanks"] });
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const onScan = (payload: QrPayload) => {
    if (payload.kind !== "packageSerial") {
      pushToast(t("storage.tag.notAPackageSticker"), "error");
      return;
    }
    // The scanner is a door onto the roll, so it gets the same answers.
    const held = spent.find((s) => s.serial === payload.serial);
    if (held) {
      pushToast(
        held.queued
          ? t("storage.tag.alreadyAssignedQueued", { serial: payload.serial })
          : t("storage.tag.alreadyAssigned", { serial: payload.serial }),
        "error",
      );
      return;
    }
    const hit = roll.find((b) => b.serial === payload.serial);
    if (!hit) {
      pushToast(t("storage.tag.assignedOrUnknown", { serial: payload.serial }), "error");
      return;
    }
    // Physical reality wins: the sticker in hand lands on the GLOWING line
    // (or the first line when none is picked), replacing its auto-assigned
    // code. Peel any sticker, scan it, stick it on that box.
    const target = selected ?? lines[0];
    if (!target) {
      pushToast(t("storage.tag.setHowManyFirst"), "error");
      return;
    }
    if (lines.some((l) => l.sticker?.id === hit.id && l.key !== target.key)) {
      pushToast(t("storage.tag.alreadyOnAnotherLine", { serial: payload.serial }), "error");
      return;
    }
    patchLine(target.key, { sticker: hit });
    setScanning(false);
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">{t("storage.tag.storage")}</p>
          <h1>{t("storage.tag.title")}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {defaultDeliveryLabel(new Date())}
            {tagged > 0 ? ` · ${t("storage.tag.taggedThisSession", { n: tagged })}` : ""}
          </p>
        </div>
      </header>
      <StationChip station={STATION_OFF_TRUCK} />

      {(() => {
        const expected = (actives.data ?? []).filter(
          (p) => p.status === "minted" && (!projectId || boneyard || p.project_id === projectId),
        );
        if (expected.length === 0) return null;
        const label = (p: StoragePackage) => {
          const mark = (p.package_marks ?? [])[0]?.mark_code ?? "?";
          const part =
            p.part_index != null && p.part_total != null
              ? ` · ${t("storage.tag.ofTotal", { index: p.part_index, total: p.part_total })}`
              : "";
          return `W${mark}${part}`;
        };
        return (
          <>
            <h2>{t("storage.tag.preLabeled")}</h2>
            <Explain id="wh-receive-minted">{t("storage.tag.preLabeledExplain")}</Explain>
            <div className="row-gap">
              {expected.slice(0, 30).map((p) => {
                const on = arriving.has(p.id);
                return (
                  <button
                    key={p.id}
                    className={on ? "button-like active-pill" : "button-like"}
                    onClick={() => {
                      const next = new Set(arriving);
                      if (on) next.delete(p.id);
                      else next.add(p.id);
                      setArriving(next);
                    }}
                  >
                    {label(p)}
                  </button>
                );
              })}
            </div>
            {arriving.size > 0 && (
              <button
                className="button-like active-pill"
                style={{ marginTop: 8 }}
                disabled={receive.isPending}
                onClick={() => receive.mutate()}
              >
                {receive.isPending
                  ? t("storage.tag.receiving")
                  : t("storage.tag.arrivedReceive", { n: arriving.size })}
              </button>
            )}
          </>
        );
      })()}

      <h2>{t("storage.tag.step1")}</h2>
      <label className="field-label">{t("storage.tag.job")}</label>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">{t("storage.tag.pickJob")}</option>
        {/* The crew's word, kept on purpose (ticket 17). Company stock gets
            tagged like anything else — it just belongs to nobody yet. */}
        <option value={BONEYARD}>{t("storage.tag.boneyardOption")}</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>
      <label className="field-label">{t("storage.tag.category")}</label>
      <div className="row-gap">
        {(Object.keys(CATEGORY_LABELS) as PackageCategory[]).map((c) => (
          <button
            key={c}
            className={category === c ? "button-like active-pill" : "button-like"}
            onClick={() => setCategory(c)}
          >
            {categoryLabel(c, t)}
          </button>
        ))}
      </div>
      {!boneyard && (
        <>
          <label className="field-label">{t("storage.tag.windowNumber")}</label>
          <input
            placeholder={t("storage.tag.windowNumberPlaceholder")}
            value={markCode}
            onChange={(e) => setMarkCode(e.target.value)}
            list="tag-mark-options"
            style={{ width: 120 }}
            aria-label={t("storage.tag.windowNumberAria")}
          />
          <datalist id="tag-mark-options">
            {markOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {markUnscheduled && (
            <p className="wh-pending" style={{ marginTop: 4 }}>
              {t("storage.tag.notOnSchedule", { mark: markTyped })}{" "}
              {/* The handle, not a note about who holds it (ADR-0007): the
                  person at the truck with a package in their hand is the one
                  who found the window the plans missed. */}
              <button
                className="link"
                style={{ font: "inherit" }}
                disabled={addMark.isPending}
                onClick={() => addMark.mutate()}
              >
                {addMark.isPending ? t("storage.tag.addingMark") : t("storage.tag.addMarkToSchedule", { mark: markTyped })}
              </button>
            </p>
          )}
        </>
      )}
      <div className="wh-row" style={{ marginTop: 6 }}>
        <label className="field-label" style={{ margin: 0 }}>
          {t("storage.tag.howManyPieces")}
        </label>
        <input
          type="number"
          min={1}
          max={20}
          inputMode="numeric"
          value={countText}
          onChange={(e) => setCountText(e.target.value)}
          style={{ width: 70, marginBottom: 0 }}
          aria-label={t("storage.tag.howManyPiecesAria")}
        />
      </div>
      {growth && (
        <p className="wh-pending" style={{ marginTop: 6 }}>
          {t(growth.have === 1 ? "storage.tag.growth.one" : "storage.tag.growth.many", {
            mark: markCode.trim().toUpperCase(),
            have: growth.have,
            ofOld: growth.oldTotal != null ? t("storage.tag.growth.ofOld", { total: growth.oldTotal }) : "",
            lines: lines.length,
            start: startIndex,
            newTotal: growth.newTotal,
          })}
        </p>
      )}

      <h2>{t("storage.tag.step2")}</h2>
      <Explain id="wh-tag-worksheet">{t("storage.tag.worksheetExplain")}</Explain>
      <div data-worksheet style={{ display: "grid", gap: 6 }}>
        {lines.map((line) => {
          const on = selectedKey === line.key;
          return (
            <button
              key={line.key}
              data-line={line.partIndex}
              onClick={() => setSelectedKey(on ? null : line.key)}
              className="project-card home-project"
              style={{
                textAlign: "left",
                cursor: "pointer",
                border: on
                  ? "2px solid var(--accent-line)"
                  : "2px solid transparent",
                boxShadow: on ? "0 0 8px var(--accent-soft)" : undefined,
              }}
            >
              <div className="row-between" style={{ gap: 8 }}>
                <div className="wh-row-main">
                  <strong>{lineLabel(boneyard ? "" : markCode, line.partIndex, partTotal)}</strong>
                  <span className="wh-row-sub">
                    {" "}· {line.partType ? partTypeLabel(line.partType as PartType, t) : t("storage.tag.whichPiece")}
                  </span>
                </div>
                <div className="wh-row">
                  <span className="muted" style={{ fontFamily: "monospace", fontSize: 12.5 }}>
                    {line.sticker
                      ? (line.sticker.short_code ?? line.sticker.serial)
                      : t("storage.tag.rollDry")}
                  </span>
                  {lines.length > 1 && (
                    <span
                      role="button"
                      aria-label={t("storage.tag.removeLine", { n: line.partIndex })}
                      className="muted"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeLine(line.key);
                      }}
                      style={{ padding: "0 4px" }}
                    >
                      ×
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {selected && (
        <div style={{ marginTop: 8 }}>
          <label className="field-label">
            {t("storage.tag.whichPieceIs", { line: lineLabel(boneyard ? "" : markCode, selected.partIndex, partTotal) })}
          </label>
          <div className="row-gap">
            {PART_TYPES.map((pt) => (
              <button
                key={pt}
                className={selected.partType === pt ? "button-like active-pill" : "button-like"}
                onClick={() =>
                  patchLine(selected.key, {
                    partType: selected.partType === pt ? null : pt,
                  })
                }
              >
                {partTypeLabel(pt, t)}
              </button>
            ))}
          </div>
          <label className="field-label">{t("storage.tag.theirNumber")}</label>
          <input
            placeholder={t("storage.tag.theirNumberPlaceholder")}
            value={selected.mfrMark}
            onChange={(e) => patchLine(selected.key, { mfrMark: e.target.value })}
            style={{ width: 160 }}
          />
        </div>
      )}

      <div className="wh-row" style={{ marginTop: 8 }}>
        <button className="button-like" onClick={() => setScanning((v) => !v)}>
          {scanning ? t("storage.tag.stopScanning") : t("storage.tag.scanOntoGlowing")}
        </button>
      </div>
      {scanning && <Scanner onScan={onScan} />}

      {waiting.length > 0 && (
        <div data-roll="waiting">
          <p className="wh-pending">{waitingLine(waiting.length, t)}</p>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
            {t("storage.tag.offRollForGood")}
          </p>
          <div className="row-gap" style={{ marginTop: 6 }}>
            {waiting.slice(0, 12).map((s) => (
              <button
                key={s.id}
                className="button-like"
                disabled
                title={t("storage.tag.assignedNotSent")}
              >
                {s.code}
              </button>
            ))}
            {waiting.length > 12 && (
              <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
                {t("storage.tag.andNMore", { n: waiting.length - 12 })}
              </span>
            )}
          </div>
        </div>
      )}
      {roll.length === 0 && (
        <p className="muted" style={{ marginTop: 6 }}>
          {t("storage.tag.noBlankStickers")}
        </p>
      )}

      <h2>{t("storage.tag.step3")}</h2>
      <label className="field-label">{t("storage.tag.noteOptional")}</label>
      <input
        placeholder={t("storage.tag.notePlaceholder")}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div style={{ marginTop: 12 }}>
        <button
          className="button-like active-pill"
          disabled={!canSubmit || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending
            ? t("storage.tag.tagging")
            : !projectId
              ? t("storage.tag.pickJobFirst")
              : !boneyard && markCode.trim() === ""
                ? t("storage.tag.typeWindowFirst")
                : linesReady.length !== lines.length
                  ? t("storage.tag.lineNoSticker")
                  : t(lines.length === 1 ? "storage.tag.submit.one" : "storage.tag.submit.many", { n: lines.length })}
        </button>
      </div>
    </div>
  );
}
