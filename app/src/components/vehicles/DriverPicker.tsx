import { useMemo, useState } from "react";
import { Plus, UserPlus, X } from "lucide-react";
import type { Profile } from "../../lib/install/types";
import type { VehicleDriver } from "../../lib/vehicles/types";
import { driverDisplayName, insuredDrivers, primaryDriver } from "../../lib/vehicles/drivers";

interface Props {
  profiles: Profile[];
  value: VehicleDriver[];
  onChange: (drivers: VehicleDriver[]) => void;
}

/** Add-a-driver control: searchable profile list + "add by name" free-text. */
function AddControl({
  profiles,
  exclude,
  label,
  onAdd,
}: {
  profiles: Profile[];
  exclude: Set<string>;
  label: string;
  onAdd: (driver: { profile_id: string | null; name: string | null; display_name: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const matches = useMemo(() => {
    const query = q.trim().toLowerCase();
    return profiles
      .filter((p) => p.active && !exclude.has(p.id))
      .filter((p) => !query || p.display_name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [profiles, exclude, q]);

  if (!open) {
    return (
      <button type="button" className="button-like veh-add-driver" onClick={() => setOpen(true)}>
        <Plus size={15} aria-hidden /> {label}
      </button>
    );
  }

  const typed = q.trim();
  return (
    <div className="veh-driver-add">
      <input
        type="text"
        autoFocus
        value={q}
        placeholder="Search crew or type a name"
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search crew or type a name"
      />
      <div className="veh-driver-matches">
        {matches.map((p) => (
          <button
            key={p.id}
            type="button"
            className="veh-driver-match"
            onClick={() => {
              onAdd({ profile_id: p.id, name: null, display_name: p.display_name });
              setQ("");
              setOpen(false);
            }}
          >
            {p.display_name}
          </button>
        ))}
        {typed && (
          <button
            type="button"
            className="veh-driver-match is-typed"
            onClick={() => {
              onAdd({ profile_id: null, name: typed, display_name: null });
              setQ("");
              setOpen(false);
            }}
          >
            <UserPlus size={13} aria-hidden /> Add “{typed}”
          </button>
        )}
        {matches.length === 0 && !typed && (
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            Type a name to add someone not on the roster.
          </p>
        )}
      </div>
      <button type="button" className="button-like" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

/**
 * Manages a vehicle's drivers: one primary + additional insured drivers, each
 * an app profile OR a typed free-text name. Emits the canonical VehicleDriver[]
 * up to the editor (normalized on save).
 */
export function DriverPicker({ profiles, value, onChange }: Props) {
  const primary = primaryDriver(value);
  const insured = insuredDrivers(value);
  const usedProfileIds = new Set(
    value.map((d) => d.profile_id).filter((id): id is string => Boolean(id)),
  );

  const setPrimary = (driver: Omit<VehicleDriver, "relation">) => {
    const rest = value.filter((d) => d.relation !== "primary");
    onChange([{ ...driver, relation: "primary" }, ...rest]);
  };
  const clearPrimary = () => onChange(value.filter((d) => d.relation !== "primary"));
  const addInsured = (driver: Omit<VehicleDriver, "relation">) =>
    onChange([...value, { ...driver, relation: "insured" }]);
  const removeInsured = (driver: VehicleDriver) =>
    onChange(
      value.filter(
        (d) =>
          !(
            d.relation === "insured" &&
            d.profile_id === driver.profile_id &&
            d.name === driver.name
          ),
      ),
    );

  return (
    <div className="veh-drivers">
      <div>
        <label className="field-label">Primary driver</label>
        {primary ? (
          <div className="veh-driver-chip is-primary">
            <span>{driverDisplayName(primary)}</span>
            <button type="button" onClick={clearPrimary} aria-label="Remove primary driver">
              <X size={14} />
            </button>
          </div>
        ) : (
          <AddControl
            profiles={profiles}
            exclude={usedProfileIds}
            label="Set primary driver"
            onAdd={setPrimary}
          />
        )}
      </div>

      <div>
        <label className="field-label">Insured drivers</label>
        <div className="veh-driver-list">
          {insured.map((d, i) => (
            <div key={`${d.profile_id ?? d.name}-${i}`} className="veh-driver-chip">
              <span>{driverDisplayName(d)}</span>
              <button type="button" onClick={() => removeInsured(d)} aria-label={`Remove ${driverDisplayName(d)}`}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <AddControl
          profiles={profiles}
          exclude={usedProfileIds}
          label="Add insured driver"
          onAdd={addInsured}
        />
      </div>
    </div>
  );
}
