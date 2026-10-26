import type { LaborMetric } from "./laborMetrics";
import { createContext, useContext } from "react";
export type ChartView = "weeklyUnitRates" | "clocked" | "mix" | "units" | "compare" | "activityTime" | "general";
export type ChartScope = { key: string; label: string; ids: string[] };
export const Charts = createContext<{
  laborSource: "clocked" | "timers"; setLaborSource: (source: "clocked" | "timers") => void;
  laborMeasure: LaborMetric; setLaborMeasure: (measure: LaborMetric) => void;
  laborFormat: string; setLaborFormat: (format: string) => void;
  laborStart: "clocked" | "unit"; setLaborStart: (basis: "clocked" | "unit") => void;
  laborAxis: string; setLaborAxis: (axis: string) => void;
  laborWeeks: number; setLaborWeeks: (weeks: number) => void;
  view: ChartView; open: boolean; target: HTMLDivElement | null; scopes: ChartScope[];
  setScopes: (scopes: ChartScope[]) => void; clockedJobs: string[]; setClockedJobs: (jobs: string[]) => void;
  show: (view: ChartView, scope?: ChartScope) => void; close: () => void; clear: () => void; toggle: (scope: ChartScope) => void;
} | null>(null);
export const useCharts = () => useContext(Charts);
