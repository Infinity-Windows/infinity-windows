import type { Project } from "../types";

export type VehicleKind = "pickup" | "car" | "heavy_machinery" | "trailer";

export type TrailerSubtype = "flatbed" | "tiltdeck" | "box" | "gooseneck";

export type VehicleStatus = "active" | "in_shop" | "out_of_service" | "sold";

export type DriverRelation = "primary" | "insured";

export type LocationSource = "manual" | "provider";

/** A driver on a vehicle: either an app profile OR a typed free-text name. */
export interface VehicleDriver {
  id?: string;
  /** Set when the driver is an app profile (mutually exclusive with `name`). */
  profile_id: string | null;
  /** Set when the driver is a typed free-text name (no app account). */
  name: string | null;
  relation: DriverRelation;
  /** Joined display name for a profile driver (best-effort). */
  display_name?: string | null;
}

export interface VehicleLocation {
  vehicle_id: string;
  lat: number;
  lng: number;
  speed_mph: number | null;
  heading_deg: number | null;
  battery_pct: number | null;
  ignition_on: boolean | null;
  recorded_at: string;
  source: LocationSource | string;
}

export interface VehicleServiceRecord {
  id: string;
  vehicle_id: string;
  performed_at: string;
  odometer: number | null;
  engine_hours: number | null;
  category: string | null;
  description: string | null;
  cost: number | null;
  vendor: string | null;
  created_at: string;
}

/** Owner-only. Never fetched/rendered unless the REAL role is owner. */
export interface VehicleFinancials {
  vehicle_id: string;
  paid_cash: boolean;
  loan_balance: number | null;
  interest_rate: number | null;
  lender_bank: string | null;
  monthly_payment: number | null;
  purchase_price: number | null;
  purchase_date: string | null;
  notes: string | null;
  updated_at?: string;
}

/**
 * One automatically-detected drive for a vehicle (from the GPS fix stream).
 * `business` is true only when the driver was clocked in during the drive — the
 * year-end write-off sums business drives only. `driver_id` records who drove.
 */
export interface VehicleDriveSession {
  id: string;
  vehicle_id: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  distance_miles: number;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  business: boolean;
  driver_id: string | null;
  source: string;
  created_at: string;
}

export interface VehicleProjectAssignment {
  id: string;
  vehicle_id: string;
  project_id: string;
  assigned_at: string;
  note: string | null;
  /** Set when the link is tied to a specific scheduled crew block. Optional
   * until the date-aware migration is applied. */
  assignment_id?: string | null;
  /** Days the vehicle is committed (mirrors the assignment range). Optional
   * until the date-aware migration is applied. */
  start_date?: string | null;
  end_date?: string | null;
  project?: Pick<Project, "id" | "job_code" | "name" | "address"> | null;
}

/** A vehicle link surfaced next to a schedule assignment / job (read views). */
export interface ScheduleVehicleLink {
  id: string;
  vehicle_id: string;
  project_id: string;
  assignment_id: string | null;
  start_date: string | null;
  end_date: string | null;
  note: string | null;
  vehicle: Pick<
    Vehicle,
    "id" | "kind" | "trailer_subtype" | "year" | "make" | "model" | "color" | "plate"
  > | null;
}

/** Input to tie a vehicle/trailer to a scheduled crew block. */
export interface VehicleScheduleLinkInput {
  vehicleId: string;
  projectId: string;
  assignmentId: string;
  startDate: string;
  endDate: string;
  note?: string | null;
}

export interface Vehicle {
  id: string;
  kind: VehicleKind;
  trailer_subtype: TrailerSubtype | null;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  vin: string | null;
  plate: string | null;
  odometer: number | null;
  engine_hours: number | null;
  last_service_date: string | null;
  next_service_date: string | null;
  status: VehicleStatus;
  primary_driver_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A vehicle plus the joined bits the list/detail views render. */
export interface VehicleWithMeta extends Vehicle {
  drivers: VehicleDriver[];
  location: VehicleLocation | null;
  assignment: VehicleProjectAssignment | null;
}

/** Create/edit payload from the vehicle editor. */
export interface VehicleInput {
  kind: VehicleKind;
  trailer_subtype: TrailerSubtype | null;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  vin: string | null;
  plate: string | null;
  odometer: number | null;
  engine_hours: number | null;
  last_service_date: string | null;
  next_service_date: string | null;
  status: VehicleStatus;
  notes: string | null;
  /** All drivers (one primary + insured). Source of truth for driver display. */
  drivers: VehicleDriver[];
}

export interface ManualLocationInput {
  lat: number;
  lng: number;
  speed_mph?: number | null;
  heading_deg?: number | null;
}

export interface ServiceRecordInput {
  performed_at: string;
  odometer: number | null;
  engine_hours: number | null;
  category: string | null;
  description: string | null;
  cost: number | null;
  vendor: string | null;
}

export const VEHICLE_KIND_LABELS: Record<VehicleKind, string> = {
  pickup: "Truck",
  car: "Car",
  heavy_machinery: "Machinery",
  trailer: "Trailer",
};

export const TRAILER_SUBTYPE_LABELS: Record<TrailerSubtype, string> = {
  flatbed: "Flatbed",
  tiltdeck: "Tilt deck",
  box: "Box",
  gooseneck: "Gooseneck",
};

export const VEHICLE_STATUS_LABELS: Record<VehicleStatus, string> = {
  active: "Active",
  in_shop: "In shop",
  out_of_service: "Out of service",
  sold: "Sold",
};

/** Filter segments on the list page. */
export type VehicleSegment = "all" | "pickup" | "car" | "heavy_machinery" | "trailer";
