// Saves one day's operator dashboard aggregate as snapshots/YYYY-MM-DD.json.
// The date is the Eastern calendar date, matching the dashboard's Usage series.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function easternDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function fetchDashboard({ serverUrl, secret, fetchImpl = fetch }) {
  const response = await fetchImpl(`${serverUrl}/v1/admin/dashboard`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) {
    throw new Error(`dashboard read failed: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body !== 'object' || body === null || !('schemaVersion' in body)) {
    throw new Error('dashboard read returned an unexpected body');
  }
  return body;
}

export async function writeSnapshot({ directory, date, body }) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${date}.json`);
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const serverUrl = process.env.BEELINE_SERVER_URL ?? 'https://server.usebeeline.app';
  const secret = process.env.BEELINE_DASHBOARD_SECRET;
  if (!secret) {
    console.error('BEELINE_DASHBOARD_SECRET is not set');
    process.exit(1);
  }
  const body = await fetchDashboard({ serverUrl, secret });
  const path = await writeSnapshot({ directory: 'snapshots', date: easternDate(), body });
  console.log(`wrote ${path}`);
}
