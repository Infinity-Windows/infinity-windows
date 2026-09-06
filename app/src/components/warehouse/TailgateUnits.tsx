// The tailgate, unit first (warehouse redesign wave 4). One row per window or
// door: tap it and every expected piece arrives; the dots say which pieces
// are here. One sticky button puts everything that arrived into the box you
// used last — or tap a different box. Every write goes through the offline
// wrappers, because the yard is the dead zone, and the arrive/store that
// reached the server gets the app's Undo toast.
//
// The slot-level controls below it (counts, what-is-it, file onto job, crate
// pieces, rewrite a set) stay for the cases a tick cannot express.
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../../lib/errors";
import { pushToast } from "../../lib/toast";
import { showUndoToast } from "../../lib/undoToast";
import { playErrorTone, playSuccessTone } from "../../lib/sound";
import type { StorageContainer } from "../../lib/storage";
import { unreceivePackages, unstorePackages } from "../../lib/storage";
import type { JobGroup } from "../../lib/warehouse/deliveryReceiving";
import { receiveMintedOffline, storePackagesOffline, writeToast } from "../../lib/warehouse/offlineWrites";
import { looseOnTruck, tailgateUnits, tickOf, truckHeadline, type UnitRow } from "../../lib/warehouse/tailgateUnits";

const LAST_BOX_KEY = "forge.tailgate.lastBox";

function readLastBox(): string | null {
  try {
    return localStorage.getItem(LAST_BOX_KEY);
  } catch {
    return null;
  }
}
function rememberBox(id: string): void {
  try {
    localStorage.setItem(LAST_BOX_KEY, id);
  } catch {
    /* a phone that blocks storage still works, it just asks again */
  }
}

export function TailgateUnits({
  groups,
  containers,
  jobTitle,
  onChanged,
}: {
  groups: JobGroup[];
  containers: StorageContainer[];
  jobTitle: (projectId: string) => string | null;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const rows = useMemo(() => tailgateUnits(groups, jobTitle), [groups, jobTitle]);
  const loose = looseOnTruck(rows);
  const boxes = containers.filter((c) => c.active !== false && (c.kind ?? "conex") !== "crate");
  const [boxId, setBoxId] = useState<string | null>(() => readLastBox());
  const [pickingBox, setPickingBox] = useState(false);
  const box = boxes.find((c) => c.id === boxId) ?? null;

  const feedback = (ok: boolean) => {
    if (ok) playSuccessTone();
    else playErrorTone();
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [40, 40, 40]);
  };
  const refresh = () => {
    onChanged();
    void qc.invalidateQueries({ queryKey: ["storagePackages"] });
  };

  const arrive = useMutation({
    mutationFn: async (row: UnitRow) => {
      const r = await receiveMintedOffline(row.expectedIds);
      return { row, r };
    },
    onSuccess: ({ row, r }) => {
      refresh();
      feedback(true);
      const done = `${row.title} — ${row.expectedIds.length === 1 ? "1 piece" : `${row.expectedIds.length} pieces`} arrived.`;
      if (r.queued) pushToast(writeToast(r, done));
      else
        showUndoToast({
          message: done,
          undo: async () => {
            await unreceivePackages(row.expectedIds);
            refresh();
          },
        });
    },
    onError: (e) => {
      feedback(false);
      pushToast(formatApiError(e), "error");
    },
  });

  const putAway = useMutation({
    mutationFn: async (into: StorageContainer) => {
      const ids = [...loose];
      const r = await storePackagesOffline(
        ids.map((id) => ({ id, status: "received", container_id: null })),
        into.id,
      );
      return { ids, into, r };
    },
    onSuccess: ({ ids, into, r }) => {
      rememberBox(into.id);
      setBoxId(into.id);
      setPickingBox(false);
      refresh();
      feedback(true);
      const done = `${ids.length === 1 ? "1 piece" : `${ids.length} pieces`} put in ${into.name}.`;
      if (r.queued) pushToast(writeToast(r, done));
      else
        showUndoToast({
          message: done,
          undo: async () => {
            await unstorePackages(ids);
            refresh();
          },
        });
    },
    onError: (e) => {
      feedback(false);
      pushToast(formatApiError(e), "error");
    },
  });

  if (rows.length === 0) return null;

  return (
    <section className="tailgate" aria-label="Units on this truck">
      <p className="tailgate-head">{truckHeadline(rows)}</p>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
        Tap a unit and all its pieces arrive. Dots: grey expected, green here, dark put away.
      </p>
      <ul className="tailgate-list">
        {rows.map((row) => {
          const tick = tickOf(row);
          const busy = arrive.isPending && arrive.variables?.key === row.key;
          return (
            <li key={row.key} className="tailgate-row">
              <button
                type="button"
                className={`tailgate-unit tailgate-unit--${tick}`}
                disabled={row.expectedIds.length === 0 || busy}
                onClick={() => arrive.mutate(row)}
                aria-label={
                  row.expectedIds.length === 0
                    ? `${row.title}, all here`
                    : `Arrive ${row.title}, ${row.expectedIds.length} expected`
                }
              >
                <span className={`tailgate-tick tailgate-tick--${tick}`} aria-hidden="true">
                  {tick === "all" ? "✓" : tick === "some" ? "½" : ""}
                </span>
                <span className="tailgate-text">
                  <b>
                    {row.title}
                    {row.twins > 1 ? ` ×${row.twins}` : ""}
                  </b>
                  <span>{row.sub}</span>
                </span>
                <span className="tailgate-dots" aria-hidden="true">
                  {row.pieces.slice(0, 12).map((p) => (
                    <i key={p.id} className={`tailgate-dot tailgate-dot--${p.state}`} />
                  ))}
                  {row.pieces.length > 12 ? <em>+{row.pieces.length - 12}</em> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {loose.length > 0 ? (
        <div className="tailgate-bar">
          {pickingBox || !box ? (
            <div className="tailgate-boxes">
              <span className="muted" style={{ fontSize: 12.5 }}>Which box do the {loose.length} go in?</span>
              <div className="scan-boxes">
                {boxes.map((c) => (
                  <button key={c.id} type="button" className="scan-box" disabled={putAway.isPending} onClick={() => putAway.mutate(c)}>
                    <b>{c.name}</b>
                    <span>{c.kind ?? "conex"}</span>
                  </button>
                ))}
                {boxes.length === 0 ? <p className="muted">No boxes yet — add one on the Warehouse page.</p> : null}
              </div>
              {box ? (
                <button type="button" className="link" onClick={() => setPickingBox(false)}>
                  Back
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <button type="button" className="tailgate-put" disabled={putAway.isPending} onClick={() => putAway.mutate(box)}>
                {putAway.isPending ? "Putting away…" : `Put ${loose.length} away → ${box.name}`}
              </button>
              <button type="button" className="link" onClick={() => setPickingBox(true)}>
                or tap a different box
              </button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
