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
import { Scanner } from "../../components/Scanner";
import type { QrPayload } from "../../lib/qr";
import { subscribeSynced } from "../../lib/offline/outbox";
import {
  bindPackageOffline,
  receiveMintedOffline,
  tagToast,
  writeToast,
} from "../../lib/warehouse/offlineWrites";
import { Explain } from "../../components/ui/Explain";
import {
  CATEGORY_LABELS,
  defaultDeliveryLabel,
  ensureDelivery,
  listActivePackages,
  listBlankPackages,
  PART_LABELS,
  PART_TYPES,
  type PackageCategory,
  type PartType,
  type StoragePackage,
} from "../../lib/storage";

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
function waitingLine(n: number): string {
  return n === 1
    ? "1 sticker is assigned and saved on this phone, not sent yet. It goes up on its own when you have signal."
    : `${n} stickers are assigned and saved on this phone, not sent yet. They go up on their own when you have signal.`;
}

export function TagPackages() {
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
        writeToast(
          r,
          `${r.count} package${r.count === 1 ? "" : "s"} received.`,
        ),
      );
      setArriving(new Set());
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });
  const [selected, setSelected] = useState<StoragePackage | null>(null);
  const [scanning, setScanning] = useState(false);
  const [projectId, setProjectId] = useState<string>(
    () => localStorage.getItem(LAST_JOB_KEY) ?? "",
  );
  const [category, setCategory] = useState<PackageCategory | null>("windows");
  const [marks, setMarks] = useState<Set<string>>(new Set());
  // The label's "#16 2/3": which piece, and N of M. Type and total stay put
  // between binds — a truck usually unloads a run of same-kind packages —
  // while the piece number and the manufacturer's mark reset every sticker.
  const [partType, setPartType] = useState<PartType | null>(null);
  const [partIndex, setPartIndex] = useState("");
  const [partTotal, setPartTotal] = useState("");
  const [mfrMark, setMfrMark] = useState("");
  const [note, setNote] = useState("");
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [tagged, setTagged] = useState(0);
  // Seeded from the phone, so a remount or a cold start in a conex still knows
  // which stickers this phone has already spent.
  const [spent, setSpent] = useState<SpentSticker[]>(readSpent);

  // One delivery group per truck: created lazily on first bind, reused after.
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
    if (projectId && !projects.data.some((p) => p.id === projectId)) {
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
  // screen nothing asks for one: the roll is 30s-stale at worst and refetches
  // on focus, and somebody watching the queue empty never blurs the tab. So
  // when the drainer says it sent something, read the blank list again. Without
  // this the "not sent yet" line below outlives the write it describes — the
  // screen lying the other way round. Same wiring the clock and the photo feed
  // use for the same reason (lib/clockContext.tsx, components/photos).
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
  const markOptions = useMemo(
    () => (specs.data ?? []).map((s) => s.mark_code),
    [specs.data],
  );

  // "2 of 3" needs both halves and the first can't beat the second. Empty is
  // fine — plenty of labels carry no part number, and receiving never blocks.
  const idx = partIndex.trim() === "" ? null : parseInt(partIndex, 10);
  const tot = partTotal.trim() === "" ? null : parseInt(partTotal, 10);
  const partInvalid =
    (idx === null) !== (tot === null) ||
    (idx !== null && (!Number.isFinite(idx) || idx < 1)) ||
    (tot !== null && (!Number.isFinite(tot) || tot < 1)) ||
    (idx !== null && tot !== null && idx > tot);

  const bind = useMutation({
    mutationFn: async () => {
      if (!selected || !projectId) throw new Error("Pick a sticker and a job");
      const boneyard = projectId === BONEYARD;
      // The sticker in hand is held BEFORE the write, because a queued tag
      // never gets a row back from the server to read its serial — or its
      // short code — off.
      const sticker = selected;
      const serial = sticker.serial;
      const r = await bindPackageOffline({
        packageId: selected.id,
        projectId: boneyard ? null : projectId,
        boneyard,
        category,
        note: note || null,
        // A window number is a position on one job's plans; the Boneyard has
        // none, and the mark list is hidden when it is picked.
        marks: boneyard ? [] : [...marks],
        deliveryId,
        partIndex: idx,
        partTotal: tot,
        partType,
        mfrMark: mfrMark.trim() || null,
      });
      return { sticker, serial: r.package?.serial ?? serial, queued: r.queued };
    },
    onSuccess: ({ sticker, serial, queued }) => {
      localStorage.setItem(LAST_JOB_KEY, projectId);
      pushToast(tagToast(serial, queued));
      // This sticker is spoken for either way. A tag that reached the server
      // is dropped again by the prune above on the next good read of the roll;
      // a queued one stays until its write goes up. Both are written down
      // before the invalidate below, because offline that invalidate cannot
      // refetch and re-serves the same list with this sticker still in it.
      setSpent((prev) =>
        prev.some((s) => s.id === sticker.id)
          ? prev
          : writeSpent([
              ...prev,
              {
                id: sticker.id,
                serial,
                code: sticker.short_code ?? sticker.serial,
                queued,
              },
            ]),
      );
      setSelected(null);
      setMarks(new Set());
      setNote("");
      // Piece number and their mark are per-package; type and total usually
      // repeat down the truck, so those stay for the next sticker.
      setPartIndex("");
      setMfrMark("");
      setTagged((n) => n + 1);
      void qc.invalidateQueries({ queryKey: ["storageBlanks"] });
      void qc.invalidateQueries({ queryKey: ["storagePackages"] });
    },
    onError: (e) => pushToast(formatApiError(e), "error"),
  });

  const onScan = (payload: QrPayload) => {
    if (payload.kind !== "packageSerial") {
      pushToast("That's not a package sticker.", "error");
      return;
    }
    // The scanner is the other door onto the roll, so it gets the same answer.
    // Named separately from "already assigned or unknown" because this one has
    // a reason worth hearing: nothing is wrong, the write is just still here.
    const held = spent.find((s) => s.serial === payload.serial);
    if (held) {
      pushToast(
        held.queued
          ? `${payload.serial} is already assigned — saved on this phone and not sent yet.`
          : `${payload.serial} is already assigned.`,
        "error",
      );
      return;
    }
    const hit = roll.find((b) => b.serial === payload.serial);
    if (!hit) {
      pushToast(`${payload.serial} is already assigned or unknown.`, "error");
      return;
    }
    setSelected(hit);
    setScanning(false);
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <BackChip />
          <p className="home-greeting">Storage</p>
          <h1>Tag packages</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {defaultDeliveryLabel(new Date())}
            {tagged > 0 ? ` · ${tagged} tagged this session` : ""}
          </p>
        </div>
      </header>

      {(() => {
        const expected = (actives.data ?? []).filter(
          (p) => p.status === "minted" && (!projectId || p.project_id === projectId),
        );
        if (expected.length === 0) return null;
        const label = (p: StoragePackage) => {
          const mark = (p.package_marks ?? [])[0]?.mark_code ?? "?";
          const part =
            p.part_index != null && p.part_total != null
              ? ` · ${p.part_index} of ${p.part_total}`
              : "";
          return `W${mark}${part}`;
        };
        return (
          <>
            <h2>Pre-labeled — off the truck</h2>
            <Explain id="wh-receive-minted">
              These labels were printed before the truck. Stick each one on its
              package, tap it here, and hit Arrived. If the maker&rsquo;s own
              label says a different count than the sticker (&ldquo;2 of
              3&rdquo; against our &ldquo;2 of 4&rdquo;), the maker wins —
              tell a foreman so the wrong stickers get burned and the count
              fixed. Nothing here blocks the truck.
            </Explain>
            <div className="row-gap" style={{ flexWrap: "wrap" }}>
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
                  ? "Receiving…"
                  : `Arrived — receive ${arriving.size}`}
              </button>
            )}
          </>
        );
      })()}

      <h2>1 · The sticker</h2>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        <button
          className="button-like"
          onClick={() => setScanning((v) => !v)}
        >
          {scanning ? "Stop scanning" : "Scan sticker"}
        </button>
        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
          or tap one from the roll:
        </span>
      </div>
      {scanning && <Scanner onScan={onScan} />}
      <div className="row-gap" data-roll="free" style={{ flexWrap: "wrap", marginTop: 6 }}>
        {roll.slice(0, 24).map((b) => (
          <button
            key={b.id}
            className={
              selected?.id === b.id ? "button-like active-pill" : "button-like"
            }
            onClick={() => setSelected(b)}
          >
            {b.short_code ?? b.serial}
          </button>
        ))}
        {roll.length === 0 && (
          <p className="muted">
            No blank stickers left — print a batch from the Storage page.
          </p>
        )}
      </div>

      {waiting.length > 0 && (
        <div data-roll="waiting">
          <p className="wh-pending">{waitingLine(waiting.length)}</p>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
            Off the roll for good — a sticker only ever belongs to one package.
          </p>
          <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 6 }}>
            {waiting.slice(0, 12).map((s) => (
              <button
                key={s.id}
                className="button-like"
                disabled
                title="Assigned — saved on this phone and not sent yet."
              >
                {s.code}
              </button>
            ))}
            {waiting.length > 12 && (
              <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
                and {waiting.length - 12} more
              </span>
            )}
          </div>
        </div>
      )}

      <h2>2 · What it is</h2>
      <label className="field-label">Job</label>
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">Pick the job…</option>
        {/* The crew's word, kept on purpose (ticket 17). Company stock gets
            tagged like anything else — it just belongs to nobody yet. */}
        <option value={BONEYARD}>Boneyard — company stock, no job yet</option>
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.job_code} — {p.name}
          </option>
        ))}
      </select>
      <label className="field-label">Category</label>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        {(Object.keys(CATEGORY_LABELS) as PackageCategory[]).map((c) => (
          <button
            key={c}
            className={category === c ? "button-like active-pill" : "button-like"}
            onClick={() => setCategory(c)}
          >
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      {projectId && projectId !== BONEYARD && markOptions.length > 0 && (
        <>
          <label className="field-label">
            Marks inside (optional — makes “where is window 16?” answerable)
          </label>
          <div className="row-gap" style={{ flexWrap: "wrap" }}>
            {markOptions.map((m) => (
              <button
                key={m}
                className={marks.has(m) ? "button-like active-pill studio-mini" : "button-like studio-mini"}
                onClick={() =>
                  setMarks((prev) => {
                    const next = new Set(prev);
                    if (next.has(m)) next.delete(m);
                    else next.add(m);
                    return next;
                  })
                }
              >
                {m}
              </button>
            ))}
          </div>
        </>
      )}
      <label className="field-label">
        Which piece is it? (from the label, e.g. “#16 2/3”)
      </label>
      <div className="row-gap" style={{ flexWrap: "wrap" }}>
        {PART_TYPES.map((t) => (
          <button
            key={t}
            className={partType === t ? "button-like active-pill" : "button-like"}
            onClick={() => setPartType(partType === t ? null : t)}
          >
            {PART_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="row-gap" style={{ alignItems: "center", marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 13 }}>Part</span>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          placeholder="2"
          value={partIndex}
          onChange={(e) => setPartIndex(e.target.value)}
          style={{ width: 64, marginBottom: 0 }}
        />
        <span className="muted" style={{ fontSize: 13 }}>of</span>
        <input
          type="number"
          min={1}
          inputMode="numeric"
          placeholder="3"
          value={partTotal}
          onChange={(e) => setPartTotal(e.target.value)}
          style={{ width: 64, marginBottom: 0 }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          — leave empty if the label has none
        </span>
      </div>
      {partInvalid && (
        <p className="error" style={{ fontSize: 12, margin: "4px 0 0" }}>
          A part number needs both halves, and “2 of 3” can’t be “4 of 3”.
        </p>
      )}
      <label className="field-label">
        Their mark # (only if it differs from ours)
      </label>
      <input
        placeholder="e.g. A-2216"
        value={mfrMark}
        onChange={(e) => setMfrMark(e.target.value)}
      />
      <label className="field-label">Note (optional)</label>
      <input
        placeholder="e.g. glass crate, fragile"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      <div style={{ marginTop: 12 }}>
        <button
          className="button-like active-pill"
          disabled={!selected || !projectId || partInvalid || bind.isPending}
          onClick={() => bind.mutate()}
        >
          {bind.isPending
            ? "Assigning…"
            : selected
              ? `Assign ${selected.short_code ?? selected.serial} & next`
              : "Pick a sticker first"}
        </button>
      </div>
    </div>
  );
}
