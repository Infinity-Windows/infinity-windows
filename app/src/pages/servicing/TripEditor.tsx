import { useState } from "react";
import { VoiceTextarea } from "../../components/voice/VoiceTextarea";
import type { ServiceDetails, ServiceVisit } from "../../lib/servicing/model";
import { useServiceText } from "../../lib/servicing/text";
import type { VehicleWithMeta } from "../../lib/vehicles/types";
export function ServiceTripEditor({
  visit,
  vehicles,
  people,
  busy,
  onSave,
}: {
  visit: ServiceVisit;
  vehicles: VehicleWithMeta[];
  people: { id: string; display_name: string }[];
  busy: boolean;
  onSave: (data: ServiceDetails, revision: number) => void;
}) {
  const tx = useServiceText();
  const [details, setDetails] = useState(visit.details),
    [revision] = useState(visit.revision);
  return (
    <div className="sv-trip-form">
      <div className="sv-fields">
        <label>
          {tx("date")}
          <input
            type="date"
            value={details.scheduled_date ?? ""}
            onChange={(e) =>
              setDetails({ ...details, scheduled_date: e.target.value })
            }
          />
        </label>
        <label>
          {tx("truck")}
          <input
            list="service-trucks"
            value={details.truck ?? ""}
            onChange={(e) => {
              const vehicle = vehicles.find(
                (v) =>
                  [v.year, v.make, v.model, v.plate]
                    .filter(Boolean)
                    .join(" ") === e.target.value,
              );
              setDetails({
                ...details,
                truck: e.target.value,
                truck_id: vehicle?.id ?? "",
              });
            }}
          />
          <datalist id="service-trucks">
            {vehicles.map((v) => (
              <option key={v.id}>
                {[v.year, v.make, v.model, v.plate].filter(Boolean).join(" ")}
              </option>
            ))}
          </datalist>
        </label>
        <label className="sv-span">
          {tx("crewNames")}
          <input
            list="service-crew"
            value={details.crew_names ?? ""}
            onChange={(e) =>
              setDetails({ ...details, crew_names: e.target.value })
            }
          />
          <datalist id="service-crew">
            {people.map((p) => (
              <option key={p.id}>{p.display_name}</option>
            ))}
          </datalist>
        </label>
        {(
          [
            "estimated_miles",
            "actual_miles",
            "lodging_cost",
            "parts_cost",
            "other_cost",
          ] as const
        ).map((key) => (
          <label key={key}>
            {tx(
              (
                {
                  estimated_miles: "estimatedMiles",
                  actual_miles: "actualMiles",
                  lodging_cost: "lodgingCost",
                  parts_cost: "partsCost",
                  other_cost: "otherCost",
                } as const
              )[key],
            )}
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={details[key] ?? ""}
              onChange={(e) => {
                const next = { ...details };
                if (e.target.value === "") delete next[key];
                else next[key] = Number(e.target.value);
                setDetails(next);
              }}
            />
          </label>
        ))}
      </div>
      <p className="muted">{tx("crewHelp")}</p>
      <label className="sv-check">
        <input
          type="checkbox"
          checked={details.lodging ?? false}
          onChange={(e) =>
            setDetails({ ...details, lodging: e.target.checked })
          }
        />
        {tx("lodging")}
      </label>
      <label>
        {tx("tripNotes")}
        <VoiceTextarea
          rows={3}
          value={details.travel_notes ?? ""}
          onChange={(e) =>
            setDetails({ ...details, travel_notes: e.target.value })
          }
        />
      </label>
      <button disabled={busy} onClick={() => onSave(details, revision)}>
        {tx("save")}
      </button>
    </div>
  );
}
