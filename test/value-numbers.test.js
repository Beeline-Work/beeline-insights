import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUNNEL, METRICS, valueSQL, windows } from '../scripts/value-numbers.mjs';

test('every metric has last7, prior7 and last28 windows that close by the through date', () => {
  const all = windows('2026-10-27');
  assert.equal(all.length, Object.keys(METRICS).length * 3);
  const get = (metric, window) => all.find((w) => w.metric === metric && w.window === window);
  assert.deepEqual(get('return7', 'last7'), { metric: 'return7', window: 'last7', from: '2026-10-14', through: '2026-10-20' });
  assert.deepEqual(get('return7', 'prior7'), { metric: 'return7', window: 'prior7', from: '2026-10-07', through: '2026-10-13' });
  assert.deepEqual(get('return28', 'last28'), { metric: 'return28', window: 'last28', from: '2026-09-02', through: '2026-09-29' });
  assert.deepEqual(get('active', 'last7'), { metric: 'active', window: 'last7', from: '2026-10-21', through: '2026-10-27' });
  for (const w of all) assert.ok(w.through <= '2026-10-27' && w.from <= w.through, `${w.metric} ${w.window}`);
});

test('the SQL is read-only, the same on every run, and covers every metric', () => {
  const sql = valueSQL({ through: '2026-10-27' });
  assert.equal(sql, valueSQL({ through: '2026-10-27' }));
  assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i);
  for (const metric of Object.keys(METRICS)) assert.match(sql, new RegExp(`'${metric}'`), metric);
  assert.deepEqual(FUNNEL.filter((step) => !METRICS[step]), []);
  assert.doesNotMatch(sql, /\btext\b\s*,|msg\.text/, 'never reads message text');
});

test('a bad date is refused', () => {
  assert.throws(() => valueSQL({ through: '2026-13-01' }), /--through/);
  assert.throws(() => valueSQL({}), /--through/);
});

test('it reads only invite columns production has, and counts coming back among people who wrote', () => {
  const sql = valueSQL({ through: '2026-10-27' });
  const invites = sql.slice(sql.indexOf('invites_made AS'), sql.indexOf('cards AS'));
  assert.doesNotMatch(invites, /\b(i|inv)\.created_at\b/, 'invites.created_at is missing or null before its release');
  assert.match(sql, /coalesce\(i\.onboarding_created_at, i\.expires_at - interval '7 days'\)/);
  assert.match(sql.slice(sql.indexOf('writers AS'), sql.indexOf('active AS')), /FROM returns r WHERE r\.first_at IS NOT NULL/);
  for (const metric of ['return1', 'return7', 'return28']) assert.match(sql, new RegExp(`FROM win w LEFT JOIN writers x [^\\n]*'${metric}'`), metric);
});
