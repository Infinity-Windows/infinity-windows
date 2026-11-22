// Offline regression checks for integration/release workflow boundaries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = name => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
const job = (text, name) => {
  const block = text.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(block, `job ${name} exists`);
  return block;
};
const condition = block => {
  const expression = block.match(/^    if: (.+)$/m)?.[1]?.trim();
  assert.ok(expression, 'production entry point has a job condition');
  return expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
};
const allowed = (expression, event, base, ref) => runInNewContext(expression, {
  github: { event_name: event, base_ref: base, ref }, always: () => true,
});
let checks = 0;
const check = (expression, event, base, ref, expected) => {
  assert.equal(allowed(expression, event, base, ref), expected, `${event} ${base} ${ref}`);
  checks++;
};

for (const [file, name] of [['ci', 'release-baseline'], ['ci', 'trip-browser'], ['verify-invariants', 'invariants']]) {
  const expression = condition(job(read(file), name));
  check(expression, 'pull_request', 'integrations', 'refs/pull/1/merge', false);
  check(expression, 'pull_request', 'master', 'refs/pull/1/merge', true);
  check(expression, 'push', '', 'refs/heads/master', true);
  check(expression, 'schedule', '', 'refs/heads/master', true);
}
const drift = read('migration-drift');
const probe = drift.match(/- name: Is everything already on master live in production\?[\s\S]*?\n        if: (.+)/)?.[1]?.trim();
assert.ok(probe, 'live migration probe has its own step guard');
check(probe, 'pull_request', 'integrations', 'refs/pull/1/merge', false);
check(probe, 'pull_request', 'master', 'refs/pull/1/merge', true);
assert.match(job(drift, 'pull-request'), /Lint the migrations/);
assert.match(read('advisory-review'), /pull_request:\r?\n(?:\s*#[^\n]*\n)*    branches: \[master\]/);
assert.match(read('slack-changelog'), /pull_request:[\s\S]*?branches: \[master\]/);

for (const [file, names] of [['deploy-backend', ['functions', 'migrations', 'verify']], ['deploy-pages', ['build', 'deploy', 'verify']]]) {
  const workflow = read(file);
  assert.match(workflow, /on:\r?\n  push:\r?\n    branches: \[master\]/);
  for (const name of names) {
    const expression = condition(job(workflow, name));
    for (const event of ['push', 'workflow_dispatch']) {
      check(expression, event, '', 'refs/heads/integrations', false);
      check(expression, event, '', 'refs/heads/master', true);
    }
    check(expression, 'pull_request', 'integrations', 'refs/pull/1/merge', false);
    check(expression, 'pull_request', 'master', 'refs/heads/master', false);
  }
}
for (const path of ['../vercel.json', '../app/vercel.json']) {
  const config = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  assert.equal(config.git.deploymentEnabled.integrations, false);
  assert.equal(config.git.deploymentEnabled['matt/fix-save-conflicts'], false);
  assert.equal(config.git.deploymentEnabled.master, undefined, 'production config is unchanged');
}
console.log(`workflow-production-scope: ${checks} event/ref checks and Vercel branch guards passed`);
