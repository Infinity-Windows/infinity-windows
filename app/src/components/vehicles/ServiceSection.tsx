import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wrench } from "lucide-react";
import { EmptyState, QueryError, SkeletonList } from "../ui/States";
import { addServiceRecord, deleteServiceRecord, listServiceRecords } from "../../lib/vehicles/api";
import { serviceBadge } from "../../lib/vehicles/service";
import { toastSuccess } from "../../lib/toast";
import type { ServiceRecordInput, VehicleWithMeta } from "../../lib/vehicles/types";

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function money(n: number | null): string {
  if (n == null) return "";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function ServiceSection({ vehicle }: { vehicle: VehicleWithMeta }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [performedAt, setPerformedAt] = useState(todayISO());
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [vendor, setVendor] = useState("");
  const [odometer, setOdometer] = useState("");

  const records = useQuery({
    queryKey: ["vehicleService", vehicle.id],
    queryFn: () => listServiceRecords(vehicle.id),
  });

  const badge = serviceBadge({
    todayISO: todayISO(),
    nextServiceDate: vehicle.next_service_date,
    odometer: vehicle.odometer,
  });

  const add = useMutation({
    mutationFn: (input: ServiceRecordInput) => addServiceRecord(vehicle.id, input),
    onSuccess: () => {
      toastSuccess("Service record added");
      setAdding(false);
      setCategory("");
      setDescription("");
      setCost("");
      setVendor("");
      setOdometer("");
      qc.invalidateQueries({ queryKey: ["vehicleService", vehicle.id] });
      qc.invalidateQueries({ queryKey: ["vehicle", vehicle.id] });
      qc.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteServiceRecord(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["vehicleService", vehicle.id] });
    },
  });

  const totalCost = (records.data ?? []).reduce((sum, r) => sum + (r.cost ?? 0), 0);

  return (
    <section className="veh-section">
      <div className="veh-section-head">
        <h2>Service</h2>
        {badge && <span className={`veh-badge veh-badge-${badge.tone}`}>{badge.label}</span>}
      </div>

      <div className="veh-service-summary muted">
        {vehicle.last_service_date && <span>Last service {vehicle.last_service_date}</span>}
        {vehicle.next_service_date && <span>Next due {vehicle.next_service_date}</span>}
        {totalCost > 0 && <span>Total logged {money(totalCost)}</span>}
      </div>

      {!adding && (
        <button className="button-like active-pill veh-add-service" onClick={() => setAdding(true)}>
          <Plus size={15} aria-hidden /> Add service record
        </button>
      )}

      {adding && (
        <div className="veh-service-form">
          <div className="sched-row-2">
            <div>
              <label className="field-label">Date</label>
              <input type="date" value={performedAt} onChange={(e) => setPerformedAt(e.target.value)} />
            </div>
            <div>
              <label className="field-label">Odometer / hours</label>
              <input type="number" inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value)} />
            </div>
          </div>
          <label className="field-label">Category</label>
          <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Oil change, tires, repair…" />
          <label className="field-label">Description</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What was done" />
          <div className="sched-row-2">
            <div>
              <label className="field-label">Cost</label>
              <input type="number" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className="field-label">Vendor</label>
              <input type="text" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Shop name" />
            </div>
          </div>
          <div className="sched-sheet-actions">
            <button className="button-like" onClick={() => setAdding(false)} disabled={add.isPending}>
              Cancel
            </button>
            <button
              className="button-like active-pill"
              style={{ marginLeft: "auto" }}
              disabled={add.isPending}
              onClick={() =>
                add.mutate({
                  performed_at: performedAt,
                  odometer: odometer.trim() ? Number(odometer) : null,
                  engine_hours: null,
                  category: category.trim() || null,
                  description: description.trim() || null,
                  cost: cost.trim() ? Number(cost) : null,
                  vendor: vendor.trim() || null,
                })
              }
            >
              {add.isPending ? "Saving…" : "Save record"}
            </button>
          </div>
        </div>
      )}

      {records.isError ? (
        <QueryError error={records.error} onRetry={() => void records.refetch()} label="Couldn't load service history" />
      ) : records.isLoading ? (
        <SkeletonList rows={2} />
      ) : (records.data ?? []).length === 0 ? (
        <EmptyState icon={<Wrench size={20} />} title="No service history yet" message="Log oil changes, repairs and inspections here." />
      ) : (
        <ul className="veh-service-list">
          {records.data!.map((r) => (
            <li key={r.id} className="veh-service-item">
              <div>
                <div className="veh-service-item-top">
                  <strong>{r.category || "Service"}</strong>
                  <span className="muted">{r.performed_at}</span>
                </div>
                {r.description && <p className="veh-service-desc">{r.description}</p>}
                <p className="muted veh-service-sub">
                  {r.vendor && <span>{r.vendor}</span>}
                  {r.odometer != null && <span>{r.odometer.toLocaleString()} mi</span>}
                  {r.cost != null && <span>{money(r.cost)}</span>}
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Delete record"
                onClick={() => remove.mutate(r.id)}
                disabled={remove.isPending}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
