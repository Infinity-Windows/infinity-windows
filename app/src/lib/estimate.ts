// Client seam for job-duration/crew-mix estimating. The pure math now lives
// in the runtime-agnostic shared module (same move knowledge.ts made) so the
// `ask` edge function's get_scheduling_picture tool (wave A2) can surface the
// exact same estimate to the scheduling AI instead of a model re-deriving it.
// See supabase/functions/_shared/estimate.ts for the implementation and the
// caveat about its sample-size floor.
export {
  estimateJob,
  fallbackMinutes,
  formatHours,
  recommendCrew,
  variance,
  type CrewRecommendation,
  type EstimateOpening,
  type JobEstimate,
  type TypeStat,
  type Variance,
} from "../../../supabase/functions/_shared/estimate.ts";
