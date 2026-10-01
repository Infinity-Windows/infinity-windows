import type { CatalogEntry } from "./translate";
import { registerCatalog } from "./catalog";

// The job-scoped QC review queue is a lazy route; its phrases stay out of
// the first-screen bundle, same pattern as qcEvidenceCatalog.ts.
export const QC_REVIEW_CATALOG = {
  "qcReview.recoveredSubmission": {
    en: "A previously submitted review still needs confirmation. Retry this same saved request; it will not create a duplicate decision.",
    es: "Una revisión enviada anteriormente aún necesita confirmación. Reintenta la misma solicitud guardada; no creará una decisión duplicada.",
  },
  "qcReview.storageUnavailable": {
    en: "No new save was sent. This phone could not retain the exact request for safe recovery. Restore session storage and try again, or reload to recover an earlier submission.",
    es: "No se envió un nuevo guardado. Este teléfono no pudo conservar la solicitud exacta para recuperarla. Restablece el almacenamiento de sesión y reintenta, o recarga para recuperar un envío anterior.",
  },
  "qcReview.invalidRecovery": {
    en: "The saved recovery record could not be validated. No review was sent. Check review history before clearing this phone's invalid session data.",
    es: "No se pudo validar el registro de recuperación. No se envió una revisión. Revisa el historial antes de borrar los datos de sesión no válidos de este teléfono.",
  },
  "qcReview.savedRecoveryRetained": {
    en: "Your review was saved. This phone could not clear its recovery copy; retrying that exact copy remains safe.",
    es: "Tu revisión se guardó. Este teléfono no pudo borrar la copia de recuperación; reintentar esa copia exacta sigue siendo seguro.",
  },
  "qcReview.finishBeforeLeaving": {
    en: "Finish or cancel the current review first. For a saved callback, retry or choose Not now for its follow-up.",
    es: "Termina o cancela primero la revisión actual. Si la devolución ya está guardada, reintenta o elige Ahora no para el seguimiento.",
  },
  "qcReview.draftChanged": {
    en: "This unit changed while you were writing. Your note is kept. Review the current decision before submitting it.",
    es: "Esta unidad cambió mientras escribías. Conservamos tu nota. Revisa la decisión actual antes de enviarla.",
  },
  "qcReview.reviewCurrentDecision": { en: "Use this reviewed state", es: "Usar este estado revisado" },
  "qcReview.unitList": { en: "Unit list", es: "Lista de unidades" },
  "qcReview.selectedReview": { en: "Selected unit review", es: "Revisión de la unidad seleccionada" },
  "qcReview.saving": { en: "Saving review…", es: "Guardando revisión…" },
  "qcReview.chooseJob": { en: "Choose a job", es: "Elige un trabajo" },
  "qcReview.jobSearchPlaceholder": { en: "Search jobs by code or name", es: "Buscar trabajos por código o nombre" },
  "qcReview.loadingJobs": { en: "Loading jobs…", es: "Cargando trabajos…" },
  "qcReview.jobsError": { en: "Jobs could not load.", es: "No se pudieron cargar los trabajos." },
  "qcReview.noJobs": { en: "No jobs match that search.", es: "Ningún trabajo coincide con esa búsqueda." },
  "qcReview.loadMoreJobs": { en: "Load more jobs", es: "Cargar más trabajos" },
  "qcReview.queueCount": { en: "{n} in queue", es: "{n} en la cola" },
  "qcReview.newCount": { en: "{n} new", es: "{n} nuevas" },
  "qcReview.callbackCount": { en: "{n} callbacks", es: "{n} devoluciones" },
  "qcReview.changeJob": { en: "Change job", es: "Cambiar trabajo" },

  "qcReview.filterAll": { en: "All", es: "Todas" },
  "qcReview.filterNew": { en: "New", es: "Nuevas" },
  "qcReview.filterCallbacks": { en: "Callbacks", es: "Devoluciones" },
  "qcReview.searchPlaceholder": { en: "Search this job's units", es: "Buscar unidades de este trabajo" },

  "qcReview.loading": { en: "Loading units…", es: "Cargando unidades…" },
  "qcReview.loadError": { en: "This list could not load.", es: "No se pudo cargar esta lista." },
  "qcReview.retry": { en: "Try again", es: "Intentar de nuevo" },
  "qcReview.noUnits": { en: "No units match this search and filter.", es: "Ninguna unidad coincide con esta búsqueda y filtro." },
  "qcReview.showingCount": { en: "{shown} of {total}", es: "{shown} de {total}" },
  "qcReview.next": { en: "Next", es: "Siguiente" },
  "qcReview.previous": { en: "Previous", es: "Anterior" },

  "qcReview.selectedOutsideQueue": {
    en: "This unit is no longer in the current queue. Refresh to review it again.",
    es: "Esta unidad ya no está en la cola actual. Actualiza para revisarla de nuevo.",
  },
  "qcReview.refresh": { en: "Refresh", es: "Actualizar" },

  "qcReview.pass": { en: "Pass ✓", es: "Aprobar ✓" },
  "qcReview.callback": { en: "Callback", es: "Devolución" },
  "qcReview.cancel": { en: "Cancel", es: "Cancelar" },
  "qcReview.rootCauseLabel": { en: "Root-cause term (pushed to crew decks)", es: "Término de causa raíz (enviado a las tarjetas de la cuadrilla)" },
  "qcReview.pickTerm": { en: "— pick a term —", es: "— elige un término —" },
  "qcReview.noteLabel": { en: "Note (optional)", es: "Nota (opcional)" },
  "qcReview.logCallback": { en: "Log callback", es: "Registrar devolución" },

  "qcReview.savedPassed": { en: "Unit passed.", es: "Unidad aprobada." },
  "qcReview.callbackSaved": { en: "Callback logged.", es: "Devolución registrada." },
  "qcReview.rootCausePushed": { en: "Root cause pushed to crew decks.", es: "Causa raíz enviada a las tarjetas de la cuadrilla." },
  "qcReview.savedReceiptPassed": { en: "You passed this unit.", es: "Aprobaste esta unidad." },
  "qcReview.savedReceiptCallback": { en: "You logged a callback for this unit.", es: "Registraste una devolución para esta unidad." },
  "qcReview.savedReceiptHistorical": {
    en: "This is your saved decision. The unit's current state may have changed since.",
    es: "Esta es tu decisión guardada. El estado actual de la unidad puede haber cambiado desde entonces.",
  },

  "qcReview.pinnedUnit": { en: "Pinned unit", es: "Unidad fijada" },
  "qcReview.pinnedOutOfQueue": {
    en: "This unit is no longer in the current queue. Refresh to review it again.",
    es: "Esta unidad ya no está en la cola actual. Actualiza para revisarla de nuevo.",
  },

  "qcReview.retryDecision": { en: "Retry save", es: "Reintentar guardado" },
  "qcReview.cancelDecision": { en: "Cancel", es: "Cancelar" },
  "qcReview.cannotCancelAmbiguous": {
    en: "This save's result is unknown — retry the exact same request rather than risk a duplicate decision.",
    es: "Se desconoce el resultado de este guardado — reintenta exactamente la misma solicitud en lugar de arriesgar una decisión duplicada.",
  },
  "qcReview.noFurtherUnit": { en: "No further unit in this direction.", es: "No hay más unidades en esta dirección." },
  "qcReview.navError": { en: "Could not move to the next unit. Try again.", es: "No se pudo pasar a la siguiente unidad. Inténtalo de nuevo." },
  "qcReview.draftLocked": {
    en: "This decision is saving — the term and note can't be changed right now.",
    es: "Esta decisión se está guardando — el término y la nota no se pueden cambiar ahora.",
  },
  "qcReview.termFieldLabel": { en: "Root-cause term", es: "Término de causa raíz" },
  "qcReview.noteFieldLabel": { en: "Callback note", es: "Nota de la devolución" },

  "qcReview.openFullRecord": { en: "Open full unit record", es: "Abrir el registro completo de la unidad" },
  "qcReview.photoBasedOn": { en: "Based on an after photo saved {date}.", es: "Basado en una foto de después guardada el {date}." },
  "qcReview.photoOpenFull": { en: "Open the photo and full record", es: "Abrir la foto y el registro completo" },
  "qcReview.visibleChecks": { en: "Visible details", es: "Detalles visibles" },
  "qcReview.questionsForForeman": { en: "Check in person", es: "Verificar en persona" },

  "qcReview.errorStale": {
    en: "This unit changed since you loaded it. Refresh the list and review it again.",
    es: "Esta unidad cambió desde que la cargaste. Actualiza la lista y revísala de nuevo.",
  },
  "qcReview.errorConflict": {
    en: "This save already went through under a different request. Refresh to see the current state.",
    es: "Este guardado ya se completó con otra solicitud. Actualiza para ver el estado actual.",
  },
  "qcReview.errorUnauthorized": { en: "You don't have permission to review this unit.", es: "No tienes permiso para revisar esta unidad." },
  "qcReview.errorUnavailable": { en: "QC review is temporarily unavailable. Try again shortly.", es: "La revisión de calidad no está disponible temporalmente. Inténtalo en unos minutos." },

  "qcReview.decisionAlreadyRecorded": {
    en: "The QC decision was already recorded. Only the learning update failed — retry just that.",
    es: "La decisión de calidad ya quedó registrada. Solo falló la actualización de aprendizaje — vuelve a intentar solo eso.",
  },
  "qcReview.retryLearning": { en: "Retry learning update", es: "Reintentar actualización de aprendizaje" },

  "qcReview.openServiceCasePrompt": { en: "Open a service case for {code}?", es: "¿Abrir un caso de servicio para {code}?" },
  "qcReview.openServiceCaseHint": {
    en: "Links this callback to warranty tracking. Choosing Not now during a send stops waiting; a case may already have been created.",
    es: "Vincula esta devolución al seguimiento de garantía. Elegir Ahora no durante un envío deja de esperar; el caso puede haberse creado.",
  },
  "qcReview.openServiceCase": { en: "Open service case", es: "Abrir caso de servicio" },
  "qcReview.learningPending": { en: "The callback is saved. Updating the learning deck… You can stop waiting; the update may already have reached the server.", es: "La devolución está guardada. Actualizando las tarjetas… Puedes dejar de esperar; la actualización puede haber llegado al servidor." },
  "qcReview.skipLearning": { en: "Skip learning update for now", es: "Omitir la actualización de aprendizaje por ahora" },
  "qcReview.submittedNote": { en: "Submitted note", es: "Nota enviada" },
  "qcReview.notNow": { en: "Not now", es: "Ahora no" },
  "qcReview.serviceCaseOpened": { en: "Service case opened — linked to this callback for warranty tracking.", es: "Caso de servicio abierto — vinculado a esta devolución para seguimiento de garantía." },

  "qcReview.aiPhotoReview": { en: "AI photo review", es: "Revisión de foto con IA" },
  "qcReview.reviewingPhoto": { en: "Reviewing photo…", es: "Revisando foto…" },
} satisfies Record<string, CatalogEntry>;

export type QcReviewKey = keyof typeof QC_REVIEW_CATALOG;

registerCatalog(QC_REVIEW_CATALOG);
