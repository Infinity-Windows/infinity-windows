import type { Project } from "../types";

export type TripStatus = "draft" | "published";

/** Computed lifecycle from the date range (independent of draft/published). */
export type TripPhase = "upcoming" | "in_progress" | "past";

/** One assigned crew member on a trip. */
export interface TripCrewMember {
  profile_id: string;
  role: string;
  display_name?: string | null;
}

export interface Trip {
  id: string;
  project_id: string | null;
  name: string;
  destination: string | null;
  start_date: string;
  end_date: string;
  /** Trip home IANA timezone (per-leg zones live on flights/lodging). */
  timezone: string | null;
  notes: string | null;
  status: TripStatus;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  crew: TripCrewMember[];
  project?: Pick<Project, "id" | "job_code" | "name" | "address"> | null;
}

export interface Flight {
  id: string;
  trip_id: string;
  /** Whose flight this is; null = the whole crew. */
  profile_id: string | null;
  airline: string | null;
  flight_number: string | null;
  confirmation_code: string | null;
  depart_airport: string | null;
  arrive_airport: string | null;
  /** UTC instant. */
  depart_at: string | null;
  arrive_at: string | null;
  /** IANA zone of the departure / arrival airport (for local rendering). */
  depart_timezone: string | null;
  arrive_timezone: string | null;
  /** Buffer before departure to "be at the airport" (120 domestic/180 intl). */
  minutes_before_departure: number;
  drive_minutes_to_airport: number | null;
  seat: string | null;
  notes: string | null;
  sort_order: number;
}

export interface Lodging {
  id: string;
  trip_id: string;
  name: string | null;
  address: string | null;
  timezone: string | null;
  wifi_ssid: string | null;
  wifi_password: string | null;
  door_code: string | null;
  entry_steps: string | null;
  backup_entry: string | null;
  host_name: string | null;
  host_phone: string | null;
  check_in_at: string | null;
  check_out_at: string | null;
  nights: number | null;
  bedrooms: number | null;
  beds: number | null;
  baths: number | null;
  washer_dryer: boolean | null;
  kitchen: boolean | null;
  parking: string | null;
  quiet_hours: string | null;
  checkout_tasks: string | null;
  notes: string | null;
  sort_order: number;
}

export interface GroundTransport {
  id: string;
  trip_id: string;
  type: string | null;
  provider: string | null;
  confirmation_code: string | null;
  pickup_location: string | null;
  pickup_at: string | null;
  pickup_timezone: string | null;
  dropoff_location: string | null;
  dropoff_at: string | null;
  dropoff_timezone: string | null;
  notes: string | null;
  sort_order: number;
}

export interface Procedure {
  id: string;
  /** null = company-wide template applied to every trip. */
  trip_id: string | null;
  title: string;
  body: string | null;
  sort_order: number;
}

export interface TripContact {
  id: string;
  trip_id: string;
  name: string;
  label: string | null;
  phone: string | null;
  notes: string | null;
  sort_order: number;
}

export interface TripAttachment {
  id: string;
  trip_id: string;
  flight_id: string | null;
  lodging_id: string | null;
  storage_path: string;
  label: string | null;
  created_by: string | null;
  created_at: string;
}

/** Everything needed to render one trip's detail view. */
export interface TripDetail {
  trip: Trip;
  flights: Flight[];
  lodging: Lodging[];
  ground: GroundTransport[];
  procedures: Procedure[];
  contacts: TripContact[];
  attachments: TripAttachment[];
}

// --- Input / patch shapes ---------------------------------------------------

export interface NewTripInput {
  name: string;
  destination?: string | null;
  start_date: string;
  end_date: string;
  timezone?: string | null;
  notes?: string | null;
  project_id?: string | null;
  crew: TripCrewMember[];
}

export interface TripPatch {
  name?: string;
  destination?: string | null;
  start_date?: string;
  end_date?: string;
  timezone?: string | null;
  notes?: string | null;
  project_id?: string | null;
  status?: TripStatus;
  crew?: TripCrewMember[];
}

export type FlightInput = Omit<Flight, "id" | "trip_id" | "sort_order"> &
  Partial<Pick<Flight, "sort_order">>;
export type LodgingInput = Omit<Lodging, "id" | "trip_id" | "sort_order"> &
  Partial<Pick<Lodging, "sort_order">>;
export type GroundInput = Omit<GroundTransport, "id" | "trip_id" | "sort_order"> &
  Partial<Pick<GroundTransport, "sort_order">>;
export type ProcedureInput = Omit<Procedure, "id" | "sort_order"> &
  Partial<Pick<Procedure, "sort_order">>;
export type ContactInput = Omit<TripContact, "id" | "trip_id" | "sort_order"> &
  Partial<Pick<TripContact, "sort_order">>;
