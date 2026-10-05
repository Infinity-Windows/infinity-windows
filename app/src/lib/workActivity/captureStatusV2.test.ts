import { describe, expect, it, vi } from 'vitest';
import { captureStatusV2, captureStatusOutcomeV2, type CaptureDisplayV2 } from './captureStatusV2';
import { confirmAllocation, predictAllocation } from './allocationPredecessor';
import { handoff, actionHandoff, row, id, lookup, submission } from '../workCapture/crossJobStorageV3.fixtures';
import { freezeCrossJobOriginal, type RecordV3, type OriginalV3 } from '../workCapture/crossJobStorageV3';

const display = (): CaptureDisplayV2 => ({ admitted: true, ownerId: id(1), deviceId: id(2), loginGeneration: 2, language: 'en', latestCheck: 'none' });
function attempted(original = handoff()): RecordV3 { return { ...row(original), revision: 1, everAttempted: true, attemptToken: id(70) }; }
function historical(confirmed = true, original: OriginalV3 = handoff()): RecordV3 {
  const r = attempted(original), p = predictAllocation(r.original.command, 'applied'), sent = submission(p), receipt = lookup(p);
  return { ...r, revision: 2, hold: confirmed ? null : 'intent_unproven', historical: {
    submission: sent, lookup: confirmed ? receipt : null,
    confirmed: confirmed ? confirmAllocation(p, receipt, sent) : null,
  } };
}

describe('dormant saved-action display; synthetic receipts, no provider or current-allocation proof', () => {
  it('preserves original tap/physical shift while exposing the separately requested project', () => {
    const r = row(handoff()), before = JSON.stringify(r), model = captureStatusV2(r, display())!;
    expect(model).toMatchObject({ kind: 'saved', commandId: r.commandId, physicalShiftId: id(7), requestedProjectId: id(10), originalTappedAt: r.original.command.payload.tappedAt, scope: 'saved_action_history', needsReview: false });
    expect(model.physicalShiftId).not.toBe(model.requestedProjectId);
    expect(JSON.stringify(r)).toBe(before); expect(Object.isFrozen(model)).toBe(true);
    expect(model).not.toHaveProperty('paidTotal'); expect(model).not.toHaveProperty('currentJob');
    expect(model).not.toHaveProperty('canResend'); expect(model).not.toHaveProperty('canCancel');
  });
  it.each(['unknown', 'unavailable', 'context_changed', null] as const)('keeps a permanent attempt uncertain under %s without claiming delivery or a fresh action', hold => {
    const r = { ...attempted(), hold };
    expect(captureStatusV2(r, display())).toMatchObject({ kind: 'uncertain', needsReview: true, commandId: r.commandId });
  });
  it('requires a full matched historical receipt before using the confirmation label', () => {
    expect(captureStatusV2(historical(false), display())).toMatchObject({ kind: 'receipt_saved', needsReview: true });
    expect(captureStatusV2(historical(), display())).toMatchObject({ kind: 'receipt_matched', scope: 'saved_action_history', needsReview: false });
  });
  it('retains matched history through a later unavailable check and a separate current hold', () => {
    const r = { ...historical(), hold: 'context_changed' as const };
    expect(captureStatusV2(r, { ...display(), latestCheck: 'unavailable' })).toMatchObject({ kind: 'receipt_matched', needsReview: true, hold: 'context_changed', latestCheckMessage: 'Latest check unavailable. The saved history remains.' });
  });
  it('does not interpret a local refusal hold as a server receipt', () => {
    expect(captureStatusV2({ ...row(handoff()), revision: 1, hold: 'refused' }, display())).toMatchObject({ kind: 'held', label: 'Saved action needs review' });
  });
  it('does not manufacture submission provenance from a receipt lookup', () => {
    const r = historical(); delete (r.historical as unknown as Record<string, unknown>).submission;
    expect(captureStatusV2(r, display())).toBeNull();
  });
  it('hides same UUID with a different saved job or selected activity', () => {
    for (const field of ['projectId', 'selectionId'] as const) {
      const r = structuredClone(historical()), intent = r.historical!.submission.command.payload.intent;
      if (intent.kind !== 'switch') throw new Error('Invalid test fixture');
      intent[field] = id(999);
      expect(captureStatusV2(r, display())).toBeNull();
    }
  });
  it('hides same UUID with a different finish-setup cost code', () => {
    const r = structuredClone(historical(true, actionHandoff('finish_setup'))), intent = r.historical!.submission.command.payload.intent;
    if (intent.kind !== 'finish_setup') throw new Error('Invalid test fixture');
    intent.costCodeId = id(999); expect(captureStatusV2(r, display())).toBeNull();
  });
  it.each(['refused', 'conflict'] as const)('uses %s only when a full saved-request receipt records it', status => {
    const r = structuredClone(historical(false)), reply = r.historical!.submission.reply;
    if (reply.availability !== 'available') throw new Error('Invalid test fixture');
    reply.receipt = { ...reply.receipt, status, reasonCode: 'fixture_reason', afterRevision: reply.receipt.beforeRevision, transitionId: null, effectiveAt: null };
    r.hold = status;
    expect(captureStatusV2(r, display())).toMatchObject({ kind: status, needsReview: true });
  });
  it('preserves the saved timezone spelling and microseconds', () => {
    const { commandBytes: _, ...raw } = structuredClone(handoff());
    raw.command.payload.tappedAt = '2026-10-05T00:00:00.123456-06:00';
    const r = row(freezeCrossJobOriginal(raw));
    expect(captureStatusV2(r, display())!.originalTappedAt).toBe(raw.command.payload.tappedAt);
  });
  it.each(['closed', 'owner', 'device', 'login', 'invalid_login', 'language', 'extra'] as const)('hides records for %s display context', kind => {
    const context: Record<string, unknown> = { ...display() };
    if (kind === 'closed') context.admitted = false;
    if (kind === 'owner') context.ownerId = id(999);
    if (kind === 'device') context.deviceId = id(999);
    if (kind === 'login') context.loginGeneration = 3;
    if (kind === 'invalid_login') context.loginGeneration = NaN;
    if (kind === 'language') context.language = 'unknown';
    if (kind === 'extra') context.override = true;
    expect(captureStatusV2(historical(), context as unknown as CaptureDisplayV2)).toBeNull();
  });
  it('rejects display accessors without executing them', () => {
    const context = display(), getter = vi.fn(() => id(1)); Object.defineProperty(context, 'ownerId', { get: getter, enumerable: true });
    expect(captureStatusV2(historical(), context)).toBeNull(); expect(getter).not.toHaveBeenCalled();
  });
  it('keeps Spanish receipt and unavailable-check copy separate from current allocation', () => {
    expect(captureStatusV2(historical(), { ...display(), language: 'es', latestCheck: 'unavailable' })).toMatchObject({ label: 'Recibo confirmado', scope: 'saved_action_history', latestCheckMessage: 'La última verificación no está disponible. El historial sigue guardado.' });
  });
  it('fails closed on corrupt storage without converting it into an empty saved action', () => {
    expect(captureStatusV2(null, display())).toBeNull(); expect(captureStatusV2({}, display())).toBeNull();
    const r = structuredClone(row(handoff())); r.original.commandBytes = '{}'; expect(captureStatusV2(r, display())).toBeNull();
  });
});

describe('tagged history outcomes on inert structured-cloned data; no census or auth proof', () => {
  it('keeps the full valid model in an available outcome without changing its bytes', () => {
    const raw = historical(), before = JSON.stringify(raw), outcome = captureStatusOutcomeV2(raw, display());
    expect(outcome).toEqual({ availability: 'available', value: captureStatusV2(raw, display()) });
    expect(JSON.stringify(raw)).toBe(before); expect(Object.isFrozen(outcome)).toBe(true);
  });
  it('reports known-scope corrupt bytes generically, with no IDs or raw errors', () => {
    const raw = structuredClone(row(handoff())); raw.original.commandBytes = '{}';
    const outcome = captureStatusOutcomeV2(raw, display());
    expect(outcome).toEqual({ availability: 'unreadable', scope: 'saved_action_history', label: 'Saved history could not be verified', detail: 'Keep the saved data for review.' });
    expect(Object.isFrozen(outcome)).toBe(true);
    for (const id of [raw.commandId, raw.ownerId, raw.deviceId]) expect(JSON.stringify(outcome)).not.toContain(id);
  });
  it('uses a generic unreadable outcome for mismatched historical provenance under a matching header', () => {
    const raw = structuredClone(historical()), intent = raw.historical!.submission.command.payload.intent;
    if (intent.kind !== 'switch') throw new Error('Invalid test fixture');
    intent.projectId = id(999); expect(captureStatusOutcomeV2(raw, display()).availability).toBe('unreadable');
  });
  it.each(['owner', 'device', 'login', 'closed'] as const)('never exposes a corrupt row for %s scope', scope => {
    const raw = structuredClone(row(handoff())); raw.original.commandBytes = '{}';
    const context = display();
    if (scope === 'owner') context.ownerId = id(999);
    if (scope === 'device') context.deviceId = id(999);
    if (scope === 'login') context.loginGeneration = 3;
    if (scope === 'closed') context.admitted = false;
    expect(captureStatusOutcomeV2(raw, context)).toEqual({ availability: 'hidden' });
  });
  it.each([null, {}, { ownerId: id(1), deviceId: id(2) }])('does not turn an unscopable value into a foreign-presence warning', raw => {
    expect(captureStatusOutcomeV2(raw, display())).toEqual({ availability: 'hidden' });
  });
  it.each(['ownerId', 'deviceId', 'original'] as const)('does not execute a %s header getter', key => {
    const raw = structuredClone(row(handoff())), getter = vi.fn(() => id(1));
    Object.defineProperty(raw, key, { get: getter, enumerable: true });
    expect(captureStatusOutcomeV2(raw, display())).toEqual({ availability: 'hidden' }); expect(getter).not.toHaveBeenCalled();
  });
  it('does not execute a generation getter or expose its row', () => {
    const raw = structuredClone(row(handoff())), getter = vi.fn(() => 2);
    Object.defineProperty(raw.original.fences, 'loginGeneration', { get: getter, enumerable: true });
    expect(captureStatusOutcomeV2(raw, display())).toEqual({ availability: 'hidden' }); expect(getter).not.toHaveBeenCalled();
  });
  it('does not execute a body getter while returning a generic matching-scope warning', () => {
    const raw = structuredClone(row(handoff())), getter = vi.fn(() => '{}');
    Object.defineProperty(raw.original, 'commandBytes', { get: getter, enumerable: true });
    expect(captureStatusOutcomeV2(raw, display()).availability).toBe('unreadable'); expect(getter).not.toHaveBeenCalled();
  });
  it('keeps invalid display accessors hidden without executing them', () => {
    const context = display(), getter = vi.fn(() => id(1)); Object.defineProperty(context, 'ownerId', { get: getter, enumerable: true });
    expect(captureStatusOutcomeV2(historical(), context)).toEqual({ availability: 'hidden' }); expect(getter).not.toHaveBeenCalled();
  });
  it('provides the same generic unreadable shape in Spanish', () => {
    const raw = structuredClone(row(handoff())); raw.original.commandBytes = '{}';
    expect(captureStatusOutcomeV2(raw, { ...display(), language: 'es' })).toEqual({ availability: 'unreadable', scope: 'saved_action_history', label: 'No se pudo verificar el historial guardado', detail: 'Conserva los datos guardados para su revisión.' });
  });
  it.each([row(handoff()), historical()])('separates saved-action review from a latest unavailable check', raw => {
    const outcome = captureStatusOutcomeV2(raw, { ...display(), latestCheck: 'unavailable' });
    if (outcome.availability !== 'available') throw new Error('Invalid test fixture');
    expect(outcome.value.needsReview).toBe(false); expect(outcome.value.latestCheckMessage).not.toBeNull();
  });
});

describe('own enumerable scope hints; aggregate completeness remains outside this module', () => {
  it.each(['ownerId', 'deviceId', 'original'] as const)('keeps non-enumerable %s headers hidden', key => {
    const raw = structuredClone(row(handoff())); Object.defineProperty(raw, key, { enumerable: false });
    expect(captureStatusOutcomeV2(raw, display())).toEqual({ availability: 'hidden' });
  });
  it('keeps inherited scope headers hidden', () => {
    const base = row(handoff()), raw = Object.create(base);
    expect(captureStatusOutcomeV2(raw, display())).toEqual({ availability: 'hidden' });
  });
  it('keeps non-enumerable generation hints hidden', () => {
    const raw = structuredClone(row(handoff())); Object.defineProperty(raw.original.fences, 'loginGeneration', { enumerable: false });
    expect(captureStatusOutcomeV2(raw, display())).toEqual({ availability: 'hidden' });
  });
  it('accepts inert null-prototype headers without mutation', () => {
    const raw = structuredClone(row(handoff())); Object.setPrototypeOf(raw, null); Object.setPrototypeOf(raw.original, null); Object.setPrototypeOf(raw.original.fences, null);
    const before = JSON.stringify(raw); expect(captureStatusOutcomeV2(raw, display()).availability).toBe('available'); expect(JSON.stringify(raw)).toBe(before);
  });
  it('does not offer completeness or empty-history proof in any outcome', () => {
    const corrupt = structuredClone(row(handoff())); corrupt.original.commandBytes = '{}';
    for (const raw of [null, historical(), corrupt]) {
      const outcome = captureStatusOutcomeV2(raw, display());
      expect(outcome).not.toHaveProperty('coverage'); expect(outcome).not.toHaveProperty('empty'); expect(outcome).not.toHaveProperty('hiddenCount'); expect(outcome).not.toHaveProperty('reason');
    }
  });
});
