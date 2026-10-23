import { readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SERIES, addDays, cliOptions, finiteCount, isDate, isMain, loadSnapshots, measure, readJSON } from './lib/analysis.mjs';

export function validateBet(bet, file) {
  const require = (condition, field, message) => {
    if (!condition) throw new Error(`${file}: ${field}: ${message}`);
  };
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  require(object(bet), 'bet', 'expected an object');
  for (const field of ['id', 'title', 'problem']) require(typeof bet[field] === 'string' && bet[field].trim().length > 0, field, 'expected nonempty text');
  require(/^[a-z0-9][a-z0-9-]*$/.test(bet.id) && basename(file) === `${bet.id}.json`, 'id', 'use a lowercase slug matching the filename');
  require(object(bet.metric), 'metric', 'expected an object');
  require(SERIES.includes(bet.metric.numerator), 'metric.numerator', 'expected a known series');
  require(bet.metric.denominator === undefined || SERIES.includes(bet.metric.denominator), 'metric.denominator', 'expected a known series');
  require(Number.isInteger(bet.metric.windowDays) && bet.metric.windowDays > 0 && bet.metric.windowDays <= 90, 'metric.windowDays', 'expected an integer from 1 to 90');
  require(object(bet.baseline), 'baseline', 'expected an object');
  require(finiteCount(bet.baseline.value), 'baseline.value', 'expected a finite nonnegative number');
  for (const field of ['from', 'through']) require(isDate(bet.baseline[field]), `baseline.${field}`, 'expected a calendar date YYYY-MM-DD');
  require(bet.baseline.from <= bet.baseline.through, 'baseline.through', 'must be on or after baseline.from');
  require(object(bet.target), 'target', 'expected an object');
  require(finiteCount(bet.target.value), 'target.value', 'expected a finite nonnegative number');
  require(['up', 'down'].includes(bet.target.direction), 'target.direction', 'expected up or down');
  require(bet.releasedOn === null || isDate(bet.releasedOn), 'releasedOn', 'expected a calendar date or null');
  require(isDate(bet.gradeOn), 'gradeOn', 'expected a calendar date YYYY-MM-DD');
  require(bet.releasedOn === null || bet.releasedOn <= bet.gradeOn, 'gradeOn', 'must be on or after releasedOn');
  require(finiteCount(bet.minSamples), 'minSamples', 'expected a finite nonnegative number');
  require(['open', 'hit', 'miss', 'unclear'].includes(bet.status), 'status', 'expected open, hit, miss or unclear');
  for (const field of ['extensionUsed', 'retryPending']) require(bet[field] === undefined || typeof bet[field] === 'boolean', field, 'expected a boolean');
  require(!bet.retryPending || (bet.status === 'unclear' && bet.extensionUsed === true), 'retryPending', 'requires unclear status and extensionUsed');
  require(bet.status !== 'open' || (!bet.extensionUsed && !bet.retryPending), 'status', 'an extended bet must have an unclear grade');
  if (bet.status === 'open') require(bet.grade === null, 'grade', 'must be null until graded');
  else {
    require(object(bet.grade), 'grade', 'expected a grade object');
    require(bet.grade.value === null || finiteCount(bet.grade.value), 'grade.value', 'expected a finite nonnegative number or null');
    require(finiteCount(bet.grade.samples), 'grade.samples', 'expected a finite nonnegative number');
    require(typeof bet.grade.snapshot === 'string' && /^\d{4}-\d{2}-\d{2}\.json$/.test(bet.grade.snapshot) && isDate(bet.grade.snapshot.slice(0, -5)), 'grade.snapshot', 'expected a dated snapshot filename');
    require(isDate(bet.grade.gradedOn), 'grade.gradedOn', 'expected a calendar date YYYY-MM-DD');
    require(bet.status === 'unclear' || bet.grade.value !== null, 'grade.value', 'a hit or miss needs a measured value');
  }
  return bet;
}

export function gradeBet(bet, snapshot, today) {
  if (bet.status !== 'open' && !(bet.status === 'unclear' && bet.retryPending)) {
    return { bet, result: { id: bet.id, status: bet.status, target: bet.target, ...bet.grade, gradeOn: bet.gradeOn, retryPending: false }, changed: false };
  }
  const due = bet.gradeOn <= today;
  const through = due ? bet.gradeOn : today;
  const reading = measure(snapshot, bet.metric, through);
  const result = {
    id: bet.id, status: bet.status, target: bet.target, ...reading,
    snapshot: snapshot.file, gradeOn: bet.gradeOn,
    daysLeft: Math.max(0, Math.round((Date.parse(bet.gradeOn) - Date.parse(today)) / 86400000)),
    retryPending: bet.retryPending ?? false,
  };
  if (!due || reading.reason) return { bet, result, changed: false };
  const unclear = reading.value === null || reading.samples < bet.minSamples;
  const status = unclear ? 'unclear' : ((bet.target.direction === 'up' ? reading.value >= bet.target.value : reading.value <= bet.target.value) ? 'hit' : 'miss');
  const extend = unclear && !bet.extensionUsed;
  const updated = {
    ...bet, status,
    gradeOn: extend ? addDays(bet.gradeOn, 7) : bet.gradeOn,
    extensionUsed: Boolean(bet.extensionUsed || extend), retryPending: extend,
    grade: { value: reading.value, samples: reading.samples, snapshot: snapshot.file, gradedOn: today },
  };
  return {
    bet: updated, changed: true,
    result: { ...result, status, gradeOn: updated.gradeOn,
      daysLeft: Math.max(0, Math.round((Date.parse(updated.gradeOn) - Date.parse(today)) / 86400000)),
      evaluatedThrough: through, gradedOn: today, retryPending: extend,
      reason: unclear ? (reading.value === null ? 'zero denominator' : 'below minSamples') : null },
  };
}

export async function gradeBets({ bets, snapshots, today, write = false }) {
  const files = (await readdir(bets)).filter((file) => file.endsWith('.json')).sort();
  // Validate the whole set before any writes so a malformed file cannot cause a partial run.
  const entries = await Promise.all(files.map(async (file) => {
    const path = join(bets, file);
    return { path, bet: validateBet(await readJSON(path), path) };
  }));
  const snapshot = (await loadSnapshots(snapshots, today)).at(-1);
  const grades = entries.map(({ bet }) => gradeBet(bet, snapshot, today));
  if (write) {
    for (const [index, grade] of grades.entries()) {
      if (grade.changed) await writeFile(entries[index].path, `${JSON.stringify(grade.bet, null, 2)}\n`);
    }
  }
  return { today, snapshot: snapshot.file, write, bets: grades.map((grade) => grade.result) };
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await gradeBets(cliOptions({ write: true })), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
