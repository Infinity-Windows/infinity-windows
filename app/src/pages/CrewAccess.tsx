import { BackChip } from "../components/BackChip";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "../lib/errors";
import { getMyProfile } from "../lib/install/api";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import {
  createCrewInvite,
  listCrewAccess,
  listCrewInvites,
  reissueCrewLogin,
  removeCrewAccess,
  resendCrewInvite,
  restoreCrewAccess,
  revokeCrewInvite,
  type CrewAccessMember,
  type IssuedInvite,
} from "../lib/crewAccess";
import {
  buildInviteLink,
  canManageMember,
  expiresInWords,
  formatInviteCode,
  invitableRolesFor,
  inviteShareMessage,
  inviteStatus,
  INVITE_TTL_DAYS,
  isMintedCrewLogin,
  ROLE_TITLES,
  type CrewRoleName,
} from "../../../supabase/functions/_shared/crewInvites";

/**
 * "Crew access" — the screen an owner uses to add his own people.
 *
 * The job it replaces: opening the Supabase dashboard, creating an auth user by
 * hand, then setting a role. Self-signup is off (deliberately), so before this
 * existed the owner could not add anybody without a developer.
 *
 * The role dropdown only lists roles this person may actually grant, but that is
 * cosmetic — every rule is re-checked by the manage-crew-access edge function
 * against the caller's role as stored in the database. A hostile caller posting
 * straight at the function gets the same answer.
 */

/** The one-time code card. Shown after minting, and never recoverable after. */
function IssuedInviteCard({
  issued,
  onDone,
}: {
  issued: IssuedInvite;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const link = buildInviteLink(window.location.href, issued.code);
  const message = inviteShareMessage(
    issued.invite.display_name,
    issued.invite.role,
    link,
    issued.code,
  );

  const copy = async (what: "link" | "code", value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard is blocked in some in-app browsers. The code is on screen
      // either way, so there is nothing to recover from.
    }
  };

  /**
   * Open whatever the phone uses to send messages. The Web Share sheet is the
   * good path (it offers Messages, WhatsApp, AirDrop); `sms:` is the fallback
   * for desktop and browsers without it. The odd-looking `?&body=` is the form
   * both iOS and Android accept.
   */
  const share = async () => {
    const shareable = navigator as Navigator & {
      share?: (data: { text: string; title?: string }) => Promise<void>;
    };
    if (shareable.share) {
      try {
        await shareable.share({
          title: "Forge Windows login",
          text: message,
        });
        return;
      } catch {
        // The user dismissed the sheet, or it is unavailable. Fall through.
      }
    }
    window.location.href = `sms:?&body=${encodeURIComponent(message)}`;
  };

  return (
    <div className="detail-card invite-issued">
      <p style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>
        Send this to {issued.invite.display_name.split(/\s+/)[0]}
      </p>
      <p className="muted" style={{ margin: "6px 0 12px", lineHeight: 1.55 }}>
        This is shown once and is not saved anywhere — send it now. It works for{" "}
        {INVITE_TTL_DAYS} days, for one person, once. If it goes astray, tap
        Cancel next to their name and add them again.
      </p>

      <div className="invite-code" aria-label="Invite code">
        {formatInviteCode(issued.code)}
      </div>

      <div className="row-gap" style={{ flexWrap: "wrap", marginTop: 12 }}>
        <button className="button-like button-like--primary" onClick={share}>
          Text it to them
        </button>
        <button className="button-like" onClick={() => copy("link", link)}>
          {copied === "link" ? "Link copied ✓" : "Copy link"}
        </button>
        <button
          className="button-like"
          onClick={() => copy("code", formatInviteCode(issued.code))}
        >
          {copied === "code" ? "Code copied ✓" : "Copy code"}
        </button>
      </div>

      <p className="muted" style={{ margin: "12px 0 0", fontSize: 12, wordBreak: "break-all" }}>
        {link}
      </p>
      {isMintedCrewLogin(issued.invite.email) ? (
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
          They have no email on file, so their username will be{" "}
          <code>{issued.invite.email}</code>. They will not need to type it — the
          link signs them in — but write it down if you want a record.
        </p>
      ) : (
        <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>
          They will sign in as <code>{issued.invite.email}</code> with the
          password they pick.
        </p>
      )}

      <div className="row-gap" style={{ marginTop: 12 }}>
        <button className="link" onClick={onDone}>
          Done — I've sent it
        </button>
      </div>
    </div>
  );
}

export function CrewAccess() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole } = useEffectiveRole();
  const allowed = isSupervisorPlus(effectiveRole);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CrewRoleName>("installer");
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const members = useQuery({
    queryKey: ["crewAccess"],
    queryFn: listCrewAccess,
    enabled: allowed,
  });
  const invites = useQuery({
    queryKey: ["crewInvites"],
    queryFn: listCrewInvites,
    enabled: allowed,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["crewInvites"] });
    queryClient.invalidateQueries({ queryKey: ["crewAccess"] });
    queryClient.invalidateQueries({ queryKey: ["profiles"] });
  };

  const onIssued = (result: IssuedInvite) => {
    setError(null);
    setIssued(result);
    setName("");
    setEmail("");
    refresh();
  };
  const onFailed = (err: unknown) => {
    setIssued(null);
    setError(formatApiError(err));
  };

  const add = useMutation({
    mutationFn: () =>
      createCrewInvite({ display_name: name.trim(), role, email }),
    onSuccess: onIssued,
    onError: onFailed,
  });
  const resend = useMutation({
    mutationFn: (id: string) => resendCrewInvite(id),
    onSuccess: onIssued,
    onError: onFailed,
  });
  const reissue = useMutation({
    mutationFn: (id: string) => reissueCrewLogin(id),
    onSuccess: onIssued,
    onError: onFailed,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeCrewInvite(id),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: onFailed,
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeCrewAccess(id),
    onSuccess: () => {
      setError(null);
      setConfirmRemove(null);
      refresh();
    },
    onError: onFailed,
  });
  const restore = useMutation({
    mutationFn: (id: string) => restoreCrewAccess(id),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: onFailed,
  });

  // Only the roles this person may actually grant. The server enforces the same
  // rule; this stops the owner-only option even appearing for a supervisor.
  const roleOptions = useMemo(
    () => invitableRolesFor(effectiveRole),
    [effectiveRole],
  );

  const now = new Date();
  const all = invites.data ?? [];
  const pending = all.filter((i) => inviteStatus(i, now) === "pending");
  const past = all.filter((i) => inviteStatus(i, now) !== "pending");
  const people = members.data ?? [];
  const live = people.filter((p) => !p.access_revoked_at);
  const removed = people.filter((p) => p.access_revoked_at);

  if (me.data && !allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Crew access</h1>
          <BackChip fallback="/team" label="Back" />
        </header>
        <p className="muted">
          Only a supervisor or the owner can add or remove crew.
        </p>
      </div>
    );
  }

  const busy =
    add.isPending || resend.isPending || reissue.isPending ||
    revoke.isPending || remove.isPending || restore.isPending;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">People</p>
          <h1>Crew access</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Add someone, send them a login, take it away again.
          </p>
        </div>
        <BackChip fallback="/team" label="Back" />
      </header>

      {error && <p className="error">{error}</p>}
      {issued && (
        <IssuedInviteCard issued={issued} onDone={() => setIssued(null)} />
      )}

      {/* ---------------------------------------------------------------- */}
      <h2>Add someone</h2>
      <div className="detail-card">
        <label className="field-label" htmlFor="invite-name">
          Their name
        </label>
        <input
          id="invite-name"
          placeholder="e.g. Mike Alvarez"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="field-label" htmlFor="invite-role">
          What they can do
        </label>
        <select
          id="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as CrewRoleName)}
        >
          {roleOptions.map((r) => (
            <option key={r} value={r}>
              {ROLE_TITLES[r]}
            </option>
          ))}
        </select>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 }}>
          {ROLE_HINTS[role]}
        </p>

        <label className="field-label" htmlFor="invite-email">
          Their email — optional
        </label>
        <input
          id="invite-email"
          type="email"
          placeholder="Leave blank if they don't use email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5 }}>
          Nothing is ever emailed to them — you send the login yourself by text.
          The address is only the name they type to sign in, so leave it blank if
          they don't have one.
        </p>

        <div className="row-gap" style={{ marginTop: 12 }}>
          <button
            className="button-like button-like--primary"
            disabled={busy || !name.trim() || roleOptions.length === 0}
            onClick={() => add.mutate()}
          >
            {add.isPending ? "Making their login..." : "Add & get their code"}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      <h2>Waiting to be used ({pending.length})</h2>
      {pending.length === 0 && (
        <p className="muted">
          Nobody is waiting. Codes you send show up here until they're used.
        </p>
      )}
      <ul className="unit-list work-list">
        {pending.map((invite) => (
          <li key={invite.id} className="find-row" style={{ flexWrap: "wrap" }}>
            <div>
              <strong>{invite.display_name}</strong>{" "}
              <span className="muted">
                {ROLE_TITLES[invite.role as CrewRoleName] ?? invite.role}
              </span>
              <div className="muted" style={{ fontSize: 12 }}>
                {expiresInWords(invite.expires_at, now)}
                {invite.target_user_id ? " · new password code" : ""}
              </div>
            </div>
            <div className="row-gap" style={{ marginLeft: "auto" }}>
              <button
                className="button-like"
                disabled={busy}
                onClick={() => resend.mutate(invite.id)}
              >
                New code
              </button>
              <button
                className="button-like danger-outline"
                disabled={busy}
                onClick={() => revoke.mutate(invite.id)}
              >
                Cancel
              </button>
            </div>
          </li>
        ))}
      </ul>

      {/* ---------------------------------------------------------------- */}
      <h2>Who has access ({live.length})</h2>
      <ul className="unit-list work-list">
        {live.map((person) => (
          <MemberRow
            key={person.id}
            person={person}
            myRole={effectiveRole}
            isMe={person.id === me.data?.id}
            busy={busy}
            confirming={confirmRemove === person.id}
            onConfirm={() => setConfirmRemove(person.id)}
            onCancelConfirm={() => setConfirmRemove(null)}
            onRemove={() => remove.mutate(person.id)}
            onReissue={() => reissue.mutate(person.id)}
          />
        ))}
      </ul>

      {removed.length > 0 && (
        <>
          <h2>Access switched off ({removed.length})</h2>
          <p className="muted" style={{ fontSize: 12, lineHeight: 1.55 }}>
            They can't sign in. Their past work — hours, installs, sign-offs — is
            kept, so job records stay complete.
          </p>
          <ul className="unit-list work-list">
            {removed.map((person) => (
              <li key={person.id} className="find-row">
                <div>
                  <strong>{person.display_name ?? "Unnamed"}</strong>{" "}
                  <span className="muted">
                    {ROLE_TITLES[person.role as CrewRoleName] ?? person.role}
                  </span>
                </div>
                <div className="row-gap" style={{ marginLeft: "auto" }}>
                  <button
                    className="button-like"
                    disabled={busy || !canManageMember(effectiveRole, person.role).ok}
                    onClick={() => restore.mutate(person.id)}
                  >
                    Let them back in
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {past.length > 0 && (
        <>
          <h2>
            <button
              className="link"
              onClick={() => setShowHistory((v) => !v)}
              style={{ font: "inherit", padding: 0 }}
            >
              Codes already dealt with ({past.length}) {showHistory ? "▴" : "▾"}
            </button>
          </h2>
          {showHistory && (
            <ul className="unit-list work-list">
              {past.map((invite) => (
                <li key={invite.id} className="find-row">
                  <div>
                    <strong>{invite.display_name}</strong>{" "}
                    <span className="muted">
                      {ROLE_TITLES[invite.role as CrewRoleName] ?? invite.role}
                    </span>
                  </div>
                  <span
                    className={
                      inviteStatus(invite, now) === "redeemed" ? "ok" : "muted"
                    }
                    style={{
                      marginLeft: "auto",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      fontSize: 11,
                    }}
                  >
                    {STATUS_WORDS[inviteStatus(invite, now)]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_WORDS: Record<string, string> = {
  redeemed: "Used",
  revoked: "Cancelled",
  expired: "Ran out",
  pending: "Waiting",
};

/** Plain English for what each role unlocks, so the choice is not a guess. */
const ROLE_HINTS: Record<CrewRoleName, string> = {
  installer:
    "Their own jobs, scanning, the clock, and Ask Forge. Nothing about money.",
  foreman:
    "Everything an installer sees, plus the crew roster, timecards, quality sign-off and issues.",
  supervisor:
    "Everything a foreman sees, plus scheduling, vehicles, and adding or removing crew themselves.",
  owner:
    "Everything, including job costing and margins. Only give this to someone who should see the money.",
};

function MemberRow({
  person,
  myRole,
  isMe,
  busy,
  confirming,
  onConfirm,
  onCancelConfirm,
  onRemove,
  onReissue,
}: {
  person: CrewAccessMember;
  myRole: string | null | undefined;
  isMe: boolean;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onRemove: () => void;
  onReissue: () => void;
}) {
  // Someone senior to you is not yours to change. The server refuses this too;
  // hiding the buttons just avoids offering an action that cannot work.
  const mayManage = canManageMember(myRole, person.role).ok && !isMe;

  return (
    <li className="find-row" style={{ flexWrap: "wrap" }}>
      <div>
        <strong>{person.display_name ?? "Unnamed"}</strong>{" "}
        <span className="muted">
          {ROLE_TITLES[person.role as CrewRoleName] ?? person.role}
        </span>
        {isMe && <span className="muted" style={{ fontSize: 12 }}> · you</span>}
      </div>
      {mayManage && (
        <div className="row-gap" style={{ marginLeft: "auto", flexWrap: "wrap" }}>
          {confirming ? (
            <>
              <span className="muted" style={{ fontSize: 12 }}>
                Stop {person.display_name?.split(/\s+/)[0] ?? "them"} signing in?
              </span>
              <button
                className="button-like danger-outline"
                disabled={busy}
                onClick={onRemove}
              >
                Yes, remove
              </button>
              <button className="link" onClick={onCancelConfirm}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button className="button-like" disabled={busy} onClick={onReissue}>
                New password code
              </button>
              <button className="button-like danger-outline" onClick={onConfirm}>
                Remove
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
