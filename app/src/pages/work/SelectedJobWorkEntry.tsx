import type { ReactNode } from "react";
import { useSelectedJobWorkGate } from "../../lib/workActivity/selectedJobWorkGate";
import { SelectedJobWorkRoute } from "./SelectedJobWorkRoute";
/** Deliberate release flag remains owned by paidClock. No second route/clock. */
export default function SelectedJobWorkEntry({ fallback }: { fallback: ReactNode }) {
  return useSelectedJobWorkGate() ? <SelectedJobWorkRoute /> : fallback;
}
