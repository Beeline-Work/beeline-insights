import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeBet, validateBet } from '../scripts/grade-bets.mjs';
import { metricsFromSnapshots } from '../scripts/metrics.mjs';
import { addDays, isDate, measure, windowDates } from '../scripts/lib/analysis.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = JSON.parse(await readFile(new URL('./fixtures/example-bet.json', import.meta.url), 'utf8'));
const bet = (patch = {}) => ({ ...structuredClone(example), ...patch });
const block = (daily) => ({ state: 'measured', data: { daily } });
const points = (values, start = '2026-08-31') => values.map((value, index) => ({ date: addDays(start, index), value }));
function snapshot(date = '2026-09-02', numerator = [1, 5, 4], denominator = [2, 8, 10]) {
  return { date, file: `${date}.json`, body: { schemaVersion: 1, overview: {
    series: { firstReply: block(points(numerator)), signups: block(points(denominator)) },
    retention: { state: 'measured', data: { day: 7, cohort: 20, retained: 10, from: '2026-08-01', through: '2026-08-21' } },
  } } };
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'insights-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bets = join(directory, 'bets');
  const snapshots = join(directory, 'snapshots');
  await mkdir(bets);
  await mkdir(snapshots);
  const path = join(bets, 'example-bet.json');
  await writeFile(path, `${JSON.stringify(example, null, 2)}\n`);
  const saveSnapshot = async (s) => writeFile(join(snapshots, s.file), JSON.stringify(s.body));
  await saveSnapshot(snapshot());
  const args = ['--bets', bets, '--snapshots', snapshots, '--today', '2026-09-02'];
  const run = (script, extra = []) => JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', script), ...args, ...extra], { encoding: 'utf8' }));
  return { directory, path, bets, snapshots, args, run, saveSnapshot };
}

test('bet validator names the file and malformed field, including impossible dates', () => {
  assert.equal(validateBet(bet(), 'bets/example-bet.json').id, 'example-bet');
  for (const [patch, field] of [
    [{ metric: { numerator: 'unknown', windowDays: 3 } }, 'metric.numerator'],
    [{ metric: { numerator: 'dau', windowDays: 0 } }, 'metric.windowDays'],
    [{ metric: { numerator: 'dau', denominator: 'unknown', windowDays: 3 } }, 'metric.denominator'],
    [{ baseline: { ...example.baseline, value: -1 } }, 'baseline.value'],
    [{ baseline: { ...example.baseline, from: '2026-09-03' } }, 'baseline.through'],
    [{ target: { value: 1, direction: 'sideways' } }, 'target.direction'],
    [{ gradeOn: '2026-02-30' }, 'gradeOn'],
    [{ releasedOn: '2026-09-03' }, 'gradeOn'],
    [{ minSamples: -1 }, 'minSamples'],
    [{ status: 'won' }, 'status'],
    [{ grade: {} }, 'grade'],
    [{ retryPending: true }, 'retryPending'],
    [{ extensionUsed: true }, 'status'],
    [{ status: 'hit', grade: { value: null, samples: 10, snapshot: '2026-09-02.json', gradedOn: '2026-09-02' } }, 'grade.value'],
  ]) {
    assert.throws(() => validateBet(bet(patch), 'bets/example-bet.json'), (error) => error.message.startsWith(`bets/example-bet.json: ${field}:`));
  }
  assert.equal(isDate('2026-2-03'), false);
  assert.equal(isDate('2028-02-29'), true);
});

test('CLI rejects malformed bets before writing any files', async (t) => {
  const ws = await workspace(t);
  const before = await readFile(ws.path, 'utf8');
  await writeFile(join(ws.bets, 'broken.json'), JSON.stringify(bet({ id: 'broken', gradeOn: 'no' })));
  const result = spawnSync(process.execPath, [join(root, 'scripts/grade-bets.mjs'), ...ws.args, '--write'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /broken.json: gradeOn:/);
  assert.equal(await readFile(ws.path, 'utf8'), before);
  await writeFile(join(ws.bets, 'broken.json'), '{');
  const invalid = spawnSync(process.execPath, [join(root, 'scripts/grade-bets.mjs'), ...ws.args], { encoding: 'utf8' });
  assert.match(invalid.stderr, /broken.json: JSON:/);
});

test('due rate uses ratio of sums across month end and an inclusive exact target', () => {
  assert.deepEqual(windowDates('2026-09-02', 3), ['2026-08-31', '2026-09-01', '2026-09-02']);
  const result = gradeBet(bet(), snapshot(), '2026-09-02');
  assert.equal(result.bet.status, 'hit');
  assert.equal(result.bet.grade.value, 0.5);
  assert.equal(result.bet.grade.samples, 20);
  assert.equal(result.bet.grade.snapshot, '2026-09-02.json');
  assert.equal(gradeBet(bet({ target: { value: 0.6, direction: 'up' } }), snapshot(), '2026-09-02').bet.status, 'miss');
  assert.equal(gradeBet(bet({ target: { value: 0.5, direction: 'down' } }), snapshot(), '2026-09-02').bet.status, 'hit');
  assert.equal(gradeBet(bet({ target: { value: 0.4, direction: 'down' } }), snapshot(), '2026-09-02').bet.status, 'miss');
});

test('count bet sums numerator and treats sample threshold equality as sufficient', () => {
  const result = gradeBet(bet({ metric: { numerator: 'signups', windowDays: 3 }, target: { value: 20, direction: 'up' }, minSamples: 20 }), snapshot(), '2026-09-02');
  assert.equal(result.bet.status, 'hit');
  assert.equal(result.bet.grade.value, 20);
  assert.equal(result.bet.grade.samples, 20);
});

test('CLI grades due bets from newest snapshot at or before today; dry run leaves bytes unchanged', async (t) => {
  const ws = await workspace(t);
  await ws.saveSnapshot(snapshot('2026-09-01', [0, 0, 0]));
  await ws.saveSnapshot(snapshot('2026-09-03', [0, 0, 0]));
  const before = await readFile(ws.path, 'utf8');
  const dry = ws.run('grade-bets.mjs');
  assert.equal(dry.snapshot, '2026-09-02.json');
  assert.deepEqual([dry.bets[0].status, dry.bets[0].value, dry.bets[0].samples, dry.bets[0].target.value], ['hit', 0.5, 20, 0.5]);
  assert.equal(await readFile(ws.path, 'utf8'), before);
  const saved = ws.run('grade-bets.mjs', ['--write']);
  assert.equal(saved.bets[0].status, 'hit');
  assert.equal(JSON.parse(await readFile(ws.path)).status, 'hit');
  const after = await readFile(ws.path, 'utf8');
  ws.run('grade-bets.mjs', ['--write', '--today', '2026-09-03']);
  assert.equal(await readFile(ws.path, 'utf8'), after);
  t.diagnostic(`CLI due bet: ${JSON.stringify(dry.bets[0])}`);
});

test('CLI lists open bets with current value and days left, unchanged even with --write', async (t) => {
  const ws = await workspace(t);
  await writeFile(ws.path, JSON.stringify(bet({ gradeOn: '2026-09-05' })));
  const before = await readFile(ws.path, 'utf8');
  const result = ws.run('grade-bets.mjs', ['--write']).bets[0];
  assert.deepEqual([result.status, result.value, result.daysLeft], ['open', 0.5, 3]);
  assert.equal(await readFile(ws.path, 'utf8'), before);
});

test('zero denominator is unclear even with minSamples zero; extends only once', async (t) => {
  const ws = await workspace(t);
  await ws.saveSnapshot(snapshot('2026-09-02', [0, 0, 0], [0, 0, 0]));
  await writeFile(ws.path, JSON.stringify(bet({ minSamples: 0 })));
  const first = ws.run('grade-bets.mjs', ['--write']).bets[0];
  assert.deepEqual([first.status, first.value, first.samples, first.gradeOn, first.retryPending], ['unclear', null, 0, '2026-09-09', true]);
  const saved = await readFile(ws.path, 'utf8');
  ws.run('grade-bets.mjs', ['--write']);
  assert.equal(await readFile(ws.path, 'utf8'), saved);
  const next = snapshot('2026-09-09', [0, 0, 0], [0, 0, 0]);
  next.body.overview.series.firstReply = block(points([0, 0, 0], '2026-09-07'));
  next.body.overview.series.signups = block(points([0, 0, 0], '2026-09-07'));
  await ws.saveSnapshot(next);
  const second = ws.run('grade-bets.mjs', ['--write', '--today', '2026-09-09']).bets[0];
  assert.deepEqual([second.status, second.gradeOn, second.retryPending], ['unclear', '2026-09-09', false]);
  const terminal = await readFile(ws.path, 'utf8');
  ws.run('grade-bets.mjs', ['--write', '--today', '2026-09-10']);
  assert.equal(await readFile(ws.path, 'utf8'), terminal);
});

test('low sample retry can resolve to hit or miss and uses extended deadline window', () => {
  const first = gradeBet(bet({ minSamples: 21 }), snapshot(), '2026-09-02').bet;
  assert.equal(first.status, 'unclear');
  const next = snapshot('2026-09-09');
  next.body.overview.series.firstReply = block(points([10, 10, 10], '2026-09-07'));
  next.body.overview.series.signups = block(points([20, 20, 20], '2026-09-07'));
  const second = gradeBet(first, next, '2026-09-10').bet;
  assert.equal(second.status, 'hit');
  assert.equal(second.grade.samples, 60);
  assert.equal(second.retryPending, false);
  assert.equal(gradeBet({ ...first, target: { value: 0.9, direction: 'up' } }, next, '2026-09-10').bet.status, 'miss');
});

test('missing, null, negative, duplicate and non-measured data never grade or extend', () => {
  const mutations = [
    (s) => { s.body.overview.series.firstReply.state = 'missing'; },
    (s) => { s.body.overview.series.signups.state = 'error'; },
    (s) => { delete s.body.overview.series.firstReply; },
    (s) => { s.body.overview.series.firstReply.data.daily.pop(); },
    (s) => { s.body.overview.series.signups.data.daily[0].value = null; },
    (s) => { s.body.overview.series.signups.data.daily[0].value = -1; },
    (s) => { s.body.overview.series.signups.data.daily.push({ date: '2026-08-31', value: 2 }); },
  ];
  for (const mutate of mutations) {
    const s = snapshot();
    mutate(s);
    const original = bet();
    const outcome = gradeBet(original, s, '2026-09-02');
    assert.equal(outcome.changed, false);
    assert.deepEqual(outcome.bet, original);
    assert.equal(outcome.result.value, null);
    assert.ok(outcome.result.reason);
  }
});

test('a late grade still evaluates the deadline; a stale snapshot cannot fill missing days', () => {
  const s = snapshot();
  s.body.overview.series.firstReply.data.daily.push({ date: '2026-09-03', value: 1000 });
  assert.equal(gradeBet(bet(), s, '2026-09-03').bet.grade.value, 0.5);
  assert.equal(gradeBet(bet({ gradeOn: '2026-09-03' }), snapshot(), '2026-09-03').changed, false);
});

function headlineSnapshots() {
  const s = snapshot('2026-09-02');
  const dates = windowDates('2026-09-02', 29);
  const values = dates.map((date, i) => ({ date, value: i === 28 ? 100 : (i % 2 ? 12 : 10) }));
  s.body.overview.series = Object.fromEntries(['firstReply', 'signups', 'dau', 'wau'].map((name) => [name, block(structuredClone(values))]));
  s.body.overview.series.firstReply.data.daily = dates.map((date, i) => ({ date, value: i === 28 ? 90 : 5 }));
  return [...windowDates('2026-09-01', 8).map((date, i) => {
    const prior = snapshot(date);
    prior.body.overview.retention.data = { day: 7, cohort: 20, retained: 2, from: addDays('2026-07-01', i), through: addDays('2026-07-21', i) };
    return prior;
  }), s];
}

test('daily metrics cover all headlines with prior 28-day median/MAD and exclude today', () => {
  const result = metricsFromSnapshots(headlineSnapshots(), '2026-09-02');
  assert.deepEqual(Object.keys(result.metrics), ['firstReply/signups', 'signups', 'dau', 'wau', 'retention7']);
  const signups = result.metrics.signups;
  assert.equal(signups.value, 100);
  assert.equal(signups.samples, 100);
  assert.deepEqual(signups.normal, { low: 9, high: 13, median: 11, mad: 1 });
  assert.equal(signups.historySamples, 28);
  assert.equal(signups.outside, true);
  assert.equal(result.metrics['firstReply/signups'].value, 0.9);
  assert.equal(result.metrics['firstReply/signups'].samples, 100);
  assert.equal(result.metrics['firstReply/signups'].outside, true);
  assert.equal(result.metrics.retention7.value, 0.5);
  assert.equal(result.metrics.retention7.samples, 20);
  assert.equal(result.metrics.retention7.historySamples, 8);
  assert.equal(result.metrics.retention7.normal.median, 0.1);
  assert.equal(result.metrics.retention7.outside, true);
});

test('metrics flag small samples, insufficient history and unavailable data without an outside claim', () => {
  const snapshots = headlineSnapshots();
  const latest = snapshots.at(-1);
  latest.body.overview.series.signups.data.daily.at(-1).value = 2;
  latest.body.overview.series.dau.state = 'missing';
  latest.body.overview.series.wau.data.daily = [{ date: '2026-09-02', value: 100 }];
  const result = metricsFromSnapshots(snapshots, '2026-09-02').metrics;
  for (const name of ['firstReply/signups', 'signups', 'dau', 'wau']) assert.equal(result[name].outside, false);
  assert.ok(result.signups.flags.includes('small sample'));
  assert.equal(result.dau.value, null);
  assert.ok(result.dau.flags.some((flag) => flag.includes('state missing')));
  assert.ok(result.wau.flags.includes('insufficient history'));
  assert.equal(result.wau.normal, null);
  const stale = metricsFromSnapshots(snapshots, '2026-09-03').metrics;
  assert.equal(stale.signups.value, null);
  assert.equal(stale.retention7.value, null);
});

test('normal ranges keep quiet count days, exclude days before the window, and include range boundaries', () => {
  const snapshots = headlineSnapshots();
  const daily = snapshots.at(-1).body.overview.series.signups.data.daily;
  for (const point of daily.slice(0, -1)) point.value = 0;
  daily.unshift({ date: '2026-08-04', value: 9999 });
  let result = metricsFromSnapshots(snapshots, '2026-09-02').metrics.signups;
  assert.equal(result.historySamples, 28);
  assert.deepEqual(result.normal, { low: 0, high: 0, median: 0, mad: 0 });
  assert.equal(result.outside, true);
  for (const point of daily) point.value = 10;
  result = metricsFromSnapshots(snapshots, '2026-09-02').metrics.signups;
  assert.deepEqual(result.normal, { low: 10, high: 10, median: 10, mad: 0 });
  assert.equal(result.outside, false);
  assert.deepEqual(result.flags, []);
});

test('invalid ratios do not turn into a hit or serialize a non-finite value', () => {
  const s = snapshot('2026-09-02', [1e300, 1e300, 1e300], [1e-300, 1e-300, 1e-300]);
  const reading = measure(s, example.metric, '2026-09-02');
  assert.equal(reading.value, null);
  assert.equal(reading.reason, 'invalid ratio');
  assert.equal(gradeBet(bet(), s, '2026-09-02').changed, false);
});

test('retention uses measured seven-day cohorts, deduplicates repeated windows and rejects zero cohorts', () => {
  const snapshots = headlineSnapshots();
  snapshots[1].body.overview.retention = structuredClone(snapshots[0].body.overview.retention);
  snapshots[2].body.overview.retention = structuredClone(snapshots.at(-1).body.overview.retention);
  let result = metricsFromSnapshots(snapshots, '2026-09-02').metrics.retention7;
  assert.equal(result.historySamples, 6);
  assert.equal(result.outside, false);
  const data = snapshots.at(-1).body.overview.retention.data;
  data.cohort = 0;
  data.retained = 0;
  result = metricsFromSnapshots(snapshots, '2026-09-02').metrics.retention7;
  assert.equal(result.value, null);
  assert.ok(result.flags.includes('small sample'));
  data.day = 1;
  assert.match(metricsFromSnapshots(snapshots, '2026-09-02').metrics.retention7.reason, /invalid 7-day/);
  snapshots.at(-1).body.overview.retention.state = 'missing';
  assert.equal(metricsFromSnapshots(snapshots, '2026-09-02').metrics.retention7.value, null);
});

test('CLI provides headline values and ranges in one JSON result', async (t) => {
  const ws = await workspace(t);
  for (const s of headlineSnapshots()) await ws.saveSnapshot(s);
  const result = ws.run('metrics.mjs');
  assert.equal(result.metrics.signups.value, 100);
  assert.equal(result.metrics.signups.outside, true);
  assert.equal(result.metrics.retention7.normal.median, 0.1);
  t.diagnostic(`CLI daily metrics: ${JSON.stringify(result.metrics.signups)}`);
});

test('CLI names unavailable snapshots and invalid dates instead of emitting fabricated output', async (t) => {
  const ws = await workspace(t);
  for (const extra of [['--today', '2026-02-30'], ['--today', '2026-01-01'], ['--typo']]) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/grade-bets.mjs'), ...ws.args, ...extra], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.trim());
  }
});

test('PR and main push CI run the existing test command with read-only permissions', async () => {
  const workflow = await readFile(join(root, '.github/workflows/test.yml'), 'utf8');
  assert.match(workflow, /on:\s+pull_request:\s+push:\s+branches: \[main\]/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /uses: actions\/checkout@v4/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /run: npm test/);
});


test('new-bet CLI validates, computes baseline, refuses duplicates, grades and disappears from feed', async (t) => {
  const ws = await workspace(t);
  const fields = ['--id', 'new-bet', '--title', 'Better replies', '--problem', 'Reply friction',
    '--numerator', 'firstReply', '--denominator', 'signups', '--window-days', '3',
    '--target', '0.5', '--direction', 'up', '--grade-on', '2026-09-02'];
  const run = (extra = []) => spawnSync(process.execPath, [join(root, 'scripts/new-bet.mjs'), ...ws.args, ...fields, ...extra], { encoding: 'utf8' });
  for (const extra of [ ['--id', '../escape'], ['--numerator', 'bogus'], ['--window-days', '0'],
    ['--target', 'NaN'], ['--direction', 'sideways'], ['--grade-on', '2026-02-30'],
    ['--grade-on', '2026-09-01'], ['--min-samples', '-1'], ['--title', ' '], ['--wat'] ]) {
    const invalid = run(extra);
    assert.equal(invalid.status, 1, JSON.stringify(extra));
    assert.ok(invalid.stderr.trim());
  }
  const created = run();
  assert.equal(created.status, 0, created.stderr);
  const saved = JSON.parse(created.stdout);
  assert.deepEqual(saved.baseline, { value: 0.5, from: '2026-08-31', through: '2026-09-02' });
  assert.equal(saved.minSamples, 10);
  const path = join(ws.bets, 'new-bet.json');
  const before = await readFile(path, 'utf8');
  assert.match(run().stderr, /id already exists/);
  assert.equal(await readFile(path, 'utf8'), before);
  const { buildLoop } = await import('../scripts/build-loop.mjs');
  const options = { today: '2026-09-02', bets: ws.bets, snapshots: ws.snapshots, output: join(ws.directory, 'loop.json') };
  assert.ok((await buildLoop(options)).openBets.some((b) => b.id === 'new-bet'));
  ws.run('grade-bets.mjs', ['--write']);
  const graded = JSON.parse(await readFile(path));
  assert.equal(graded.status, 'hit');
  assert.equal(graded.grade.value, 0.5);
  assert.deepEqual((await buildLoop(options)).openBets, []);
  const feed = await readFile(options.output, 'utf8');
  ws.run('grade-bets.mjs', ['--write']);
  await buildLoop({ ...options, now: new Date('2030-01-01') });
  assert.equal(await readFile(options.output, 'utf8'), feed);
  await ws.saveSnapshot(snapshot('2026-09-02', [0, 0, 0], [0, 0, 0]));
  assert.match(run(['--id', 'zero-baseline']).stderr, /baseline: zero denominator/);
  t.diagnostic('Reproduction BET-LOOP: CLI creation → baseline 0.5 → persisted hit → absent from feed → repeat unchanged');
});
