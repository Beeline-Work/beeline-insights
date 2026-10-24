import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFeed } from '../scripts/build-feed.mjs';
import { themeErrors } from '../scripts/lib/contract.mjs';
import { FEEDBACK_CLASSES, THEME_IDS, themeSQL } from '../scripts/theme-classes.mjs';
import { trackThemes } from '../scripts/track-themes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const themeFiles = (await readdir(join(root, 'themes'))).filter((file) => file.endsWith('.json')).sort();
const realThemes = await Promise.all(themeFiles.map(async (file) => JSON.parse(await readFile(join(root, 'themes', file), 'utf8'))));
const wakes = realThemes.find((theme) => theme.id === 'wakes-without-causality');

// The mock v3 tree plus the real themes/.
async function tree(t) {
  const directory = await mkdtemp(join(tmpdir(), 'themes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'test/fixtures/v3'), directory, { recursive: true });
  await cp(join(root, 'themes'), join(directory, 'themes'), { recursive: true });
  return directory;
}
const cli = (script, directory, today, ...rest) => spawnSync(process.execPath, [join(root, 'scripts', script), '--root', directory, ...(today ? ['--today', today] : []), ...rest], { encoding: 'utf8' });
const lastDay = wakes.track.history.at(-1).date;
const save = (directory, theme) => writeFile(join(directory, 'themes', `${theme.id}.json`), JSON.stringify(theme));

test('the feed carries every theme file, open first', async (t) => {
  const directory = await tree(t);
  const feed = await buildFeed({ root: directory, today: lastDay });
  assert.equal(feed.themes.length, themeFiles.length);
  const merged = { ...structuredClone(wakes), id: 'a-merged-theme', status: 'merged' };
  const retired = { ...structuredClone(wakes), id: 'a-retired-theme', status: 'retired' };
  await save(directory, merged);
  await save(directory, retired);
  const statuses = (await buildFeed({ root: directory, today: lastDay })).themes.map((theme) => theme.status);
  assert.equal(statuses.length, themeFiles.length + 2);
  assert.deepEqual(statuses.slice(-2), ['merged', 'retired']);
  assert.ok(statuses.slice(0, -2).every((status) => status === 'open'));
  const committed = JSON.parse(await readFile(join(root, 'feed/latest.json'), 'utf8'));
  assert.equal(committed.themes.length, themeFiles.length);
});

test('every real theme tracks one number with a 30-day backfill and a keyword-match definition', () => {
  assert.deepEqual(realThemes.map((theme) => theme.id).sort(), THEME_IDS);
  for (const theme of realThemes) {
    assert.deepEqual(themeErrors(theme, `${theme.id}.json`), [], theme.id);
    assert.ok(theme.track.history[0].date <= '2026-09-25', `${theme.id} starts ${theme.track.history[0].date}`);
    if (theme.track.source === 'feedback-share') assert.match(theme.track.definition, /match/i, theme.id);
  }
});

test('validate fails when a theme lacks track, has empty history, or is more than 2 days stale', async (t) => {
  const directory = await tree(t);
  assert.equal(cli('build-feed.mjs', directory, lastDay).status, 0);
  const ok = cli('validate.mjs', directory, lastDay);
  assert.equal(ok.status, 0, ok.stderr);
  // The day after the newest point and 2 days after both pass; 3 days after fails.
  const plus = (days) => new Date(Date.parse(`${lastDay}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  assert.equal(cli('validate.mjs', directory, plus(2)).status, 0, cli('validate.mjs', directory, plus(2)).stderr);
  const stale = cli('validate.mjs', directory, plus(3));
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /themes\/wakes-without-causality.json: track.history: newest point .* more than 2 days/);
  // build-feed never blocks on a stale track.
  assert.equal(cli('build-feed.mjs', directory, plus(3)).status, 0);

  const { track, ...untracked } = structuredClone(wakes);
  const cases = [
    ['no track', untracked, /wakes-without-causality.json: \(root\): missing track/],
    ['empty history', { ...structuredClone(wakes), track: { ...track, history: [] } }, /wakes-without-causality.json: track.history: expected at least 1 items/],
    ['out of order', { ...structuredClone(wakes), track: { ...track, history: [...track.history].reverse() } }, /track.history\[1\].date: must be after the previous day/],
    ['share above 1', { ...structuredClone(wakes), track: { ...track, history: [{ date: lastDay, value: 2, samples: 3 }] } }, /a share is a fraction/],
  ];
  for (const [name, theme, message] of cases) {
    const copy = await tree(t);
    await save(copy, theme);
    const result = cli('validate.mjs', copy, lastDay);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, message, name);
    assert.equal(cli('build-feed.mjs', copy, lastDay).status, 1, name);
  }
});

test('a bad theme file fails: unknown field, an @handle, missing falsifiedIf', () => {
  assert.deepEqual(themeErrors(wakes, 'wakes-without-causality.json'), []);
  assert.ok(themeErrors({ ...wakes, tags: ['x'] }).includes('tags: unknown field'));
  assert.ok(themeErrors({ ...wakes, track: { ...wakes.track, color: 'red' } }).includes('track.color: unknown field'));
  assert.ok(themeErrors({ ...wakes, mechanism: 'Reported by @lunchboxfortwo' }).includes('mechanism: contains an @handle'));
  assert.ok(themeErrors({ ...wakes, evidence: [{ source: 'feedback', text: 'Ask jane@example.com' }] }).includes('evidence[0].text: contains an email address'));
  assert.ok(themeErrors({ ...wakes, track: { ...wakes.track, definition: 'Room 7813975a-9c99-4321-817b-784d747ce55b only' } }).includes('track.definition: contains an identifier'));
  const { falsifiedIf, ...unfalsifiable } = wakes;
  assert.ok(themeErrors(unfalsifiable).includes('(root): missing falsifiedIf'));
  assert.ok(themeErrors(wakes, 'other.json').includes('id: must match the filename'));
});

test('an experiment may name a theme, and validate checks the theme file exists', async (t) => {
  const directory = await tree(t);
  const path = join(directory, 'experiments/fix-notices.json');
  const experiment = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...experiment, theme: 'wakes-without-causality' }));
  assert.equal(cli('build-feed.mjs', directory, lastDay).status, 0);
  assert.equal(cli('validate.mjs', directory, lastDay).status, 0);
  await writeFile(path, JSON.stringify({ ...experiment, theme: 'no-such-theme' }));
  const result = cli('validate.mjs', directory, lastDay);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /experiments\/fix-notices.json: theme: no themes\/no-such-theme.json/);
});

test('track-themes appends or replaces one day per theme and writes nothing on a bad input', async (t) => {
  const directory = await tree(t);
  const next = new Date(Date.parse(`${lastDay}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const values = Object.fromEntries(THEME_IDS.map((id) => [id, { value: 0.1, samples: 50 }]));
  const before = await readFile(join(directory, 'themes/wakes-without-causality.json'), 'utf8');
  await assert.rejects(trackThemes({ root: directory, date: next, values: { ...values, 'not-a-theme': { value: 0.1, samples: 1 } } }), /values: not-a-theme: no themes\/not-a-theme.json/);
  const { 'state-copies-diverge': _, ...missing } = values;
  await assert.rejects(trackThemes({ root: directory, date: next, values: missing }), /values: missing open theme state-copies-diverge/);
  await assert.rejects(trackThemes({ root: directory, date: next, values: { ...values, 'wakes-without-causality': { value: 1.5, samples: 9 } } }), /a share is a fraction/);
  assert.equal(await readFile(join(directory, 'themes/wakes-without-causality.json'), 'utf8'), before);

  const file = join(directory, 'values.json');
  await writeFile(file, JSON.stringify(values));
  const result = spawnSync(process.execPath, [join(root, 'scripts/track-themes.mjs'), '--root', directory, '--date', next, '--values', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const tracked = JSON.parse(await readFile(join(directory, 'themes/wakes-without-causality.json'), 'utf8'));
  assert.equal(tracked.track.history.length, wakes.track.history.length + 1);
  assert.deepEqual(tracked.track.history.at(-1), { date: next, value: 0.1, samples: 50 });
  await trackThemes({ root: directory, date: next, values: { ...values, 'wakes-without-causality': { value: 0.2, samples: 60 } } });
  const replaced = JSON.parse(await readFile(join(directory, 'themes/wakes-without-causality.json'), 'utf8'));
  assert.equal(replaced.track.history.length, wakes.track.history.length + 1);
  assert.deepEqual(replaced.track.history.at(-1), { date: next, value: 0.2, samples: 60 });
  assert.equal(cli('build-feed.mjs', directory, next).status, 0);
  assert.equal(cli('validate.mjs', directory, next).status, 0);
});

test('the theme SQL is read-only, covers every theme and holds no ids or row text', () => {
  const sql = themeSQL({ from: '2026-10-01', through: '2026-10-23' });
  assert.match(sql, /^WITH /);
  assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i);
  assert.doesNotMatch(sql, /\b[0-9a-f]{24,}\b|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  for (const id of THEME_IDS) assert.ok(sql.includes(`'${id}'`), id);
  for (const pattern of Object.values(FEEDBACK_CLASSES)) assert.ok(sql.includes(pattern));
  assert.throws(() => themeSQL({ from: '2026-10-23', through: '2026-10-01' }), /from on or before through/);
  const printed = spawnSync(process.execPath, [join(root, 'scripts/theme-classes.mjs'), '--from', '2026-10-23'], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout.trim(), themeSQL({ from: '2026-10-23', through: '2026-10-23' }).trim());
});
