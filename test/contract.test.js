import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFeed } from '../scripts/build-feed.mjs';
import { gradeExperiment, gradeExperiments } from '../scripts/grade-experiments.mjs';
import { journeyFromSnapshot } from '../scripts/journey.mjs';
import { experimentErrors, insightsErrors, parseDigest, reachErrors, schemaErrors } from '../scripts/lib/contract.mjs';
import { addDays } from '../scripts/lib/analysis.mjs';
import { validate } from '../scripts/validate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'test/fixtures/v3');
const today = '2026-10-23';
const load = async (path) => JSON.parse(await readFile(join(fixture, path), 'utf8'));
const insights = await load('insights/latest.json');
const reach = await load('reach/latest.json');
const proposed = await load('experiments/remove-onboarding-steps.json');
const running = await load('experiments/fix-notices.json');

async function copy(t) {
  const directory = await mkdtemp(join(tmpdir(), 'contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  return directory;
}
const cli = (script, directory) => spawnSync(process.execPath, [join(root, 'scripts', script), '--root', directory, '--today', today], { encoding: 'utf8' });

test('mock v3 fixture validates and builds the committed feed with only the contract fields', async (t) => {
  assert.deepEqual(await validate({ root: fixture, today }), []);
  const directory = await copy(t);
  const committed = await load('feed/latest.json');
  const feed = await buildFeed({ root: directory, today, now: new Date('2030-01-01T00:00:00.000Z') });
  assert.deepEqual(feed, committed);
  assert.deepEqual(Object.keys(feed), ['generatedAt', 'insights', 'experiments', 'reach', 'digests']);
  assert.deepEqual(feed.experiments.map((e) => [e.id, e.status]), [
    ['free-deepseek-agents', 'proposed'], ['remove-onboarding-steps', 'proposed'], ['fix-notices', 'running']]);
  assert.deepEqual(feed.digests.map((d) => d.date), ['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20']);
  assert.deepEqual(feed.digests[0], { date: today, title: 'Voice crash leads errors; onboarding drop is the top pain', findings: 2, proposals: 1, path: 'digests/2026-10-23.md' });
  assert.deepEqual(await load('digests/index.json'), feed.digests);
  assert.ok(!JSON.stringify(feed).includes('Errors up 38%'), 'digest bodies stay out of the feed');
  t.diagnostic(`Feed: ${feed.experiments.length} experiments, ${feed.digests.length} digests, biggest drop ${JSON.stringify(feed.insights.journey.biggestDrop)}`);
});

test('journey comes from the newest snapshot, not from typed numbers', async (t) => {
  const snapshot = { body: JSON.parse(await readFile(join(fixture, 'snapshots/2026-10-23.json'), 'utf8')) };
  assert.deepEqual(journeyFromSnapshot(snapshot), insights.journey);
  assert.deepEqual(journeyFromSnapshot({ body: { usage: { state: 'missing' } } }), { steps: [], biggestDrop: null });
  const real = { body: JSON.parse(await readFile(join(root, 'snapshots/2026-10-23.json'), 'utf8')) };
  assert.deepEqual(journeyFromSnapshot(real).biggestDrop, { label: 'Messaged their free agent', lost: 19 });

  const directory = await copy(t);
  const typed = structuredClone(insights);
  typed.journey.steps[0].count = 40;
  await writeFile(join(directory, 'insights/latest.json'), JSON.stringify(typed));
  const result = cli('validate.mjs', directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /insights\/latest.json: journey: differs from the newest snapshot/);
  assert.equal(cli('build-feed.mjs', directory).status, 0);
  assert.equal(cli('validate.mjs', directory).status, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'insights/latest.json'), 'utf8')).journey.steps[0].count, 37);
});

test('unknown fields are rejected at every level', async () => {
  const add = (value, path, key = 'tag') => {
    const copy = structuredClone(value);
    path.reduce((node, part) => node[part], copy)[key] = 'extra';
    return copy;
  };
  assert.match(insightsErrors(add(insights, ['errors', 'areas', 0]))[0], /errors.areas\[0\].tag: unknown field/);
  assert.match(insightsErrors(add(insights, [], 'metrics'))[0], /metrics: unknown field/);
  assert.match(experimentErrors(add(proposed, ['metric'], 'windowDays'))[0], /metric.windowDays: unknown field/);
  assert.match(reachErrors(add(reach, ['posts', 0], 'tags'))[0], /posts\[0\].tags: unknown field/);
  const feed = await load('feed/latest.json');
  assert.match(schemaErrors({ ...feed, metrics: {} }, 'feed.schema.json')[0], /metrics: unknown field/);
  assert.ok(schemaErrors(add(feed, ['experiments', 0], 'tags'), 'feed.schema.json').some((e) => /experiments\[0\].tags: unknown field/.test(e)));
  const digest = parseDigest('---\ntitle: A\nfindings: 1\nproposals: 0\ntags: x\n---\nBody\n', '2026-10-24.md');
  assert.match(digest.errors[0], /tags: unknown field/);
});

test('a running or concluded experiment needs the owner approval message', () => {
  const unapproved = { ...running, approval: null };
  assert.deepEqual(experimentErrors(unapproved, 'fix-notices.json'), ['approval: running requires approval.messageId']);
  assert.match(experimentErrors({ ...running, approval: { messageId: ' ' } })[0], /approval.messageId: expected nonempty text/);
  assert.match(experimentErrors({ ...running, approval: {} })[0], /approval: missing messageId/);
  assert.deepEqual(experimentErrors(running, 'fix-notices.json'), []);
  const concluded = { ...running, status: 'concluded', verdict: { result: 'not_enough_data', decision: 'keep', value: 0.25, samples: 4, on: today } };
  assert.deepEqual(experimentErrors(concluded), []);
  assert.ok(experimentErrors({ ...concluded, approval: null }).includes('approval: concluded requires approval.messageId'));
  assert.ok(experimentErrors({ ...proposed, startedOn: today }).includes('startedOn: must be null while proposed'));
  assert.ok(experimentErrors(proposed, 'other.json').includes('id: must match the filename'));
});

test('decision points need at least ten samples and verdicts follow the rules', () => {
  assert.match(experimentErrors({ ...proposed, decideAt: { samples: 9, date: '2026-11-20' } })[0], /decideAt.samples: expected at least 10/);
  const verdict = (patch) => experimentErrors({ ...running, status: 'concluded', verdict: { result: 'supported', decision: 'keep', value: 0.4, samples: 12, on: today, ...patch } });
  assert.deepEqual(verdict({}), []);
  assert.ok(verdict({ samples: 4 }).includes('verdict.result: below decideAt.samples must be not_enough_data'));
  assert.ok(verdict({ decision: 'undo' }).includes('verdict.decision: supported keeps the change'));
  assert.ok(verdict({ result: 'not_enough_data', decision: 'undo' }).includes('verdict.decision: not_enough_data follows ifUnclear'));
  assert.match(experimentErrors({ ...proposed, metric: { ...proposed.metric, numerator: 'made-up' } })[0], /metric.numerator: does not match/);
  assert.ok(experimentErrors({ ...proposed, metric: { ...proposed.metric, denominator: 'feedback:reporters' } })
    .includes('metric.denominator: do not mix snapshot and agent-written series'));
});

test('privacy: emails, @handles and identifiers are rejected in leads, reach and digests', () => {
  for (const text of ['Ask jane@example.com about it', 'Reported by @lunchboxfortwo', 'Room 7813975a-9c99-4321-817b-784d747ce55b broke']) {
    assert.ok(insightsErrors({ ...insights, errors: { ...insights.errors, lead: text } }).some((e) => e.startsWith('errors.lead: contains')), text);
    assert.ok(reachErrors({ ...reach, recommendations: [{ ...reach.recommendations[0], detail: text }] }).some((e) => e.startsWith('recommendations[0].detail: contains')), text);
    assert.ok(parseDigest(`---\ntitle: Daily\nfindings: 1\nproposals: 0\n---\n${text}\n`, '2026-10-24.md').errors.some((e) => e.startsWith('body: contains')), text);
    assert.ok(experimentErrors({ ...proposed, source: { ...proposed.source, text } }).some((e) => e.startsWith('source.text: contains')), text);
  }
  assert.deepEqual(insightsErrors(insights), []);
  assert.deepEqual(reachErrors(reach), []);
});

test('aggregate totals stay consistent', () => {
  assert.ok(insightsErrors({ ...insights, feedback: { ...insights.feedback, people: 10 } }).includes('feedback.total: must equal people plus agents'));
  assert.ok(insightsErrors({ ...insights, errors: { ...insights.errors, total: 10 } }).includes('errors.areas: counts exceed errors.total'));
  assert.ok(insightsErrors({ ...insights, velocity: { ...insights.velocity, hoursLost: 5 } }).includes('velocity.items: hours exceed velocity.hoursLost'));
});

test('validate CLI fails on any invalid file, unknown link or stale feed and names the file', async (t) => {
  const directory = await copy(t);
  const ok = cli('validate.mjs', directory);
  assert.equal(ok.status, 0, ok.stderr);
  await writeFile(join(directory, 'experiments/fix-notices.json'), JSON.stringify({ ...running, approval: null }));
  let result = cli('validate.mjs', directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /experiments\/fix-notices.json: approval: running requires approval.messageId/);
  const feedBefore = await readFile(join(directory, 'feed/latest.json'), 'utf8');
  assert.equal(cli('build-feed.mjs', directory).status, 1);
  assert.equal(await readFile(join(directory, 'feed/latest.json'), 'utf8'), feedBefore);

  const fresh = await copy(t);
  await writeFile(join(fresh, 'insights/latest.json'), JSON.stringify({ ...insights, links: [{ section: 'errors', experimentId: 'missing' }] }));
  assert.match(cli('validate.mjs', fresh).stderr, /links\[0\].experimentId: no experiments\/missing.json/);

  const stale = await copy(t);
  await writeFile(join(stale, 'digests/2026-10-24.md'), '---\ntitle: New day\nfindings: 1\nproposals: 0\n---\nOne finding.\n');
  result = cli('validate.mjs', stale);
  assert.match(result.stderr, /digests\/index.json: missing or stale/);
  assert.match(result.stderr, /feed\/latest.json: missing or stale/);
  assert.equal(cli('build-feed.mjs', stale).status, 0);
  assert.equal(cli('validate.mjs', stale).status, 0);
  assert.equal(JSON.parse(await readFile(join(stale, 'digests/index.json'), 'utf8'))[0].date, '2026-10-24');
});

test('validate CLI rejects a saved feed with a malformed or missing generatedAt, and build-feed repairs it', async (t) => {
  for (const generatedAt of ['not-a-timestamp', undefined]) {
    const directory = await copy(t);
    const path = join(directory, 'feed/latest.json');
    const feed = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...feed, generatedAt }));
    const result = cli('validate.mjs', directory);
    assert.equal(result.status, 1, String(generatedAt));
    assert.match(result.stderr, generatedAt ? /feed\/latest.json: generatedAt: expected date-time/ : /feed\/latest.json: \(root\): missing generatedAt/);
    assert.equal(cli('build-feed.mjs', directory).status, 0);
    assert.ok(Number.isFinite(Date.parse(JSON.parse(await readFile(path, 'utf8')).generatedAt)));
    assert.equal(cli('validate.mjs', directory).status, 0);
  }
});

function seriesSnapshot(through, workspaces, signups) {
  const daily = (values) => values.map((value, i) => ({ date: addDays(through, i - values.length + 1), value }));
  return { date: through, file: `${through}.json`, body: { schemaVersion: 1, overview: { series: {
    workspaces: { state: 'measured', data: { daily: daily(workspaces) } },
    signups: { state: 'measured', data: { daily: daily(signups) } },
  } } } };
}
const started = { ...proposed, status: 'running', approval: { messageId: 'approval' }, startedOn: '2026-10-21', decideAt: { samples: 30, date: '2026-11-20' } };

test('grading measures running snapshot experiments from their start and concludes at the decision point', () => {
  const early = gradeExperiment(started, seriesSnapshot(today, [9, 4, 4, 4], [10, 5, 5, 5]), today);
  assert.equal(early.experiment.status, 'running');
  assert.deepEqual(early.experiment.progress, { value: 0.8, samples: 15, asOf: today });
  assert.equal(early.experiment.verdict, null);
  const enough = gradeExperiment(started, seriesSnapshot(today, [0, 9, 9, 9], [0, 10, 10, 10]), today);
  assert.deepEqual(enough.experiment.progress, { value: 0.9, samples: 30, asOf: today });
  assert.equal(enough.experiment.status, 'concluded');
  assert.deepEqual(enough.experiment.verdict, { result: 'supported', decision: 'keep', value: 0.9, samples: 30, on: today });
  const missed = gradeExperiment(started, seriesSnapshot(today, [0, 5, 5, 5], [0, 10, 10, 10]), today).experiment;
  assert.deepEqual([missed.verdict.result, missed.verdict.decision], ['not_supported', 'undo']);
  const due = { ...started, decideAt: { samples: 30, date: today } };
  const thin = gradeExperiment(due, seriesSnapshot(today, [0, 2, 2, 2], [0, 2, 2, 2]), today).experiment;
  assert.deepEqual(thin.verdict, { result: 'not_enough_data', decision: 'undo', value: 1, samples: 6, on: today });
  for (const outcome of [enough, { experiment: missed }, { experiment: thin }]) assert.deepEqual(experimentErrors(outcome.experiment), []);
});

test('grading leaves agent-written, proposed and unmeasured experiments unchanged', () => {
  const snapshot = seriesSnapshot(today, [9, 9, 9], [10, 10, 10]);
  assert.equal(gradeExperiment(running, snapshot, today).changed, false);
  assert.equal(gradeExperiment(proposed, snapshot, today).changed, false);
  const stale = gradeExperiment(started, seriesSnapshot('2026-10-22', [9, 9, 9], [10, 10, 10]), today);
  assert.equal(stale.changed, false);
  assert.match(stale.result.reason, /missing, invalid or duplicate day 2026-10-23/);
});

test('grade CLI validates every experiment before writing any', async (t) => {
  const directory = await copy(t);
  const experiments = join(directory, 'experiments');
  const snapshots = join(directory, 'snapshots');
  await writeFile(join(snapshots, `${today}.json`), JSON.stringify(seriesSnapshot(today, [0, 9, 9, 9], [0, 10, 10, 10]).body));
  await writeFile(join(experiments, 'started.json'), JSON.stringify({ ...started, id: 'started' }));
  await writeFile(join(experiments, 'zz-broken.json'), JSON.stringify({ ...running, id: 'zz-broken', approval: null }));
  const files = await readdir(experiments);
  const before = await Promise.all(files.map((file) => readFile(join(experiments, file), 'utf8')));
  await assert.rejects(gradeExperiments({ experiments, snapshots, today, write: true }), /zz-broken.json: approval/);
  assert.deepEqual(await Promise.all(files.map((file) => readFile(join(experiments, file), 'utf8'))), before);
  await rm(join(experiments, 'zz-broken.json'));
  const dry = await gradeExperiments({ experiments, snapshots, today });
  assert.equal(dry.experiments.find((e) => e.id === 'started').status, 'concluded');
  assert.equal(JSON.parse(await readFile(join(experiments, 'started.json'), 'utf8')).status, 'running');
  await gradeExperiments({ experiments, snapshots, today, write: true });
  assert.equal(JSON.parse(await readFile(join(experiments, 'started.json'), 'utf8')).verdict.result, 'supported');
});

test('no workflow calls YouTube or X, and no new secrets appear', async () => {
  for (const file of await readdir(join(root, '.github/workflows'))) {
    const text = await readFile(join(root, '.github/workflows', file), 'utf8');
    assert.doesNotMatch(text, /youtube|twitter|x\.com|googleapis/i, file);
    assert.deepEqual([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).filter((name) => name !== 'BEELINE_DASHBOARD_SECRET'), [], file);
  }
});

test('the repository files pass validation', async () => {
  const { easternDate } = await import('../scripts/snapshot.mjs');
  assert.deepEqual(await validate({ root, today: easternDate() }), []);
});
