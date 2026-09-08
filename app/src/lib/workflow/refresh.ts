import type { QueryClient } from "@tanstack/react-query";
export function refreshWorkflow(qc: QueryClient) {
  for (const root of ["workflowPlans", "workflowLinks", "workflowReview", "workflowMyTrips", "scheduleAssignments", "scheduleDrafts", "scheduleCoverage", "mySchedule", "trips", "trip", "vehicleLinks", "vehicles", "vehicle", "myScheduleVehicles", "projectSchedule"]) {
    void qc.invalidateQueries({ queryKey: [root] });
  }
}
