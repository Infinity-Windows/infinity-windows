// @vitest-environment happy-dom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import corpus from "../../lib/workActivityTotals/__fixtures__/sourceMatchedWire.json";
import { parseTotalsReply,type TotalsView } from "../../lib/workActivityTotals/protocol";
import { ActivityTotalsPanel } from "./ActivityTotalsPanel";
vi.mock("../../lib/i18n",()=>({useLanguage:()=>({lang:"en"})}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement;
beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);});afterEach(()=>{act(()=>root.unmount());host.remove();});
function view(index:number){const raw=corpus.calls[index].result,t=raw.totals!;const reply=parseTotalsReply(raw,t.projectId,t.unitId,t.actorId);if(reply.availability!=="available")throw Error("Bad source fixture");return reply.totals;}
async function render(data:TotalsView|null){await act(async()=>root.render(<ActivityTotalsPanel totals={{state:data?"ready":"unavailable",data,liveElapsedMicros:0n,refresh:vi.fn()}} onRefresh={async()=>{}}/>));}
describe("totals truthful user display",()=>{
 it("unavailable is an explicit state, with no zero hours or area guarantee",async()=>{await render(null);expect(host.textContent).toContain("Totals are unavailable");expect(host.textContent).not.toContain("0:00:00");expect(host.querySelector("button")?.textContent).toBe("Check totals");});
 it("partial shows known subtotal and cannot show a trusted rate",async()=>{const index=corpus.calls.findIndex(c=>c.result.totals?.complete===false);await render(view(index));expect(host.textContent).toContain("Partial — known subtotal");expect(host.textContent).toContain("trusted unit rate is unavailable");expect(host.textContent).not.toContain("hours per100 sq ft");});
 it("personal reconciliation has its own heading and never prints internal safety codes",async()=>{const index=corpus.calls.findIndex(c=>c.result.totals?.reconciliation.scope==="personal");const data=view(index);await render(data);expect(host.textContent).toContain("Your payroll reconciliation");expect(host.textContent).not.toContain("Authorized payroll reconciliation");for(const issue of data.reconciliation.issues)expect(host.textContent).not.toContain(issue);});
 it("eligible rate names its same-unit numerator and denominator and excludes general overhead",async()=>{const index=corpus.calls.findIndex(c=>c.result.totals?.cohort?.eligible===true);await render(view(index));expect(host.textContent).toContain("hours per100 sq ft");expect(host.textContent).toContain("same eligible unit");expect(host.textContent).toContain("general overhead is excluded");expect(host.textContent).toContain("not a bid guarantee");});
 it("machine time is displayed as an included subset and historical versions stay visible",async()=>{const data=view(0);data.activities[0].retired=true;await render(data);expect(host.textContent).toContain("Retired activity");expect(host.textContent).toContain("Machine time is included in activity time");});
});
