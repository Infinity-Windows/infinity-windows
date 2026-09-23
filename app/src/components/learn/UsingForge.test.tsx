// @vitest-environment happy-dom
//
// The "Using Forge" tab mounted for real, with only the network held still:
// Supabase's auth stream, the catalog read, storage signing and the caption
// fetch. lib/appTraining.ts and the hooks run as they do on a phone, because
// the things worth pinning live in how they fit together — the role the screen
// renders as, the warning above the player, the chapter that seeks, the link
// that fails and comes back, and above all a SECOND ACCOUNT on the same phone
// never inheriting the first one's media.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AuthCb = (event: string, session: { user: { id: string } } | null) => void;

const h = vi.hoisted(() => ({
  authCbs: [] as AuthCb[],
  role: { current: "installer" as string | null },
  catalogByUser: new Map<string, unknown[]>(),
  currentUser: { current: null as string | null },
  catalogError: { current: null as unknown },
  signImpl: { current: null as null | ((paths: string[]) => Promise<unknown>) },
  writes: [] as string[],
}));

vi.mock("../../lib/supabase", () => {
  const catalogChain = () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: async () =>
        h.catalogError.current
          ? { data: null, error: h.catalogError.current }
          : { data: h.catalogByUser.get(h.currentUser.current ?? "") ?? [], error: null },
      insert: () => h.writes.push("insert"),
      update: () => h.writes.push("update"),
      upsert: () => h.writes.push("upsert"),
      delete: () => h.writes.push("delete"),
    };
    return chain;
  };
  return {
    supabaseConfigured: true,
    supabase: {
      auth: {
        onAuthStateChange: (cb: AuthCb) => {
          h.authCbs.push(cb);
          queueMicrotask(() =>
            cb("INITIAL_SESSION", h.currentUser.current ? { user: { id: h.currentUser.current } } : null),
          );
          return { data: { subscription: { unsubscribe: () => h.authCbs.splice(h.authCbs.indexOf(cb), 1) } } };
        },
      },
      from: (table: string) => {
        expect(table).toBe("app_training_videos");
        return catalogChain();
      },
      rpc: () => h.writes.push("rpc"),
      storage: {
        from: (bucket: string) => {
          expect(bucket).toBe("app-training");
          return {
            createSignedUrls: (paths: string[]) => h.signImpl.current!(paths),
            upload: () => h.writes.push("upload"),
            remove: () => h.writes.push("remove"),
          };
        },
      },
    },
  };
});

// The role is a tiny external store so a test can flip "view as role" while a
// player is open, the way the owner's preview switcher does.
const roleListeners = new Set<() => void>();
function setPreviewRole(role: string | null) {
  h.role.current = role;
  for (const l of roleListeners) l();
}
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

// React's act() only settles effects when it is told this is a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import UsingForge from "./UsingForge";
import { LanguageContext } from "../../lib/i18n/context";
import { CATALOG } from "../../lib/i18n/catalog";
import { translate, type Lang } from "../../lib/i18n/translate";

const PREVIEW_EN = "Design preview — some steps are proposed, not available in the current app.";
const PREVIEW_ES = "Vista previa de diseño — algunos pasos son propuestas y no están disponibles en la app actual.";

function row(slug: "installer" | "foreman" | "leadership") {
  const floor = slug === "leadership" ? "supervisor" : slug;
  return {
    id: `id-${slug}`,
    slug,
    title: `${slug[0].toUpperCase()}${slug.slice(1)} walkthrough`,
    min_role: floor,
    language: "en",
    content_status: "proposal",
    version: 1,
    duration_seconds: 300,
    video_path: `${slug}/en/v1/walkthrough.mp4`,
    captions_path: `${slug}/en/v1/captions.vtt`,
    poster_path: `${slug}/en/v1/poster.jpg`,
    transcript_text: `${slug} narration, first paragraph.\n\nSecond paragraph.`,
    chapters: [
      { seconds: 0, title: "Clock in", status: "live" },
      { seconds: 90, title: "Proposed job card", status: "proposal" },
      { seconds: 200, title: "Approvals", status: "mixed" },
    ],
    published_at: "2026-09-23T12:00:00Z",
    active: true,
  };
}
const ALL = [row("installer"), row("foreman"), row("leadership")];

const okSign = async (paths: string[]) => ({
  data: paths.map((p) => ({ path: p, signedUrl: `https://s.test/storage/v1/object/sign/app-training/${p}?token=${h.currentUser.current}`, error: null })),
  error: null,
});

let root: Root | null = null;
let container: HTMLDivElement;
let qc: QueryClient;
const created: string[] = [];
const revoked: string[] = [];

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(lang: Lang = "en") {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const value = {
    lang,
    t: (k: Parameters<typeof translate>[2], v?: Parameters<typeof translate>[3]) => translate(CATALOG, lang, k, v),
    setLang: () => {},
    needsChoice: false,
  };
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <LanguageContext.Provider value={value}>
          <UsingForge />
        </LanguageContext.Provider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function switchUser(id: string | null, role: string | null) {
  h.currentUser.current = id;
  h.role.current = role;
  await act(async () => {
    for (const cb of [...h.authCbs]) cb(id ? "SIGNED_IN" : "SIGNED_OUT", id ? { user: { id } } : null);
  });
  await settle();
}

const text = () => container.textContent ?? "";
const buttons = (label: RegExp | string) =>
  [...container.querySelectorAll("button")].filter((b) =>
    typeof label === "string" ? b.textContent?.trim() === label || b.getAttribute("aria-label") === label : label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
  );
async function click(el: Element | undefined) {
  expect(el, "button exists").toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

beforeEach(() => {
  h.authCbs.length = 0;
  h.catalogByUser.clear();
  h.catalogError.current = null;
  h.writes.length = 0;
  h.signImpl.current = okSign;
  created.length = 0;
  revoked.length = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const u = `blob:captions-${created.length}`;
    created.push(u);
    return u;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => {
    revoked.push(u);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("WEBVTT\n\n00:00.000 --> 00:02.000\nHello", { status: 200 })),
  );
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the shelf", () => {
  it("shows an installer only the installer walkthrough, with the warning on the card", async () => {
    h.currentUser.current = "u-installer";
    h.role.current = "installer";
    // Even if the server answered with more, the screen narrows to the role.
    h.catalogByUser.set("u-installer", ALL);
    await mount();
    const cards = container.querySelectorAll(".uf-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("Installer walkthrough");
    expect(cards[0].textContent).toContain(PREVIEW_EN);
    expect(cards[0].textContent).toContain("Installers and up");
    expect(cards[0].textContent).toContain("Narration and captions in English");
    expect(text()).not.toContain("Leadership walkthrough");
    expect(text()).toContain("does not add learning time");
  });

  it("shows a foreman two and an owner all three, installer first", async () => {
    h.currentUser.current = "u-owner";
    h.role.current = "owner";
    h.catalogByUser.set("u-owner", [row("leadership"), row("foreman"), row("installer")]);
    await mount();
    const titles = [...container.querySelectorAll(".uf-card h3")].map((e) => e.textContent);
    expect(titles).toEqual(["Installer walkthrough", "Foreman walkthrough", "Leadership walkthrough"]);
    expect(container.querySelectorAll(".uf-card .uf-preview")).toHaveLength(3);
  });

  it("is honest when nothing is published (or the table is not deployed yet)", async () => {
    h.currentUser.current = "u-installer";
    h.catalogError.current = { code: "PGRST205", message: "Could not find the table 'public.app_training_videos'" };
    await mount();
    expect(text()).toContain("No walkthroughs yet");
    expect(container.querySelector("video")).toBeNull();
  });

  it("offers Retry when the catalog fails, and recovers", async () => {
    h.currentUser.current = "u-installer";
    h.catalogError.current = { code: "08006", message: "network" };
    h.catalogByUser.set("u-installer", [row("installer")]);
    await mount();
    expect(text()).toContain("Couldn't load the walkthroughs.");
    h.catalogError.current = null;
    await click(buttons("Try again")[0]);
    expect(container.querySelectorAll(".uf-card")).toHaveLength(1);
  });

  it("says offline in plain words when there is no signal", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    h.currentUser.current = "u-installer";
    h.catalogError.current = { message: "Failed to fetch" };
    await mount();
    expect(text()).toContain("You're offline.");
  });

  it("reads in Spanish, and says truthfully the narration is English", async () => {
    h.currentUser.current = "u-installer";
    h.catalogByUser.set("u-installer", [row("installer")]);
    await mount("es");
    expect(text()).toContain(PREVIEW_ES);
    expect(text()).toContain("Narración y subtítulos en inglés");
    expect(text()).toContain("Instaladores y superiores");
  });
});

describe("the player", () => {
  async function openInstaller() {
    h.currentUser.current = "u-installer";
    h.role.current = "installer";
    h.catalogByUser.set("u-installer", [row("installer")]);
    await mount();
    await click(buttons("Watch Installer walkthrough")[0]);
  }

  it("puts the warning above the video and never autoplays", async () => {
    await openInstaller();
    const section = container.querySelector(".uf-player")!;
    const preview = section.querySelector(".uf-preview")!;
    const video = section.querySelector("video")!;
    expect(preview.textContent).toContain(PREVIEW_EN);
    expect(preview.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.hasAttribute("autoplay")).toBe(false);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.getAttribute("src")).toContain("installer/en/v1/walkthrough.mp4");
    expect(video.getAttribute("poster")).toContain("poster.jpg");
  });

  it("carries English WebVTT captions as a default track, from a blob", async () => {
    await openInstaller();
    const track = container.querySelector("video track")!;
    expect(track.getAttribute("kind")).toBe("captions");
    expect(track.getAttribute("srclang")).toBe("en");
    expect(track.getAttribute("label")).toBe("English");
    expect(track.hasAttribute("default")).toBe(true);
    expect(track.getAttribute("src")).toBe("blob:captions-0");
  });

  it("seeks from the chapter list, holding the jump until metadata is in", async () => {
    await openInstaller();
    const video = container.querySelector("video")! as HTMLVideoElement;
    const chapter = buttons(/Jump to 1:30, Proposed job card/)[0];
    expect(chapter.textContent).toContain("Proposed");
    // Metadata not loaded yet: the jump waits.
    await click(chapter);
    expect(chapter.getAttribute("aria-current")).toBe("true");
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(video.currentTime).toBe(90);
    // Metadata loaded: the jump is immediate.
    Object.defineProperty(video, "readyState", { configurable: true, get: () => 1 });
    await click(buttons(/Jump to 3:20, Approvals/)[0]);
    expect(video.currentTime).toBe(200);
    expect(text()).toContain("Partly in the app");
    expect(text()).toContain("In the app today");
  });

  it("has a readable, expandable transcript", async () => {
    await openInstaller();
    const details = container.querySelector("details.uf-transcript")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Read the transcript");
    expect([...details.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "installer narration, first paragraph.",
      "Second paragraph.",
    ]);
  });

  it("explains a signing failure and recovers on Try again", async () => {
    h.signImpl.current = async () => ({ data: null, error: { message: "fetch failed" } });
    await openInstaller();
    expect(container.querySelector("video")).toBeNull();
    expect(text()).toContain("The video couldn't be opened.");
    h.signImpl.current = okSign;
    await click(buttons("Try again")[0]);
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("re-signs and resumes at the same moment when playback fails mid-sitting", async () => {
    await openInstaller();
    const video = container.querySelector("video")! as HTMLVideoElement;
    video.currentTime = 120;
    await act(async () => {
      video.dispatchEvent(new Event("timeupdate"));
      video.dispatchEvent(new Event("error"));
    });
    await settle();
    expect(text()).toContain("The link may have expired");
    await click(buttons("Try again")[0]);
    const again = container.querySelector("video")! as HTMLVideoElement;
    await act(async () => {
      again.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(again.currentTime).toBe(120);
  });

  it("keeps playing without captions when they fail, and says the transcript has the words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await openInstaller();
    expect(container.querySelector("video")).not.toBeNull();
    expect(container.querySelector("video track")).toBeNull();
    expect(text()).toContain("Captions couldn't load.");
  });

  it("writes nothing anywhere — no row, no upload, no RPC", async () => {
    await openInstaller();
    await click(buttons(/Jump to 1:30/)[0]);
    expect(h.writes).toEqual([]);
  });
});

describe("a second account on the same phone", () => {
  it("closes the first person's player, revokes their captions and shows only the new shelf", async () => {
    h.currentUser.current = "u-owner";
    h.role.current = "owner";
    h.catalogByUser.set("u-owner", ALL);
    h.catalogByUser.set("u-installer", [row("installer")]);
    await mount();
    await click(buttons("Watch Leadership walkthrough")[0]);
    expect(container.querySelector("video")!.getAttribute("src")).toContain("leadership/");
    expect(created).toEqual(["blob:captions-0"]);

    await switchUser("u-installer", "installer");
    expect(container.querySelector("video")).toBeNull();
    expect(revoked).toContain("blob:captions-0");
    expect(text()).not.toContain("Leadership walkthrough");
    expect(container.querySelectorAll(".uf-card")).toHaveLength(1);
    // The owner's catalog (with its transcripts) is gone from the cache.
    expect(qc.getQueryData(["appTrainingVideos", "u-owner"])).toBeUndefined();
  });

  it("closes a higher-role player when the owner switches preview to installer", async () => {
    h.currentUser.current = "u-owner";
    h.role.current = "owner";
    h.catalogByUser.set("u-owner", ALL);
    await mount();
    await click(buttons("Watch Leadership walkthrough")[0]);
    expect(container.querySelector("video")).not.toBeNull();
    await act(async () => setPreviewRole("installer"));
    await settle();
    expect(container.querySelector("video")).toBeNull();
    expect(text()).not.toContain("leadership narration");
    expect(revoked).toContain("blob:captions-0");
    expect([...container.querySelectorAll(".uf-card h3")].map((e) => e.textContent)).toEqual(["Installer walkthrough"]);
    // Ending the preview shows the owner's shelf again, not the old player.
    await act(async () => setPreviewRole("owner"));
    await settle();
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelectorAll(".uf-card")).toHaveLength(3);
  });

  it("drops a signature that arrives after the switch", async () => {
    h.currentUser.current = "u-owner";
    h.role.current = "owner";
    h.catalogByUser.set("u-owner", ALL);
    h.catalogByUser.set("u-installer", [row("installer")]);
    let release: (() => void) | null = null;
    h.signImpl.current = (paths) =>
      new Promise((resolve) => {
        release = () => resolve(okSign(paths));
      });
    await mount();
    await click(buttons("Watch Leadership walkthrough")[0]);
    expect(text()).toContain("Preparing the video");

    await switchUser("u-installer", "installer");
    await act(async () => {
      release!();
    });
    await settle();
    expect(container.querySelector("video")).toBeNull();
    expect(text()).not.toContain("Leadership walkthrough");
    // The late answer's captions blob, if one was made, is revoked at once.
    for (const u of created) expect(revoked).toContain(u);
  });

  it("aborts an in-flight caption download when the account changes", async () => {
    h.currentUser.current = "u-owner";
    h.role.current = "owner";
    h.catalogByUser.set("u-owner", ALL);
    h.catalogByUser.set("u-installer", [row("installer")]);
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Promise<Response>(() => {}); // stalls, and ignores its signal
      }),
    );
    await mount();
    await click(buttons("Watch Leadership walkthrough")[0]);
    expect(text()).toContain("Preparing the video");
    expect(signals).toHaveLength(1);
    await switchUser("u-installer", "installer");
    expect(signals[0].aborted).toBe(true);
    expect(container.querySelector("video")).toBeNull();
    expect(created).toEqual([]);
  });

  it("signing out empties the tab", async () => {
    h.currentUser.current = "u-installer";
    h.catalogByUser.set("u-installer", [row("installer")]);
    await mount();
    expect(container.querySelectorAll(".uf-card")).toHaveLength(1);
    await switchUser(null, null);
    expect(container.querySelectorAll(".uf-card")).toHaveLength(0);
    expect(qc.getQueryData(["appTrainingVideos", "u-installer"])).toBeUndefined();
  });
});
