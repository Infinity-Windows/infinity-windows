// Wave S, S5: the owner's builder-logins screen. Owner-only, twice over —
// the route (App.tsx's <RequireRole path="/account/builders">) and this
// component's own isOwner(effectiveRole) fallback, same belt-and-suspenders
// pattern AiSpend.tsx already uses for an owner-only screen. The database
// enforces the real floor regardless (my_role_rank() >= 3 inside every RPC
// this page calls); both of these are just how the screen behaves for
// everyone else who reaches the URL.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BackChip } from "../components/BackChip";
import { isOwner } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { pushToast, toastError } from "../lib/toast";
import { QueryError, SkeletonList } from "../components/ui/States";
import {
  addPartnerInvite,
  grantPartnerJob,
  listGrantableJobs,
  listPartnerInvites,
  listPartnerJobGrants,
  listPartnerLogins,
  removePartnerInvite,
  revokePartnerJob,
  type GrantableJob,
} from "../lib/accountBuilders";

export function AccountBuilders() {
  const queryClient = useQueryClient();
  const { effectiveRole } = useEffectiveRole();
  const canOpen = isOwner(effectiveRole);

  const logins = useQuery({ queryKey: ["partnerLogins"], queryFn: listPartnerLogins, enabled: canOpen });
  const invites = useQuery({ queryKey: ["partnerInvites"], queryFn: listPartnerInvites, enabled: canOpen });
  const grants = useQuery({ queryKey: ["partnerJobGrants"], queryFn: listPartnerJobGrants, enabled: canOpen });
  const jobs = useQuery({ queryKey: ["grantableJobs"], queryFn: listGrantableJobs, enabled: canOpen });

  const [email, setEmail] = useState("");

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["partnerLogins"] });
    void queryClient.invalidateQueries({ queryKey: ["partnerInvites"] });
    void queryClient.invalidateQueries({ queryKey: ["partnerJobGrants"] });
  };

  const sendInvite = useMutation({
    mutationFn: () => addPartnerInvite(email.trim()),
    onSuccess: () => {
      setEmail("");
      pushToast("Invite added", "info");
      invalidateAll();
    },
    onError: (e) => toastError(e),
  });

  const revokeInvite = useMutation({
    mutationFn: (addr: string) => removePartnerInvite(addr),
    onSuccess: () => {
      pushToast("Invite revoked", "info");
      invalidateAll();
    },
    onError: (e) => toastError(e),
  });

  const toggleGrant = useMutation({
    mutationFn: ({ partnerId, projectId, granted }: { partnerId: string; projectId: string; granted: boolean }) =>
      granted ? revokePartnerJob(partnerId, projectId) : grantPartnerJob(partnerId, projectId),
    onSuccess: invalidateAll,
    onError: (e) => toastError(e),
  });

  if (!canOpen) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Builder logins</h1>
          <BackChip fallback="/" label="Home" />
        </header>
        <p className="muted">
          Inviting a builder login and granting jobs is the owner's call. Nothing you do is being
          limited by this screen.
        </p>
      </div>
    );
  }

  const grantedSet = new Set(
    (grants.data ?? []).map((g) => `${g.partner_profile_id}:${g.project_id}`),
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Builder logins</h1>
          <p className="muted" style={{ margin: 0 }}>
            This person sees ONLY the jobs you grant, as the STG Windows &amp; Doors view.
          </p>
        </div>
        <BackChip fallback="/" label="Home" />
      </header>

      <div className="detail-card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>Invite a builder</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Add their email here, then get them signed in with it — through your normal process for
          that. The first time they sign in with this email, they automatically become a builder
          login: no crew screen, no crew data, only the jobs you grant below.
        </p>
        <form
          className="row-gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) sendInvite.mutate();
          }}
        >
          <input
            type="email"
            placeholder="name@builder.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            type="submit"
            className="button-like active-pill"
            disabled={sendInvite.isPending || !email.trim()}
          >
            Add invite
          </button>
        </form>
      </div>

      {invites.isLoading && <SkeletonList rows={2} />}
      {invites.isError && <QueryError error={invites.error} onRetry={() => invites.refetch()} />}
      {invites.isSuccess && invites.data.length > 0 && (
        <div className="detail-card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Pending invites</h2>
          <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
            Added, not yet signed in.
          </p>
          {invites.data.map((inv) => (
            <div key={inv.email} className="row-between" style={{ padding: "6px 0" }}>
              <span>{inv.email}</span>
              <button
                type="button"
                className="button-like"
                onClick={() => revokeInvite.mutate(inv.email)}
                disabled={revokeInvite.isPending}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 15 }}>Builder logins</h2>
      {logins.isLoading && <SkeletonList rows={2} />}
      {logins.isError && <QueryError error={logins.error} onRetry={() => logins.refetch()} />}
      {logins.isSuccess && logins.data.length === 0 && (
        <p className="muted">No builder logins yet — add an invite above to create the first one.</p>
      )}
      {logins.isSuccess &&
        logins.data.map((login) => (
          <div key={login.id} className="detail-card" style={{ marginBottom: 12 }}>
            <p style={{ fontWeight: 650, margin: "0 0 8px" }}>{login.display_name}</p>
            {jobs.isLoading && <SkeletonList rows={2} />}
            {jobs.isSuccess && jobs.data.length === 0 && (
              <p className="muted" style={{ fontSize: 13 }}>
                No active or finished jobs to grant yet.
              </p>
            )}
            {jobs.isSuccess &&
              jobs.data.map((job: GrantableJob) => {
                const granted = grantedSet.has(`${login.id}:${job.id}`);
                return (
                  <label
                    key={job.id}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13.5 }}
                  >
                    <input
                      type="checkbox"
                      checked={granted}
                      disabled={toggleGrant.isPending}
                      onChange={() => toggleGrant.mutate({ partnerId: login.id, projectId: job.id, granted })}
                      // Explicit accent-color, same reasoning as .tcx-removed-
                      // toggle's own checkbox: without one, an unchecked box
                      // renders filled-dark under this app's dark theme
                      // instead of a plain outline.
                      style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
                    />
                    {job.name} <span className="muted">({job.job_code})</span>
                  </label>
                );
              })}
          </div>
        ))}
    </div>
  );
}
