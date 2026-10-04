import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ViewAsRoleProvider } from "../../src/lib/viewAsRole";
import { useViewAsRole, type ViewAsRoleValue } from "../../src/lib/viewAsRoleContext";
import { LanguageContext } from "../../src/lib/i18n/context";
import { UnitReviewPanel } from "../../src/components/work/UnitReviewPanel";
import { createUnitReviewSelectionSource } from "../../src/lib/workUnitReview/useUnitReviewCoordinator";
import * as auth from "../../src/lib/signedIn";
import * as storage from "../../src/lib/workUnitReview/storage";
import { parseUnitReviewReply, type ReviewPayload, type ReviewStoredReceipt, type ReviewReply } from "../../src/lib/workUnitReview/protocol";
import type { ReviewAttempt } from "../../src/lib/workUnitReview/api";
import type { ReviewCoordinatorDependencies } from "../../src/lib/workUnitReview/coordinator";
import "../../src/index.css";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1), UNIT = id(2), JOB = id(3);
auth.rememberSignedIn({ user: { id: OWNER } });
const initial = (): Extract<ReviewReply, { availability: "available" }> => ({ protocolVersion: 1, asOf: "2026-10-04T12:00:00Z", availability: "available", review: {
  basis: { unitId: UNIT, unitRevision: 1, factId: id(4), factRevision: 1, scopeToken: `ur1:${"a".repeat(64)}`, reviewRevision: 0, submissionId: null, generation: 0 }, basisStatus: "current",
  observation: { observerId: id(5), source: "estimated", widthDecimal: "1.000000000000000001", heightDecimal: "72", unit: "in", sourceReference: "Original field estimate" },
  capabilities: { verifyDimensions: true, submit: true, pass: false, fail: false, claimResolved: false, reopen: false }, dimensionVerification: { state: "unverified", verificationId: null },
  qc: { state: "not_submitted", acceptance: "not_accepted", lifecycle: "proven", qcAccepted: false }, work: { availability: "available", activeCount: 0, pendingCount: 0 }, defects: [],
} });
let current = initial(), receiptVisible = true, mode: "applied" | "unknown" | "lost" | "refused" | "wait" = "applied";
const hiddenReceipts = new Set<string>();
let readWait = false; const readResolvers: (() => void)[] = [];
let waitSend: (() => void) | null = null, reads = 0, cancels = 0;
const serverKey = "synthetic-unit-review-panel-server";
const ledger = (): Record<string, ReviewStoredReceipt> => JSON.parse(localStorage.getItem(serverKey) ?? "{}");
const calls: { commandId: string; payload: ReviewPayload; durable: boolean }[] = [];
const source = createUnitReviewSelectionSource();
const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
const profile = { id: OWNER, display_name: "Synthetic reviewer", role: "owner", active: true, skill_level: 0 };
client.setQueryData(["myRealProfile"], profile);
const select = (unitId = UNIT, jobId = JOB, role = "owner") => source.select({ login: auth.signInMark(), realRole: role, selectedJobId: jobId, selectedUnitId: unitId,
  binding: { unitId, projectId: jobId }, admitted: () => true });
select();
function applied(commandId: string, payload: ReviewPayload): ReviewStoredReceipt {
  const b = payload.basis, eventId = id(100 + Object.keys(ledger()).length);
  let generation = b.generation, submissionId = b.submissionId;
  if (payload.action === "submit") { generation = b.submissionId === null ? Math.max(b.generation, 1) : b.generation + 1; submissionId = eventId; }
  if (payload.action === "reopen") { generation++; submissionId = null; }
  return { protocolVersion: 1, commandId, action: payload.action, unitId: b.unitId, eventId, reviewRevision: b.reviewRevision + 1, generation, submissionId, recordedAt: "2026-10-04T12:00:01Z", outcome: "applied" };
}
function keep(receipt: ReviewStoredReceipt) { const all = ledger(); all[receipt.commandId] = receipt; localStorage.setItem(serverKey, JSON.stringify(all)); return receipt; }
const deps: Partial<ReviewCoordinatorDependencies> = {
  read: async unit => { reads++; const value = structuredClone(current); if (readWait) await new Promise<void>(yes => readResolvers.push(yes)); return parseUnitReviewReply(value, unit); },
  receipt: async command => receiptVisible && !hiddenReceipts.has(command) && ledger()[command] ? { protocolVersion: 1, availability: "available", receipt: ledger()[command] } : { protocolVersion: 1, availability: "unavailable", receipt: null },
  send: async (commandId, payload, login, admission): Promise<ReviewAttempt> => {
    const row = (await storage.readReviewJournal(login, payload.basis.unitId, admission)).find(r => r.commandId === commandId)!;
    calls.push({ commandId, payload: structuredClone(payload), durable: row.durability === "strict" && row.attempts.at(-1)?.outcome === "pending" });
    if (mode === "wait") await new Promise<void>(yes => { waitSend = yes; });
    if (mode === "refused") return { kind: "attempt_refused", sqlState: "42501" };
    if (mode === "unknown") return { kind: "unknown" };
    const receipt = ledger()[commandId] ?? keep(applied(commandId, payload));
    if (mode === "lost") { receiptVisible = false; return { kind: "unknown" }; }
    return receipt.outcome === "applied" ? { kind: "applied", receipt } : { kind: "cancelled", receipt };
  },
  cancel: async (commandId, payload) => {
    cancels++;
    const receipt = ledger()[commandId] ?? keep({ protocolVersion: 1, commandId, action: payload.action, unitId: payload.basis.unitId, recordedAt: "2026-10-04T12:00:02Z", outcome: "cancelled", original: payload });
    receiptVisible = true;
    return receipt.outcome === "applied" ? { kind: "applied", receipt } : { kind: "cancelled", receipt };
  },
};
let preview!: ViewAsRoleValue, setLanguage!: (lang: "en" | "es") => void;
export function Harness() {
  preview = useViewAsRole(); const [lang, setLang] = useState<"en" | "es">("en"); setLanguage = setLang;
  return <LanguageContext.Provider value={{ lang, t: key => key, setLang, needsChoice: false }}><main style={{ padding: 12, maxWidth: 760, margin: "auto", boxSizing: "border-box" }}><UnitReviewPanel source={source} dependencies={deps} /></main></LanguageContext.Provider>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><QueryClientProvider client={client}><ViewAsRoleProvider><Harness /></ViewAsRoleProvider></QueryClientProvider></StrictMode>);
const panelFixture = {
  id, OWNER, UNIT, JOB, source, select, auth, storage, calls, ledger, reads: () => reads, cancels: () => cancels,
  current: () => current, setCurrent: (value: typeof current) => { current = value; },
  hideReceipt: (commandId: string) => hiddenReceipts.add(commandId),
  mode: (value: typeof mode) => { mode = value; }, receipts: (visible: boolean) => { receiptVisible = visible; },
  holdReads: () => { readWait = true; }, releaseReads: () => { readWait = false; readResolvers.splice(0).forEach(yes => yes()); },
  releaseSend: () => { waitSend?.(); waitSend = null; },
  preview: () => preview, language: (lang: "en" | "es") => setLanguage(lang),
  profile: (role: string) => { client.setQueryData(["myRealProfile"], { ...profile, role }); },
  unmount: () => root.unmount(),
};
export type PanelFixture = typeof panelFixture;
declare global { interface Window { unitReviewPanelFixture: typeof panelFixture } }
window.unitReviewPanelFixture = panelFixture;
