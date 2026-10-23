import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { easternDate } from '../snapshot.mjs';

export const SERIES = ['dau', 'downloads', 'firstReply', 'friendsJoined', 'signups', 'wau', 'workspaces'];
export const finiteCount = (value) => Number.isFinite(value) && value >= 0;

export function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export function windowDates(through, days) {
  return Array.from({ length: days }, (_, i) => addDays(through, i - days + 1));
}

export async function readJSON(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: JSON: ${error.message}`);
  }
}

export async function loadSnapshots(directory, today, { history = false } = {}) {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')
    && isDate(name.slice(0, -5)) && name.slice(0, -5) <= today).sort();
  if (!files.length) throw new Error(`${directory}: no snapshot on or before ${today}`);
  const selected = files.filter((file) => (history && file.slice(0, -5) >= addDays(today, -28)) || file === files.at(-1));
  return Promise.all(selected.map(async (file) => {
    const body = await readJSON(join(directory, file));
    if (body?.schemaVersion !== 1) throw new Error(`${file}: schemaVersion: expected 1`);
    return { date: file.slice(0, -5), file, body };
  }));
}

export function measure(snapshot, metric, through) {
  const dates = windowDates(through, metric.windowDays);
  const totals = [];
  for (const name of [metric.numerator, metric.denominator].filter(Boolean)) {
    const block = snapshot.body.overview?.series?.[name];
    if (block?.state !== 'measured') return { value: null, samples: null, reason: `${name}: state ${block?.state ?? 'missing'}` };
    if (!Array.isArray(block.data?.daily)) return { value: null, samples: null, reason: `${name}: missing daily series` };
    let total = 0;
    for (const date of dates) {
      const points = block.data.daily.filter((point) => point.date === date);
      if (points.length !== 1 || !finiteCount(points[0].value)) {
        return { value: null, samples: null, reason: `${name}: missing, invalid or duplicate day ${date}` };
      }
      total += points[0].value;
    }
    if (!finiteCount(total)) return { value: null, samples: null, reason: `${name}: invalid sum` };
    totals.push(total);
  }
  const samples = totals.at(-1);
  const value = metric.denominator ? (samples === 0 ? null : totals[0] / samples) : totals[0];
  if (value !== null && !finiteCount(value)) return { value: null, samples, reason: 'invalid ratio' };
  return { value, samples, reason: null };
}

export function cliOptions({ write = false } = {}) {
  const options = { today: easternDate(), experiments: 'experiments', snapshots: 'snapshots', write: false };
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === '--write' && write) options.write = true;
    else if (['--today', '--experiments', '--snapshots'].includes(flag) && args[0] && !args[0].startsWith('--')) options[flag.slice(2)] = args.shift();
    else throw new Error(`unknown or incomplete option: ${flag}`);
  }
  if (!isDate(options.today)) throw new Error('--today: expected a calendar date YYYY-MM-DD');
  return options;
}

export function isMain(url) {
  return process.argv[1] && url === pathToFileURL(process.argv[1]).href;
}
