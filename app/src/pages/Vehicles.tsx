import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Map as MapIcon, Plus, Truck } from "lucide-react";
import { listProfiles } from "../lib/install/api";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { VehicleCard } from "../components/vehicles/VehicleCard";
import { VehicleEditor } from "../components/vehicles/VehicleEditor";
import { FleetFinancialsSection } from "../components/vehicles/FleetFinancialsSection";
import { createVehicle, listVehicles } from "../lib/vehicles/api";
import { filterBySegment, segmentCounts, sortVehicles } from "../lib/vehicles/localFilters";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { canSeeFinancials } from "../lib/vehicles/financials";
import { toastSuccess } from "../lib/toast";
import type { VehicleInput, VehicleSegment } from "../lib/vehicles/types";

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const SEGMENTS: { id: VehicleSegment; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pickup", label: "Trucks" },
  { id: "car", label: "Cars" },
  { id: "heavy_machinery", label: "Machinery" },
  { id: "trailer", label: "Trailers" },
];

export function Vehicles() {
  const qc = useQueryClient();
  const today = todayLocalISO();
  const nowMs = Date.now();
  const [segment, setSegment] = useState<VehicleSegment>("all");
  const [editing, setEditing] = useState(false);
  const { realRole, isPreviewing } = useEffectiveRole();
  const showFinancials = canSeeFinancials({ realRole, isPreviewing });

  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: listVehicles });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });

  const all = useMemo(() => sortVehicles(vehicles.data ?? []), [vehicles.data]);
  const counts = useMemo(() => segmentCounts(all), [all]);
  const shown = useMemo(() => filterBySegment(all, segment), [all, segment]);

  const create = useMutation({
    mutationFn: (input: VehicleInput) => createVehicle(input),
    onSuccess: () => {
      setEditing(false);
      toastSuccess("Vehicle added");
      qc.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });

  return (
    <div className="page veh-page">
      <header className="page-header">
        <div>
          <h1>Vehicles &amp; Machinery</h1>
          <p className="muted" style={{ margin: 0 }}>
            Your fleet — drivers, location, service and jobs.
          </p>
        </div>
        <Link to="/" className="back-chip" aria-label="Home" />
      </header>

      <div className="veh-toolbar">
        <div className="veh-segments" role="tablist" aria-label="Filter by type">
          {SEGMENTS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={segment === s.id}
              className={`sched-viewtab${segment === s.id ? " is-active" : ""}`}
              onClick={() => setSegment(s.id)}
            >
              {s.label} <span className="veh-seg-count">{counts[s.id]}</span>
            </button>
          ))}
        </div>
        <div className="veh-toolbar-actions">
          <Link to="/vehicles/map" className="button-like">
            <MapIcon size={16} aria-hidden /> Map
          </Link>
          <button className="button-like active-pill" onClick={() => setEditing(true)}>
            <Plus size={16} aria-hidden /> Add vehicle
          </button>
        </div>
      </div>

      {showFinancials && all.length > 0 && <FleetFinancialsSection vehicleCount={all.length} />}

      {vehicles.isError && (
        <QueryError error={vehicles.error} onRetry={() => void vehicles.refetch()} label="Couldn't load the fleet" />
      )}

      {vehicles.isLoading ? (
        <SkeletonList rows={4} />
      ) : all.length === 0 ? (
        <EmptyState
          icon={<Truck size={22} />}
          title="No vehicles yet"
          message="Add your first truck, car, machine or trailer to start tracking it."
          action={
            <button className="button-like active-pill" onClick={() => setEditing(true)}>
              <Plus size={16} aria-hidden /> Add vehicle
            </button>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState title="Nothing in this filter" message="Try another type, or add a vehicle." />
      ) : (
        <div className="veh-grid">
          {shown.map((v) => (
            <VehicleCard key={v.id} vehicle={v} todayISO={today} nowMs={nowMs} />
          ))}
        </div>
      )}

      {editing && (
        <VehicleEditor
          vehicle={null}
          profiles={profiles.data ?? []}
          saving={create.isPending}
          onSave={(input) => create.mutate(input)}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
