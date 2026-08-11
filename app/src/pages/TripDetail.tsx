import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CalendarDays, MapPin, Pencil, Send, Users } from "lucide-react";
import { getMyProfile } from "../lib/install/api";
import { isSupervisorPlus } from "../lib/install/types";
import { useEffectiveRole } from "../lib/useEffectiveRole";
import { EmptyState, QueryError, SkeletonList } from "../components/ui/States";
import { DirectionsButton } from "../components/maps/DirectionsButton";
import {
  deleteContact,
  deleteFlight,
  deleteGround,
  deleteLodging,
  deleteProcedure,
  getTrip,
  publishTrip,
} from "../lib/travel/api";
import type {
  Flight,
  GroundTransport,
  Lodging,
  Procedure,
  TripContact,
} from "../lib/travel/types";
import { areCodesVisible, phaseLabel, tripPhase } from "../lib/travel/status";
import { buildTimeline, selectNextUp } from "../lib/travel/timeline";
import { flightsForViewer } from "../lib/travel/visibility";
import { directionsTargets } from "../lib/travel/links";
import { tripChangeMessage, tripPublishMessage } from "../lib/travel/notify";
import { sendPush } from "../lib/permissions/pushServer";
import { notifyLocal } from "../lib/permissions/notifyLocal";
import { toastError } from "../lib/toast";
import { NextUpBanner } from "../components/travel/NextUpBanner";
import { TripTimeline } from "../components/travel/TripTimeline";
import { FlightsSection } from "../components/travel/FlightsSection";
import { LodgingSection } from "../components/travel/LodgingSection";
import { GettingAroundSection } from "../components/travel/GettingAroundSection";
import { HouseRulesSection } from "../components/travel/HouseRulesSection";
import { ContactsSection } from "../components/travel/ContactsSection";
import { AttachmentsPanel } from "../components/travel/AttachmentsPanel";
import { TripEditor } from "../components/travel/TripEditor";
import { FlightEditor } from "../components/travel/FlightEditor";
import { LodgingEditor } from "../components/travel/LodgingEditor";
import { GroundEditor } from "../components/travel/GroundEditor";
import { ProcedureEditor } from "../components/travel/ProcedureEditor";
import { ContactEditor } from "../components/travel/ContactEditor";

type Tab = "timeline" | "flights" | "lodging" | "ground" | "rules" | "contacts";
const TABS: { id: Tab; label: string }[] = [
  { id: "timeline", label: "Timeline" },
  { id: "flights", label: "Flights" },
  { id: "lodging", label: "Lodging" },
  { id: "ground", label: "Getting around" },
  { id: "rules", label: "House rules" },
  { id: "contacts", label: "Contacts" },
];

type EditorState =
  | { kind: "trip" }
  | { kind: "flight"; entity: Flight | null }
  | { kind: "lodging"; entity: Lodging | null }
  | { kind: "ground"; entity: GroundTransport | null }
  | { kind: "procedure"; entity: Procedure | null }
  | { kind: "contact"; entity: TripContact | null }
  | null;

function todayLocalISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function tripUrl(id: string): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  if (typeof window === "undefined") return `/travel/${id}`;
  return `${window.location.origin}${base}/travel/${id}`;
}

export function TripDetail() {
  const { tripId = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = todayLocalISO();

  const me = useQuery({ queryKey: ["myProfile"], queryFn: getMyProfile });
  const { effectiveRole: role } = useEffectiveRole();
  const canEdit = isSupervisorPlus(role);
  const myId = me.data?.id ?? null;

  const detailQ = useQuery({
    queryKey: ["trip", tripId],
    queryFn: () => getTrip(tripId),
    enabled: Boolean(tripId),
  });

  const [tab, setTab] = useState<Tab>("timeline");
  const [editor, setEditor] = useState<EditorState>(null);
  const [publishing, setPublishing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick every minute so "next up" + countdown stay current.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const detail = detailQ.data ?? null;
  const codesVisible = detail
    ? areCodesVisible(detail.trip.start_date, detail.trip.end_date, today)
    : true;

  const timeline = useMemo(
    () => (detail ? buildTimeline(detail, { profileId: myId, codesVisible }) : []),
    [detail, myId, codesVisible],
  );
  const nextUp = useMemo(() => selectNextUp(timeline, nowMs), [timeline, nowMs]);

  // Best-effort local reminder for the next-up item (fires while the app is
  // open; permission-guarded and deduped by notifyLocal). The in-app banner is
  // the reliable surface — this is a bonus, never blocking.
  useEffect(() => {
    if (!nextUp) return;
    const delta = Date.parse(nextUp.at) - Date.now();
    if (delta <= 0 || delta > 12 * 60 * 60 * 1000) return;
    const timer = setTimeout(() => {
      void notifyLocal({
        title: nextUp.title,
        body: nextUp.subtitle ?? undefined,
        tag: `travel-${tripId}-${nextUp.id}`,
        url: tripUrl(tripId),
      });
    }, delta);
    return () => clearTimeout(timer);
  }, [nextUp, tripId]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["trip", tripId] });
    qc.invalidateQueries({ queryKey: ["trips"] });
  };

  async function notifyCrew(msg: { title: string; body: string }) {
    const ids = (detail?.trip.crew ?? []).map((m) => m.profile_id);
    for (const pid of ids) {
      void sendPush({ profileIds: [pid], title: msg.title, body: msg.body, tag: `travel-${tripId}`, url: tripUrl(tripId) });
    }
    if (myId && ids.includes(myId)) {
      void notifyLocal({ title: msg.title, body: msg.body, tag: `travel-${tripId}-self`, url: tripUrl(tripId) });
    }
  }

  const publish = useMutation({
    mutationFn: async () => {
      if (!detail) return;
      await publishTrip(detail.trip.id);
      await notifyCrew(tripPublishMessage(detail.trip.name));
    },
    onSuccess: refresh,
    onError: (e) => toastError(e),
  });

  const removeEntity = useMutation({
    mutationFn: async (fn: () => Promise<void>) => {
      await fn();
      if (detail?.trip.status === "published") await notifyCrew(tripChangeMessage(detail.trip.name));
    },
    onSuccess: refresh,
    onError: (e) => toastError(e),
  });

  const nameOf = (id: string) =>
    detail?.trip.crew.find((m) => m.profile_id === id)?.display_name ?? "Crew";

  const doPublish = async () => {
    setPublishing(true);
    try {
      await publish.mutateAsync();
    } finally {
      setPublishing(false);
    }
  };

  if (detailQ.isLoading || me.isLoading) {
    return (
      <div className="page travel-detail">
        <SkeletonList rows={4} />
      </div>
    );
  }
  if (detailQ.isError) {
    return (
      <div className="page travel-detail">
        <QueryError error={detailQ.error} onRetry={() => void detailQ.refetch()} label="Couldn't load this trip" />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="page travel-detail">
        <EmptyState title="Trip not found" message="It may have been removed." action={<Link className="button-like" to="/travel">Back to Travel</Link>} />
      </div>
    );
  }

  const { trip } = detail;
  const phase = tripPhase(trip.start_date, trip.end_date, today);
  const shownFlights = canEdit ? detail.flights : flightsForViewer(detail.flights, myId);
  const tripAttachments = detail.attachments.filter((a) => !a.flight_id && !a.lodging_id);
  const targets = directionsTargets(detail);

  const onEditedSection = () => {
    setEditor(null);
    refresh();
  };

  return (
    <div className="page travel-detail">
      <header className="page-header">
        <div>
          <div className="travel-detail-titlerow">
            <h1>{trip.destination || trip.name}</h1>
            <span className={`travel-chip travel-chip-${phase}`}>{phaseLabel(phase)}</span>
            {canEdit && trip.status === "draft" && <span className="travel-chip travel-chip-draft">Draft</span>}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            <CalendarDays size={13} aria-hidden /> {trip.start_date} → {trip.end_date}
            {" · "}
            <Users size={13} aria-hidden /> {trip.crew.map((m) => m.display_name).filter(Boolean).join(", ") || `${trip.crew.length} crew`}
          </p>
        </div>
        <Link to="/travel" className="back-chip" aria-label="Back to Travel" />
      </header>

      {canEdit && (
        <div className="travel-toolbar">
          <button className="button-like" onClick={() => setEditor({ kind: "trip" })}>
            <Pencil size={15} aria-hidden /> Edit trip
          </button>
          {trip.status === "draft" && (
            <button className="button-like active-pill" style={{ marginLeft: "auto" }} onClick={doPublish} disabled={publishing}>
              <Send size={15} aria-hidden /> {publishing ? "Publishing…" : "Publish to crew"}
            </button>
          )}
        </div>
      )}

      {nextUp && <NextUpBanner item={nextUp} nowMs={nowMs} />}

      {trip.project?.address && (
        <div className="travel-jobsite">
          <MapPin size={14} aria-hidden /> <span>{trip.project.job_code ?? "Jobsite"}</span>
          <DirectionsButton address={trip.project.address} label="Jobsite" />
          {trip.project.id && (
            <Link to={`/projects/${trip.project.id}`} className="button-like">
              Open job
            </Link>
          )}
        </div>
      )}
      {trip.project?.id && !trip.project.address && (
        <div className="travel-jobsite">
          <MapPin size={14} aria-hidden /> <span>{trip.project.job_code ?? "Job"}</span>
          <Link to={`/projects/${trip.project.id}`} className="button-like">
            Open job
          </Link>
        </div>
      )}

      {targets.length > 0 && (
        <div className="travel-quickdir">
          <span className="muted">Directions:</span>
          {targets.map((t) => (
            <DirectionsButton key={t.key} address={t.address} label={t.label} />
          ))}
        </div>
      )}

      <nav className="travel-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`travel-tab${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "timeline" && (
        <>
          {trip.notes && <p className="travel-notes travel-trip-notes">{trip.notes}</p>}
          <TripTimeline items={timeline} nextUpId={nextUp?.id} />
          {tripAttachments.length > 0 || canEdit ? (
            <section className="travel-section">
              <div className="travel-section-head"><h3>Trip files</h3></div>
              <AttachmentsPanel tripId={trip.id} attachments={tripAttachments} canEdit={canEdit} onChanged={refresh} />
            </section>
          ) : null}
        </>
      )}

      {tab === "flights" && (
        <FlightsSection
          tripId={trip.id}
          flights={shownFlights}
          attachments={detail.attachments}
          canEdit={canEdit}
          codesVisible={codesVisible}
          nameOf={nameOf}
          onAdd={() => setEditor({ kind: "flight", entity: null })}
          onEdit={(f) => setEditor({ kind: "flight", entity: f })}
          onDelete={(f) => removeEntity.mutate(() => deleteFlight(trip.id, f.id))}
          onAttachmentsChanged={refresh}
        />
      )}

      {tab === "lodging" && (
        <LodgingSection
          tripId={trip.id}
          lodging={detail.lodging}
          attachments={detail.attachments}
          canEdit={canEdit}
          codesVisible={codesVisible}
          onAdd={() => setEditor({ kind: "lodging", entity: null })}
          onEdit={(l) => setEditor({ kind: "lodging", entity: l })}
          onDelete={(l) => removeEntity.mutate(() => deleteLodging(trip.id, l.id))}
          onAttachmentsChanged={refresh}
        />
      )}

      {tab === "ground" && (
        <GettingAroundSection
          ground={detail.ground}
          canEdit={canEdit}
          codesVisible={codesVisible}
          onAdd={() => setEditor({ kind: "ground", entity: null })}
          onEdit={(g) => setEditor({ kind: "ground", entity: g })}
          onDelete={(g) => removeEntity.mutate(() => deleteGround(trip.id, g.id))}
        />
      )}

      {tab === "rules" && (
        <HouseRulesSection
          procedures={detail.procedures}
          canEdit={canEdit}
          onAdd={() => setEditor({ kind: "procedure", entity: null })}
          onEdit={(p) => setEditor({ kind: "procedure", entity: p })}
          onDelete={(p) => removeEntity.mutate(() => deleteProcedure(trip.id, p.id))}
        />
      )}

      {tab === "contacts" && (
        <ContactsSection
          contacts={detail.contacts}
          canEdit={canEdit}
          onAdd={() => setEditor({ kind: "contact", entity: null })}
          onEdit={(c) => setEditor({ kind: "contact", entity: c })}
          onDelete={(c) => removeEntity.mutate(() => deleteContact(trip.id, c.id))}
        />
      )}

      {editor?.kind === "trip" && (
        <TripEditor
          trip={trip}
          onClose={() => setEditor(null)}
          onSaved={async (saved) => {
            setEditor(null);
            if (saved.status === "published") await notifyCrew(tripChangeMessage(saved.name));
            refresh();
          }}
          onDeleted={() => {
            setEditor(null);
            qc.invalidateQueries({ queryKey: ["trips"] });
            navigate("/travel");
          }}
        />
      )}
      {editor?.kind === "flight" && (
        <FlightEditor tripId={trip.id} crew={trip.crew} flight={editor.entity} onClose={() => setEditor(null)} onSaved={onEditedSection} />
      )}
      {editor?.kind === "lodging" && (
        <LodgingEditor tripId={trip.id} lodging={editor.entity} onClose={() => setEditor(null)} onSaved={onEditedSection} />
      )}
      {editor?.kind === "ground" && (
        <GroundEditor tripId={trip.id} ground={editor.entity} onClose={() => setEditor(null)} onSaved={onEditedSection} />
      )}
      {editor?.kind === "procedure" && (
        <ProcedureEditor tripId={trip.id} procedure={editor.entity} onClose={() => setEditor(null)} onSaved={onEditedSection} />
      )}
      {editor?.kind === "contact" && (
        <ContactEditor tripId={trip.id} contact={editor.entity} onClose={() => setEditor(null)} onSaved={onEditedSection} />
      )}
    </div>
  );
}
