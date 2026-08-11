import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Scanner } from "../components/Scanner";
import {
  findWindowByCode,
  findWindowBySerial,
  getLocationByAddress,
  getLocationBySerial,
  getUnitsAtLocation,
  getWindowByWindowId,
} from "../lib/api";
import { resolveLocationFromScan, resolveWindowFromScan } from "../lib/scanResolve";
import { formatApiError } from "../lib/errors";
import { supabase } from "../lib/supabase";
import type { Location, WindowUnit } from "../lib/types";

const windowLookups = { getWindowByWindowId, findWindowByCode, findWindowBySerial };
const locationLookups = { getLocationByAddress, getLocationBySerial };

export function CycleCount() {
  const [params] = useSearchParams();
  const [location, setLocation] = useState<Location | null>(null);
  const [scanned, setScanned] = useState<Set<string>>(new Set());
  const [unexpected, setUnexpected] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const initialAddress = params.get("address");

  useQuery({
    queryKey: ["countInit", initialAddress],
    queryFn: async () => {
      const loc = await getLocationByAddress(initialAddress!);
      if (loc) setLocation(loc);
      return loc;
    },
    enabled: Boolean(initialAddress) && !location,
  });

  const expected = useQuery({
    queryKey: ["countUnits", location?.id],
    queryFn: () => getUnitsAtLocation(location!.id),
    enabled: Boolean(location?.id),
  });

  const missing = useMemo(
    () =>
      (expected.data ?? []).filter((u) => !scanned.has(u.window_id)),
    [expected.data, scanned],
  );

  const save = useMutation({
    mutationFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      const discrepancies = [
        ...missing.map((u: WindowUnit) => ({
          window_id: u.window_id,
          issue: "missing",
        })),
        ...unexpected.map((id) => ({ window_id: id, issue: "unexpected" })),
      ];
      const { error } = await supabase.from("cycle_counts").insert({
        location_id: location!.id,
        started_by: userData.user?.email ?? null,
        completed_at: new Date().toISOString(),
        expected: expected.data?.length ?? 0,
        found: scanned.size,
        discrepancies,
      });
      if (error) throw error;
    },
    onSuccess: () => setSaved(true),
  });

  if (!location) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <p className="home-greeting">Warehouse</p>
            <h1>Cycle count</h1>
          </div>
          <Link to="/warehouse" className="back-chip" aria-label="Warehouse">
            ‹
          </Link>
        </header>
        <p className="scanner-hint">Scan the slot label you want to count.</p>
        <Scanner
          onScan={async (payload) => {
            const res = await resolveLocationFromScan(payload, locationLookups);
            if (res.status === "ok") setLocation(res.location);
          }}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Counting</p>
          <h1>{location.address}</h1>
        </div>
        <Link to="/warehouse" className="back-chip" aria-label="Warehouse">
          ‹
        </Link>
      </header>
      <p className="muted">
        Scan every window physically in this slot. Expected:{" "}
        {expected.data?.length ?? 0}, scanned: {scanned.size}
        {unexpected.length > 0 && `, unexpected: ${unexpected.length}`}
      </p>

      {!saved && (
        <Scanner
          onScan={async (payload) => {
            const res = await resolveWindowFromScan(payload, windowLookups);
            if (res.status !== "ok") return;
            const windowId = res.unit.window_id;
            const known = (expected.data ?? []).some(
              (u) => u.window_id === windowId,
            );
            if (known) {
              setScanned((prev) => new Set(prev).add(windowId));
            } else if (!unexpected.includes(windowId)) {
              setUnexpected((prev) => [...prev, windowId]);
            }
          }}
        />
      )}

      <h2>Expected here</h2>
      <ul className="unit-list">
        {(expected.data ?? []).map((u) => (
          <li key={u.id} className={scanned.has(u.window_id) ? "ok" : ""}>
            {scanned.has(u.window_id) ? "\u2713 " : "\u2022 "}
            {u.window_id}{" "}
            <span className="muted">{u.window_types?.type_code}</span>
          </li>
        ))}
      </ul>

      {unexpected.length > 0 && (
        <>
          <h2>Unexpected (scanned but not assigned here)</h2>
          <ul className="unit-list">
            {unexpected.map((id) => (
              <li key={id} className="warn-text">{id}</li>
            ))}
          </ul>
        </>
      )}

      {saved ? (
        <p className="ok">
          Count saved.{" "}
          {missing.length + unexpected.length === 0
            ? "Slot is clean."
            : `${missing.length} missing, ${unexpected.length} unexpected — flagged for review.`}
        </p>
      ) : (
        <button
          className="primary big"
          onClick={() => save.mutate()}
          disabled={save.isPending || expected.isLoading}
        >
          Finish count ({missing.length} missing)
        </button>
      )}
      {save.error && <p className="error">{formatApiError(save.error)}</p>}
    </div>
  );
}
