import { createContext, useContext } from "react";
export type SelectedUnit = { id: string; jobId: string; label: string; jobLabel?: string; category?: string | null; subtype?: string | null; floor?: string; area: number | null; seconds: number; people: string[]; records: number };
export type ChartView = "clockCompare" | "records";
export type ChartScope = { key: string; label: string; ids: string[] };
export const Charts = createContext<{
  view: ChartView; open: boolean; target: HTMLDivElement | null; scopes: ChartScope[];
  setScopes: (scopes: ChartScope[]) => void; clockedJobs: string[]; setClockedJobs: (jobs: string[]) => void;
  show: (view: ChartView, scope?: ChartScope) => void; close: () => void; clear: () => void; toggle: (scope: ChartScope) => void;
} | null>(null);
export const useCharts = () => useContext(Charts);
