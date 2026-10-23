import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { easternDate, fetchDashboard, writeSnapshot } from '../scripts/snapshot.mjs';

test('easternDate uses the New York calendar day', () => {
  // 03:30 UTC on 23 Oct is still 22 Oct in New York (EDT, UTC-4).
  assert.equal(easternDate(new Date('2026-10-23T03:30:00Z')), '2026-10-22');
  assert.equal(easternDate(new Date('2026-10-23T04:30:00Z')), '2026-10-23');
  // EST after the November change (UTC-5).
  assert.equal(easternDate(new Date('2026-11-10T04:30:00Z')), '2026-11-09');
});

test('fetchDashboard sends the bearer secret and returns the body', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, usage: {} }) };
  };
  const body = await fetchDashboard({ serverUrl: 'https://example.test', secret: 's3', fetchImpl });
  assert.deepEqual(seen, { url: 'https://example.test/v1/admin/dashboard', auth: 'Bearer s3' });
  assert.equal(body.schemaVersion, 1);
});

test('fetchDashboard refuses a failed read', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(
    fetchDashboard({ serverUrl: 'https://example.test', secret: 'x', fetchImpl }),
    /HTTP 403/,
  );
});

test('fetchDashboard refuses a body without a schema version', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: 'nope' }) });
  await assert.rejects(
    fetchDashboard({ serverUrl: 'https://example.test', secret: 'x', fetchImpl }),
    /unexpected body/,
  );
});

test('writeSnapshot writes one dated JSON file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snap-'));
  const path = await writeSnapshot({ directory, date: '2026-10-22', body: { schemaVersion: 1 } });
  assert.equal(path, join(directory, '2026-10-22.json'));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { schemaVersion: 1 });
});
