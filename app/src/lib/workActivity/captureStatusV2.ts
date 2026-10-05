/** Dormant saved-action presenter. This is neither an admission check nor a
 * current-allocation reader. The caller must supply a live, privacy-admitted
 * display lifetime; page-local login counters cannot attest a provider session.
 * Importing this module opens no storage and sends no request. */
import { activityUuid } from './protocol';
import { exactV2, freezeV2 } from './protocolV2';
import { parseCrossJobRecord, type HoldV3, type RecordV3 } from '../workCapture/crossJobStorageV3';

export interface CaptureDisplayV2 {
  admitted: boolean;
  ownerId: string;
  deviceId: string;
  loginGeneration: number;
  language: 'en' | 'es';
  latestCheck: 'none' | 'unavailable';
}
export type CaptureStatusKindV2 = 'saved' | 'uncertain' | 'held'
  | 'receipt_saved' | 'receipt_matched' | 'refused' | 'conflict';
export interface CaptureStatusV2 {
  scope: 'saved_action_history';
  kind: CaptureStatusKindV2;
  commandId: string;
  originalTappedAt: string;
  physicalShiftId: string;
  requestedProjectId: string | null;
  hold: HoldV3 | null;
  /** Saved-action state only; latestCheck is reported separately. */
  needsReview: boolean;
  label: string;
  detail: string;
  latestCheckMessage: string | null;
}
const copy = {
  en: {
    saved: ['Saved on this device', 'This saved action has not been attempted here.'],
    uncertain: ['Confirmation unknown', 'Keep this saved action while checking its receipt.'],
    held: ['Saved action needs review', 'Resolve this hold before another action depends on it.'],
    receipt_saved: ['Receipt saved', 'The full intended change still needs confirmation.'],
    receipt_matched: ['Receipt confirmed', 'The receipt matches this saved action.'],
    refused: ['Action refused', 'The server receipt records a refusal. Review the saved action.'],
    conflict: ['Action conflict', 'The server receipt records a conflict. Review the saved action.'],
    unavailable: 'Latest check unavailable. The saved history remains.',
    unreadable: ['Saved history could not be verified', 'Keep the saved data for review.'],
  },
  es: {
    saved: ['Guardado en este dispositivo', 'Esta acción guardada todavía no se ha intentado aquí.'],
    uncertain: ['Confirmación desconocida', 'Conserva esta acción guardada mientras verificas su recibo.'],
    held: ['La acción guardada requiere revisión', 'Resuelve este bloqueo antes de que otra acción dependa de ella.'],
    receipt_saved: ['Recibo guardado', 'El cambio solicitado completo aún requiere confirmación.'],
    receipt_matched: ['Recibo confirmado', 'El recibo corresponde a esta acción guardada.'],
    refused: ['Acción rechazada', 'El recibo del servidor registra un rechazo. Revisa la acción guardada.'],
    conflict: ['Conflicto en la acción', 'El recibo del servidor registra un conflicto. Revisa la acción guardada.'],
    unavailable: 'La última verificación no está disponible. El historial sigue guardado.',
    unreadable: ['No se pudo verificar el historial guardado', 'Conserva los datos guardados para su revisión.'],
  },
} as const;

export type CaptureStatusOutcomeV2 =
  | Readonly<{ availability: 'hidden' }>
  | Readonly<{ availability: 'unreadable'; scope: 'saved_action_history'; label: string; detail: string }>
  | Readonly<{ availability: 'available'; value: Readonly<CaptureStatusV2> }>;
const hidden = Object.freeze({ availability: 'hidden' as const });

function admittedDisplay(display: CaptureDisplayV2): Readonly<CaptureDisplayV2> | null {
  try {
    const context = freezeV2(display);
    exactV2(context, ['admitted', 'ownerId', 'deviceId', 'loginGeneration', 'language', 'latestCheck']);
    if (context.admitted !== true || !Number.isSafeInteger(context.loginGeneration)
      || context.loginGeneration < 0 || !['en', 'es'].includes(context.language)
      || !['none', 'unavailable'].includes(context.latestCheck)) return null;
    activityUuid(context.ownerId); activityUuid(context.deviceId);
    return context;
  } catch { return null; }
}

/** Read only ordinary data descriptors. Inputs must be inert structured-cloned
 * storage data: reflection can execute Proxy traps, so arbitrary active objects
 * are outside this contract. Header equality is an untrusted routing hint and
 * does not attest ownership, authentication, session continuity or authority. */
function dataField(raw: unknown, key: string): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** Preferred list-facing outcome. Hidden means no displayable per-record
 * information; it is never an absent-row or empty-history proof. A caller needs
 * independent current-owner storage/census health before claiming empty history.
 * Foreign and unscopable rows supply no warning, reason or count. This outcome
 * grants no recovery, resend, fresh action or paid-clock permission. */
export function captureStatusOutcomeV2(raw: unknown, display: CaptureDisplayV2): CaptureStatusOutcomeV2 {
  const context = admittedDisplay(display);
  if (!context) return hidden;
  try {
    if (dataField(raw, 'ownerId') !== context.ownerId) return hidden;
    if (dataField(raw, 'deviceId') !== context.deviceId) return hidden;
    const fences = dataField(dataField(raw, 'original'), 'fences');
    if (dataField(fences, 'loginGeneration') !== context.loginGeneration) return hidden;
    let record: RecordV3;
    try { record = parseCrossJobRecord(raw); }
    catch {
      const [label, detail] = copy[context.language].unreadable;
      return Object.freeze({ availability: 'unreadable', scope: 'saved_action_history', label, detail });
    }
    if (record.ownerId !== context.ownerId || record.deviceId !== context.deviceId
      || record.original.fences.loginGeneration !== context.loginGeneration) return hidden;
    return Object.freeze({ availability: 'available', value: renderStatusV2(record, context) });
  } catch { return hidden; }
}

/** Compatibility model only: null is ambiguous; list callers must use the tagged
 * outcome above. A matched historical receipt never establishes what is happening now. No
 * timer, current job, paid total, resend permission or cancellation is derived. */
export function captureStatusV2(raw: unknown, display: CaptureDisplayV2): Readonly<CaptureStatusV2> | null {
  const outcome = captureStatusOutcomeV2(raw, display);
  return outcome.availability === 'available' ? outcome.value : null;
}

function renderStatusV2(record: RecordV3, display: Readonly<CaptureDisplayV2>): Readonly<CaptureStatusV2> {
  const command = record.original.command;
  const receipt = record.historical?.submission.reply;
  let kind: CaptureStatusKindV2;
  if (receipt?.availability === 'available' && receipt.receipt.status === 'refused') kind = 'refused';
  else if (receipt?.availability === 'available' && receipt.receipt.status === 'conflict') kind = 'conflict';
  else if (record.historical?.confirmed) kind = 'receipt_matched';
  else if (record.historical) kind = 'receipt_saved';
  else if (record.everAttempted) kind = 'uncertain';
  else kind = record.hold === null ? 'saved' : 'held';
  const [label, detail] = copy[display.language][kind];
  const intent = command.payload.intent;
  return Object.freeze({
    scope: 'saved_action_history', kind, commandId: command.commandId,
    originalTappedAt: command.payload.tappedAt, physicalShiftId: command.payload.shiftRef!.id,
    requestedProjectId: 'projectId' in intent ? intent.projectId : null,
    hold: record.hold,
    needsReview: record.hold !== null || !['saved', 'receipt_matched'].includes(kind),
    label, detail,
    latestCheckMessage: display.latestCheck === 'unavailable' ? copy[display.language].unavailable : null,
  });
}
