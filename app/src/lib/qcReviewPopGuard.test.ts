import { describe, expect, it } from "vitest";
import { installQcReviewPopGuard, qcReviewEntryForLocation, qcReviewHistoryEntry, registerQcReviewPopGuard } from "./qcReviewPopGuard";

const pop = () => new Event("popstate");
describe("early QC POP dispatcher", () => {
  it("leaves ordinary navigation untouched outside QC and after its cleanup", () => {
    const target = new EventTarget();
    installQcReviewPopGuard(target);
    let routerVisits = 0;
    target.addEventListener("popstate", () => routerVisits++);
    target.dispatchEvent(pop());
    const cleanup = registerQcReviewPopGuard(event => event.stopImmediatePropagation());
    target.dispatchEvent(pop());
    cleanup(); target.dispatchEvent(pop());
    expect(routerVisits).toBe(2);
  });
  it("prevents an earlier router commit even when QC itself mounts later", () => {
    const target = new EventTarget();
    installQcReviewPopGuard(target);
    let mounted = true;
    target.addEventListener("popstate", () => { mounted = false; });
    const cleanup = registerQcReviewPopGuard(event => {
      expect(mounted).toBe(true);
      event.stopImmediatePropagation();
    });
    target.dispatchEvent(pop());
    expect(mounted).toBe(true);
    cleanup();
  });
  it("does not intercept an unblocked mounted QC flow", () => {
    const target = new EventTarget();
    installQcReviewPopGuard(target);
    let routerVisits = 0;
    target.addEventListener("popstate", () => routerVisits++);
    const cleanup = registerQcReviewPopGuard(() => {});
    target.dispatchEvent(pop());
    expect(routerVisits).toBe(1);
    cleanup();
  });
  it("installs once and an obsolete cleanup cannot remove the next mount's guard", () => {
    const target = new EventTarget();
    installQcReviewPopGuard(target); installQcReviewPopGuard(target);
    let calls = 0;
    const previousCleanup = registerQcReviewPopGuard(() => { throw new Error("obsolete guard"); });
    const cleanup = registerQcReviewPopGuard(() => calls++);
    previousCleanup(); target.dispatchEvent(pop());
    expect(calls).toBe(1);
    cleanup(); target.dispatchEvent(pop());
    expect(calls).toBe(1);
  });
});


describe("QC history snapshot consistency", () => {
  const job = "?job=job-id", selected = `${job}&sel=unit-id`;
  const location = (key: string, search: string) => ({ key, pathname: "/qc", search, hash: "" });
  it("keeps a synchronous selection snapshot when the previous React location commits late", () => {
    const written = qcReviewHistoryEntry(`https://forge.test/qc${selected}`, { idx: 1, key: "selected" });
    let protectedEntry = qcReviewEntryForLocation(written, location("selected", selected), "/")!;
    const staleEffect = qcReviewEntryForLocation(written, location("job-only", job), "/");
    if (staleEffect) protectedEntry = staleEffect;
    expect(staleEffect).toBeNull();
    expect(protectedEntry.url).toBe(`https://forge.test/qc${selected}`);
  });
  it("never pairs the selected React location with the temporary native Back destination", () => {
    const destination = qcReviewHistoryEntry("https://forge.test/team", { idx: 0, key: "team" });
    expect(qcReviewEntryForLocation(destination, location("selected", selected), "/")).toBeNull();
  });
  it("requires the matching entry key even if two entries have identical paths and queries", () => {
    const other = qcReviewHistoryEntry(`https://forge.test/qc${selected}`, { idx: 0, key: "other" });
    expect(qcReviewEntryForLocation(other, location("selected", selected), "/")).toBeNull();
  });
  it("accepts the exact selected entry after the reversal, including a production basename", () => {
    const returned = qcReviewHistoryEntry(`https://forge.test/infinity-windows/qc${selected}`, { idx: 1, key: "selected" });
    expect(qcReviewEntryForLocation(returned, location("selected", selected), "/infinity-windows/"))
      .toBe(returned);
    expect(qcReviewEntryForLocation(returned, location("selected", selected), "/")).toBeNull();
  });
  it("does not accept changed query, hash, path or a mutable history identity", () => {
    const state = { idx: 1, key: "selected" };
    const entry = qcReviewHistoryEntry(`https://forge.test/qc${selected}`, state);
    state.idx = 0; state.key = "team";
    expect(entry.history).toEqual({idx: 1, key: "selected"});
    for (const changed of [{search:job}, {hash:"#other"}, {pathname:"/team"}]) {
      expect(qcReviewEntryForLocation(entry, {...location("selected", selected),...changed}, "/")).toBeNull();
    }
  });
});
