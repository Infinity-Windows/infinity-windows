import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ImageIcon, MapPin } from "lucide-react";
import { listProjects } from "../lib/api";
import { groupPhotosByDay, listPhotos, photoTime, type FeedPhoto } from "../lib/photos";
import { subscribeSynced } from "../lib/offline/outbox";
import { EmptyState, QueryError, SkeletonCard } from "../components/ui/States";
import { JobPhotoCapture } from "../components/JobPhotoCapture";

function whoLabel(createdBy: string | null): string {
  if (!createdBy) return "Someone";
  const at = createdBy.indexOf("@");
  return at > 0 ? createdBy.slice(0, at) : createdBy;
}

function timeLabel(p: FeedPhoto): string {
  const d = new Date(photoTime(p));
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function Photos() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const projectId = params.get("project");
  const kind = params.get("kind") === "receipt" ? "receipt" : "photo";
  const [capturing, setCapturing] = useState(params.get("capture") === "1");
  const [viewer, setViewer] = useState<FeedPhoto | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const photos = useQuery({
    queryKey: ["photos", projectId ?? "all"],
    queryFn: () => listPhotos(projectId),
  });

  // Refetch once a queued upload actually lands on the server.
  useEffect(() => {
    return subscribeSynced(() => {
      void queryClient.invalidateQueries({ queryKey: ["photos"] });
    });
  }, [queryClient]);

  const jobCodeById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects.data ?? []) map.set(p.id, p.job_code);
    return map;
  }, [projects.data]);

  const selectedJobCode = projectId ? jobCodeById.get(projectId) ?? null : null;
  const groups = useMemo(
    () => groupPhotosByDay(photos.data ?? []),
    [photos.data],
  );

  const setProject = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("project", id);
    else next.delete("project");
    next.delete("capture");
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="home-greeting">Photos</p>
          <h1>{selectedJobCode ? selectedJobCode : "Recent across all jobs"}</h1>
        </div>
        <Link to="/" className="back-chip" aria-label="Home">
          ‹
        </Link>
      </header>

      <div className="photos-toolbar">
        <select
          className="photos-filter"
          value={projectId ?? ""}
          onChange={(e) => setProject(e.target.value)}
          aria-label="Filter by job"
        >
          <option value="">All jobs</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.job_code} — {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="action-btn primary photos-add"
          onClick={() => setCapturing(true)}
        >
          <Camera size={16} aria-hidden /> Add photo
        </button>
      </div>

      {photos.isLoading && (
        <div className="photos-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} height={120} />
          ))}
        </div>
      )}
      {photos.isError && (
        <QueryError
          error={photos.error}
          onRetry={() => void photos.refetch()}
          label="Couldn't load photos"
        />
      )}
      {!photos.isLoading && !photos.isError && groups.length === 0 && (
        <EmptyState
          icon={<ImageIcon size={22} />}
          title="No photos yet"
          message={
            selectedJobCode
              ? "Snap the first progress or install photo for this job."
              : "Photos from every job show up here as the crew captures them."
          }
          action={
            <button type="button" className="action-btn primary" onClick={() => setCapturing(true)}>
              <Camera size={16} aria-hidden /> Add a photo
            </button>
          }
        />
      )}

      {!photos.isLoading &&
        !photos.isError &&
        groups.map((group) => (
          <section key={group.key} className="photos-day">
            <h2 className="photos-day-label">{group.label}</h2>
            <div className="photos-grid">
              {group.photos.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="photo-card"
                  onClick={() => setViewer(p)}
                >
                  {p.signedUrl ? (
                    <img src={p.signedUrl} alt={p.caption ?? "Job photo"} loading="lazy" />
                  ) : (
                    <div className="photo-card-missing muted">
                      <ImageIcon size={20} aria-hidden />
                    </div>
                  )}
                  <span className="photo-card-meta">
                    <span className="photo-card-who">{whoLabel(p.createdBy)}</span>
                    <span className="photo-card-time">{timeLabel(p)}</span>
                  </span>
                  {p.lat != null && p.lng != null && (
                    <span className="photo-gps-chip">
                      <MapPin size={11} aria-hidden /> GPS
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ))}

      {capturing && (
        <JobPhotoCapture
          projectId={projectId}
          label={selectedJobCode}
          kind={kind}
          onClose={() => setCapturing(false)}
          onQueued={() => void photos.refetch()}
        />
      )}

      {viewer && (
        <div
          className="photo-viewer-backdrop overlay-enter"
          role="dialog"
          aria-modal="true"
          onClick={() => setViewer(null)}
        >
          <div className="photo-viewer" onClick={(e) => e.stopPropagation()}>
            {viewer.signedUrl ? (
              <img src={viewer.signedUrl} alt={viewer.caption ?? "Job photo"} />
            ) : (
              <div className="photo-card-missing muted">Image unavailable offline.</div>
            )}
            <div className="photo-viewer-info">
              {viewer.caption && <p className="photo-viewer-caption">{viewer.caption}</p>}
              <p className="muted">
                {whoLabel(viewer.createdBy)} ·{" "}
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(photoTime(viewer)))}
              </p>
              {viewer.lat != null && viewer.lng != null && (
                <a
                  className="photo-viewer-map"
                  href={mapsUrl(viewer.lat, viewer.lng)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <MapPin size={13} aria-hidden /> {viewer.lat.toFixed(4)},{" "}
                  {viewer.lng.toFixed(4)}
                </a>
              )}
            </div>
            <button
              type="button"
              className="action-btn photo-viewer-close"
              onClick={() => setViewer(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
