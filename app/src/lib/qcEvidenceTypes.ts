import type { ProjectOpening } from "./install/types";
import type { RecordEvent } from "./install/record";

export interface QcEvidenceEvent extends RecordEvent {
  project_opening_id: string;
  window_id: string | null;
}

export type QcEvidenceSource = "install" | "unit" | "assigned_window" | "flashing";
export interface QcEvidenceMedia {
  id: string;
  kind: "photo" | "voice_memo";
  source: QcEvidenceSource;
  installEventId: string | null;
  storagePath: string;
  signedUrl: string | null;
  createdAt: string | null;
  caption: string | null;
  transcript: string | null;
}

export interface QcEvidenceProblem {
  source: "events" | "attachments" | "legacy" | "phase";
  reason: "unavailable" | "ambiguous" | "incomplete" | "conflict";
}

export interface QcUnitEvidence {
  opening: ProjectOpening;
  events: QcEvidenceEvent[];
  media: QcEvidenceMedia[];
  problems: QcEvidenceProblem[];
  sources: {
    eventsLoaded: boolean;
    attachmentsLoaded: boolean;
    phaseLoaded: boolean;
    legacyLoaded: boolean;
  };
}
