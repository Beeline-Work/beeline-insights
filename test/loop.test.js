import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLoop } from '../scripts/build-loop.mjs';
import { metricsFromSnapshots } from '../scripts/metrics.mjs';
import { windowDates } from '../scripts/lib/analysis.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const today = '2026-09-02';
const now = new Date('2026-09-02T13:00:00.000Z');
const keys = (object) => Object.keys(object).sort();
const expectedKeys = (object, list) => assert.deepEqual(keys(object), [...list].sort());

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'loop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const experiments = join(directory, 'experiments');
  const snapshots = join(directory, 'snapshots');
  const output = join(directory, 'loop/latest.json');
  await mkdir(experiments);
  await mkdir(snapshots);
  const archive = windowDates(today, 9).map((date, i) => ({
    date, file: `${date}.json`, body: { schemaVersion: 1, overview: {
      series: Object.fromEntries(['firstReply', 'signups', 'dau', 'wau'].map((name) => [name, {
        state: 'measured', data: { daily: windowDates(date, 29).map((day) => ({ date: day, value: name === 'firstReply' ? 5 : 20 })) },
      }])),
      retention: { state: 'measured', data: { day: 7, cohort: 20, retained: 4, from: `2026-07-0${i + 1}`, through: `2026-07-1${i + 1}` } },
    } },
  }));
  const save = async () => {
    for (const s of archive) await writeFile(join(snapshots, s.file), JSON.stringify(s.body));
  };
  await save();
  const build = (extra = {}) => buildLoop({ snapshots, today, output, now, ...extra });
  return { directory, experiments, snapshots, output, archive, save, build };
}

test('saved feed locks the full schema and preserves every metrics number from existing functions', async (t) => {
  const ws = await workspace(t);
  const feed = await ws.build();
  assert.deepEqual(JSON.parse(await readFile(ws.output)), feed);
  expectedKeys(feed, ['schemaVersion', 'generatedAt', 'date', 'snapshotDate', 'snapshot', 'headline', 'method', 'minSamples', 'minHistory', 'metrics', 'openBets']);
  assert.equal(feed.schemaVersion, 1);
  // The live Loop tab keeps working until the dashboard removes it.
  assert.deepEqual(feed.openBets, []);
  assert.equal(feed.generatedAt, now.toISOString());
  assert.equal(feed.date, today);
  assert.equal(feed.snapshotDate, today);
  assert.equal(feed.headline, 'firstReply/signups');
  const daily = metricsFromSnapshots(ws.archive, today);
  for (const field of ['snapshot', 'method', 'minSamples', 'minHistory']) assert.deepEqual(feed[field], daily[field]);
  expectedKeys(feed.metrics, ['firstReply/signups', 'signups', 'dau', 'wau', 'retention7']);
  for (const [name, metric] of Object.entries(feed.metrics)) {
    const { state, smallSample, ...original } = metric;
    expectedKeys(metric, ['value', 'samples', 'reason', 'normal', 'historySamples', 'flags', 'outside', 'state', 'smallSample', ...(name === 'retention7' ? ['from', 'through'] : [])]);
    expectedKeys(metric.normal, ['low', 'high', 'median', 'mad']);
    assert.deepEqual(original, daily.metrics[name]);
    assert.equal(state, 'measured');
    assert.equal(smallSample, daily.metrics[name].flags.includes('small sample'));
  }
});

test('non-measured blocks preserve exact states and null values for headlines', async (t) => {
  const ws = await workspace(t);
  for (const state of ['missing', 'error', 'not_connected', 'unmeasured']) {
    const latest = ws.archive.at(-1).body.overview;
    for (const block of [...Object.values(latest.series), latest.retention]) block.state = state;
    await ws.save();
    const feed = await ws.build();
    for (const reading of Object.values(feed.metrics)) {
      assert.equal(reading.state, state);
      assert.equal(reading.value, null);
      assert.equal(reading.samples, null);
      assert.match(reading.reason, new RegExp(`state ${state}`));
    }
  }
});

test('small samples, missing denominator, absent retention and stale dates remain explicit', async (t) => {
  const ws = await workspace(t);
  const latest = ws.archive.at(-1).body.overview;
  latest.series.signups.data.daily.at(-1).value = 2;
  await ws.save();
  let feed = await ws.build();
  assert.equal(feed.metrics.signups.smallSample, true);
  assert.equal(feed.metrics.signups.outside, false);
  delete latest.series.signups;
  delete latest.retention;
  await ws.save();
  feed = await ws.build();
  assert.equal(feed.metrics['firstReply/signups'].state, 'missing');
  assert.equal(feed.metrics['firstReply/signups'].value, null);
  assert.equal(feed.metrics.retention7.state, 'missing');
  feed = await ws.build({ today: '2026-09-03' });
  assert.equal(feed.date, '2026-09-03');
  assert.equal(feed.snapshotDate, today);
  assert.equal(feed.metrics.dau.state, 'unavailable');
  assert.equal(feed.metrics.dau.value, null);
});

test('CLI builds the dashboard file offline and fails without replacing a valid feed', async (t) => {
  const ws = await workspace(t);
  const args = [join(root, 'scripts/build-loop.mjs'), '--today', today, '--snapshots', ws.snapshots];
  const run = (extra = []) => spawnSync(process.execPath, [...args, ...extra], { cwd: ws.directory, encoding: 'utf8' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const feed = JSON.parse(await readFile(ws.output));
  assert.deepEqual(JSON.parse(result.stdout), feed);
  t.diagnostic(`CLI feed: ${JSON.stringify({ date: feed.date, snapshotDate: feed.snapshotDate, headline: feed.headline, metric: feed.metrics[feed.headline] })}`);
  const before = await readFile(ws.output, 'utf8');
  for (const extra of [['--today', '2026-02-30'], ['--today', '2020-01-01'], ['--write']]) assert.equal(run(extra).status, 1);
  await writeFile(join(ws.snapshots, `${today}.json`), '{');
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /JSON:/);
  assert.equal(await readFile(ws.output, 'utf8'), before);
});

test('daily workflow saves snapshot, grades and feeds in one commit, and still pushes snapshots when the insights feed fails', async (t) => {
  const workflow = await readFile(join(root, '.github/workflows/snapshot.yml'), 'utf8');
  const script = (name) => {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1);
    const section = workflow.slice(start).split('\n      - ').at(0);
    const body = section.split('        run: ')[1].split('\n        env:')[0];
    return body.startsWith('|\n') ? body.slice(2).split('\n').filter(Boolean).map((line) => line.slice(10)).join('\n') : body.trim();
  };
  for (const step of ['Grade experiments', 'Build Loop feed', 'Build insights feed']) {
    assert.match(workflow, new RegExp(`name: ${step}\n        continue-on-error: true`));
  }
  assert.match(workflow, /if: \$\{\{ always\(\) && steps.snapshot-commit.outcome == 'success' \}\}/);
  assert.match(workflow, /cron: '30 10 \* \* \*'/);
  assert.match(workflow, /BEELINE_DASHBOARD_SECRET: \$\{\{ secrets.BEELINE_DASHBOARD_SECRET \}\}/);
  assert.match(workflow, /npm run grade-experiments -- --write/);
  assert.match(workflow, /cron: '30 12 \* \* \*'/);
  assert.doesNotMatch(workflow, /--force|bets/);

  const proposed = await readFile(join(root, 'test/fixtures/v3/experiments/remove-onboarding-steps.json'), 'utf8');
  for (const failFeed of [false, true]) {
    const ws = await workspace(t);
    const git = (...args) => execFileSync('git', args, { cwd: ws.directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const remote = join(ws.directory, 'remote.git');
    git('init', '--bare', remote);
    git('init', '-b', 'main');
    git('config', 'user.name', 'Workflow test');
    git('config', 'user.email', 'workflow@example.invalid');
    for (const path of ['scripts', 'schemas', 'package.json']) await cp(join(root, path), join(ws.directory, path), { recursive: true });
    await writeFile(join(ws.experiments, '.gitkeep'), '');
    await mkdir(join(ws.directory, 'insights'));
    await writeFile(join(ws.directory, 'insights/.gitkeep'), '');
    await ws.build();
    execFileSync(process.execPath, ['scripts/build-feed.mjs', '--today', today], { cwd: ws.directory });
    git('add', 'scripts', 'schemas', 'package.json', 'snapshots', 'experiments', 'insights', 'loop', 'digests', 'feed');
    git('commit', '-m', 'Initial fixtures');
    git('remote', 'add', 'origin', remote);
    git('push', '-u', 'origin', 'main');
    const initial = git('rev-parse', 'HEAD');
    const previousFeed = await readFile(join(ws.directory, 'feed/latest.json'), 'utf8');
    const easternToday = (await import('../scripts/snapshot.mjs')).easternDate();
    const snapshotPath = `snapshots/${easternToday}.json`;
    await writeFile(join(ws.directory, snapshotPath), JSON.stringify(ws.archive.at(-1).body));
    // The digest run left a new proposal (or, when failing, a broken file) for the workflow to pick up.
    await writeFile(join(ws.experiments, 'remove-onboarding-steps.json'), failFeed ? '{}' : proposed);
    const env = { ...process.env, GITHUB_OUTPUT: join(ws.directory, 'step-output') };
    const shell = (command, extraEnv = {}) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], { cwd: ws.directory, encoding: 'utf8', env: { ...env, ...extraEnv } });
    assert.equal(shell(script('Capture missing snapshot')).status, 0);
    const committed = shell(script('Commit snapshot'));
    assert.equal(committed.status, 0, committed.stderr);
    assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /created=true/);
    const graded = shell(script('Grade experiments'));
    assert.equal(graded.status, failFeed ? 1 : 0, graded.stderr);
    const loop = shell(script('Build Loop feed'));
    assert.equal(loop.status, 0, loop.stderr);
    const built = shell(script('Build insights feed'));
    assert.equal(built.status, failFeed ? 1 : 0, built.stderr);
    const pushed = shell(script('Save snapshot and feed'), { SNAPSHOT_COMMITTED: 'true' });
    assert.equal(pushed.status, 0, pushed.stderr);
    const remoteGit = (...args) => git('--git-dir', remote, ...args);
    assert.equal(remoteGit('rev-parse', 'main^'), initial);
    assert.equal(remoteGit('show', `main:${snapshotPath}`), await readFile(join(ws.directory, snapshotPath), 'utf8'));
    assert.equal(JSON.parse(remoteGit('show', 'main:loop/latest.json')).snapshotDate, easternToday);
    const saved = remoteGit('show', 'main:feed/latest.json');
    if (failFeed) assert.equal(saved, previousFeed.trim());
    else {
      assert.deepEqual(JSON.parse(saved).experiments.map((experiment) => experiment.id), ['remove-onboarding-steps']);
      assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'),
        ['experiments/remove-onboarding-steps.json', 'feed/latest.json', 'loop/latest.json', snapshotPath]);
      // A same-day rerun has no snapshot commit to amend and must preserve history.
      const first = git('rev-parse', 'HEAD');
      for (const step of ['Capture missing snapshot', 'Grade experiments', 'Build Loop feed', 'Build insights feed']) assert.equal(shell(script(step)).status, 0, step);
      assert.equal(shell(script('Save snapshot and feed'), { SNAPSHOT_COMMITTED: '' }).status, 0);
      assert.equal(git('rev-parse', 'HEAD'), first);
    }
    t.diagnostic(`Workflow path: ${failFeed ? 'insights feed failed; snapshot and Loop feed pushed, prior insights feed preserved' : 'snapshot, new experiment and both feeds saved in one commit; rerun preserved history'}`);
  }
});
