// Test-only mount for e2e/ai-daily-logs.spec.ts. Plain JS (no JSX) so it needs
// no build config of its own; everything it renders is the real app code.
import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "/src/index.css";
import { AiDailyLogCard } from "/src/components/aiDailyLogs/AiDailyLogCard.tsx";
import { useAiDailyLogDraft } from "/src/lib/aiDailyLogs/useAiDailyLogDraft.ts";
import { preparePhoto } from "/src/lib/aiDailyLogs/photos.ts";
import { enqueueUpload } from "/src/lib/offline/outbox.ts";
import { applyDailyLogReply, dailyLogAskContext, dailyLogContextForMessage } from "/src/lib/aiDailyLogs/askBridge.ts";
import { rememberSignedIn } from "/src/lib/signedIn.ts";
import { LanguageContext } from "/src/lib/i18n/context.ts";
import { CATALOG } from "/src/lib/i18n/catalog.ts";
import { translate } from "/src/lib/i18n/translate.ts";

const ACTORS = {
  ana: { userId: "00000000-0000-4000-8000-00000000a001", email: "ana@example.test", displayName: "Ana" },
  ben: { userId: "00000000-0000-4000-8000-00000000b002", email: "ben@example.test", displayName: "Ben" },
};
const JOBS = [
  { projectId: "00000000-0000-4000-8000-000000000090", label: "SMITH · Smith Residence" },
  { projectId: "00000000-0000-4000-8000-000000000091", label: "SMYTHE · Smythe Ranch" },
];
const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "es" ? "es" : "en";

function Harness() {
  const [who, setWhoState] = useState(params.get("user") ?? "ana");
  // A real sign-in changes both what the screen shows and the stored session.
  const setWho = (w) => { window.__authAs = w; setWhoState(w); };
  const actor = ACTORS[who] ?? null;
  rememberSignedIn(actor ? { user: { email: actor.email } } : null);
  // The real stamp pipeline; a test may hold it (window.__holdPrepare) to look
  // at the card while a photo is still being prepared.
  const ctl = useAiDailyLogDraft(actor, {
    prepare: async (file, opts) => { if (window.__holdPrepare) await window.__holdPrepare; return preparePhoto(file, opts); },
    // The real upload queue; a test may make it refuse (a full phone).
    enqueueUpload: async (input) => {
      if (window.__failEnqueue) throw new Error("Couldn't save this offline (storage may be full): QuotaExceededError");
      return enqueueUpload(input);
    },
  });
  useEffect(() => {
    window.__aiLog = {
      ctl, jobs: JOBS, switchTo: setWho,
      // Only the auth session changes (a token for another account landed).
      switchSessionOnly: (w) => { window.__authAs = w; },
      reply: (raw) => applyDailyLogReply(ctl, raw),
      context: () => dailyLogAskContext(ctl.snapshot()),
      firstMessage: (text) => dailyLogContextForMessage(ctl, text, { cardOpen: false }),
    };
    if (actor && !ctl.loading && !ctl.draft) void ctl.start();
  }, [ctl, actor]);
  return h("main", { style: { padding: 12 } }, h(AiDailyLogCard, { controller: ctl, jobs: JOBS }));
}

const value = { lang, t: (k, v) => translate(CATALOG, lang, k, v), setLang: () => {}, needsChoice: false };
createRoot(document.getElementById("root")).render(
  h(QueryClientProvider, { client: new QueryClient() },
    h(MemoryRouter, null, h(LanguageContext.Provider, { value }, h(Harness)))),
);
