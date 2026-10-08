// Synthetic staging-evidence projection. Held design prototype, never loaded by
// the app. Pure function: no I/O, storage, network, wall time, randomness or
// identifier minting. Every confirmation it reports rests on a SUPPLIED fixture
// assertion; nothing here authenticates, grants permission or proves a restore.
// See docs/design-prototypes/staging-evidence.md for the strict input schema.

const REFUSED = Object.freeze({ kind: 'refused' });
const LIMITS = Object.freeze({ depth: 12, nodes: 200000, contributions: 500, intakes: 500, revisions: 5000, lines: 64, assertions: 5000, cover: 5000, label: 200 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DOMAINS = Object.freeze(['live', 'test']);
const PROOF_KEYS = Object.freeze(['projectId', 'domain', 'sourceVersion', 'rootId', 'eventId', 'incarnation', 'restoreFence']);
const TOP_KEYS = Object.freeze(['scope', 'restoreFenceAssumption', 'pool', 'contributions', 'intakes', 'resolutionRevisions', 'allocationRevisions', 'projectionAssertions', 'selection', 'admission']);

// Every failure, whatever its cause, becomes the one shared refusal object.
function refuse() { throw REFUSED; }

/** Private bounded copy. Rejects accessors, symbols, cycles, sparse arrays,
 * non-plain prototypes and non-finite numbers. A non-cyclic object reached
 * from several places is NOT refused: each occurrence is copied separately
 * (and counted against the node bound), so the copy itself shares no nodes.
 * Getters are never invoked; the caller's input is never written. */
function clone(value) {
  let nodes = 0;
  const seen = new Set();
  const walk = (v, depth) => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) refuse();
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) refuse(); return v; }
    if (typeof v !== 'object' || seen.has(v)) refuse();
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) refuse();
    if (Object.getOwnPropertySymbols(v).length) refuse();
    const descriptors = Object.getOwnPropertyDescriptors(v);
    seen.add(v);
    let out;
    if (array) {
      if (Object.keys(descriptors).length !== v.length + 1) refuse();
      out = [];
      for (let i = 0; i < v.length; i++) {
        const d = descriptors[i];
        if (!d || !('value' in d) || !d.enumerable) refuse();
        out.push(walk(d.value, depth + 1));
      }
    } else {
      out = {};
      for (const [key, d] of Object.entries(descriptors)) {
        if (!('value' in d) || !d.enumerable) refuse();
        // defineProperty, not assignment: an own "__proto__" key stays a key.
        Object.defineProperty(out, key, { value: walk(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
    }
    seen.delete(v);
    return out;
  };
  return walk(value, 0);
}
function deepFreeze(v) { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); } return v; }

function exact(v, keys) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) refuse();
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) refuse();
  return v;
}
function list(v, max, min = 0) { if (!Array.isArray(v) || v.length > max || v.length < min) refuse(); return v; }
function uuid(v) { if (typeof v !== 'string' || !UUID.test(v)) refuse(); return v; }
// Opaque proof tokens. An all-zero token is a baseline, never lifecycle proof.
function token(v) { if (typeof v !== 'string' || !TOKEN.test(v) || /^0+$/.test(v)) refuse(); return v; }
function amount(v, positive = false) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || Object.is(v, -0) || (positive && v === 0)) refuse();
  return v;
}
function add(a, b) { const sum = a + b; if (!Number.isSafeInteger(sum)) refuse(); return sum; }
function label(v) { if (typeof v !== 'string' || v.length < 1 || v.length > LIMITS.label) refuse(); return v; }
const proofKey = p => JSON.stringify(PROOF_KEYS.map(k => p[k]));
const copyProof = p => Object.fromEntries(PROOF_KEYS.map(k => [k, p[k]]));
const by = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/** Complete single-parent chains from each owner's declared root. Refuses a
 * missing or foreign parent, a fork (accepted siblings), a second root and any
 * revision that cannot reach its root (cycle). Nothing is repaired. */
function chains(revisions, roots, ownerOf) {
  const parents = new Set();
  for (const r of revisions.values()) {
    const owner = ownerOf(r);
    if (!roots.has(owner)) refuse();
    if (r.parentRevisionId === null) { if (roots.get(owner) !== r.revisionId) refuse(); continue; }
    const parent = revisions.get(r.parentRevisionId);
    if (!parent || ownerOf(parent) !== owner || parents.has(r.parentRevisionId)) refuse();
    parents.add(r.parentRevisionId);
  }
  for (const [owner, root] of roots) {
    const r = revisions.get(root);
    if (!r || ownerOf(r) !== owner || r.parentRevisionId !== null) refuse();
  }
  const reached = new Set();
  for (const r of revisions.values()) {
    const path = [];
    let current = r;
    while (!reached.has(current.revisionId) && current.parentRevisionId !== null) {
      path.push(current.revisionId);
      if (path.length > revisions.size) refuse();
      current = revisions.get(current.parentRevisionId);
    }
    if (!reached.has(current.revisionId)) {
      if (roots.get(ownerOf(current)) !== current.revisionId) refuse();
      reached.add(current.revisionId);
    }
    for (const id of path) reached.add(id);
  }
}
function ancestorOrEqual(revisions, ancestor, head) {
  for (let id = head, steps = 0; id !== null; id = revisions.get(id).parentRevisionId) {
    if (id === ancestor) return true;
    if (++steps > revisions.size) refuse();
  }
  return false;
}

function project(x) {
  exact(x, TOP_KEYS);
  if (x.scope !== 'synthetic') refuse();
  const fence = token(x.restoreFenceAssumption);
  // Every proof must carry the supplied fence exactly. A changed fence makes
  // every earlier binding stale; the model cannot attest the fence itself.
  const proof = v => {
    exact(v, PROOF_KEYS); uuid(v.projectId);
    if (!DOMAINS.includes(v.domain)) refuse();
    for (const k of PROOF_KEYS.slice(2)) token(v[k]);
    if (v.restoreFence !== fence) refuse();
    return v;
  };
  const minted = new Set();
  const mint = v => { uuid(v); if (minted.has(v)) refuse(); minted.add(v); return v; };

  exact(x.pool, ['poolId', 'totalUnits']);
  const poolId = mint(x.pool.poolId), totalUnits = amount(x.pool.totalUnits);

  // One contribution per person; the pool total is checked, never derived.
  const contributions = new Map();
  let pooled = 0;
  for (const c of list(x.contributions, LIMITS.contributions, 1)) {
    exact(c, ['contributionId', 'personId', 'units', 'allocationRootRevisionId']);
    mint(c.contributionId); mint(c.personId); amount(c.units); uuid(c.allocationRootRevisionId);
    contributions.set(c.contributionId, c);
    pooled = add(pooled, c.units);
  }
  if (pooled !== totalUnits) refuse();

  // Same labels stay separate intakes: identity is the intake UUID only.
  const intakes = new Map();
  for (const i of list(x.intakes, LIMITS.intakes)) {
    exact(i, ['intakeId', 'originalLabel', 'originContext', 'rootRevisionId']);
    mint(i.intakeId); label(i.originalLabel); uuid(i.rootRevisionId);
    if (i.originContext !== null) proof(i.originContext);
    intakes.set(i.intakeId, i);
  }

  const resolutions = new Map();
  for (const r of list(x.resolutionRevisions, LIMITS.revisions)) {
    exact(r, ['revisionId', 'intakeId', 'parentRevisionId', 'action', 'target']);
    mint(r.revisionId);
    if (!intakes.has(uuid(r.intakeId))) refuse();
    if (r.parentRevisionId !== null) uuid(r.parentRevisionId);
    if (r.action === 'link') proof(r.target);
    else if (r.action === 'root' || r.action === 'unlink') { if (r.target !== null) refuse(); }
    else refuse();
    if ((r.action === 'root') !== (r.parentRevisionId === null)) refuse();
    resolutions.set(r.revisionId, r);
  }
  chains(resolutions, new Map([...intakes.values()].map(i => [i.intakeId, i.rootRevisionId])), r => r.intakeId);

  // Each allocation revision accounts for its whole contribution explicitly:
  // lines plus unallocatedUnits. No missing value defaults to zero.
  const allocations = new Map(), allocationLines = new Map();
  for (const a of list(x.allocationRevisions, LIMITS.revisions)) {
    exact(a, ['revisionId', 'contributionId', 'parentRevisionId', 'lines', 'unallocatedUnits']);
    mint(a.revisionId);
    const c = contributions.get(uuid(a.contributionId));
    if (!c) refuse();
    if (a.parentRevisionId !== null) uuid(a.parentRevisionId);
    const lines = new Map();
    let sum = amount(a.unallocatedUnits);
    for (const l of list(a.lines, LIMITS.lines)) {
      exact(l, ['lineId', 'intakeId', 'units']);
      uuid(l.lineId);
      if (lines.has(l.lineId) || !intakes.has(uuid(l.intakeId))) refuse();
      sum = add(sum, amount(l.units, true));
      lines.set(l.lineId, l);
    }
    if (sum !== c.units) refuse();
    allocations.set(a.revisionId, a);
    allocationLines.set(a.revisionId, lines);
  }
  chains(allocations, new Map([...contributions.values()].map(c => [c.contributionId, c.allocationRootRevisionId])), a => a.contributionId);

  // Heads and applied assertions are explicit. Any listed revision may be
  // chosen, including an older one; array position, recency and counters
  // never choose for the caller, and no provided assertion applies unless its
  // ID is selected. The selection is a caller recipe, not an approval.
  const heads = (value, owners, revisions, ownerOf, key) => {
    const out = new Map();
    for (const h of list(value, owners.size, owners.size)) {
      exact(h, [key, 'revisionId']); uuid(h[key]); uuid(h.revisionId);
      if (!owners.has(h[key]) || out.has(h[key])) refuse();
      const r = revisions.get(h.revisionId);
      if (!r || ownerOf(r) !== h[key]) refuse();
      out.set(h[key], h.revisionId);
    }
    return out;
  };
  const parseSelection = s => {
    exact(s, ['allocationHeads', 'resolutionHeads', 'projectionAssertionIds']);
    const assertions = new Set();
    for (const e of list(s.projectionAssertionIds, LIMITS.assertions)) { uuid(e); if (assertions.has(e)) refuse(); assertions.add(e); }
    return {
      allocation: heads(s.allocationHeads, contributions, allocations, a => a.contributionId, 'contributionId'),
      resolution: heads(s.resolutionHeads, intakes, resolutions, r => r.intakeId, 'intakeId'),
      assertions,
    };
  };
  const pairs = (map, key) => [...map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([owner, revisionId]) => ({ [key]: owner, revisionId }));
  const canonicalSelection = s => ({ allocationHeads: pairs(s.allocation, 'contributionId'), resolutionHeads: pairs(s.resolution, 'intakeId'), projectionAssertionIds: [...s.assertions].sort() });
  const selectionKey = s => JSON.stringify(canonicalSelection(s));
  const selection = parseSelection(x.selection);

  // External projection assertions bind one exact line of one exact allocation
  // revision to one exact link revision and target tuple. A newer intake link
  // alone never retargets or approves labor. EVERY provided assertion, selected
  // or not, is structurally validated and occupies its (revision, line) slot.
  const assertionsById = new Map(), slots = new Set();
  for (const p of list(x.projectionAssertions, LIMITS.assertions)) {
    exact(p, ['assertionId', 'contributionId', 'allocationRevisionId', 'lineId', 'intakeId', 'units', 'resolutionRevisionId', 'target']);
    mint(p.assertionId);
    uuid(p.contributionId); uuid(p.allocationRevisionId); uuid(p.lineId); uuid(p.intakeId); uuid(p.resolutionRevisionId);
    amount(p.units, true); proof(p.target);
    const a = allocations.get(p.allocationRevisionId);
    if (!a || a.contributionId !== p.contributionId) refuse();
    const l = allocationLines.get(a.revisionId).get(p.lineId);
    if (!l || l.intakeId !== p.intakeId || l.units !== p.units) refuse();
    const r = resolutions.get(p.resolutionRevisionId);
    if (!r || r.intakeId !== p.intakeId || r.action !== 'link' || proofKey(r.target) !== proofKey(p.target)) refuse();
    const slot = `${p.allocationRevisionId}|${p.lineId}`;
    if (slots.has(slot)) refuse();
    slots.add(slot);
    assertionsById.set(p.assertionId, p);
  }
  // Only selected assertions bind. Each must exist, sit on the selected
  // allocation head and name a link within the selected intake history.
  const bound = new Map();
  for (const assertionId of selection.assertions) {
    const p = assertionsById.get(assertionId);
    if (!p || selection.allocation.get(p.contributionId) !== p.allocationRevisionId) refuse();
    if (!ancestorOrEqual(resolutions, p.resolutionRevisionId, selection.resolution.get(p.intakeId))) refuse();
    bound.set(`${p.allocationRevisionId}|${p.lineId}`, p);
  }

  // Retained origins: the original context plus EVERY accepted link target in
  // the intake's history, whichever head is selected. Unlink, relink or an
  // older head cannot drop a dependency.
  const origins = new Map();
  for (const i of intakes.values()) origins.set(i.intakeId, new Map(i.originContext ? [[proofKey(i.originContext), i.originContext]] : []));
  for (const r of resolutions.values()) if (r.action === 'link') origins.get(r.intakeId).set(proofKey(r.target), r.target);

  // Supplied disclosure assertion. Structural coverage only; this is not a
  // verified permission and no role, label or flag substitutes for it.
  const m = exact(x.admission, ['kind', 'status', 'poolId', 'restoreFence', 'selection', 'covers']);
  if (m.kind !== 'supplied_disclosure_assertion' || m.status !== 'admitted' || m.poolId !== poolId || m.restoreFence !== fence) refuse();
  if (selectionKey(parseSelection(m.selection)) !== selectionKey(selection)) refuse();
  const covers = exact(m.covers, ['contributionIds', 'personIds', 'intakeIds', 'projects']);
  const idSet = v => { const s = new Set(); for (const e of list(v, LIMITS.cover)) { uuid(e); if (s.has(e)) refuse(); s.add(e); } return s; };
  const coveredContributions = idSet(covers.contributionIds), coveredPeople = idSet(covers.personIds), coveredIntakes = idSet(covers.intakeIds), coveredProjects = new Set();
  for (const q of list(covers.projects, LIMITS.cover)) { const k = proofKey(proof(q)); if (coveredProjects.has(k)) refuse(); coveredProjects.add(k); }
  for (const c of contributions.values()) if (!coveredContributions.has(c.contributionId) || !coveredPeople.has(c.personId)) refuse();
  for (const i of intakes.values()) {
    if (!coveredIntakes.has(i.intakeId)) refuse();
    for (const k of origins.get(i.intakeId).keys()) if (!coveredProjects.has(k)) refuse();
  }

  const buckets = new Map(), rows = [];
  let projectBound = 0, pending = 0, unallocated = 0;
  for (const c of contributions.values()) {
    const headId = selection.allocation.get(c.contributionId), head = allocations.get(headId), shares = [];
    let ownBound = 0, ownPending = 0;
    for (const l of allocationLines.get(headId).values()) {
      const p = bound.get(`${headId}|${l.lineId}`), original = intakes.get(l.intakeId).originalLabel;
      if (!p) {
        ownPending = add(ownPending, l.units);
        shares.push({ lineId: l.lineId, intakeId: l.intakeId, intakeOriginalLabel: original, units: l.units, state: 'pending', assertionId: null, resolutionRevisionId: null, target: null });
        continue;
      }
      ownBound = add(ownBound, l.units);
      const k = proofKey(p.target), bucket = buckets.get(k);
      buckets.set(k, { target: p.target, units: add(bucket ? bucket.units : 0, l.units) });
      shares.push({ lineId: l.lineId, intakeId: l.intakeId, intakeOriginalLabel: original, units: l.units, state: 'project_bound', assertionId: p.assertionId, resolutionRevisionId: p.resolutionRevisionId, target: copyProof(p.target) });
    }
    if (add(add(ownBound, ownPending), head.unallocatedUnits) !== c.units) refuse();
    projectBound = add(projectBound, ownBound); pending = add(pending, ownPending); unallocated = add(unallocated, head.unallocatedUnits);
    rows.push({ contributionId: c.contributionId, personId: c.personId, units: c.units, allocationRevisionId: headId,
      projectBoundUnits: ownBound, pendingUnits: ownPending, unallocatedUnits: head.unallocatedUnits, shares: shares.sort(by('lineId')) });
  }
  if (add(add(projectBound, pending), unallocated) !== totalUnits) refuse();

  const markers = { runtimeAuthority: 'none', scope: 'synthetic', confirmationBasis: 'supplied_fixture_assertion' };
  return {
    kind: 'synthetic_projection_assessment', ...markers,
    // Depends only on the selection and the records it names: no current
    // coverage, ledger digest, count or unselected later record. Its
    // JSON.stringify is the canonical historical export.
    historicalExport: {
      kind: 'synthetic_projection', ...markers,
      poolId, totalUnits,
      selection: canonicalSelection(selection),
      originalIntakes: [...intakes.values()].sort(by('intakeId')).map(i => ({
        intakeId: i.intakeId, originalLabel: i.originalLabel, originContext: i.originContext ? copyProof(i.originContext) : null, rootRevisionId: i.rootRevisionId })),
      totals: { projectBoundUnits: projectBound, pendingUnits: pending, unallocatedUnits: unallocated },
      contributions: rows.sort(by('contributionId')),
      projects: [...buckets].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, b]) => ({ target: copyProof(b.target), projectBoundUnits: b.units })),
    },
    // Current full-history dependencies the supplied admission had to cover.
    // This may grow as later records arrive; the historical export does not.
    disclosureAssessment: {
      basis: 'supplied_disclosure_assertion',
      retainedOrigins: [...intakes.values()].sort(by('intakeId')).map(i => ({
        intakeId: i.intakeId, originalLabel: i.originalLabel, rootRevisionId: i.rootRevisionId,
        selectedResolutionRevisionId: selection.resolution.get(i.intakeId),
        origins: [...origins.get(i.intakeId)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, p]) => copyProof(p)),
      })),
    },
  };
}

/** Returns a deep-frozen assessment built from a private copy, or the one
 * shared frozen refusal. Every admission check precedes both pieces; a refusal
 * has no partial export and no reason, label, ID or count. */
export function evaluateSyntheticStaging(input) {
  try { return deepFreeze(project(clone(input))); } catch { return REFUSED; }
}
