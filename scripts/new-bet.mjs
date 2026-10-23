import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateBet } from './grade-bets.mjs';
import { MIN_SAMPLES } from './metrics.mjs';
import { easternDate } from './snapshot.mjs';
import { isDate, isMain, loadSnapshots, measure, windowDates } from './lib/analysis.mjs';

export function newBetOptions(args = process.argv.slice(2)) {
  const options = { today: easternDate(), bets: 'bets', snapshots: 'snapshots', 'min-samples': String(MIN_SAMPLES) };
  const allowed = ['id', 'title', 'problem', 'numerator', 'denominator', 'window-days', 'target', 'direction', 'grade-on', 'min-samples', 'today', 'bets', 'snapshots'];
  while (args.length) {
    const flag = args.shift();
    const key = flag.slice(2);
    if (!flag.startsWith('--') || !allowed.includes(key) || !args[0] || args[0].startsWith('--')) throw new Error(`unknown or incomplete option: ${flag}`);
    options[key] = args.shift();
  }
  for (const key of ['id', 'title', 'problem', 'numerator', 'window-days', 'target', 'direction', 'grade-on']) {
    if (!options[key]?.trim()) throw new Error(`--${key}: required`);
  }
  if (!isDate(options.today)) throw new Error('--today: expected a calendar date YYYY-MM-DD');
  return options;
}

export async function newBet(options) {
  const metric = { numerator: options.numerator, ...(options.denominator ? { denominator: options.denominator } : {}), windowDays: Number(options['window-days']) };
  const path = join(options.bets, `${options.id}.json`);
  const bet = {
    id: options.id, title: options.title, problem: options.problem, metric,
    baseline: { value: 0, from: options.today, through: options.today },
    target: { value: Number(options.target), direction: options.direction },
    releasedOn: options.today, gradeOn: options['grade-on'],
    minSamples: Number(options['min-samples']), status: 'open', grade: null,
  };
  validateBet(bet, path);
  const snapshot = (await loadSnapshots(options.snapshots, options.today)).at(-1);
  const reading = measure(snapshot, metric, snapshot.date);
  if (reading.reason || reading.value === null) throw new Error(`baseline: ${reading.reason ?? 'zero denominator; no measurable baseline'}`);
  bet.baseline = { value: reading.value, from: windowDates(snapshot.date, metric.windowDays)[0], through: snapshot.date };
  validateBet(bet, path);
  await mkdir(options.bets, { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(bet, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${path}: id already exists; choose a new id`);
    throw error;
  }
  return bet;
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await newBet(newBetOptions()), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
