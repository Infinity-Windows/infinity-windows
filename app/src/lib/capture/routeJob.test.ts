// The job the Capture sheet reads off the screen the person is standing on.
// It outranks the open shift, so getting it wrong files somebody's photo on
// the wrong house — these are the paths the route table actually serves.

import { describe, expect, it } from "vitest";
import { projectIdFromPath } from "./routeJob";

const ID = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";

describe("a screen that is about one job", () => {
  it("reads the job hub", () => {
    expect(projectIdFromPath(`/projects/${ID}`)).toBe(ID);
  });

  it("reads every child of it — the sheet opens over these too", () => {
    for (const tail of [
      "map",
      "upload",
      "review",
      "model",
      "trace-model",
      "flash-run",
      "model-studio",
      `opening/2f1c8f60-1111-4111-8111-111111111111`,
    ]) {
      expect(projectIdFromPath(`/projects/${ID}/${tail}`), tail).toBe(ID);
    }
  });

  it("reads the studio's job view", () => {
    expect(projectIdFromPath(`/studio/j/${ID}`)).toBe(ID);
  });
});

describe("a screen that is not", () => {
  it("says nothing for the jobs list, so the open shift answers instead", () => {
    expect(projectIdFromPath("/projects")).toBeNull();
    expect(projectIdFromPath("/")).toBeNull();
    expect(projectIdFromPath("/warehouse")).toBeNull();
    expect(projectIdFromPath("/photos")).toBeNull();
  });

  it("refuses a /projects child that is not an id", () => {
    // Nothing serves /projects/new today. If something ever does, reading it
    // as a job would file every capture on that screen to a job named "new".
    expect(projectIdFromPath("/projects/new")).toBeNull();
    expect(projectIdFromPath("/projects/BLACK22")).toBeNull();
  });

  it("refuses the studio's PLANSET route, whose id is not a job", () => {
    expect(projectIdFromPath(`/studio/p/${ID}`)).toBeNull();
  });
});
