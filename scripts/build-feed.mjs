import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { journeyFromSnapshot } from './journey.mjs';
import { loadContract, schemaErrors, sortExperiments } from './lib/contract.mjs';
import { isDate, isMain, loadSnapshots } from './lib/analysis.mjs';
import { easternDate } from './snapshot.mjs';

export function feedOptions(args = process.argv.slice(2)) {
  const options = { root: '.', today: easternDate() };
  while (args.length) {
    const flag = args.shift();
    if (['--root', '--today'].includes(flag) && args[0] && !args[0].startsWith('--')) options[flag.slice(2)] = args.shift();
    else throw new Error(`unknown or incomplete option: ${flag}`);
  }
  if (!isDate(options.today)) throw new Error('--today: expected a calendar date YYYY-MM-DD');
  return options;
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function save(path, text) {
  try {
    if (await readFile(path, 'utf8') === text) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

// Everything the feed needs, computed without writing. Problems list every invalid input.
export async function planFeed({ root, today, now = new Date() }) {
  const contract = await loadContract(root);
  const { problems } = contract;
  let insights = contract.insights;
  if (insights !== null) {
    try {
      const snapshot = (await loadSnapshots(join(root, 'snapshots'), today)).at(-1);
      insights = { ...insights, journey: journeyFromSnapshot(snapshot) };
    } catch (error) {
      problems.push(`insights/latest.json: journey: ${error.message}`);
    }
  }
  const feed = { generatedAt: now.toISOString(), insights, experiments: sortExperiments(contract.experiments), reach: contract.reach, digests: contract.digests };
  problems.push(...schemaErrors(feed, 'feed.schema.json').map((error) => `feed/latest.json: ${error}`));
  // Keep the generation time when nothing the dashboard shows has changed.
  try {
    const previous = JSON.parse(await readFile(join(root, 'feed/latest.json'), 'utf8'));
    if (typeof previous.generatedAt === 'string' && json({ ...previous, generatedAt: feed.generatedAt }) === json(feed)) feed.generatedAt = previous.generatedAt;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return { problems, files: [
    ...(insights === null ? [] : [['insights/latest.json', json(insights)]]),
    ['digests/index.json', json(contract.digests)],
    ['feed/latest.json', json(feed)],
  ], feed };
}

// Refreshes the journey from the newest snapshot, then writes the digest index and the feed.
export async function buildFeed(options) {
  const plan = await planFeed(options);
  if (plan.problems.length) throw new Error(plan.problems.join('\n'));
  for (const [file, text] of plan.files) await save(join(options.root, file), text);
  return plan.feed;
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await buildFeed(feedOptions()), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
