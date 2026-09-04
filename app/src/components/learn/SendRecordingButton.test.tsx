// @vitest-environment happy-dom
//
// The button is mounted for real, because the bug this pins was not in any
// function: foreman_contacts_for_me() answers with the leads on the job the
// caller is CLOCKED INTO, and the button cached that answer under a key that
// never mentioned the job. An installer who finished at one house and clocked
// in at the next then got a mail composer addressed to yesterday's lead with
// today's job in the subject line — and nothing in the app invalidates that
// key, so it stayed wrong for the whole hour.
//
// So the test does what the installer does: mount on one job, switch jobs the
// way a clock-in does (invalidate "openShift"), and read the To: line again.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { shiftHolder, contactsSpy } = vi.hoisted(() => ({
  shiftHolder: { current: null as Record<string, unknown> | null },
  contactsSpy: vi.fn(),
}));

vi.mock("../../lib/install/api", () => ({
  getMyProfile: vi.fn(async () => ({ id: "me", display_name: "Dana", role: "installer" })),
}));
vi.mock("../../lib/timeclock", () => ({
  getOpenShift: vi.fn(async () => shiftHolder.current),
}));
// The address book is the only thing held still. Everything that builds the
// mailto: — mailAddresses, buildRecordingMail, recordingDateLabel — stays real,
// because the href is what the test reads.
vi.mock("../../lib/recordings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/recordings")>();
  return { ...actual, listForemanContacts: contactsSpy };
});

import { SendRecordingButton } from "./SendRecordingButton";

/** Stand in for the RPC: its answer depends on the caller's open shift, which
 * is exactly the dependency the cache key has to carry. */
contactsSpy.mockImplementation(async () => {
  const job = shiftHolder.current?.project_id ?? null;
  if (job === "job-a") return [{ contact_name: "Jed", contact_email: "jed@forgewd.com" }];
  if (job === "job-b") return [{ contact_name: "Sam", contact_email: "sam@forgewd.com" }];
  return [{ contact_name: "Every lead", contact_email: "leads@forgewd.com" }];
});

function shiftOn(projectId: string, name: string) {
  return {
    id: `s-${projectId}`,
    profile_id: "me",
    project_id: projectId,
    cost_code_id: null,
    clock_in_at: new Date().toISOString(),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: new Date().toISOString(),
    projects: { job_code: projectId.toUpperCase(), name },
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  contactsSpy.mockClear();
  shiftHolder.current = null;
});

/** Profile, then shift, then address book: three promises in a row, so give
 * the chain a few ticks rather than one. */
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function href(): string {
  return host?.querySelector("a")?.getAttribute("href") ?? "";
}

describe("Send a recording", () => {
  it("re-addresses the mail when the installer moves to another job", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    shiftHolder.current = shiftOn("job-a", "Sand Hollow");

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={qc}>
          <SendRecordingButton />
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(href()).toContain("mailto:jed@forgewd.com");
    expect(decodeURIComponent(href())).toContain("Sand Hollow");

    // Clock out of one job and into the next. This is exactly what a clock-in
    // does (ClockInBlock and ClockSheet both invalidate "openShift"), and it is
    // the only thing the app does — nothing anywhere touches the address book.
    shiftHolder.current = shiftOn("job-b", "Mad Moose");
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["openShift"] });
    });
    await settle();

    const after = href();
    expect(decodeURIComponent(after)).toContain("Mad Moose");
    // The half that used to lag an hour behind the subject line.
    expect(after).toContain("mailto:sam@forgewd.com");
    expect(after).not.toContain("jed@forgewd.com");
  });

  it("addresses every lead in the company when nobody is on the clock", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    shiftHolder.current = null;

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={qc}>
          <SendRecordingButton />
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(href()).toContain("mailto:leads@forgewd.com");
    // No job, so the subject is just the day — and the button still works.
    expect(decodeURIComponent(href())).toContain("Recording — ");
  });

  it("asks for the address book once, and only once it knows the job", async () => {
    // The fix's other half: without the enabled gate the first load fetches the
    // company-wide fallback and then the real crew a moment later, which is two
    // round trips on a phone that has one bar.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    shiftHolder.current = shiftOn("job-a", "Sand Hollow");

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={qc}>
          <SendRecordingButton />
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(contactsSpy).toHaveBeenCalledTimes(1);
    expect(href()).toContain("mailto:jed@forgewd.com");
  });
});
