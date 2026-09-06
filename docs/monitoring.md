# Knowing when something breaks

Until now, nothing in this app told anybody when it broke.

A screen that crashed on a phone showed "Something went wrong" and wrote the
reason to a devtools console no installer will ever open. An edge function that
threw wrote its reason into Supabase's log viewer, which has no alert, keeps
nothing anybody looks at, and gives no way to find out that the receipt reader
has been failing since Tuesday other than an installer mentioning it. There is
no `window.onerror` and no `unhandledrejection` handler anywhere in `app/src`,
so anything that broke outside a React render was caught by nothing at all.

This is the plumbing that fixes that. **It is entirely optional and ships
switched off** — with no DSN set, the app and the functions behave exactly as
they did before, and the monitoring code is never even downloaded: it sits
behind a dynamic import nothing calls, *and* the build leaves its chunk out of
the service worker's precache list, which would otherwise pull all 83 kB of it
onto every phone on every release. Set a DSN and the chunk is precached again
on purpose, because a crash in a dead zone cannot wait for a download.

## The five-character code

A crashed screen shows a short code — five characters, like `K7F3Q`. It is the
thing to read out over the phone: "it says K7F3Q."

- It is **not** the Sentry event id (a 32-character hex string nobody can say
  down a bad line). It is a fingerprint of the crash site — the same crash in
  the same place gives the same code — and it goes on the console line, on the
  bug row the app files itself, and onto the Sentry report as a `crash_code`
  tag. Searching any of the three for those five characters finds the others.
- The alphabet is Crockford base32: no I, L, O or U, so it survives being said
  out loud and typed back by whoever answered.
- It is stable within a build. Between builds the minified frame names shift and
  the same crash may get a new code; that is fine, because a code is only ever
  used to find the report it was born with.

The crashed screen also offers **Try again**, which re-renders rather than
reloading, so nobody is forced to lose the screen they were on. Anything already
saved on the phone — queued installs, photos waiting to send — is untouched by a
crash and the screen says so, in English and Spanish.

## What is sent

**Kept**, because a fix needs it:

| | |
|---|---|
| the error | its type, its message, and its stack |
| the release | the build id already compiled into the bundle (`VITE_BUILD_ID`, the commit sha) |
| the environment | `production` on `app.forgewd.com`, `preview` anywhere else |
| the route **pattern** | `/projects/:id/openings` — never the real ids |
| the request | method and route pattern only |
| tags | `role` (the effective one), `build`, `offline`, `crash_code`, and for a function, its name |

**Never sent.** This app holds installers' faces, the addresses of the houses
they stand in, GPS stamps accurate to a few metres, payroll truth and the notes
they write about each other's work. None of it may leave in an error report, so
every event goes through one tested scrubber
([`supabase/functions/_shared/scrub.ts`](../supabase/functions/_shared/scrub.ts),
tested in `app/src/lib/monitoring/scrub.test.ts`) before it is handed to the
transport:

- **email addresses and phone numbers**, wherever they appear — including inside
  an error message, which keeps the sentence and masks the address
- **latitude, longitude and accuracy** — and a lat/lng pair written into a
  sentence, down to three decimal places, which is about a hundred metres
- **a street address written into a sentence**, matched on its shape:
  *"Home Depot, 1425 Sagebrush Hollow Dr"* keeps the shop and loses the house
- **anything under a key whose words include** `note`, `notes`, `caption`,
  `address`, `display_name`, `name`, `email`, `phone`, `pin`, `token`,
  `password` or `authorization`. Matched on words, so `job_address`,
  `installer_email` and `crew_notes` all go too — and the words this app's own
  rows use for the same three things: a house (`site`, `street`, `city`, `zip`,
  `location`, `place`), a person (`driver`, `customer`, `contact`, `member`,
  `crew`) and free text somebody typed (`description`, `memo`, `title`,
  `details`, `summary`, `text`, `label`)
- **request and response bodies**, headers and cookies. A fetch breadcrumb keeps
  its method, its status and its route pattern, and loses everything else
- **what a tapped control says about a person.** The SDK writes a tap's
  breadcrumb itself, as a path to the element — and it inlines that element's
  `aria-label`, `title`, `alt` and `name`, which on this app's screens are a
  crew member's name (*"Schedule Maria Gomez on Tuesday"*), a photo's caption,
  and the street address on the Directions button. The attribute values come
  off; `button.cb-plus` is what survives, and it is the part that says which
  control was tapped
- **console breadcrumb messages**, whole. The SDK JSON-stringifies every
  non-primitive argument into one, so a single `console.error("saving", row)`
  would carry an install row's notes and captions out. The crash itself still
  arrives with its own message and stack
- **query strings**, whole. PostgREST puts the filter there, so
  `?opening_id=eq.<uuid>` and `?select=…,notes` both live in one
- **the whole `user` object** — no id, no email, no IP address. `role` is the
  only thing about a person that goes out
- **stack-frame local variables**, which are the quiet leak: a frame inside the
  receipt save holds the note, the caption and the address as ordinary variables
- **session tokens and API keys** that found their way into a message

There is **no Session Replay** — recording a crew member's screen would ship
faces, addresses and pay — and **no performance tracing**; `tracesSampleRate` is
0 and errors are the only thing sampled. Replay is not merely switched off: the
build takes `rrweb`, replay and feedback out of the chunk altogether, which is
why the monitoring chunk is 83 kB rather than 475 kB.

One consequence worth knowing: because `name` is a sensitive word, the browser
and OS names Sentry would normally attach are redacted too. That is the trade
this makes on purpose — over-redacting costs a little debugging context, and
under-redacting costs a crew member's privacy.

**The one thing the scrubber cannot do for you.** The error's own message is
kept, deliberately — *"could not save the receipt"* is the whole value of a
report — and only the patterns above are masked inside it. A **person's name**
written into free text matches no pattern and will go out as typed. So when you
write an error, name the thing that broke, not the person: put the id in the
console line and a plain sentence in the error. That rule is the reason `name`,
`driver` and `description` are on the key list at all.

## Turning it on

Two DSNs, and they are not the same kind of thing.

### The browser: repo secret `VITE_SENTRY_DSN`

Settings → Secrets and variables → Actions → **New repository secret**, named
exactly `VITE_SENTRY_DSN`. `deploy-pages.yml` passes it into the build; unset, it
arrives as an empty string and the app never loads the SDK at all.

**This DSN is public, by design.** It is compiled into the bundle, which is
served to anyone, and this repository is public. That is how every browser SDK
works and it is not a leak: a DSN only permits *sending* events, never reading
them.

### The functions: GitHub secret `SENTRY_DSN`

Same place, named exactly `SENTRY_DSN`. The backend deploy pushes it into the
Supabase project with the other function secrets
(`scripts/sync-function-secrets.sh`), so it has a backup and an owner rather than
living only in a dashboard. **This one is a real secret** and is never printed.

It is **optional** everywhere the secret census looks: every function wraps its
handler in `withSentry`, and that module feature-detects the DSN, so
`scripts/function_secrets.py` reports it under *optional* for all 23 functions
and under *required* for none. A deploy can never fail because nobody has made a
Sentry account. When GitHub does not hold it, the sync step passes over it in
silence — a warning on every merge about a feature nobody turned on is how
warnings stop being read.

### What actually gets reported

Every function's handler is wrapped in `withSentry`, which reports a throw that
**escapes** it. Most functions here catch everything themselves, though, and a
caught throw never escapes — so the seventeen that do call
`reportCaughtError(name, req, err)` from inside their own catch. Without that,
the receipt reader could fail every hour of every day and Sentry would show
nothing, which is the exact failure this page opens by describing.

Fourteen of those seventeen also used to answer `{"error": String(e)}` — a
Postgres constraint name shown to somebody standing at a window opening. They
now answer one plain sentence, the same one `withSentry` uses, and the real
reason goes to the function log and to Sentry. `functionSentry.test.ts` sweeps
all 23 functions and fails if either rule is dropped.

**Writing a new function?** If you catch your own errors, report them. If you do
not catch anything, `withSentry` has you covered.

### Alerts

Alert routing is **Sentry's own settings, not this repo**: in the Sentry project,
Alerts → create a rule → send to the ops Slack channel via Sentry's Slack
integration. Nothing here posts to Slack, and nothing here should — the one
place that decides who gets woken up should be the place that also decides what
counts as noise.

## Where it lives

| | |
|---|---|
| `app/src/lib/monitoring/sentry.ts` | the browser gate: no DSN, no import, no chunk |
| `app/src/lib/monitoring/scrub.ts` | the app's door to the shared scrubber |
| `app/src/lib/crashReport.ts` | the five-character code, the bug row, the console line |
| `app/src/components/ErrorBoundary.tsx` | the crash screen |
| `supabase/functions/_shared/scrub.ts` | the scrubber itself, shared by both sides |
| `supabase/functions/_shared/sentryCore.ts` | the function-side rules, unit-tested |
| `supabase/functions/_shared/sentry.ts` | the ten lines that touch `Deno.env` |

The scrubber has one implementation on purpose. Two copies would be two
scrubbers that agree on the day they are written and disagree the first time
somebody adds a key to one of them.
