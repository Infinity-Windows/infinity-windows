// The one concrete wiring of reconcileDailyLogPendingPhotos's injectable
// uploader to the real offline outbox — shared by LogPhotoCapture (reconciles
// on mount, when a log already has an id) and DailyLogDialog's own Save
// success handler (reconciles immediately with the id Save just returned,
// which matters because a clean save with no draft conflict closes the
// dialog right away — LogPhotoCapture's own mount effect would never get a
// re-render with the new id in that case, only a fresh mount next time this
// job-day is reopened).
import { enqueueUpload } from "./outbox";
import type { DailyLogPhotoUploader } from "./dailyLogPendingPhotos";

export const dailyLogPhotoUploader: DailyLogPhotoUploader = (input) =>
  enqueueUpload({
    kind: "photo",
    bucket: "install-media",
    path: input.path,
    contentType: input.contentType,
    projectId: input.projectId,
    dailyLogId: input.dailyLogId,
    createdBy: input.createdBy,
    ownerId: input.ownerId,
    lat: input.lat,
    lng: input.lng,
    accuracyM: input.accuracyM,
    takenAt: input.takenAt,
    blob: input.blob,
    clientId: input.clientId,
  });
