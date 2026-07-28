import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BrainCircuit,
  Check,
  FolderSync,
  FolderUp,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  clearKnowledge,
  deactivateKnowledgeDoc,
  deriveTitle,
  getVaultPinStatus,
  ingestKnowledge,
  listKnowledgeDocs,
  setVaultPin,
  type IngestSummary,
  type VaultNote,
} from "../lib/knowledge";
import {
  diffVault,
  notesToIngest,
  summarizeDiff,
  type LiveDocLite,
  type ScannedNote,
  type VaultDiff,
} from "../lib/vaultDiff";
import {
  connectVaultFolder,
  ensureReadPermission,
  forgetVaultFolder,
  getSavedVaultHandle,
  hasFileSystemAccess,
  scanVaultFolder,
  type VaultDirHandle,
} from "../lib/vaultSync";
import { getMyProfile } from "../lib/install/api";
import { roleRank } from "../lib/install/types";
import { formatApiError } from "../lib/errors";
import { pinSetupBlockMessage, vaultPinPhase } from "../lib/vaultPinUx";
import { validateNewPin } from "../../../supabase/functions/_shared/pin.ts";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";

const NOTE_RE = /\.(md|markdown|mdx|txt)$/i;
const AUTO_RECHECK_MS = 60_000;

async function readNotes(fileList: FileList | null): Promise<VaultNote[]> {
  const files = Array.from(fileList ?? []).filter((f) => NOTE_RE.test(f.name));
  const notes: VaultNote[] = [];
  for (const f of files) {
    const content = await f.text();
    if (!content.trim()) continue;
    const path = f.webkitRelativePath || f.name;
    notes.push({ path, title: deriveTitle(path, content), content });
  }
  return notes;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Masked-PIN modal used for every vault mutation (add / refresh / remove /
 * approve). It keeps itself open on a wrong-PIN error so the user can retry. */
function PinModal({
  title,
  hint,
  onSubmit,
  onClose,
}: {
  title: string;
  hint?: string;
  onSubmit: (pin: string) => Promise<void>;
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!pin.trim()) {
      setError("Enter the vault PIN.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pin.trim());
      onClose();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pin-modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pin-modal-card">
        <h3 style={{ margin: "0 0 4px", display: "flex", alignItems: "center", gap: 6 }}>
          <KeyRound size={16} /> {title}
        </h3>
        {hint && <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{hint}</p>}
        <input
          type="password"
          inputMode="text"
          autoFocus
          autoComplete="off"
          className="vault-pin-input"
          placeholder="Vault PIN"
          value={pin}
          disabled={busy}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {error && <p className="error" style={{ marginBottom: 0 }}>{error}</p>}
        <div className="action-list" style={{ marginTop: 12, flexDirection: "row", gap: 8 }}>
          <button type="button" className="action-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="action-btn primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Working…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Owner-only first-time set / later change of the shared vault PIN. */
function VaultPinSection({
  isOwner,
  available,
  pinSet,
  onChanged,
  rootRef,
}: {
  isOwner: boolean;
  available: boolean;
  pinSet: boolean;
  onChanged: () => void;
  rootRef?: React.RefObject<HTMLDivElement | null>;
}) {
  // When no PIN exists yet the setup form is the section's primary content, so
  // it's shown by default. When one is set, the form stays collapsed behind a
  // "Change PIN" toggle.
  const [changing, setChanging] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  if (!available) {
    return (
      <div className="pin-section" ref={rootRef}>
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <KeyRound size={16} /> Vault PIN
          </h2>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          <ShieldCheck size={13} /> The vault PIN needs a quick database update before
          it can be set. Once that's applied, an owner can set the shared PIN here.
        </p>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="pin-section" ref={rootRef}>
        <div className="section-head" style={{ marginTop: 0 }}>
          <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <KeyRound size={16} /> Vault PIN
          </h2>
          <span className="muted" style={{ fontSize: 12 }}>
            {pinSet ? "PIN set" : "No PIN yet"}
          </span>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          <ShieldCheck size={13} />{" "}
          {pinSet
            ? "Adding to the vault is protected by the owner's vault PIN."
            : "No vault PIN is set yet. Ask an owner to set the vault PIN before adding notes."}
        </p>
      </div>
    );
  }

  // Owner + available: this is where the PIN is created or changed.
  const formVisible = !pinSet || changing;

  const reset = () => {
    setCurrentPin("");
    setNewPin("");
    setConfirmPin("");
    setError(null);
  };

  const submit = async () => {
    setError(null);
    setOk(false);
    if (pinSet && !currentPin.trim()) {
      setError("Enter the current PIN to change it.");
      return;
    }
    const check = validateNewPin(newPin);
    if (!check.ok) {
      setError(check.error ?? "Enter a valid PIN.");
      return;
    }
    if (newPin.trim() !== confirmPin.trim()) {
      setError("The PIN and confirmation don't match.");
      return;
    }
    setBusy(true);
    try {
      await setVaultPin({
        newPin: newPin.trim(),
        currentPin: pinSet ? currentPin.trim() : undefined,
      });
      setOk(true);
      reset();
      setChanging(false);
      onChanged();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pin-section" ref={rootRef}>
      <div className="section-head" style={{ marginTop: 0 }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <KeyRound size={16} /> Vault PIN
        </h2>
        {pinSet && !changing && (
          <button type="button" className="link-btn" onClick={() => setChanging(true)}>
            Change PIN
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {pinSet
          ? "A shared PIN is set. Everyone who adds, refreshes or removes notes must enter it."
          : "No vault PIN is set yet. Create one below — supervisors will need it every time they add, refresh or remove notes."}
      </p>
      {ok && <p className="ok" style={{ marginTop: 0 }}>Vault PIN updated.</p>}
      {formVisible && (
        <div className="pin-form">
          {pinSet && (
            <input
              type="password"
              autoComplete="off"
              className="vault-pin-input"
              placeholder="Current PIN"
              value={currentPin}
              disabled={busy}
              onChange={(e) => setCurrentPin(e.target.value)}
            />
          )}
          <input
            type="password"
            autoComplete="off"
            className="vault-pin-input"
            placeholder="New PIN (4–10 letters/numbers)"
            value={newPin}
            disabled={busy}
            onChange={(e) => setNewPin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <input
            type="password"
            autoComplete="off"
            className="vault-pin-input"
            placeholder="Confirm new PIN"
            value={confirmPin}
            disabled={busy}
            onChange={(e) => setConfirmPin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          {error && <p className="error" style={{ marginBottom: 0 }}>{error}</p>}
          <div className="action-list" style={{ flexDirection: "row", gap: 8 }}>
            {pinSet && (
              <button
                type="button"
                className="action-btn"
                disabled={busy}
                onClick={() => {
                  reset();
                  setChanging(false);
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="action-btn primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "Saving…" : pinSet ? "Change PIN" : "Set vault PIN"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Knowledge() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<IngestSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pinPrompt, setPinPrompt] = useState<
    | { title: string; hint?: string; run: (pin: string) => Promise<void> }
    | null
  >(null);

  // Auto-sync state.
  const [handle, setHandle] = useState<VaultDirHandle | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [scanned, setScanned] = useState<ScannedNote[]>([]);
  const [diff, setDiff] = useState<VaultDiff | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const autoSyncSupported = hasFileSystemAccess();

  const dirRef = (el: HTMLInputElement | null) => {
    if (el) {
      el.setAttribute("webkitdirectory", "");
      el.setAttribute("directory", "");
    }
  };

  const profile = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const pinStatus = useQuery({ queryKey: ["vaultPinStatus"], queryFn: getVaultPinStatus });
  const docs = useQuery({ queryKey: ["knowledgeDocs"], queryFn: listKnowledgeDocs });

  const role = profile.data?.role ?? null;
  const isOwner = roleRank(role) >= 3;
  const pinAvailable = Boolean(pinStatus.data?.available);
  const pinSet = Boolean(pinStatus.data?.pinSet);
  const pinReady = pinAvailable && pinSet;
  const pinPhase = vaultPinPhase({ available: pinAvailable, pinSet });

  // The setup form lives in <VaultPinSection>; this lets a blocked mutation
  // scroll the owner straight to it instead of leaving them on a dead prompt.
  const pinSectionRef = useRef<HTMLDivElement | null>(null);

  // Guard run before any vault mutation prompt: when no PIN has been created
  // yet, steer the user to the setup flow instead of asking them to "enter"
  // a PIN that was never established.
  const requirePinSet = (): boolean => {
    const block = pinSetupBlockMessage({ available: pinAvailable, pinSet, isOwner });
    if (block) {
      setMessage(block);
      pinSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return false;
    }
    return true;
  };

  const state = docs.data;
  const ready = state && !state.setupNeeded ? state : null;
  const liveDocs: LiveDocLite[] = (ready?.docs ?? []).map((d) => ({
    path: d.path,
    hash: d.contentHash,
  }));

  const upload = useMutation({
    mutationFn: async ({ notes, pin }: { notes: VaultNote[]; pin: string }) => {
      setSummary(null);
      setProgress({ done: 0, total: notes.length });
      return ingestKnowledge(notes, {
        pin,
        replaceMissing: true,
        onProgress: (done, total) => setProgress({ done, total }),
      });
    },
    onSuccess: (result) => {
      setSummary(result);
      setMessage(null);
      setProgress(null);
      void queryClient.invalidateQueries({ queryKey: ["knowledgeDocs"] });
    },
    onError: (e) => {
      setProgress(null);
      setMessage(formatApiError(e));
    },
  });

  const onPick = async (fileList: FileList | null) => {
    setMessage(null);
    if (!requirePinSet()) return;
    const notes = await readNotes(fileList);
    if (notes.length === 0) {
      setMessage("No markdown notes found in that selection.");
      return;
    }
    setPinPrompt({
      title: "Add to the vault",
      hint: `Enter the vault PIN to index ${notes.length} note${notes.length === 1 ? "" : "s"}.`,
      run: async (pin) => {
        await upload.mutateAsync({ notes, pin });
      },
    });
  };

  const requestRemove = (id: string, title: string) => {
    setMessage(null);
    if (!requirePinSet()) return;
    setPinPrompt({
      title: "Remove note",
      hint: `Enter the vault PIN to remove "${title}" from the vault.`,
      run: async (pin) => {
        await deactivateKnowledgeDoc(id, pin);
        void queryClient.invalidateQueries({ queryKey: ["knowledgeDocs"] });
      },
    });
  };

  const requestClear = () => {
    setMessage(null);
    if (!requirePinSet()) return;
    setPinPrompt({
      title: "Clear the whole vault",
      hint: "Enter the vault PIN to hide every note from Ask Infinity.",
      run: async (pin) => {
        await clearKnowledge(pin);
        setSummary(null);
        void queryClient.invalidateQueries({ queryKey: ["knowledgeDocs"] });
      },
    });
  };

  // --- Auto-sync ---
  const runScan = useCallback(
    async (h: VaultDirHandle, quiet = false): Promise<void> => {
      if (scanning) return;
      setScanning(true);
      if (!quiet) setSyncMsg(null);
      try {
        const permitted = await ensureReadPermission(h);
        if (!permitted) {
          setSyncMsg("Permission to read the folder was denied. Reconnect to continue.");
          return;
        }
        const notes = await scanVaultFolder(h);
        if (notes.length === 0) {
          setScanned([]);
          setDiff(null);
          setSyncMsg("No notes were found in that folder (check the folder and permission).");
          return;
        }
        setScanned(notes);
        setDiff(diffVault(liveDocs, notes));
        setLastChecked(new Date().toISOString());
        if (!quiet) setSyncMsg(null);
      } catch {
        setSyncMsg("Couldn't read the folder — it may have moved. Reconnect to continue.");
      } finally {
        setScanning(false);
      }
    },
    // liveDocs is derived from docs query; re-create when the doc set changes.
    [scanning, liveDocs],
  );

  // Rehydrate a previously connected folder on mount (no auto-prompt).
  useEffect(() => {
    if (!autoSyncSupported) return;
    let cancelled = false;
    void (async () => {
      const saved = await getSavedVaultHandle();
      if (!cancelled && saved) {
        setHandle(saved);
        setFolderName(saved.name);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoSyncSupported]);

  // Light periodic re-check + on window focus while connected.
  useEffect(() => {
    if (!handle || !pinReady) return;
    const tick = () => {
      if (!document.hidden) void runScan(handle, true);
    };
    const interval = window.setInterval(tick, AUTO_RECHECK_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", tick);
    };
  }, [handle, pinReady, runScan]);

  const connect = async () => {
    setSyncMsg(null);
    try {
      const h = await connectVaultFolder();
      setHandle(h);
      setFolderName(h.name);
      await runScan(h);
    } catch {
      // User dismissed the picker or it failed — nothing to do.
    }
  };

  const disconnect = async () => {
    await forgetVaultFolder();
    setHandle(null);
    setFolderName(null);
    setScanned([]);
    setDiff(null);
    setSyncMsg(null);
  };

  const approveSync = useMutation({
    mutationFn: async ({ pin }: { pin: string }) => {
      const toIngest = diff ? notesToIngest(diff) : [];
      setSummary(null);
      setProgress({ done: 0, total: toIngest.length });
      return ingestKnowledge(toIngest, {
        pin,
        replaceMissing: true,
        knownPaths: scanned.map((n) => n.path),
        onProgress: (done, total) => setProgress({ done, total }),
      });
    },
    onSuccess: async (result) => {
      setSummary(result);
      setProgress(null);
      setDiff(null);
      await queryClient.invalidateQueries({ queryKey: ["knowledgeDocs"] });
      if (handle) void runScan(handle, true);
    },
    onError: (e) => {
      setProgress(null);
      setSyncMsg(formatApiError(e));
    },
  });

  const requestApprove = () => {
    if (!diff) return;
    if (!requirePinSet()) return;
    const s = summarizeDiff(diff);
    setPinPrompt({
      title: "Approve & sync",
      hint: `Enter the vault PIN to apply ${s.added} new, ${s.changed} changed and ${s.removed} removed note${s.total === 1 ? "" : "s"}.`,
      run: async (pin) => {
        await approveSync.mutateAsync({ pin });
      },
    });
  };

  const busy = upload.isPending || approveSync.isPending;
  const staged = diff ? summarizeDiff(diff) : null;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting ai-eyebrow">
            <BrainCircuit size={13} /> Infinity AI
          </p>
          <h1>AI Knowledge</h1>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">
          ‹
        </Link>
      </header>

      <p className="muted">
        Upload your Obsidian vault (or a set of Markdown notes) to teach Infinity
        AI your company's playbooks, specs and standards. Everyone's Ask Infinity
        chat then answers from these notes plus live app data, with citations.
        Adding, refreshing or removing notes is protected by the owner's vault PIN.
      </p>
      <p className="muted" style={{ fontSize: 12 }}>
        Note contents are sent to OpenAI to build embeddings and answers, and
        stored (text + vectors) in your Supabase. Only upload notes you're
        comfortable sharing that way.
      </p>

      <VaultPinSection
        isOwner={isOwner}
        available={pinAvailable}
        pinSet={pinSet}
        rootRef={pinSectionRef}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ["vaultPinStatus"] });
        }}
      />

      {autoSyncSupported && (
        <div className="sync-section">
          <div className="section-head" style={{ marginTop: 0 }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <FolderSync size={16} /> Auto-sync
            </h2>
            {handle && (
              <button type="button" className="link-btn" onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Connect your vault folder once. Infinity watches for changes while
            this page is open and stages them; a supervisor enters the PIN to
            approve them into the live vault. Nothing syncs without PIN approval.
          </p>

          {!handle ? (
            <div className="action-list">
              <button
                type="button"
                className="action-btn primary"
                disabled={busy}
                onClick={() => void connect()}
              >
                <Link2 size={16} /> Connect vault folder
              </button>
            </div>
          ) : (
            <>
              <p className="muted" style={{ fontSize: 13 }}>
                Connected to <strong>{folderName}</strong>
                {lastChecked ? ` · last checked ${formatWhen(lastChecked)}` : ""}
              </p>
              <div className="action-list">
                <button
                  type="button"
                  className="action-btn"
                  disabled={busy || scanning}
                  onClick={() => void runScan(handle)}
                >
                  <RefreshCw size={16} /> {scanning ? "Checking…" : "Check for changes"}
                </button>
                {staged?.hasChanges && pinReady && (
                  <button
                    type="button"
                    className="action-btn primary"
                    disabled={busy}
                    onClick={requestApprove}
                  >
                    <Check size={16} /> Approve &amp; sync (enter PIN)
                  </button>
                )}
              </div>

              {staged && (
                <div className="staged-diff">
                  {staged.hasChanges ? (
                    <>
                      <p className="muted" style={{ fontSize: 13, marginBottom: 4 }}>
                        Staged: {staged.added} new · {staged.changed} changed ·{" "}
                        {staged.removed} removed
                      </p>
                      <ul className="unit-list">
                        {diff!.added.map((n) => (
                          <li key={`a-${n.path}`} className="doc-row">
                            <span className="diff-tag diff-add">New</span>
                            <div className="doc-main">
                              <strong>{n.title}</strong>
                              <span className="muted doc-path">{n.path}</span>
                            </div>
                          </li>
                        ))}
                        {diff!.changed.map((n) => (
                          <li key={`c-${n.path}`} className="doc-row">
                            <span className="diff-tag diff-change">Changed</span>
                            <div className="doc-main">
                              <strong>{n.title}</strong>
                              <span className="muted doc-path">{n.path}</span>
                            </div>
                          </li>
                        ))}
                        {diff!.removed.map((d) => (
                          <li key={`r-${d.path}`} className="doc-row">
                            <span className="diff-tag diff-remove">Removed</span>
                            <div className="doc-main">
                              <span className="muted doc-path">{d.path}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {!pinReady && (
                        <p className="muted" style={{ fontSize: 12 }}>
                          {isOwner
                            ? "Set a vault PIN above to approve these changes."
                            : "Ask an owner to set the vault PIN to approve these changes."}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="ok" style={{ marginTop: 0 }}>
                      <Check size={13} /> In sync — no changes to approve.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {syncMsg && <p className="error">{syncMsg}</p>}
        </div>
      )}

      <div className="section-head" style={{ marginTop: 18 }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FolderUp size={16} /> {autoSyncSupported ? "Manual upload" : "Upload vault"}
        </h2>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {autoSyncSupported
          ? "Prefer a one-off upload, or on a browser without auto-sync? Choose a folder or files — you'll enter the vault PIN to index them."
          : "Auto-sync isn't available in this browser, so upload your vault folder or files manually — you'll enter the vault PIN to index them."}
      </p>
      {pinPhase === "needs-setup" && (
        <p className="muted" style={{ fontSize: 12 }}>
          {isOwner
            ? "First set a vault PIN above — then you can add notes."
            : "A vault PIN must be set by an owner before notes can be added."}
        </p>
      )}
      <div className="action-list">
        <label
          className={`action-btn primary${busy ? " disabled" : ""}`}
          style={{ cursor: busy ? "default" : "pointer" }}
        >
          <FolderUp size={16} /> {busy ? "Uploading…" : "Choose vault folder"}
          <input
            ref={dirRef}
            type="file"
            multiple
            style={{ display: "none" }}
            disabled={busy}
            onChange={(e) => {
              void onPick(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <label
          className={`action-btn${busy ? " disabled" : ""}`}
          style={{ cursor: busy ? "default" : "pointer" }}
        >
          Choose .md files
          <input
            type="file"
            multiple
            accept=".md,.markdown,.mdx,.txt,text/markdown"
            style={{ display: "none" }}
            disabled={busy}
            onChange={(e) => {
              void onPick(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {progress && (
        <p className="muted" aria-live="polite">
          Indexing {progress.done} / {progress.total} notes…
        </p>
      )}
      {summary && (
        <p className="ok" aria-live="polite">
          Indexed {summary.docsAdded + summary.docsUpdated} notes (
          {summary.docsAdded} new, {summary.docsUpdated} updated,{" "}
          {summary.docsUnchanged} unchanged
          {summary.docsRemoved > 0 ? `, ${summary.docsRemoved} removed` : ""}) ·{" "}
          {summary.chunks} chunks.
        </p>
      )}
      {message && <p className="error">{message}</p>}

      <div className="section-head" style={{ marginTop: 18 }}>
        <h2>Indexed notes</h2>
        {ready && ready.docs.length > 0 && (
          <button type="button" className="link-btn" onClick={requestClear}>
            <Trash2 size={13} /> Clear all
          </button>
        )}
      </div>

      {docs.isLoading && <SkeletonList rows={4} />}
      {docs.isError && (
        <QueryError error={docs.error} onRetry={() => docs.refetch()} label="Couldn't load the knowledge base" />
      )}
      {state?.setupNeeded && (
        <EmptyState
          icon={<BrainCircuit size={22} />}
          title="Knowledge base not set up yet"
          message="Once the database has the knowledge store, upload a vault above and your notes will appear here. Until then, Ask Infinity still works from the built-in brain."
        />
      )}
      {ready && ready.docs.length === 0 && (
        <EmptyState
          icon={<FolderUp size={22} />}
          title="No notes indexed yet"
          message="Upload your Obsidian vault to get started."
        />
      )}
      {ready && ready.docs.length > 0 && (
        <>
          <p className="muted" style={{ fontSize: 12 }}>
            {ready.docs.length} notes · {ready.totalChunks} chunks · last refreshed{" "}
            {formatWhen(ready.lastRefreshed)}
          </p>
          <ul className="unit-list">
            {ready.docs.map((d) => (
              <li key={d.id} className="doc-row">
                <div className="doc-main">
                  <strong>{d.title}</strong>
                  <span className="muted doc-path">{d.path}</span>
                </div>
                <span className="muted doc-count">{d.chunkCount} chunks</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${d.title}`}
                  onClick={() => requestRemove(d.id, d.title)}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {pinPrompt && (
        <PinModal
          title={pinPrompt.title}
          hint={pinPrompt.hint}
          onSubmit={pinPrompt.run}
          onClose={() => setPinPrompt(null)}
        />
      )}
    </div>
  );
}
