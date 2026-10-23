import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLoop } from '../scripts/build-loop.mjs';
import { gradeBet } from '../scripts/grade-bets.mjs';
import { metricsFromSnapshots } from '../scripts/metrics.mjs';
import { measure, windowDates } from '../scripts/lib/analysis.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const today = '2026-09-02';
const now = new Date('2026-09-02T13:00:00.000Z');
const example = JSON.parse(await readFile(new URL('./fixtures/example-bet.json', import.meta.url)));
const keys = (object) => Object.keys(object).sort();
const expectedKeys = (object, list) => assert.deepEqual(keys(object), [...list].sort());

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'loop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bets = join(directory, 'bets');
  const snapshots = join(directory, 'snapshots');
  const output = join(directory, 'loop/latest.json');
  await mkdir(bets);
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
  const saveBet = async (patch = {}) => {
    const bet = { ...structuredClone(example), gradeOn: '2026-09-05', ...patch };
    await writeFile(join(bets, `${bet.id}.json`), JSON.stringify(bet));
    return bet;
  };
  await save();
  const build = (extra = {}) => buildLoop({ bets, snapshots, today, output, now, ...extra });
  return { directory, bets, snapshots, output, archive, save, saveBet, build };
}

test('saved feed locks the full schema and preserves every metrics and bet number from existing functions', async (t) => {
  const ws = await workspace(t);
  const bet = await ws.saveBet();
  const before = await readFile(join(ws.bets, 'example-bet.json'), 'utf8');
  const feed = await ws.build();
  assert.deepEqual(JSON.parse(await readFile(ws.output)), feed);
  expectedKeys(feed, ['schemaVersion', 'generatedAt', 'date', 'snapshotDate', 'snapshot', 'headline', 'method', 'minSamples', 'minHistory', 'metrics', 'openBets']);
  assert.equal(feed.schemaVersion, 1);
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
  const current = feed.openBets[0];
  expectedKeys(current, ['id', 'title', 'metric', 'baseline', 'target', 'gradeOn', 'status', 'retryPending', 'value', 'samples', 'reason', 'state']);
  expectedKeys(current.metric, ['numerator', 'denominator', 'windowDays']);
  expectedKeys(current.baseline, ['value', 'from', 'through']);
  expectedKeys(current.target, ['value', 'direction']);
  for (const field of ['id', 'title', 'metric', 'baseline', 'target', 'gradeOn', 'status']) assert.deepEqual(current[field], bet[field]);
  const grade = gradeBet(bet, ws.archive.at(-1), today).result;
  for (const field of ['value', 'samples', 'reason']) assert.deepEqual(current[field], grade[field]);
  assert.equal(current.retryPending, false);
  assert.equal(current.state, 'measured');
  assert.equal(await readFile(join(ws.bets, 'example-bet.json'), 'utf8'), before);
});

test('non-measured blocks preserve exact states and null values for headlines and bets', async (t) => {
  const ws = await workspace(t);
  await ws.saveBet();
  for (const state of ['missing', 'error', 'not_connected', 'unmeasured']) {
    const latest = ws.archive.at(-1).body.overview;
    for (const block of [...Object.values(latest.series), latest.retention]) block.state = state;
    await ws.save();
    const feed = await ws.build();
    for (const reading of [...Object.values(feed.metrics), ...feed.openBets]) {
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

test('open overdue and retry bets show current measurements without grading or extending, terminal bets excluded', async (t) => {
  const ws = await workspace(t);
  const overdue = await ws.saveBet({ gradeOn: '2026-09-01', minSamples: 1000 });
  const retry = { status: 'unclear', extensionUsed: true, retryPending: true, grade: { value: null, samples: 0, snapshot: `${today}.json`, gradedOn: today } };
  await ws.saveBet({ id: 'retry-bet', ...retry });
  for (const status of ['hit', 'miss', 'unclear']) await ws.saveBet({ id: `${status}-bet`, status, grade: { ...retry.grade, value: 1 } });
  const files = await readdir(ws.bets);
  const before = await Promise.all(files.map((file) => readFile(join(ws.bets, file), 'utf8')));
  const feed = await ws.build();
  assert.deepEqual(feed.openBets.map((bet) => bet.id), ['example-bet', 'retry-bet']);
  assert.equal(feed.openBets[0].gradeOn, overdue.gradeOn);
  assert.equal(feed.openBets[0].status, 'open');
  assert.equal(feed.openBets[1].retryPending, true);
  const reading = measure(ws.archive.at(-1), overdue.metric, today);
  for (const field of ['value', 'samples', 'reason']) assert.deepEqual(feed.openBets[0][field], reading[field]);
  const after = await Promise.all(files.map((file) => readFile(join(ws.bets, file), 'utf8')));
  assert.deepEqual(after, before);
});

test('CLI builds the dashboard file offline, supports empty bets and fails without replacing a valid feed', async (t) => {
  const ws = await workspace(t);
  const args = [join(root, 'scripts/build-loop.mjs'), '--today', today, '--snapshots', ws.snapshots, '--bets', ws.bets];
  const run = (extra = []) => spawnSync(process.execPath, [...args, ...extra], { cwd: ws.directory, encoding: 'utf8' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const feed = JSON.parse(await readFile(ws.output));
  assert.deepEqual(JSON.parse(result.stdout), feed);
  assert.deepEqual(feed.openBets, []);
  t.diagnostic(`CLI feed: ${JSON.stringify({ date: feed.date, snapshotDate: feed.snapshotDate, headline: feed.headline, metric: feed.metrics[feed.headline], openBets: feed.openBets })}`);
  const before = await readFile(ws.output, 'utf8');
  for (const extra of [['--today', '2026-02-30'], ['--today', '2020-01-01'], ['--write']]) assert.equal(run(extra).status, 1);
  await writeFile(join(ws.bets, 'bad.json'), '{}');
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /bad.json: id:/);
  assert.equal(await readFile(ws.output, 'utf8'), before);
});

test('daily workflow saves snapshot and feed in one commit, and still pushes snapshots when the feed fails', async (t) => {
  const workflow = await readFile(join(root, '.github/workflows/snapshot.yml'), 'utf8');
  const script = (name) => {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1);
    const section = workflow.slice(start).split('\n      - ').at(0);
    const body = section.split('        run: ')[1].split('\n        env:')[0];
    return body.startsWith('|\n') ? body.slice(2).split('\n').filter(Boolean).map((line) => line.slice(10)).join('\n') : body.trim();
  };
  assert.match(workflow, /name: Build Loop feed\n        continue-on-error: true/);
  assert.match(workflow, /if: \$\{\{ always\(\) && steps.snapshot-commit.outcome == 'success' \}\}/);
  assert.match(workflow, /cron: '30 10 \* \* \*'/);
  assert.match(workflow, /BEELINE_DASHBOARD_SECRET: \$\{\{ secrets.BEELINE_DASHBOARD_SECRET \}\}/);
  assert.match(workflow, /npm run grade-bets -- --write/);
  assert.match(workflow, /cron: '30 12 \* \* \*'/);
  assert.doesNotMatch(workflow, /--force/);

  for (const failFeed of [false, true]) {
    const ws = await workspace(t);
    const git = (...args) => execFileSync('git', args, { cwd: ws.directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const remote = join(ws.directory, 'remote.git');
    git('init', '--bare', remote);
    git('init', '-b', 'main');
    git('config', 'user.name', 'Workflow test');
    git('config', 'user.email', 'workflow@example.invalid');
    await cp(join(root, 'scripts'), join(ws.directory, 'scripts'), { recursive: true });
    await cp(join(root, 'package.json'), join(ws.directory, 'package.json'));
    await writeFile(join(ws.bets, '.gitkeep'), '');
    await ws.build();
    git('add', 'scripts', 'package.json', 'snapshots', 'bets', 'loop');
    git('commit', '-m', 'Initial fixtures');
    git('remote', 'add', 'origin', remote);
    git('push', '-u', 'origin', 'main');
    const initial = git('rev-parse', 'HEAD');
    const previousFeed = await readFile(ws.output, 'utf8');
    const easternToday = (await import('../scripts/snapshot.mjs')).easternDate();
    const snapshotPath = `snapshots/${easternToday}.json`;
    await writeFile(join(ws.directory, snapshotPath), JSON.stringify(ws.archive.at(-1).body));
    const env = { ...process.env, GITHUB_OUTPUT: join(ws.directory, 'step-output') };
    const shell = (command, extraEnv = {}) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], { cwd: ws.directory, encoding: 'utf8', env: { ...env, ...extraEnv } });
    assert.equal(shell(script('Capture missing snapshot')).status, 0);
    const committed = shell(script('Commit snapshot'));
    assert.equal(committed.status, 0, committed.stderr);
    assert.match(await readFile(env.GITHUB_OUTPUT, 'utf8'), /created=true/);
    if (failFeed) await writeFile(join(ws.bets, 'bad.json'), '{}');
    const graded = shell(script('Grade due bets'));
    assert.equal(graded.status, failFeed ? 1 : 0, graded.stderr);
    const built = shell(script('Build Loop feed'), { SNAPSHOT_COMMITTED: 'true' });
    assert.equal(built.status, failFeed ? 1 : 0, built.stderr);
    const pushed = shell(script('Save snapshot and feed'), { SNAPSHOT_COMMITTED: 'true' });
    assert.equal(pushed.status, 0, pushed.stderr);
    const remoteGit = (...args) => git('--git-dir', remote, ...args);
    assert.equal(remoteGit('rev-parse', 'main^'), initial);
    assert.equal(remoteGit('show', `main:${snapshotPath}`), await readFile(join(ws.directory, snapshotPath), 'utf8'));
    const saved = remoteGit('show', 'main:loop/latest.json');
    if (failFeed) assert.equal(saved, previousFeed.trim());
    else {
      assert.equal(JSON.parse(saved).snapshotDate, easternToday);
      assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'), ['loop/latest.json', snapshotPath]);
      // A same-day rerun has no snapshot commit to amend and must preserve history.
      const first = git('rev-parse', 'HEAD');
      const rerun = shell(script('Build Loop feed'), { SNAPSHOT_COMMITTED: '' });
      assert.equal(rerun.status, 0, rerun.stderr);
      assert.equal(shell(script('Capture missing snapshot')).status, 0);
      assert.equal(shell(script('Grade due bets')).status, 0);
      assert.equal(shell(script('Save snapshot and feed')).status, 0);
      assert.equal(git('rev-parse', 'HEAD'), first);
      assert.equal(shell(script('Save snapshot and feed')).status, 0);
    }
    t.diagnostic(`Workflow path: feed ${failFeed ? 'failed; snapshot pushed, prior feed preserved' : 'saved in snapshot commit; rerun preserved published history'}`);
  }
});
