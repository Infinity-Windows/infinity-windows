// Source-only acceptance. Stop the actual validator before its database import;
// no SQL, provider, database module or original manifest writer is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, unlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contract = JSON.parse(read('scripts/work-activity-reveal-inventory.contract.json'));
const boundary = '20261108400000_work_activity_engine_substrate.sql';
const note = '20261108320000_work_data_exploration_note.sql';
const noteHash = '6b2bb88a74abdcfbb5ba07abdb0d81c992f6f56e0872adfd815dedfa513600f2';

test('frozen manifest and all five original validators stay byte-identical', () => {
  assert.equal(hash(readFileSync(join(root, contract.frozenManifest.path))), contract.frozenManifest.sha256);
  assert.equal(contract.validatorCopies.length, 5);
  for (const copy of contract.validatorCopies) {
    const original = read(copy.original);
    assert.equal(hash(readFileSync(join(root, copy.original))), copy.originalSha256, copy.original);
    let expected = original;
    for (const [before, after] of Object.entries(copy.replacements)) {
      assert.equal(expected.split(before).length - 1, 1, before);
      expected = expected.replace(before, after);
    }
    assert.equal(read(copy.successor), expected, copy.successor);
  }
});

test('successor adds exactly the reviewed release note and changes no extracted evidence', () => {
  const original = JSON.parse(read(contract.frozenManifest.path));
  const successor = JSON.parse(read(contract.successorManifest));
  assert.equal(original.sources.length, 322);
  assert.deepEqual(contract.addedSource, { file: note, sha256: noteHash });
  assert.equal(hash(readFileSync(join(root, 'supabase/migrations', note))), noteHash);
  const expected = structuredClone(original);
  expected.sources.push({ file: note, sha256: noteHash });
  expected.sources.sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(successor, expected);
});

function runPrelude(mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-reveal-inventory-'));
  try {
    const migrations = join(directory, 'supabase/migrations');
    mkdirSync(migrations, { recursive: true });
    mkdirSync(join(directory, 'scripts'));
    for (const name of readdirSync(join(root, 'supabase/migrations'))) {
      if (name.endsWith('.sql') && name <= boundary) {
        copyFileSync(join(root, 'supabase/migrations', name), join(migrations, name));
      }
    }
    copyFileSync(join(root, contract.successorManifest), join(directory, contract.successorManifest));
    mutate(migrations);
    const original = read('scripts/verify-work-activity-engine-substrate-reveal.mjs');
    const stop = original.indexOf('const { PGlite } = await import');
    assert.ok(stop > 0);
    let prelude = original.slice(0, stop);
    const rootLine = "const root = new URL('../', import.meta.url);";
    assert.equal(prelude.split(rootLine).length - 1, 1);
    prelude = prelude.replace(rootLine, `const root = new URL(${JSON.stringify(pathToFileURL(directory + '/').href)});`);
    prelude += '\nconsole.log(JSON.stringify({checks, sourceCount: currentManifest.sources.length}));\n';
    const entry = join(directory, 'source-only.mjs');
    writeFileSync(entry, prelude);
    return spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 30_000, cwd: directory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('actual strict successor prelude accepts the complete combined inventory before DB import', () => {
  const result = runPrelude();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.sourceCount, 323);
  assert.ok(receipt.checks >= 8);
});

function refuses(mutate) {
  const result = runPrelude(mutate);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Source manifest matches all current prior-migration hashes and extracted evidence/);
}
test('changing one frozen predecessor fails exact inventory equality', () => {
  const predecessor = JSON.parse(read(contract.frozenManifest.path)).sources[0].file;
  refuses(folder => appendFileSync(join(folder, predecessor), '\n-- changed predecessor\n'));
});
test('removing one frozen predecessor fails exact inventory equality', () => {
  const predecessor = JSON.parse(read(contract.frozenManifest.path)).sources[0].file;
  refuses(folder => unlinkSync(join(folder, predecessor)));
});
test('changing the reviewed release note fails exact inventory equality', () => {
  refuses(folder => appendFileSync(join(folder, note), '\n-- changed release note\n'));
});
test('an unreviewed predecessor cannot silently widen the accepted inventory', () => {
  refuses(folder => writeFileSync(join(folder, '20261108330000_unreviewed.sql'), '-- unexpected predecessor\n'));
});
test('CI routes both complete development lanes and preserves source-matched concurrency', () => {
  const ci = read('.github/workflows/ci.yml');
  for (const entry of ['verify-work-activity-engine-substrate-reveal.mjs', 'verify-work-activity-engine-concurrency-reveal.py', 'verify-work-activity-engine-cutover-reveal.mjs --development-prefix', 'verify-work-activity-engine-cutover-concurrency-reveal.py']) {
    assert.equal(ci.split(entry).length - 1, 1, entry);
  }
  assert.equal(ci.split('node --test scripts/work-activity-reveal-inventory.test.mjs').length - 1, 1);
  assert.ok(ci.includes('verify-work-activity-engine-cutover-concurrency.py --source-matched'));
  const original = read('scripts/verify-work-activity-engine-cutover-concurrency.py');
  const successor = read('scripts/verify-work-activity-engine-cutover-concurrency-reveal.py');
  const branch = text => text.slice(text.indexOf('    if SOURCE_MATCHED:\n'), text.indexOf('    else:\n', text.indexOf('    if SOURCE_MATCHED:\n')));
  assert.ok(branch(original).includes('verify-work-activity-engine-schema-runtime.mjs'));
  assert.equal(branch(successor), branch(original));
});
