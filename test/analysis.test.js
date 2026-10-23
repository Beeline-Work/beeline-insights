import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsFromSnapshots } from '../scripts/metrics.mjs';
import { addDays, isDate, measure, windowDates } from '../scripts/lib/analysis.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rate = { numerator: 'firstReply', denominator: 'signups', windowDays: 3 };
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
  const snapshots = join(directory, 'snapshots');
  await mkdir(snapshots);
  const saveSnapshot = async (s) => writeFile(join(snapshots, s.file), JSON.stringify(s.body));
  await saveSnapshot(snapshot());
  const args = ['--snapshots', snapshots, '--today', '2026-09-02'];
  const run = (script, extra = []) => JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', script), ...args, ...extra], { encoding: 'utf8' }));
  return { directory, snapshots, args, run, saveSnapshot };
}

test('dates are real calendar days', () => {
  assert.equal(isDate('2026-02-30'), false);
  assert.equal(isDate('2026-2-03'), false);
  assert.equal(isDate('2028-02-29'), true);
});

test('rates use ratio of sums across month end; counts sum the numerator', () => {
  assert.deepEqual(windowDates('2026-09-02', 3), ['2026-08-31', '2026-09-01', '2026-09-02']);
  assert.deepEqual(measure(snapshot(), rate, '2026-09-02'), { value: 0.5, samples: 20, reason: null });
  assert.deepEqual(measure(snapshot(), { numerator: 'signups', windowDays: 3 }, '2026-09-02'), { value: 20, samples: 20, reason: null });
  assert.deepEqual(measure(snapshot('2026-09-02', [0, 0, 0], [0, 0, 0]), rate, '2026-09-02'), { value: null, samples: 0, reason: null });
});

test('missing, null, negative, duplicate and non-measured data never measure', () => {
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
    const reading = measure(s, rate, '2026-09-02');
    assert.equal(reading.value, null);
    assert.ok(reading.reason);
  }
  // A stale snapshot cannot fill a day it does not have.
  assert.match(measure(snapshot(), rate, '2026-09-03').reason, /missing, invalid or duplicate day 2026-09-03/);
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

test('invalid ratios do not serialize a non-finite value', () => {
  const s = snapshot('2026-09-02', [1e300, 1e300, 1e300], [1e-300, 1e-300, 1e-300]);
  const reading = measure(s, rate, '2026-09-02');
  assert.equal(reading.value, null);
  assert.equal(reading.reason, 'invalid ratio');
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
    const result = spawnSync(process.execPath, [join(root, 'scripts/metrics.mjs'), ...ws.args, ...extra], { encoding: 'utf8' });
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
  assert.match(workflow, /run: npm run validate/);
});

