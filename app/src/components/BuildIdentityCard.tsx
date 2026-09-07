import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Database, GitCommitHorizontal } from "lucide-react";
import { BUILD_ID, BUILT_AT } from "../lib/pwa/buildInfo";
import { fetchPublishedVersion } from "../lib/pwa/checkForUpdate";
import { buildIdentity } from "../lib/buildIdentity";
import { useT } from "../lib/i18n";

/**
 * Settings section: "Which app am I on?".
 *
 * Exists so two people can settle in five seconds whether they are looking at
 * the same thing. Both open this, read the one line at the top, and compare. If
 * the lines match they are on the same code and the same data, and any
 * disagreement about behaviour is real rather than an artefact of one of them
 * running an old bundle or a different database — which has happened twice and
 * cost days both times.
 *
 * The decision logic is in lib/buildIdentity, which is pure and tested; this
 * component only fetches the published build id and renders the result.
 */
export function BuildIdentityCard() {
  const t = useT();
  const [published, setPublished] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchPublishedVersion().then((v) => {
      if (live) setPublished(v?.buildId ?? null);
    });
    return () => {
      live = false;
    };
  }, []);

  const identity = useMemo(
    () =>
      buildIdentity({
        runningBuildId: BUILD_ID,
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
        publishedBuildId: published,
      }),
    [published],
  );

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(identity.fingerprint);
      setCopied(true);
    } catch {
      // Clipboard is blocked in plenty of contexts. The line is on screen and
      // selectable, so failing to copy is a minor inconvenience, not an error
      // worth interrupting anyone over.
    }
  }

  return (
    <section className="build-id" aria-label={t("buildId.ariaLabel")}>
      <div className="build-id-head">
        <div>
          <h2 className="perm-settings-title">{t("buildId.heading")}</h2>
          <p className="muted perm-settings-sub">
            {t("buildId.explain")}
          </p>
        </div>
        {/* The verdict label/hint below (lib/buildIdentity.ts) stay English —
            a pure diagnostic module shared with Diagnostics.tsx (out of this
            sweep's scope), and developer-troubleshooting copy ("copy
            app/.env.example…") rather than field-facing text. */}
        <span className={`perm-badge perm-badge-${identity.verdict.tone}`}>
          {identity.verdict.label}
        </span>
      </div>

      <div className="build-id-fingerprint">
        <code>{identity.fingerprint}</code>
        <button
          type="button"
          className="button-like build-id-copy"
          onClick={() => void copy()}
          aria-label={t("buildId.copyLine")}
        >
          {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
          {copied ? t("buildId.copied") : t("buildId.copy")}
        </button>
      </div>

      <p className="build-id-hint muted">{identity.verdict.hint}</p>

      <dl className="build-id-rows">
        <div className="build-id-row">
          <dt>
            <GitCommitHorizontal size={15} aria-hidden /> {t("buildId.code")}
          </dt>
          <dd>
            <code>{identity.build.commit ?? identity.build.raw ?? t("buildId.unknown")}</code>
            {identity.build.dirty && ` ${t("buildId.uncommittedChanges")}`}
            {BUILT_AT && (
              <span className="muted"> · {t("buildId.built", { time: formatBuiltAt(BUILT_AT) })}</span>
            )}
          </dd>
        </div>
        <div className="build-id-row">
          <dt>
            <Database size={15} aria-hidden /> {t("buildId.database")}
          </dt>
          <dd>
            <code>{identity.database.ref ?? t("buildId.none")}</code>
            {!identity.database.shared && (
              <span className="muted"> · {t("buildId.sharedOneIs", { ref: identity.database.expected })}</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * A build time is only ever read next to the build id, so the date matters far
 * less than "was this recent". Falls back to the raw string rather than showing
 * "Invalid Date" if the stamp is ever malformed.
 */
function formatBuiltAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
