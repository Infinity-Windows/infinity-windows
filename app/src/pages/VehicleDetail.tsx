import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, User } from "lucide-react";
import { QueryError, SkeletonList } from "../components/ui/States";
import { KindIcon } from "../components/vehicles/KindIcon";
import { VehicleEditor } from "../components/vehicles/VehicleEditor";
import { LocationSection } from "../components/vehicles/LocationSection";
import { ServiceSection } from "../components/vehicles/ServiceSection";
import { JobAssignmentSection } from "../components/vehicles/JobAssignmentSection";
import { FinancialsSection } from "../components/vehicles/FinancialsSection";
import { deleteVehicle, getVehicle, updateVehicle } from "../lib/vehicles/api";
import { listProfiles } from "../lib/install/api";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { canSeeFinancials } from "../lib/vehicles/financials";
import { vehicleSubtitle, vehicleTitle, usageLabel } from "../lib/vehicles/display";
import { driverDisplayName, insuredDrivers, primaryDriver } from "../lib/vehicles/drivers";
import { VEHICLE_STATUS_LABELS } from "../lib/vehicles/types";
import type { VehicleInput } from "../lib/vehicles/types";
import { toastSuccess } from "../lib/toast";

export function VehicleDetail() {
  const { vehicleId = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const { realRole, isPreviewing } = useEffectiveRole();
  const showFinancials = canSeeFinancials({ realRole, isPreviewing });

  const vehicle = useQuery({
    queryKey: ["vehicle", vehicleId],
    queryFn: () => getVehicle(vehicleId),
    enabled: Boolean(vehicleId),
  });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: listProfiles });

  const update = useMutation({
    mutationFn: (input: VehicleInput) => updateVehicle(vehicleId, input),
    onSuccess: () => {
      setEditing(false);
      toastSuccess("Vehicle updated");
      qc.invalidateQueries({ queryKey: ["vehicle", vehicleId] });
      qc.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteVehicle(vehicleId),
    onSuccess: () => {
      toastSuccess("Vehicle removed");
      qc.invalidateQueries({ queryKey: ["vehicles"] });
      navigate("/vehicles");
    },
  });

  if (vehicle.isLoading) {
    return (
      <div className="page veh-page">
        <SkeletonList rows={5} />
      </div>
    );
  }

  if (vehicle.isError) {
    return (
      <div className="page veh-page">
        <QueryError error={vehicle.error} onRetry={() => void vehicle.refetch()} label="Couldn't load this vehicle" />
      </div>
    );
  }

  const v = vehicle.data;
  if (!v) {
    return (
      <div className="page veh-page">
        <header className="page-header">
          <h1>Vehicle not found</h1>
          <Link to="/vehicles" className="button-like"><ArrowLeft size={16} aria-hidden /> Fleet</Link>
        </header>
      </div>
    );
  }

  const primary = primaryDriver(v.drivers);
  const insured = insuredDrivers(v.drivers);
  const usage = usageLabel(v);

  return (
    <div className="page veh-page">
      <header className="page-header">
        <div className="veh-detail-heading">
          <span className="veh-card-icon"><KindIcon kind={v.kind} size={22} /></span>
          <div>
            <h1 style={{ marginBottom: 2 }}>{vehicleTitle(v)}</h1>
            <p className="muted" style={{ margin: 0 }}>{vehicleSubtitle(v)}</p>
          </div>
        </div>
        <Link to="/vehicles" className="button-like" aria-label="Back to fleet"><ArrowLeft size={16} aria-hidden /></Link>
      </header>

      <div className="veh-detail-actions">
        <button className="button-like active-pill" onClick={() => setEditing(true)}>
          <Pencil size={15} aria-hidden /> Edit
        </button>
        <span className={`veh-status-chip veh-status-${v.status}`}>{VEHICLE_STATUS_LABELS[v.status]}</span>
      </div>

      <section className="veh-section">
        <div className="veh-section-head"><h2>Details</h2></div>
        <dl className="veh-details-grid">
          {usage && (<><dt>{v.kind === "heavy_machinery" ? "Engine hours" : "Odometer"}</dt><dd>{usage}</dd></>)}
          {v.plate && (<><dt>Plate</dt><dd>{v.plate}</dd></>)}
          {v.vin && (<><dt>VIN</dt><dd>{v.vin}</dd></>)}
          {v.color && (<><dt>Color</dt><dd>{v.color}</dd></>)}
          {v.last_service_date && (<><dt>Last service</dt><dd>{v.last_service_date}</dd></>)}
          {v.next_service_date && (<><dt>Next service</dt><dd>{v.next_service_date}</dd></>)}
        </dl>
        {v.notes && <p className="veh-notes">{v.notes}</p>}
      </section>

      <section className="veh-section">
        <div className="veh-section-head"><h2>Drivers</h2></div>
        <div className="veh-drivers-view">
          <div className="veh-driver-line">
            <span className="veh-driver-role">Primary</span>
            <span className="veh-driver-name">
              <User size={13} aria-hidden /> {primary ? driverDisplayName(primary) : "Not set"}
            </span>
          </div>
          <div className="veh-driver-line">
            <span className="veh-driver-role">Insured</span>
            <span className="veh-driver-name">
              {insured.length > 0 ? insured.map(driverDisplayName).join(", ") : "None"}
            </span>
          </div>
        </div>
      </section>

      <LocationSection vehicle={v} />
      <ServiceSection vehicle={v} />
      <JobAssignmentSection vehicle={v} />
      {showFinancials && <FinancialsSection vehicleId={v.id} />}

      {editing && (
        <VehicleEditor
          vehicle={v}
          profiles={profiles.data ?? []}
          saving={update.isPending || remove.isPending}
          onSave={(input) => update.mutate(input)}
          onDelete={() => remove.mutate()}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
