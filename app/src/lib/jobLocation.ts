import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { isMissingColumn, isMissingFunction } from "./schemaErrors";

export interface JobLocation {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** A decimal pair is deliberately separate from historical time-clock GPS. */
export function parseJobCoordinates(raw: string): Pick<JobLocation, "latitude" | "longitude"> {
  if (!raw.trim()) return { latitude: null, longitude: null };
  const parts = raw.trim().split(",").map((part) => part.trim());
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (parts.length !== 2 || parts.some((part) => !decimal.test(part))) {
    throw new Error("coordinatesPair");
  }
  const [latitude, longitude] = parts.map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error("coordinatesRange");
  }
  return { latitude, longitude };
}

export async function saveProjectLocation(projectId: string, location: JobLocation, expected: JobLocation): Promise<void> {
  const { latitude, longitude } = location;
  if ((latitude == null) !== (longitude == null)) throw new Error("coordinatesPair");
  if (latitude != null && longitude != null && (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)) {
    throw new Error("coordinatesRange");
  }
  const { error } = await supabase.rpc("set_project_location", {
    p_project_id: projectId,
    p_address: location.address?.trim() || null,
    p_latitude: latitude,
    p_longitude: longitude,
    p_expected_address: expected.address,
    p_expected_latitude: expected.latitude,
    p_expected_longitude: expected.longitude,
  });
  if (error) {
    if (isMissingFunction(error)) throw new Error("Location editing is being updated. Refresh Forge and try again.");
    throw error;
  }
}

/** One bounded read after a refused save; never replays the mutation. */
export async function readProjectLocation(projectId: string): Promise<JobLocation> {
  const { data, error } = await supabase.from("projects")
    .select("address,latitude,longitude").eq("id", projectId).single();
  if (error) throw error;
  if (!data) throw new Error("Job location is unavailable.");
  return { address: data.address ?? null, latitude: data.latitude ?? null, longitude: data.longitude ?? null };
}

export function isJobLocationConflict(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return code === "PT409" || code === "40001";
}

/** Keep already-open job, schedule and travel views on the same saved point. */
export async function invalidateJobLocation(client: QueryClient): Promise<void> {
  await Promise.all(["projects", "projectsAll", "mySchedule", "myScheduleTomorrow", "workSchedule", "schedule", "scheduleAssignments", "scheduleDrafts", "projectSchedule", "homeTodayCrews", "trip", "trips"].map((root) =>
    client.invalidateQueries({ queryKey: [root] }),
  ));
}

/** New app / old schema still shows the crew's schedule while deployment finishes. */
export async function readWithJobCoordinates<T extends { error: unknown }>(read: (columns: string) => PromiseLike<T>, columns: string): Promise<T> {
  const result = await read(columns);
  if (isMissingColumn(result.error, "latitude") || isMissingColumn(result.error, "longitude")) {
    return read(columns.replace(", latitude, longitude", ""));
  }
  return result;
}
