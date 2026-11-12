// Disposable pilot choices shared by planning and Workday.
export const PILOT_ACTIVITIES = [
  { kind: "general", label: "General job work", names: ["Setup", "Loading product", "Travel", "Travel with product", "Unloading product", "Hauling", "Safety / game plan", "Consulting / planning", "Waiting / blocked", "Cleanup"] },
  { kind: "unit", label: "Unit work", names: ["Staging", "RO checked", "Flashing", "Setting frame", "Sealing", "QC / adjustments", "Repairs", "RO framing", "Problem-solving"] },
] as const;
