import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregateErrors, experimentErrors, registerErrors, schemaErrors } from '../scripts/lib/contract.mjs';
import { buildFeed } from '../scripts/build-feed.mjs';

const running = JSON.parse(await readFile(new URL('fixtures/v3/experiments/fix-notices.json', import.meta.url), 'utf8'));
const problem = { id: 'agent-start', kind: 'regression', rank: 1, date: '2026-10-24', title: 'Agent does not start', peoplePerDay: 3, trend: 'up', cause: 'connection', stage: 'first-reply', source: 'Daily triage aggregate', regression: { causedByPr: 'https://github.com/Beeline-Work/beeline/pull/123', report: 'Repeated connection failures' } };
const bigProblem = { ...problem, id: 'agent-silent', kind: 'problem', scope: 'people', lastHit: '2026-10-28', fixHeldSince: '2026-10-27', whatHappens: 'A new person sends a first message and the agent never replies.', fixes: [{ date: '2026-10-25', text: 'Retry the agent start once', state: 'failed' }, { date: '2026-10-27', text: 'Restart stalled agents', state: 'holding' }], observations: [{ date: '2026-10-28', text: 'Two people hit it after signup' }] };
delete bigProblem.regression;
const walk = { date: '2026-10-24', source: 'Daily walk aggregate', counts: [{ goal: 'start-agent', friction: 'no-reply', count: 4 }] };
const retention = { generatedAt: '2026-10-24T12:00:00.000Z', source: 'Admin retention grouped by first agent source', day: 7, cohort: 40, retained: 9, window: { from: '2026-10-01', through: '2026-10-07' }, groups: { addedOwnAgent: { cohort: 12, retained: 4 }, freeAgent: { cohort: 20, retained: 3 }, noAgent: { cohort: 8, retained: 2 } } };

test('register cap names the eleventh file; proposed and concluded do not count', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ ...running, id: `experiment-${i}` }));
  assert.deepEqual(registerErrors(ten), []);
  assert.deepEqual(registerErrors([...ten, { ...running, id: 'overflow' }]), ['experiments/overflow.json: status: at most 10 running experiments; retire one first']);
  assert.deepEqual(registerErrors([...ten, { ...running, status: 'proposed' }, { ...running, status: 'concluded' }]), []);
});

test('experiment requires watched number, starting value, prediction and check date', () => {
  for (const [parent, key] of [['metric', 'numerator'], ['before', 'value'], ['predict', 'value'], ['decideAt', 'date']]) {
    const e = structuredClone(running);
    delete e[parent][key];
    assert.ok(experimentErrors(e).some((error) => error.includes(`${parent}: missing ${key}`)));
  }
});

test('only the three legacy verdict meanings and one extension are accepted', () => {
  const extension = { previousDate: running.decideAt.date, date: '2026-12-20', on: running.decideAt.date, result: 'not_enough_data' };
  const extended = { ...running, decideAt: { ...running.decideAt, date: extension.date }, extensions: [extension] };
  assert.deepEqual(experimentErrors(extended), []);
  assert.match(experimentErrors({ ...extended, extensions: [extension, extension] }).join('\n'), /extensions: expected at most 1/);
  assert.match(experimentErrors({ ...extended, decideAt: running.decideAt }).join('\n'), /must match the extension date/);
  for (const result of ['supported', 'not_supported', 'not_enough_data']) {
    assert.deepEqual(experimentErrors({ ...running, status: 'concluded', verdict: { result, decision: result === 'not_supported' ? 'undo' : 'keep', value: 1, samples: 100, on: '2026-12-20' } }), []);
  }
  assert.match(experimentErrors({ ...running, status: 'concluded', verdict: { result: 'maybe', decision: 'keep', value: 1, samples: 100, on: '2026-12-20' } }).join('\n'), /verdict.result/);
});

test('all new formats reject identity keys and private text, including nested objects', () => {
  for (const [kind, value] of [['problem', problem], ['walk', walk], ['retention', retention]]) {
    assert.deepEqual(aggregateErrors(value, kind), []);
    for (const key of ['messageText', 'name', 'email', 'userId', 'identityId']) {
      assert.match(schemaErrors({ ...value, [key]: 'private' }, `${kind}.schema.json`).join('\n'), new RegExp(`${key}: unknown field`));
    }
    assert.match(aggregateErrors({ ...value, source: 'person@example.com' }, kind).join('\n'), /contains an email/);
  }
  assert.match(aggregateErrors({ ...problem, regression: { ...problem.regression, userId: 'private' } }, 'problem').join('\n'), /regression.userId: unknown field/);
  assert.match(aggregateErrors({ ...walk, counts: [{ ...walk.counts[0], name: 'private' }] }, 'walk').join('\n'), /name: unknown field/);
  assert.match(aggregateErrors({ ...retention, groups: { ...retention.groups, freeAgent: { ...retention.groups.freeAgent, userId: 'private' } } }, 'retention').join('\n'), /userId: unknown field/);
});

test('feed CLI publishes ranked problems, anonymous counts, retention split and regression PR; empty folders work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'register-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const empty = await buildFeed({ root, today: '2026-10-24' });
  assert.deepEqual([empty.problems, empty.walk, empty.retention], [[], [], null]);
  for (const [folder, file, value] of [['problems', 'agent-start', problem], ['walk', walk.date, walk], ['retention', 'latest', retention]]) {
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, `${file}.json`), JSON.stringify(value));
  }
  const cli = (script) => spawnSync(process.execPath, [new URL(`../scripts/${script}.mjs`, import.meta.url).pathname, '--root', root, '--today', '2026-10-24'], { encoding: 'utf8' });
  const built = cli('build-feed');
  assert.equal(built.status, 0, built.stderr);
  const feed = JSON.parse(built.stdout);
  assert.deepEqual([feed.problems, feed.walk, feed.retention], [[problem], [walk], retention]);
  assert.equal(cli('validate').status, 0);
  const before = await readFile(join(root, 'feed/latest.json'), 'utf8');
  await writeFile(join(root, 'walk', `${walk.date}.json`), JSON.stringify({ ...walk, email: 'private' }));
  const invalid = cli('build-feed');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /walk\/2026-10-24.json: email: unknown field/);
  assert.equal(await readFile(join(root, 'feed/latest.json'), 'utf8'), before);
});

test('big problems accept scope, hit and fix dates, what happens, fixes and observations; bad values fail', async (t) => {
  assert.deepEqual(aggregateErrors(bigProblem, 'problem'), []);
  const bad = [
    [{ scope: 'agents' }, /scope: expected one of people, single/],
    [{ lastHit: '2026-13-01' }, /lastHit: expected date/],
    [{ fixHeldSince: 'yesterday' }, /fixHeldSince: expected date/],
    [{ whatHappens: ' ' }, /whatHappens: expected nonempty text/],
    [{ whatHappens: 'x'.repeat(301) }, /whatHappens: longer than 300/],
    [{ fixes: [{ ...bigProblem.fixes[0], state: 'done' }] }, /fixes\[0\].state: expected one of/],
    [{ fixes: [{ ...bigProblem.fixes[0], owner: 'ruby' }] }, /fixes\[0\].owner: unknown field/],
    [{ fixes: [{ ...bigProblem.fixes[0], date: '2026-02-30' }] }, /fixes\[0\].date: expected date/],
    [{ fixes: [{ ...bigProblem.fixes[0], text: '' }] }, /fixes\[0\].text: expected nonempty text/],
    [{ observations: [{ ...bigProblem.observations[0], people: 2 }] }, /observations\[0\].people: unknown field/],
    [{ observations: [{ date: 'today', text: 'Seen' }] }, /observations\[0\].date: expected date/],
    [{ observations: [{ date: '2026-10-28', text: '' }] }, /observations\[0\].text: expected nonempty text/],
  ];
  for (const [change, error] of bad) assert.match(aggregateErrors({ ...bigProblem, ...change }, 'problem').join('\n'), error);
  const root = await mkdtemp(join(tmpdir(), 'big-problem-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'problems'));
  await writeFile(join(root, 'problems', `${bigProblem.id}.json`), JSON.stringify(bigProblem));
  const built = spawnSync(process.execPath, [new URL('../scripts/build-feed.mjs', import.meta.url).pathname, '--root', root, '--today', '2026-10-29'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'feed/latest.json'), 'utf8')).problems, [bigProblem]);
});

test('regressions require the causing PR and retention rejects impossible counts', () => {
  const missing = { ...problem };
  delete missing.regression;
  assert.match(aggregateErrors(missing, 'problem').join('\n'), /requires causedByPr/);
  assert.match(aggregateErrors({ ...problem, regression: { report: 'Regression' } }, 'problem').join('\n'), /missing causedByPr/);
  assert.match(aggregateErrors({ ...retention, groups: { ...retention.groups, freeAgent: { cohort: 1, retained: 2 } } }, 'retention').join('\n'), /exceeds cohort/);
});

test('feed derives retention from the newest measured server split without storing person rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'snapshots'));
  const body = { schemaVersion: 1, overview: { retention: { state: 'measured', measuredAt: retention.generatedAt, data: { day: 7, cohort: retention.cohort, retained: retention.retained, ...retention.window, byFirstAgentSource: retention.groups } } } };
  const path = join(root, 'snapshots/2026-10-24.json');
  await writeFile(path, JSON.stringify(body));
  const feed = await buildFeed({ root, today: '2026-10-24' });
  assert.deepEqual(feed.retention.groups, retention.groups);
  delete body.overview.retention.data.byFirstAgentSource;
  await writeFile(path, JSON.stringify(body));
  assert.equal((await buildFeed({ root, today: '2026-10-24' })).retention, null);
  body.overview.retention.data.byFirstAgentSource = { ...retention.groups, userId: 'private' };
  await writeFile(path, JSON.stringify(body));
  await assert.rejects(buildFeed({ root, today: '2026-10-24' }), /userId: unknown field/);
});

test('CLI names the offending filename for capacity and every required experiment field', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'experiments'));
  const cli = () => spawnSync(process.execPath, [new URL('../scripts/build-feed.mjs', import.meta.url).pathname, '--root', root, '--today', '2026-10-24'], { encoding: 'utf8' });
  for (let i = 0; i < 10; i++) {
    await writeFile(join(root, 'experiments', `item-${i}.json`), JSON.stringify({ ...running, id: `item-${i}` }));
  }
  assert.equal(cli().status, 0);
  const extra = join(root, 'experiments/overflow.json');
  await writeFile(extra, JSON.stringify({ ...running, id: 'overflow' }));
  assert.match(cli().stderr, /experiments\/overflow.json: status: at most 10 running experiments/);
  await rm(extra);
  for (const [parent, key] of [['metric', 'numerator'], ['before', 'value'], ['predict', 'value'], ['decideAt', 'date']]) {
    const value = structuredClone(running);
    value.id = 'item-0';
    delete value[parent][key];
    await writeFile(join(root, 'experiments/item-0.json'), JSON.stringify(value));
    const result = cli();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`experiments/item-0.json: ${parent}: missing ${key}`));
  }
});


test('retention requires the no-agent baseline and reconciles every group to the overall totals', () => {
  const missing = structuredClone(retention);
  delete missing.groups.noAgent;
  assert.match(aggregateErrors(missing, 'retention').join('\n'), /groups: missing noAgent/);
  for (const field of ['cohort', 'retained']) {
    const wrong = structuredClone(retention);
    wrong.groups.noAgent[field]++;
    assert.match(aggregateErrors(wrong, 'retention').join('\n'), new RegExp(`${field} counts must sum to ${field}`));
  }
  assert.deepEqual(aggregateErrors({ ...retention, cohort: 0, retained: 0, groups: { addedOwnAgent: { cohort: 0, retained: 0 }, freeAgent: { cohort: 0, retained: 0 }, noAgent: { cohort: 0, retained: 0 } } }, 'retention'), []);
});
