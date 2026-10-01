import { describe, expect, it } from "vitest";
import { installQcReviewPopGuard, registerQcReviewPopGuard } from "./qcReviewPopGuard";

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
