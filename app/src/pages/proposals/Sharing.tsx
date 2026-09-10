import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { shareJob } from "../../lib/proposals/partner";
import type { Job, Bid, JobFile } from "../../lib/proposals/model";
import { formatApiError } from "../../lib/errors";
export function Sharing({
  job,
  bids,
  files,
}: {
  job: Job;
  bids: Bid[];
  files: JobFile[];
}) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [bidIds, setBids] = useState<string[]>([]);
  const [fileIds, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const toggle = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  async function save(remove = false) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await shareJob(job, email, bidIds, fileIds, remove);
      setMessage(
        remove
          ? "Access removed. Previously downloaded files remain with the recipient."
          : "Sharing saved. No email was sent.",
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: ["proposalWorkflow"] }),
        client.invalidateQueries({ queryKey: ["proposalJob", job.id] }),
      ]);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="pw-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>Share with a partner</h3>
      <p>
        The partner sees this job’s name, location, stage, and start timing,
        plus only the revisions and files selected below. Internal notes and
        acceptance emails stay private.
      </p>
      <label>
        Partner login email
        <input
          type="email"
          required
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <p>
        Saving replaces the selections for this email. Select everything this
        partner should retain access to. New revisions and files are never added
        automatically.
      </p>
      <fieldset disabled={busy}>
        <legend>Submitted proposals</legend>
        {bids
          .filter((b) => b.submitted_at)
          .map((b) => (
            <label key={b.id} style={{ display: "flex", gap: 8 }}>
              <input
                type="checkbox"
                checked={bidIds.includes(b.id)}
                onChange={() => setBids(toggle(bidIds, b.id))}
              />
              {b.contractor} · {b.number} · revision {b.revision}
            </label>
          ))}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Files</legend>
        {files
          .filter((f) => f.ready)
          .map((f) => (
            <label key={f.id} style={{ display: "flex", gap: 8 }}>
              <input
                type="checkbox"
                checked={fileIds.includes(f.id)}
                onChange={() => setFiles(toggle(fileIds, f.id))}
              />
              {f.filename}
            </label>
          ))}
      </fieldset>
      <div className="pw-actions">
        <button disabled={busy}>Save sharing</button>
        <button
          type="button"
          disabled={busy || !email.trim()}
          onClick={() => void save(true)}
        >
          Remove access
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
