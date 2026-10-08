// Acceptance for the held synthetic staging-evidence model (S01-S12).
// Synthetic fixtures only: every approval/admission/fence/selection below is an
// external fixture ASSUMPTION. Passing proves structural consistency, never
// permission, authentication, lifecycle truth, append-only storage or a restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateSyntheticStaging as run } from './model.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const proofFor = (n, patch = {}) => ({ projectId: id(n), domain: 'live', sourceVersion: 'src-7', rootId: `root-${n}`, eventId: `event-${n}`, incarnation: `inc-${n}`, restoreFence: 'fence-1', ...patch });
const X = proofFor(100), Y = proofFor(101), Z = proofFor(102), W = proofFor(103), V = proofFor(104);
const rev = (n, intake, parent, action, target = null) => ({ revisionId: id(n), intakeId: id(intake), parentRevisionId: parent === null ? null : id(parent), action, target: target && { ...target } });
const line = (n, intake, units) => ({ lineId: id(n), intakeId: id(intake), units });
const alloc = (n, contribution, parent, lines, unallocatedUnits) => ({ revisionId: id(n), contributionId: id(contribution), parentRevisionId: parent === null ? null : id(parent), lines, unallocatedUnits });
const assertion = (n, contribution, allocation, lineN, intake, units, resolution, target) => ({ assertionId: id(n), contributionId: id(contribution), allocationRevisionId: id(allocation), lineId: id(lineN), intakeId: id(intake), units, resolutionRevisionId: id(resolution), target: { ...target } });
const REFUSAL = '{"kind":"refused"}';
const json = v => JSON.stringify(v);
const exported = out => json(out.historicalExport);
const LABEL_A = 'Smith residence (pending)', LABEL_B = 'Warehouse rework — unnamed';

// The admission fixture copies the explicit selection; it never auto-selects
// provided assertions. Tests that change the selection must re-admit.
function admit(input, projects, patch = {}) {
  input.admission = { kind: 'supplied_disclosure_assertion', status: 'admitted', poolId: input.pool.poolId, restoreFence: input.restoreFenceAssumption,
    selection: structuredClone(input.selection),
    covers: { contributionIds: input.contributions.map(c => c.contributionId), personIds: input.contributions.map(c => c.personId), intakeIds: input.intakes.map(i => i.intakeId), projects: projects.map(p => ({ ...p })) },
    ...patch };
  return input;
}
function setHead(input, kind, owner, revision) {
  const [heads, key] = kind === 'allocation' ? [input.selection.allocationHeads, 'contributionId'] : [input.selection.resolutionHeads, 'intakeId'];
  heads.find(h => h[key] === id(owner)).revisionId = id(revision);
}
const select = (input, ns) => { input.selection.projectionAssertionIds = ns.map(id); return input; };
// Two people, three intakes (two share a label), two linked to project X.
function base() {
  const input = {
    scope: 'synthetic', restoreFenceAssumption: 'fence-1',
    pool: { poolId: id(1), totalUnits: 9000 },
    contributions: [
      { contributionId: id(10), personId: id(20), units: 5400, allocationRootRevisionId: id(30) },
      { contributionId: id(11), personId: id(21), units: 3600, allocationRootRevisionId: id(31) }],
    intakes: [
      { intakeId: id(40), originalLabel: LABEL_A, originContext: null, rootRevisionId: id(50) },
      { intakeId: id(41), originalLabel: LABEL_A, originContext: null, rootRevisionId: id(51) },
      { intakeId: id(42), originalLabel: LABEL_B, originContext: null, rootRevisionId: id(54) }],
    resolutionRevisions: [rev(50, 40, null, 'root'), rev(52, 40, 50, 'link', X), rev(51, 41, null, 'root'), rev(53, 41, 51, 'link', X), rev(54, 42, null, 'root')],
    allocationRevisions: [
      alloc(30, 10, null, [line(60, 40, 3000), line(61, 42, 1400)], 1000),
      alloc(31, 11, null, [line(62, 41, 2600)], 1000)],
    projectionAssertions: [assertion(70, 10, 30, 60, 40, 3000, 52, X), assertion(71, 11, 31, 62, 41, 2600, 53, X)],
    selection: {
      allocationHeads: [{ contributionId: id(10), revisionId: id(30) }, { contributionId: id(11), revisionId: id(31) }],
      resolutionHeads: [{ intakeId: id(40), revisionId: id(52) }, { intakeId: id(41), revisionId: id(53) }, { intakeId: id(42), revisionId: id(54) }],
      projectionAssertionIds: [id(70), id(71)] },
  };
  return admit(input, [X]);
}
// I3 later linked to Y, and I1 later relinked to W. No new approval.
function relinked() {
  const input = base();
  input.resolutionRevisions.push(rev(55, 42, 54, 'link', Y), rev(56, 40, 52, 'link', W));
  setHead(input, 'resolution', 42, 55); setHead(input, 'resolution', 40, 56);
  return admit(input, [X, Y, W]);
}
// Explicit allocation correction for person 1 with its own new assertions.
function corrected() {
  const input = relinked();
  input.allocationRevisions.push(alloc(32, 10, 30, [line(60, 40, 3000), line(61, 42, 1400)], 1000));
  input.projectionAssertions.push(assertion(72, 10, 32, 61, 42, 1400, 55, Y), assertion(73, 10, 32, 60, 40, 3000, 52, X));
  setHead(input, 'allocation', 10, 32); select(input, [71, 72, 73]);
  return admit(input, [X, Y, W]);
}
const person = (out, n) => out.historicalExport.contributions.find(c => c.contributionId === id(n));
const originsOf = (out, n) => out.disclosureAssessment.retainedOrigins.find(o => o.intakeId === id(n));
const refused = (input, message) => assert.equal(json(run(input)), REFUSAL, message);

test('S01 two synthetic contributions totalling 9000 conserve per person and per pool', () => {
  const out = run(base()), exp = out.historicalExport;
  assert.deepEqual(Object.keys(out), ['kind', 'runtimeAuthority', 'scope', 'confirmationBasis', 'historicalExport', 'disclosureAssessment']);
  assert.deepEqual([out.kind, out.runtimeAuthority, out.scope, out.confirmationBasis], ['synthetic_projection_assessment', 'none', 'synthetic', 'supplied_fixture_assertion']);
  assert.deepEqual([exp.kind, exp.runtimeAuthority, exp.scope, exp.confirmationBasis], ['synthetic_projection', 'none', 'synthetic', 'supplied_fixture_assertion']);
  assert.deepEqual(Object.keys(exp), ['kind', 'runtimeAuthority', 'scope', 'confirmationBasis', 'poolId', 'totalUnits', 'selection', 'originalIntakes', 'totals', 'contributions', 'projects']);
  assert.equal(out.disclosureAssessment.basis, 'supplied_disclosure_assertion');
  assert.equal(exp.totalUnits, 9000);
  assert.deepEqual(exp.totals, { projectBoundUnits: 5600, pendingUnits: 1400, unallocatedUnits: 2000 });
  assert.deepEqual(exp.selection.projectionAssertionIds, [id(70), id(71)]);
  assert.deepEqual(exp.originalIntakes.map(i => [i.intakeId, i.originalLabel, i.originContext, i.rootRevisionId]), [[id(40), LABEL_A, null, id(50)], [id(41), LABEL_A, null, id(51)], [id(42), LABEL_B, null, id(54)]]);
  const one = person(out, 10), two = person(out, 11);
  assert.deepEqual([one.personId, one.projectBoundUnits, one.pendingUnits, one.unallocatedUnits], [id(20), 3000, 1400, 1000]);
  assert.deepEqual([two.personId, two.projectBoundUnits, two.pendingUnits, two.unallocatedUnits], [id(21), 2600, 0, 1000]);
  assert.deepEqual(one.shares, [
    { lineId: id(60), intakeId: id(40), intakeOriginalLabel: LABEL_A, units: 3000, state: 'project_bound', assertionId: id(70), resolutionRevisionId: id(52), target: X },
    { lineId: id(61), intakeId: id(42), intakeOriginalLabel: LABEL_B, units: 1400, state: 'pending', assertionId: null, resolutionRevisionId: null, target: null }]);
  for (const forbidden of ['authenticated', 'permissionsVerified', 'restoreSafe', 'retainedOrigins', 'covers']) assert.ok(!exported(out).includes(forbidden), forbidden);
  for (const forbidden of ['authenticated', 'permissionsVerified', 'restoreSafe']) assert.ok(!json(out).includes(forbidden), forbidden);
  const wrongPool = base(); wrongPool.pool.totalUnits = 9001; refused(wrongPool, 'pool total is checked, not derived');
});

test('S02 distinct intakes with one name resolving to one project count once and keep originals', () => {
  const out = run(base());
  assert.deepEqual(out.historicalExport.projects, [{ target: X, projectBoundUnits: 5600 }]);
  const kept = out.disclosureAssessment.retainedOrigins.filter(o => o.originalLabel === LABEL_A);
  assert.deepEqual(kept.map(o => o.intakeId), [id(40), id(41)]);
  assert.deepEqual(kept.map(o => o.origins), [[X], [X]]);
  assert.deepEqual(out.historicalExport.contributions.flatMap(c => c.shares).filter(s => s.state === 'project_bound').map(s => [s.intakeId, s.intakeOriginalLabel, s.units]),
    [[id(40), LABEL_A, 3000], [id(41), LABEL_A, 2600]]);
  // Partial evidence: deselect person 2's assertion and re-admit; only that share is pending.
  const partial = admit(select(base(), [70]), [X]);
  const p = run(partial);
  assert.deepEqual(p.historicalExport.totals, { projectBoundUnits: 3000, pendingUnits: 4000, unallocatedUnits: 2000 });
  assert.deepEqual(p.historicalExport.projects, [{ target: X, projectBoundUnits: 3000 }]);
  assert.equal(person(p, 11).shares[0].state, 'pending');
  // A selected ID whose assertion was removed is dangling and refuses.
  const dangling = base(); dangling.projectionAssertions.pop(); refused(dangling, 'dangling selected assertion ID');
});

test('S03 a newer link alone neither approves pending labor nor retargets approved labor', () => {
  const out = run(relinked());
  assert.deepEqual(out.historicalExport.totals, run(base()).historicalExport.totals);
  const one = person(out, 10);
  assert.deepEqual(one.shares.map(s => [s.state, s.target]), [['project_bound', X], ['pending', null]]);
  assert.equal(one.shares[0].resolutionRevisionId, id(52)); // still the approved link, not head 56 -> W
  assert.deepEqual(out.historicalExport.projects, [{ target: X, projectBoundUnits: 5600 }]);
  const i1 = originsOf(out, 40);
  assert.equal(i1.selectedResolutionRevisionId, id(56));
  assert.deepEqual(new Set(i1.origins.map(o => o.projectId)), new Set([id(100), id(103)]));
});

test('S04 corrections and later records: the selected historical export stays byte-identical', () => {
  // (a) Later link/unlink/relink records with the ORIGINAL heads and IDs reproduce the old export.
  const old = run(base()), oldBytes = exported(old);
  const expanded = base();
  expanded.resolutionRevisions.push(rev(55, 42, 54, 'link', Y), rev(57, 42, 55, 'unlink'), rev(58, 42, 57, 'link', Z));
  admit(expanded, [X, Y, Z]);
  const grown = run(expanded);
  assert.equal(exported(grown), oldBytes, 'later records do not enter the selected export');
  assert.deepEqual(originsOf(old, 42).origins, []);
  assert.deepEqual(new Set(originsOf(grown, 42).origins.map(o => o.projectId)), new Set([id(101), id(102)]), 'full assessment does change');
  const uncovered = structuredClone(expanded); admit(uncovered, [X, Y]); refused(uncovered, 'new origin Z uncovered: no export, no dependency fields');
  // Fable's trace: a later link child of the selected head 56 to V, still head 56, V admitted.
  const before = run(relinked()), beforeBytes = exported(before);
  const later = relinked(); later.resolutionRevisions.push(rev(59, 40, 56, 'link', V)); admit(later, [X, Y, W, V]);
  assert.equal(exported(run(later)), beforeBytes);
  assert.equal(originsOf(run(later), 40).origins.length, 3);
  // (b) An appended but unselected assertion changes nothing; selecting it does.
  const appended = relinked(); appended.projectionAssertions.push(assertion(74, 10, 30, 61, 42, 1400, 55, Y));
  assert.equal(exported(run(appended)), beforeBytes);
  assert.equal(person(run(appended), 10).pendingUnits, 1400);
  const chosen = admit(select(structuredClone(appended), [70, 71, 74]), [X, Y, W]);
  assert.deepEqual(run(chosen).historicalExport.totals, { projectBoundUnits: 7000, pendingUnits: 0, unallocatedUnits: 2000 });
  const restored = admit(select(structuredClone(chosen), [70, 71]), [X, Y, W]);
  assert.equal(exported(run(restored)), beforeBytes);
  const unadmitted = select(structuredClone(appended), [70, 71, 74]); refused(unadmitted, 'selection change without matching admission');
  // (c) An actual allocation correction changes the export; old head + old IDs returns it.
  const after = run(corrected());
  assert.notEqual(exported(after), beforeBytes);
  assert.deepEqual([person(after, 10).allocationRevisionId, person(after, 10).projectBoundUnits, person(after, 10).pendingUnits], [id(32), 4400, 0]);
  assert.deepEqual(after.historicalExport.projects, [{ target: X, projectBoundUnits: 5600 }, { target: Y, projectBoundUnits: 1400 }]);
  const earlierHead = corrected(); setHead(earlierHead, 'allocation', 10, 30); select(earlierHead, [70, 71]); admit(earlierHead, [X, Y, W]);
  assert.equal(exported(run(earlierHead)), beforeBytes, 'earlier export reproduces byte-identically after correction');
  assert.equal(exported(before), beforeBytes);
  // A correction does not inherit the earlier revision's approval.
  const unbound = corrected(); select(unbound, [71, 72]); admit(unbound, [X, Y, W]);
  assert.deepEqual(person(run(unbound), 10).shares.map(s => s.state), ['pending', 'project_bound']);
});

test('S05 explicit earlier heads and assertion IDs win over newer or shuffled input; bad selections refuse', () => {
  const reverseDeep = v => Array.isArray(v) ? v.map(reverseDeep).reverse() : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseDeep(x)])) : v;
  const earlier = corrected(); setHead(earlier, 'allocation', 10, 30); setHead(earlier, 'resolution', 42, 54); select(earlier, [70, 71]); admit(earlier, [X, Y, W]);
  const out = run(earlier);
  assert.deepEqual([person(out, 10).allocationRevisionId, person(out, 10).pendingUnits], [id(30), 1400]);
  assert.equal(json(run(reverseDeep(earlier))), json(out), 'shuffled ledger: export and assessment identical');
  assert.equal(json(run(reverseDeep(corrected()))), json(run(corrected())));
  const idsOnly = corrected(); idsOnly.selection.projectionAssertionIds.reverse(); assert.equal(json(run(idsOnly)), json(run(corrected())));
  const admissionOnly = corrected(); admissionOnly.admission.selection.projectionAssertionIds.reverse(); admissionOnly.admission.covers.projects.reverse();
  assert.equal(json(run(admissionOnly)), json(run(corrected())));
  // Later link and later assertion under an older resolution head.
  const pre = base(); pre.resolutionRevisions.push(rev(55, 42, 54, 'link', Y)); pre.projectionAssertions.push(assertion(74, 10, 30, 61, 42, 1400, 55, Y)); admit(pre, [X, Y]);
  assert.equal(exported(run(pre)), exported(run(base())));
  const premature = admit(select(structuredClone(pre), [70, 71, 74]), [X, Y]); refused(premature, '74 outside selected head 54');
  const absent = corrected(); absent.selection.allocationHeads.shift(); admit(absent, [X, Y, W]); refused(absent, 'missing head');
  const twice = corrected(); twice.selection.allocationHeads.push({ ...twice.selection.allocationHeads[0] }); admit(twice, [X, Y, W]); refused(twice, 'duplicate head');
  const foreign = corrected(); setHead(foreign, 'allocation', 10, 31); admit(foreign, [X, Y, W]); refused(foreign, 'head of another contribution');
  const table = {
    missingIds: i => { delete i.selection.projectionAssertionIds; },
    nonArray: i => { i.selection.projectionAssertionIds = id(71); },
    malformedId: i => { i.selection.projectionAssertionIds.push('not-a-uuid'); },
    duplicateId: i => { i.selection.projectionAssertionIds.push(id(71)); },
    unknownId: i => { i.selection.projectionAssertionIds.push(id(79)); },
    wrongAllocationHead: i => { i.selection.projectionAssertionIds = [id(70), id(71)]; },
    outsideAncestry: i => { setHead(i, 'resolution', 42, 54); },
  };
  for (const [name, mutate] of Object.entries(table)) { const input = corrected(); mutate(input); if ('projectionAssertionIds' in input.selection) admit(input, [X, Y, W]); refused(input, name); }
  const otherIds = corrected(); otherIds.admission.selection.projectionAssertionIds = [id(72), id(73)]; refused(otherIds, 'admission binds different IDs');
  const malformedUnselected = corrected(); malformedUnselected.projectionAssertions.push(assertion(75, 10, 30, 61, 42, 1401, 55, Y)); // free slot, wrong amount
  refused(malformedUnselected, 'malformed unselected assertion');
  const slotUnselected = corrected(); slotUnselected.projectionAssertions.push(assertion(76, 10, 30, 60, 40, 3000, 52, X)); refused(slotUnselected, 'duplicate slot 30|60 even unselected');
  const emptyValid = admit(select(base(), []), [X]); assert.equal(run(emptyValid).historicalExport.totals.pendingUnits, 7000, 'explicit empty selection is valid');
});

test('S06 missing parent, cycle, cross-intake parent and accepted forks refuse generically', () => {
  const outcomes = [];
  const missing = base(); missing.resolutionRevisions[1].parentRevisionId = id(99); outcomes.push(run(missing));
  const cycle = base(); cycle.resolutionRevisions[1].parentRevisionId = id(57); cycle.resolutionRevisions.push(rev(57, 40, 52, 'unlink')); outcomes.push(run(cycle));
  const cross = base(); cross.resolutionRevisions[3].parentRevisionId = id(50); outcomes.push(run(cross));
  const fork = base(); fork.resolutionRevisions.push(rev(58, 40, 50, 'link', X)); outcomes.push(run(fork));
  const allocationFork = base(); allocationFork.allocationRevisions.push(alloc(33, 10, 30, [line(60, 40, 5400)], 0), alloc(34, 10, 30, [], 5400)); outcomes.push(run(allocationFork));
  const secondRoot = base(); secondRoot.resolutionRevisions.push(rev(59, 40, null, 'root')); outcomes.push(run(secondRoot));
  for (const o of outcomes) { assert.equal(o, outcomes[0]); assert.equal(json(o), REFUSAL); }
  // Positive control: the same chain extended linearly is accepted.
  const linear = base(); linear.resolutionRevisions.push(rev(57, 40, 52, 'unlink')); assert.equal(run(linear).kind, 'synthetic_projection_assessment');
});

test('S07 duplicate identities, unsafe/fractional/negative amounts, overflow and nonconservation reject', () => {
  const cases = {
    duplicateContribution: i => i.contributions.push({ ...i.contributions[0], personId: id(22), units: 0 }),
    duplicatePerson: i => { i.contributions[1].personId = id(20); },
    duplicateLine: i => { i.allocationRevisions[0].lines = [line(60, 40, 1500), line(60, 40, 1500), line(61, 42, 1400)]; },
    revisionIdReuse: i => { i.allocationRevisions[1].revisionId = id(52); },
    fractional: i => { i.allocationRevisions[0].unallocatedUnits = 1000.5; },
    stringNumber: i => { i.allocationRevisions[0].unallocatedUnits = '1000'; },
    negative: i => { i.allocationRevisions[0].unallocatedUnits = -1; i.allocationRevisions[0].lines[1].units = 1401; },
    unsafe: i => { i.pool.totalUnits = 2 ** 53; },
    nonconserving: i => { i.allocationRevisions[0].unallocatedUnits = 999; },
    zeroLine: i => { i.allocationRevisions[0].lines[1].units = 0; i.allocationRevisions[0].unallocatedUnits = 2400; },
    missingUnallocated: i => { delete i.allocationRevisions[0].unallocatedUnits; },
    approvedFlag: i => { i.contributions[0].approved = true; },
    overflow: i => { i.contributions[0].units = Number.MAX_SAFE_INTEGER; i.allocationRevisions[0].unallocatedUnits = Number.MAX_SAFE_INTEGER - 4400; i.pool.totalUnits = Number.MAX_SAFE_INTEGER; },
  };
  for (const [name, mutate] of Object.entries(cases)) { const input = base(); mutate(input); refused(input, name); }
  // Positive boundary: exactly MAX_SAFE_INTEGER in the pool is accepted.
  const edge = base(); const top = Number.MAX_SAFE_INTEGER - 3600;
  edge.contributions[0].units = top; edge.allocationRevisions[0].unallocatedUnits = top - 4400; edge.pool.totalUnits = Number.MAX_SAFE_INTEGER;
  assert.equal(run(edge).historicalExport.totals.unallocatedUnits, top - 4400 + 1000);
});

test('S08 every retained origin must stay admitted, even after unlink/relink or an older head', () => {
  const history = () => {
    const input = base();
    input.resolutionRevisions.push(rev(55, 42, 54, 'link', Y), rev(57, 42, 55, 'unlink'), rev(58, 42, 57, 'link', Z));
    setHead(input, 'resolution', 42, 58);
    return input;
  };
  for (const head of [58, 57, 54]) {
    const without = history(); setHead(without, 'resolution', 42, head); admit(without, [X, Z]); refused(without, `Y retained at head ${head}`);
    const full = history(); setHead(full, 'resolution', 42, head); admit(full, [X, Y, Z]);
    assert.deepEqual(new Set(originsOf(run(full), 42).origins.map(o => o.projectId)), new Set([id(101), id(102)]), `head ${head}`);
  }
  const fewer = history(); select(fewer, []); admit(fewer, [X, Z]); refused(fewer, 'selecting fewer assertions never shrinks required history coverage');
  const anchored = base(); anchored.intakes[1].originContext = { ...V }; admit(anchored, [X]); refused(anchored, 'original context is a dependency');
  admit(anchored, [X, V]);
  const a = run(anchored);
  assert.deepEqual(new Set(originsOf(a, 41).origins.map(o => o.projectId)), new Set([id(100), id(104)]));
  assert.deepEqual(a.historicalExport.originalIntakes.find(i => i.intakeId === id(41)).originContext, V);
});

test('S09 missing, denied, stale or differently bound disclosure all give one generic refusal', () => {
  const variants = {
    missing: i => { delete i.admission; },
    denied: i => { i.admission.status = 'denied'; },
    staleFence: i => { i.admission.restoreFence = 'fence-0a'; },
    otherPool: i => { i.admission.poolId = id(2); },
    otherSelection: i => { i.admission.selection.resolutionHeads[0].revisionId = id(50); },
    otherAssertionIds: i => { i.admission.selection.projectionAssertionIds = [id(70)]; },
    missingPerson: i => { i.admission.covers.personIds.pop(); },
    missingIntake: i => { i.admission.covers.intakeIds.shift(); },
    missingProject: i => { i.admission.covers.projects = []; },
    ownerLabel: i => { i.admission.role = 'Owner'; },
    approvedTrue: i => { delete i.admission; i.approved = true; },
    ownerInsteadOfAdmission: i => { i.admission = { role: 'Owner', approved: true }; },
    wrongKind: i => { i.admission.kind = 'verified_permission'; },
  };
  const outcomes = Object.entries(variants).map(([name, mutate]) => { const input = base(); mutate(input); return [name, run(input)]; });
  for (const [name, o] of outcomes) {
    assert.equal(o, outcomes[0][1], name); assert.equal(json(o), REFUSAL, name);
    assert.ok(Object.isFrozen(o)); assert.ok(!('historicalExport' in o) && !('disclosureAssessment' in o), name);
  }
});

test('S10 same project UUID with a changed root/event/incarnation/domain, absent fields or zero cannot confirm', () => {
  const tamper = (patch, where = 'assertion') => {
    const input = base();
    if (where === 'assertion') Object.assign(input.projectionAssertions[0].target, patch);
    else { Object.assign(input.resolutionRevisions[1].target, patch); admit(input, [X, input.resolutionRevisions[1].target]); }
    return input;
  };
  for (const [name, patch] of Object.entries({ root: { rootId: 'root-other' }, event: { eventId: 'event-other' }, incarnation: { incarnation: 'inc-other' }, domain: { domain: 'test' }, version: { sourceVersion: 'src-8' } })) {
    refused(tamper(patch), `assertion ${name}`); refused(tamper(patch, 'link'), `link ${name}`);
  }
  refused(tamper({ domain: 'unknown' }), 'unknown domain');
  for (const zero of ['0', '000']) {
    const input = base(); for (const t of [input.projectionAssertions[0].target, input.resolutionRevisions[1].target]) t.incarnation = zero;
    admit(input, [{ ...X, incarnation: zero }]); refused(input, `zero incarnation ${zero}`);
  }
  const absent = base(); delete absent.projectionAssertions[0].target.incarnation; refused(absent, 'absent incarnation');
  const uuidOnly = base(); uuidOnly.projectionAssertions[0].target = { projectId: X.projectId }; refused(uuidOnly, 'UUID alone');
});

test('S11 identical restored inputs are indistinguishable; a changed external fence rejects the old binding', () => {
  // NO real restore authority: the model only compares supplied fence strings.
  const first = run(base()), restored = run(structuredClone(base()));
  assert.equal(json(restored), json(first), 'byte-identical restored inputs are indistinguishable by design');
  const moved = base(); moved.restoreFenceAssumption = 'fence-2'; moved.admission.restoreFence = 'fence-2';
  refused(moved, 'proofs bound to fence-1 are stale under fence-2');
  // Limitation witness: rebinding every supplied proof to the new fence passes,
  // because the fence itself is an unattested fixture assumption.
  const rebound = JSON.parse(json(base()).replaceAll('fence-1', 'fence-2'));
  assert.equal(json(run(rebound)), json(first).replaceAll('fence-1', 'fence-2'));
});

test('S12 repeatable on frozen inputs; inputs and earlier outputs untouched; no outside effects', () => {
  const deepFreeze = v => { if (v && typeof v === 'object') { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; };
  const input = deepFreeze(corrected()), snapshot = json(input);
  const a = run(input), aJson = json(a), b = run(input);
  assert.equal(json(b), aJson); assert.notEqual(a, b);
  run(base()); run(relinked());
  assert.equal(json(a), aJson); assert.equal(json(input), snapshot);
  const objects = v => { const s = new Set(); const walk = x => { if (x && typeof x === 'object') { s.add(x); Object.values(x).forEach(walk); } }; walk(v); return s; };
  const outputObjects = objects(a);
  for (const o of outputObjects) assert.ok(Object.isFrozen(o));
  for (const o of objects(input)) assert.ok(!outputObjects.has(o), 'output never aliases input');
  // Shared non-cyclic references are copied per occurrence, not refused.
  const shared = base(), proof = { ...X };
  shared.resolutionRevisions[1].target = proof; shared.resolutionRevisions[3].target = proof; shared.projectionAssertions[0].target = proof;
  const s = run(shared);
  assert.equal(json(s), json(run(base())), 'aliased input projects like unaliased input');
  assert.ok(!objects(s).has(proof));
  // Cycles refuse and terminate.
  const cyclic = base(); const loop = { ...X }; loop.self = loop; cyclic.resolutionRevisions[1].target = loop; refused(cyclic, 'cycle');
  const listCycle = base(); listCycle.intakes.push(listCycle.intakes); refused(listCycle, 'array cycle');
  let reads = 0;
  const accessor = base(); const target = accessor.contributions[0]; delete target.units;
  Object.defineProperty(target, 'units', { enumerable: true, get() { reads++; return 5400; } });
  refused(accessor, 'accessor input'); assert.equal(reads, 0);
  const protoKey = JSON.parse(json(base()).replace('"scope":"synthetic"', '"__proto__":{"scope":"synthetic"},"scope":"synthetic"'));
  refused(protoKey, 'own __proto__ key is an unknown key');
  const source = readFileSync(new URL('./model.mjs', import.meta.url), 'utf8');
  for (const pattern of [/\bimport\b/, /\brequire\s*\(/, /\bDate\b/, /Math\.random/, /\bcrypto\b/, /\bfetch\b/, /indexedDB|localStorage|sessionStorage/, /setTimeout|setInterval/, /\beval\b|new Function/, /\bprocess\./, /globalThis|navigator|performance/, /console\./, /percent/i]) {
    assert.ok(!pattern.test(source), String(pattern));
  }
});
