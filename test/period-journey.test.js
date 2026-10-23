import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const today = '2026-10-23';
const source = await readFile(join(root, 'test/fixtures/operator-dashboard-periods.json'));
const periods = JSON.parse(source).periods;
const expectedSteps = periods['7d'].funnel.steps.map(({ label, count }) => ({ label, count }));
const cli = (script, directory) => spawnSync(process.execPath, [join(root, 'scripts', script), '--root', directory, '--today', today], { encoding: 'utf8' });

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'period-journey-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'test/fixtures/v3'), directory, { recursive: true });
  return directory;
}
async function snapshot(directory, value) {
  await writeFile(join(directory, `snapshots/${today}.json`), JSON.stringify(value));
}
async function build(directory) {
  const result = cli('build-feed.mjs', directory);
  assert.equal(result.status, 0, result.stderr);
  const insights = JSON.parse(await readFile(join(directory, 'insights/latest.json')));
  const feed = JSON.parse(await readFile(join(directory, 'feed/latest.json')));
  assert.deepEqual(feed.insights, insights);
  const validation = cli('validate.mjs', directory);
  assert.equal(validation.status, 0, validation.stderr);
  return insights;
}

test('Reproduction period-journey: build the Insights feed from the unchanged server fixture', async (t) => {
  assert.equal(createHash('sha256').update(source).digest('hex'), 'd04c2cd14633186c96410c2dcba5ae5833a7554c5be7dfef19e58893413b77e1');
  const directory = await setup(t);
  const before = JSON.parse(await readFile(join(directory, 'insights/latest.json')));
  const legacy = JSON.parse(await readFile(join(directory, `snapshots/${today}.json`)));
  await snapshot(directory, { ...legacy, ...JSON.parse(source) });
  const after = await build(directory);
  assert.deepEqual(after.journey.steps, expectedSteps);
  assert.equal(after.journey.biggestDrop, null);
  assert.equal(after.journey.state, 'measured');
  assert.deepEqual({ ...after, journey: before.journey }, before);
  t.diagnostic(`Reproduction period-journey: emitted five period steps, all count 2, biggestDrop null; validator passes`);
});

test('server biggestDrop key maps to its period label; null stays null and zero counts stay zero', async (t) => {
  const directory = await setup(t);
  const funnel = structuredClone(periods['7d'].funnel);
  funnel.steps[4].count = 0;
  funnel.biggestDrop = { key: 'active_7d', lost: 2 };
  await snapshot(directory, { schemaVersion: 1, periods: { '7d': { funnel } } });
  const result = await build(directory);
  assert.deepEqual(result.journey.biggestDrop, { label: 'Active in the last 7 days', lost: 2 });
  assert.equal(result.journey.steps[4].count, 0);
  funnel.biggestDrop = null;
  await snapshot(directory, { schemaVersion: 1, periods: { '7d': { funnel } } });
  assert.equal((await build(directory)).journey.biggestDrop, null);
});

test('newest legacy snapshot falls back honestly and marks the feed limited', async (t) => {
  const directory = await setup(t);
  await writeFile(join(directory, 'snapshots/2026-10-22.json'), JSON.stringify({ schemaVersion: 1, periods }));
  const before = JSON.parse(await readFile(join(directory, 'insights/latest.json')));
  const result = await build(directory);
  assert.deepEqual(result.journey, { ...before.journey, state: 'limited' });
  await snapshot(directory, { schemaVersion: 1 });
  assert.deepEqual((await build(directory)).journey, { steps: [], biggestDrop: null, state: 'limited' });
});

test('malformed period data fails without replacing the saved feed', async (t) => {
  const directory = await setup(t);
  const before = await readFile(join(directory, 'feed/latest.json'), 'utf8');
  for (const value of [
    {},
    { '7d': { funnel: { steps: [{ key: 'signed_up', label: 'Signed up', count: -1 }], biggestDrop: null } } },
    { '7d': { funnel: { steps: periods['7d'].funnel.steps, biggestDrop: { key: 'unknown', lost: 1 } } } },
  ]) {
    await snapshot(directory, { schemaVersion: 1, periods: value });
    const result = cli('build-feed.mjs', directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /periods.7d.funnel/);
    assert.equal(await readFile(join(directory, 'feed/latest.json'), 'utf8'), before);
  }
});
