// listMyPublished / listTimeOff with and without `strictRemote`.
//
// The default is what every schedule screen has always had: a missing table
// answers from this browser's local draft store (schedule) or as "no time
// off". A Schedule-tab Start work check must never be answered that way
// (pages/work/useScheduleStartWorkIntent.ts), so strict throws instead.
// Supabase is a fake here; nothing reaches a network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Answer = { data: unknown; error: unknown };
  const answers = new Map<string, Answer[]>();
  const tablesAsked: string[] = [];
  const CHAIN = ["select", "eq", "in", "lte", "gte", "order", "range", "is", "limit"];
  function from(table: string) {
    tablesAsked.push(table);
    const answer = answers.get(table)?.shift() ?? { data: [], error: null };
    const p = Promise.resolve(answer) as Promise<Answer> & Record<string, unknown>;
    for (const m of CHAIN) p[m] = () => p;
    return p;
  }
  return { answers, tablesAsked, from };
});

vi.mock("../supabase", () => ({ supabase: { from: fake.from } }));

import { listMyPublished } from "./api";
import { filterMyPublished } from "./myPublished";
import { listTimeOff } from "../timeOff/api";
import type { ScheduleAssignment } from "./types";

const ME = "00000000-0000-4000-8000-0000000000e2";
const DAY = "2026-10-05";
const LOCAL_KEY = "infinity.schedule.assignments.v1";

const missing = (table: string) => ({ code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });

const localRow = {
  id: "local-asg",
  project_id: "local-project",
  kind: "install",
  delivery_id: null,
  start_date: DAY,
  end_date: DAY,
  start_time: "07:00",
  end_time: null,
  status: "published",
  color: null,
  note: null,
  created_by: null,
  created_via: null,
  published_at: `${DAY}T06:00:00Z`,
  created_at: `${DAY}T06:00:00Z`,
  updated_at: `${DAY}T06:00:00Z`,
  members: [{ profile_id: ME, role: "installer", display_name: null }],
  project: null,
} as unknown as ScheduleAssignment;

const remoteRow = {
  id: "remote-asg",
  project_id: "remote-project",
  kind: "install",
  delivery_id: null,
  start_date: DAY,
  end_date: DAY,
  start_time: "10:00",
  end_time: null,
  status: "published",
  color: null,
  note: null,
  created_by: null,
  published_at: `${DAY}T06:00:00Z`,
  created_at: `${DAY}T06:00:00Z`,
  updated_at: `${DAY}T06:00:00Z`,
  schedule_assignment_members: [{ profile_id: ME, role: "installer", profiles: { display_name: "Me" } }],
  projects: { id: "remote-project", job_code: "REMOTE", name: "Remote job", address: null },
};

beforeEach(() => {
  fake.answers.clear();
  fake.tablesAsked.length = 0;
  const store = new Map<string, string>([[LOCAL_KEY, JSON.stringify([localRow])]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listMyPublished — the default every schedule screen uses is unchanged", () => {
  it("a missing members table answers from the local draft store", async () => {
    fake.answers.set("schedule_assignment_members", [{ data: null, error: missing("schedule_assignment_members") }]);
    const expected = filterMyPublished([localRow], ME, DAY, DAY);
    expect(expected.map((r) => r.id)).toEqual(["local-asg"]);
    await expect(listMyPublished(ME, DAY, DAY)).resolves.toEqual(expected);
  });

  it("a missing assignments table answers from the local draft store", async () => {
    fake.answers.set("schedule_assignment_members", [{ data: [{ assignment_id: "remote-asg" }], error: null }]);
    fake.answers.set("schedule_assignments", [{ data: null, error: missing("schedule_assignments") }]);
    await expect(listMyPublished(ME, DAY, DAY)).resolves.toEqual(filterMyPublished([localRow], ME, DAY, DAY));
  });

  it("a missing time-off table reads as no time off", async () => {
    fake.answers.set("schedule_assignment_members", [{ data: [{ assignment_id: "remote-asg" }], error: null }]);
    fake.answers.set("schedule_assignments", [{ data: [remoteRow], error: null }]);
    fake.answers.set("time_off_requests", [{ data: null, error: missing("time_off_requests") }]);
    const rows = await listMyPublished(ME, DAY, DAY);
    expect(rows.map((r) => r.id)).toEqual(["remote-asg"]);
  });

  it("listTimeOff alone still answers a missing table with an empty list", async () => {
    fake.answers.set("time_off_requests", [{ data: null, error: missing("time_off_requests") }]);
    await expect(listTimeOff(ME)).resolves.toEqual([]);
  });
});

describe("listMyPublished({ strictRemote: true }) — only a fresh database answer counts", () => {
  it("a missing members table is an error, never the local store", async () => {
    const error = missing("schedule_assignment_members");
    fake.answers.set("schedule_assignment_members", [{ data: null, error }]);
    await expect(listMyPublished(ME, DAY, DAY, { strictRemote: true })).rejects.toBe(error);
  });

  it("a missing assignments table is an error, never the local store", async () => {
    const error = missing("schedule_assignments");
    fake.answers.set("schedule_assignment_members", [{ data: [{ assignment_id: "remote-asg" }], error: null }]);
    fake.answers.set("schedule_assignments", [{ data: null, error }]);
    await expect(listMyPublished(ME, DAY, DAY, { strictRemote: true })).rejects.toBe(error);
  });

  it("a missing time-off table is an error, not 'no time off'", async () => {
    const error = missing("time_off_requests");
    fake.answers.set("schedule_assignment_members", [{ data: [{ assignment_id: "remote-asg" }], error: null }]);
    fake.answers.set("schedule_assignments", [{ data: [remoteRow], error: null }]);
    fake.answers.set("time_off_requests", [{ data: null, error }]);
    await expect(listMyPublished(ME, DAY, DAY, { strictRemote: true })).rejects.toBe(error);
  });

  it("listTimeOff strict rejects a missing table", async () => {
    const error = missing("time_off_requests");
    fake.answers.set("time_off_requests", [{ data: null, error }]);
    await expect(listTimeOff(ME, { strictRemote: true })).rejects.toBe(error);
  });

  it("a real remote answer comes back the same as the default's", async () => {
    fake.answers.set("schedule_assignment_members", [{ data: [{ assignment_id: "remote-asg" }], error: null }]);
    fake.answers.set("schedule_assignments", [{ data: [remoteRow], error: null }]);
    fake.answers.set("time_off_requests", [{ data: [], error: null }]);
    const rows = await listMyPublished(ME, DAY, DAY, { strictRemote: true });
    expect(rows.map((r) => r.id)).toEqual(["remote-asg"]);
    expect(rows[0].project_id).toBe("remote-project");
    expect(fake.tablesAsked).toEqual(["schedule_assignment_members", "schedule_assignments", "time_off_requests"]);
  });
});
