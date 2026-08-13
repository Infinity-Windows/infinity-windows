// The ONLY doorway into the vendored blueprint3d-modern core. Plain JS on
// purpose: the app's strict tsc does not follow .js imports, so the vendor
// sources stay verbatim and are compiled by Vite/esbuild alone. The typed
// surface our code sees lives in core.d.ts — extend it there as the Studio
// grows, never by importing vendor/*.ts directly from TypeScript.
export { Blueprint3d } from "./vendor/blueprint3d";
export { floorplannerModes } from "./vendor/floorplanner/floorplanner_view";
