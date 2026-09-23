// @vitest-environment happy-dom
//
// The importer panel mounted for real, with the file checks and the run held
// still. What is pinned here is what the pure tests cannot see: a SECOND
// ACCOUNT on the same computer never sees the first one's manifest, file
// names, titles or results, and a check that finishes after the switch lands
// nowhere. Synthetic data only.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlannedWalkthrough, PublishedWalkthrough } from "../../lib/trainingImport";

type AuthCb = (event: string, session: { user: { id: string } } | null) => void;

const h = vi.hoisted(() => {
  vi.stubEnv("VITE_SUPABASE_URL", "https://proj.example.invalid");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
  return {
    authCbs: [] as AuthCb[],
    user: { current: "user-A" as string | null },
    role: { current: "owner" as string | null },
    prepare: [] as { resolve: (v: unknown) => void }[],
    runImport: { current: null as null | (() => Promise<PublishedWalkthrough[]>) },
  };
});

vi.mock("../../lib/supabase", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthCb) => {
        h.authCbs.push(cb);
        queueMicrotask(() => cb("INITIAL_SESSION", h.user.current ? { user: { id: h.user.current } } : null));
        return { data: { subscription: { unsubscribe: () => h.authCbs.splice(h.authCbs.indexOf(cb), 1) } } };
      },
      getSession: async () => ({ data: { session: null } }),
    },
  },
}));

const roleListeners = new Set<() => void>();
vi.mock("../../lib/useEffectiveRole", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEffectiveRole: () => {
      const role = useSyncExternalStore(
        (l) => {
          roleListeners.add(l);
          return () => roleListeners.delete(l);
        },
        () => h.role.current,
      );
      return { realRole: role, effectiveRole: role, isPreviewing: false, isLoading: false, grants: {} };
    },
  };
});

vi.mock("../../lib/trainingImport", async (orig) => {
  const actual = await orig<typeof import("../../lib/trainingImport")>();
  return {
    ...actual,
    prepareImport: () => new Promise((resolve) => h.prepare.push({ resolve })),
    runImport: () => (h.runImport.current ? h.runImport.current() : new Promise(() => {})),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import TrainingImporter from "./TrainingImporter";
import { LanguageContext } from "../../lib/i18n/context";
import { CATALOG } from "../../lib/i18n/catalog";
import { translate } from "../../lib/i18n/translate";

const SECRET_TITLE = "Synthetic leadership tour";
const SECRET_FILE = "leadership-private-cut.mp4";
const MANIFEST_NAME = "synthetic-owner-a-manifest.json";

function plan(): PlannedWalkthrough[] {
  return [{
    slug: "leadership",
    minRole: "supervisor",
    language: "en",
    title: SECRET_TITLE,
    durationSeconds: 120,
    version: null,
    chapters: [{ seconds: 0, title: "Start", status: "proposal" }],
    transcriptText: "Synthetic private narration.",
    transcriptSegments: 1,
    captionCues: 1,
    assets: [
      { kind: "video", file: new File(["x"], SECRET_FILE), bytes: 1, mime: "video/mp4", sha256: "a".repeat(64) },
      { kind: "captions", file: new File(["y"], "leadership.vtt"), bytes: 1, mime: "text/vtt", sha256: "b".repeat(64) },
    ],
  }];
}

let root: Root | null = null;
let container: HTMLDivElement;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const value = {
    lang: "en" as const,
    t: (k: Parameters<typeof translate>[2], v?: Parameters<typeof translate>[3]) => translate(CATALOG, "en", k, v),
    setLang: () => {},
    needsChoice: false,
  };
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <LanguageContext.Provider value={value}>
          <TrainingImporter />
        </LanguageContext.Provider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function switchUser(id: string | null) {
  h.user.current = id;
  await act(async () => {
    for (const cb of [...h.authCbs]) cb(id ? "SIGNED_IN" : "SIGNED_OUT", id ? { user: { id } } : null);
  });
  await settle();
}

async function pick(index: number, files: File[]) {
  const input = container.querySelectorAll<HTMLInputElement>("input[type=file]")[index];
  expect(input, "file input exists").toBeTruthy();
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function chooseEverything() {
  await pick(0, [new File(["{}"], MANIFEST_NAME)]);
  await pick(1, [new File(["x"], SECRET_FILE), new File(["y"], "leadership.vtt")]);
}

async function resolvePrepare(i = h.prepare.length - 1) {
  await act(async () => {
    h.prepare[i].resolve({ ok: true, plan: plan() });
  });
  await settle();
}

const text = () => container.textContent ?? "";
function expectNothingOfA() {
  expect(text()).not.toContain(SECRET_TITLE);
  expect(text()).not.toContain(SECRET_FILE);
  expect(text()).not.toContain(MANIFEST_NAME);
  expect(text()).not.toContain("Published");
}

beforeEach(() => {
  h.authCbs.length = 0;
  h.prepare.length = 0;
  h.user.current = "user-A";
  h.role.current = "owner";
  h.runImport.current = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
});

describe("TrainingImporter", () => {
  it("is not shown to an installer, a foreman, or an owner previewing either", async () => {
    for (const role of ["installer", "foreman", "lead"]) {
      h.role.current = role;
      await mount();
      expect(container.querySelector("section")).toBeNull();
      await act(async () => root?.unmount());
      container.remove();
    }
    root = null;
  });

  it("shows a checked leadership walkthrough to the owner who chose it", async () => {
    await mount();
    await chooseEverything();
    await resolvePrepare();
    expect(text()).toContain(SECRET_TITLE);
    expect(text()).toContain(SECRET_FILE);
    expect(text()).toContain("Design preview");
    expect(text()).toContain("Publish reviewed walkthroughs");
  });

  it("gives a second account a clean panel with none of the first one's files, titles or preview", async () => {
    await mount();
    await chooseEverything();
    await resolvePrepare();
    expect(text()).toContain(SECRET_TITLE);
    await switchUser("user-B");
    expect(text()).toContain("Publish walkthrough videos");
    expectNothingOfA();
    expect(text()).toContain("Nothing chosen yet");
  });

  it("drops a check that finishes after the account changed", async () => {
    await mount();
    await chooseEverything();
    const aCheck = h.prepare.length - 1;
    await switchUser("user-B");
    await resolvePrepare(aCheck);
    expectNothingOfA();
    expect(h.prepare).toHaveLength(1); // B never started a check of A's files
  });

  it("does not carry the first account's published result over to the second", async () => {
    h.runImport.current = async () => [{ id: "imp-1", slug: "leadership", version: 7, active: true, alreadyPublished: false }];
    await mount();
    await chooseEverything();
    await resolvePrepare();
    const publish = [...container.querySelectorAll("button")].find((b) => b.textContent === "Publish reviewed walkthroughs");
    await act(async () => publish!.click());
    await settle();
    expect(text()).toContain("Supervisors and owners: version 7 is now live for viewers.");
    await switchUser("user-B");
    expectNothingOfA();
    expect(text()).not.toContain("version 7");
  });

  it("disappears when signed out", async () => {
    await mount();
    await chooseEverything();
    await resolvePrepare();
    await switchUser(null);
    expect(container.querySelector("section")).toBeNull();
    expectNothingOfA();
  });
});
