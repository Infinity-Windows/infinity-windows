# Crew invites: how a new person gets a login

## For Taylor

**To add someone:** open the app → **People** → **Crew access** → type their
name, choose what they can do, tap **Add & get their code**. A code appears.
Tap **Text it to them** and pick them out of your contacts.

**What they do:** they tap the link, pick a password, and they are in. No email,
no waiting for approval, nothing for you to approve afterwards.

**The code dies after 7 days and works for one person, once.** If it goes to the
wrong person, tap **Cancel** next to their name and add them again.

**Somebody quit:** find them under "Who has access" and tap **Remove**. They
cannot sign in again. Their hours and finished installs stay on the job records.
Tap **Let them back in** if they come back.

**A login you want gone for good:** tap **Remove this login…** (owner only).
It tells you what it is about to do before it does it — "Nothing on file for
Eduardo, the account will be deleted and the email freed", or "Enrique has 14
punches and 3 receipts on file, the login will be closed, the email freed, and
every record kept under his name". Either way **the email address comes free**,
so you can add that person again and they get a brand-new login. There is no
undo, and the app never deletes anybody's work.

**Somebody forgot their password:** tap **New password code** next to their name
and text them the new code. (The "Reset password" button on the sign-in screen
sends an email, and this app has no email sender, so it will not work.)

**You never need to open the Supabase dashboard for any of this**, and there is
nothing to paste anywhere. Do not screenshot a code into a group chat — treat it
like a key to the front door until it has been used.

## For whoever maintains this

### Why a texted code and not an emailed invite

Verified against the live project (`czprjcskmzzagdztqonm`) on 2026-07-29 via the
public `/auth/v1/settings` endpoint:

| Setting             | Value   | Consequence                                   |
| ------------------- | ------- | --------------------------------------------- |
| `disable_signup`    | `true`  | Public signup is off, and stays off.          |
| `external.phone`    | `false` | No SMS/OTP login. Supabase cannot text anyone.|
| `anonymous_users`   | `false` | No anonymous sessions.                        |
| `mailer_autoconfirm`| `false` | A new account would await a confirmation mail.|

On top of that there is no SMTP sender configured, and Supabase's built-in
mailer is capped at a couple of messages an hour — not a way to onboard a crew.
So **no invite may depend on Supabase delivering anything.** The owner sends the
code himself from his own phone, through his own messaging app, via the Web Share
sheet (with an `sms:` fallback). That path has no rate limit and no silent
failure mode.

**Since wave H (2026-09-04) the app CAN send one kind of email**, and it changes
nothing above. `supabase/functions/send-email` mails a general contractor his
GC link over Resend's HTTP API — one recipient, stored on the link, with the
body written inside the function. It is not Supabase Auth's mailer, so it has no
bearing on invites, confirmations or password resets, and it is not a relay:
nothing else in this app may use it to send anything to anybody. A crew invite
is still a code the owner texts.

#### Which address that email comes from

The company answers to two names, and each job says which one its builder
hears. Since 2026-09-04 the From line follows that choice, so an STG job's
builder gets mail from the STG mailbox and a Forge job's builder gets mail from
the Forge one. The addresses are settings, not code — the owner can move either
mailbox without anybody changing this repo.

| Setting            | Used for                                    |
| ------------------ | ------------------------------------------- |
| `EMAIL_FROM_STG`   | Jobs whose GC sees us as STG Windows & Doors|
| `EMAIL_FROM_FORGE` | Jobs whose GC sees us as Forge Windows and Doors |
| `EMAIL_FROM`       | Both, when one mailbox covers both names    |

**All three are optional and all three are checked in that order** — the
brand's own address first, then `EMAIL_FROM`, then the built-in
`office@forgewd.com`. Nothing has to be set for the feature to work, and no
deploy fails because an address is missing. Set them in the Supabase dashboard
under Project Settings → Edge Functions → Secrets, the same place
`RESEND_API_KEY` goes.

Either a bare address (`office@stgwindows.com`) or an address with a name in
front of it (`STG Windows <office@stgwindows.com>`) is accepted; with a bare
one, the brand's own name is put in front automatically, which is what the
builder sees. **Whatever address is used has to be on a domain verified in
Resend**, or Resend refuses the send — and when it does, the GC card on the job
shows Resend's own words rather than a shrug. An address that is not an address
at all is refused before anything is sent, in a sentence naming which of the
three settings to fix. After a send goes through, the card says which mailbox
it came from.

`mailer_autoconfirm: false` is why redemption creates the user with
`email_confirm: true`: a confirmation email nobody can receive is a locked-out
crew member. The invite is the verification — a supervisor named this person
before the code existed.

### Why a password set on first use

Magic links and password resets both need mail, so they are unavailable. A
one-time code that logs you in without a password would leave the crew member
with no way back after a session expires or a phone is wiped, and re-inviting
would collide with the account that already exists. A password chosen at
redemption is durable, and the secret never travels server-to-client: they type
it, the server stores Supabase's hash of it. Length-only validation (8+), because
character-class rules produce `Winter2026!` on the inside of a hard hat.

The day-to-day burden is one password, once: the PWA keeps the session and
`PinGate` handles unlocking after that. The recovery path is `reissue_login`,
which is why that action is gated exactly as hard as inviting.

### Why the link is `?join=CODE` on the root

The app is served from `/infinity-windows/` on GitHub Pages, a static host with
no rewrite rules, and it uses `BrowserRouter`. `…/infinity-windows/` always
resolves; `…/infinity-windows/join` would be GitHub's 404 unless a fallback page
happens to be deployed. A new hire's only code must not land on a blank page, so
the code rides in a query on the URL that cannot miss, and `App.tsx` picks it up
from `window.location.search` before the router is involved.

A single-page `404.html` fallback landed separately in #199, which fixes deep
links in general — but the invite deliberately does not rely on it, so the link
still works if that fallback is ever missing or a stale copy is cached.

**No Supabase Auth redirect allow-listing is involved**, because this is not an
auth callback. It is an ordinary page carrying a code. Nothing has to be pasted
into the Supabase dashboard.

### The escalation rule

`canInviteRole` in `supabase/functions/_shared/crewInvites.ts` is the single
definition, imported by both the edge function and the UI so they cannot drift:

- caller must be **supervisor or above** (the same floor as
  `public.set_profile_role`, because "invite as foreman" and "promote to foreman"
  are the same power);
- caller may **never** name a role above their own rank.

An installer cannot invite at all. A supervisor cannot invite an owner. Enforced
in three independent places:

1. `manage-crew-access`, reading the caller's role from `profiles` — never from
   the request body;
2. the `guard_crew_invite_rank` trigger, comparing the stored role of
   `invited_by` (a column the client cannot set);
3. `redeem-crew-invite`, which copies the role off the stored invite row, so a
   redeemer cannot ask for a better one.

`canManageMember` applies the same ladder to revoking access and to re-issuing a
login, since re-issuing lets the code-holder set that account's password.

### Expiry and single use

7 days (`INVITE_TTL_DAYS`). Single use is enforced by an atomic
`UPDATE … WHERE redeemed_at IS NULL` in `redeem-crew-invite`, not by a
read-then-write, so two people racing a forwarded code cannot both succeed.
If anything fails after the claim, the claim is released so a transient error
does not burn the person's only code.

Codes are 10 symbols from a 31-symbol alphabet with no `I L O 0 1` (~49.5 bits),
stored only as PBKDF2-SHA256 at 100k iterations. The salt is fixed and not
secret — the lookup must be deterministic — so the iteration count plus the
entropy is the defence, and a stolen backup of the table is not directly
redeemable.

### Removing access bans, it does not delete

`remove_access` bans the auth user and stamps `profiles.access_revoked_at`. It
does not delete, because a departed installer still authored real production
history (shifts, installs, QC sign-offs, chat) and deleting the auth user would
cascade or orphan it. It refuses to remove the last owner with working access,
and refuses to remove yourself.

`profiles.active` was NOT reused for this: the Roster renders it as
"On site / Off today" and a foreman toggles it daily. It is availability, not
permission.

### The third door: `purge_login` frees the email

`remove_access` above leaves everything as it was, **including the address**.
Supabase Auth holds emails unique across `auth.users` forever, so a banned
account keeps its address hostage: `create_invite` answers "that email already
has an account" and there is no way past it. That is why "delete the account and
start fresh" was impossible, and it is what `purge_login` (owner only,
20260987000000) fixes. It picks between two shapes **by counting**, never by
asking:

- **Nothing on file** — `person_record_counts` returns zeroes for every table →
  `auth.admin.deleteUser`. `profiles.id` references `auth.users` ON DELETE
  CASCADE, so the profile goes with it, and there is nothing else to lose.
- **Anything on file** — nothing is deleted, ever. The auth user is banned, the
  profile is stamped `access_revoked_at` **and** `retired_at`, and the auth
  user's email is renamed to `<uid>@removed.invalid`. Every record still points
  at the same profile id, so "who installed this window" still answers, and the
  Roster shows the person under the name they always had, marked Removed.

`retired_at` is a third column with a third meaning, and the three are easy to
confuse:

| Column | Means | Reversible |
| --- | --- | --- |
| `active` | on site today | a foreman toggles it every morning |
| `access_revoked_at` | login switched off | yes — "Let them back in" |
| `retired_at` | login removed for good, email handed back | no — add them again |

The counting lives in SQL rather than in the edge function for a reason worth
keeping: wave Z's standing rule is that **no edge function may name the wage
table**, because they hold the service-role key and bypass RLS.
`app/src/lib/payRates.test.ts` enforces it by scanning every file under
`supabase/functions`, so the schema lives in the migration and in
`app/src/lib/purgeWords.ts` — and `app/src/lib/purgeWords.test.ts` reads the
migration and fails if the two lists ever stop agreeing.
