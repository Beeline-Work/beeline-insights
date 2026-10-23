import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { metricsFromSnapshots } from './metrics.mjs';
import { cliOptions, isMain, loadSnapshots } from './lib/analysis.mjs';

function stateOf(snapshot, names, reading) {
  const states = names.map((name) => name === 'retention7'
    ? snapshot.body.overview?.retention?.state ?? 'missing'
    : snapshot.body.overview?.series?.[name]?.state ?? 'missing');
  return states.find((state) => state !== 'measured') ?? (reading.reason ? 'unavailable' : 'measured');
}

export async function buildLoop({ snapshots, today, output = 'loop/latest.json', now = new Date() }) {
  const archive = await loadSnapshots(snapshots, today, { history: true });
  const latest = archive.at(-1);
  const daily = metricsFromSnapshots(archive, today);
  const feed = {
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    date: today,
    snapshotDate: latest.date,
    snapshot: daily.snapshot,
    headline: 'firstReply/signups',
    method: daily.method,
    minSamples: daily.minSamples,
    minHistory: daily.minHistory,
    metrics: Object.fromEntries(Object.entries(daily.metrics).map(([name, reading]) => [name, {
      ...reading,
      state: stateOf(latest, name.split('/'), reading),
      smallSample: reading.flags.includes('small sample'),
    }])),
  };
  // Keep the generation time when the dashboard payload has not changed.
  try {
    const previous = JSON.parse(await readFile(output, 'utf8'));
    if (typeof previous.generatedAt === 'string'
      && JSON.stringify({ ...previous, generatedAt: feed.generatedAt }) === JSON.stringify(feed)) return previous;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(feed, null, 2)}\n`);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return feed;
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await buildLoop(cliOptions()), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
