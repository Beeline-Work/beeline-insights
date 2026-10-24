import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimentErrors, registerErrors, snapshotSeries } from './lib/contract.mjs';
import { cliOptions, isMain, loadSnapshots, measure, readJSON } from './lib/analysis.mjs';

const days = (from, through) => Math.round((Date.parse(through) - Date.parse(from)) / 86400000) + 1;

// Measures a running snapshot-series experiment from its start; concludes at decideAt.
export function gradeExperiment(experiment, snapshot, today) {
  const e = experiment;
  const result = { id: e.id, status: e.status };
  if (e.status !== 'running') return { experiment: e, result, changed: false };
  if (!snapshotSeries(e.metric)) return { experiment: e, result: { ...result, reason: 'agent-written metric' }, changed: false };
  const through = today < e.decideAt.date ? today : e.decideAt.date;
  if (through < e.startedOn) return { experiment: e, result: { ...result, reason: 'not started' }, changed: false };
  const metric = { numerator: e.metric.numerator, ...(e.metric.denominator ? { denominator: e.metric.denominator } : {}), windowDays: days(e.startedOn, through) };
  const reading = measure(snapshot, metric, through);
  if (reading.reason) return { experiment: e, result: { ...result, ...reading, snapshot: snapshot.file }, changed: false };
  const progress = { value: reading.value, samples: reading.samples, asOf: through };
  const due = reading.samples >= e.decideAt.samples || today >= e.decideAt.date;
  let updated = { ...e, progress };
  if (due) {
    const enough = reading.value !== null && reading.samples >= e.decideAt.samples;
    const met = enough && (e.predict.direction === 'up' ? reading.value >= e.predict.value : reading.value <= e.predict.value);
    const verdict = enough
      ? { result: met ? 'supported' : 'not_supported', decision: met ? 'keep' : 'undo', value: reading.value, samples: reading.samples, on: today }
      : { result: 'not_enough_data', decision: e.ifUnclear, value: reading.value, samples: reading.samples, on: today };
    updated = { ...updated, status: 'concluded', verdict };
  }
  const changed = JSON.stringify(updated) !== JSON.stringify(e);
  return { experiment: updated, changed, result: { ...result, status: updated.status, ...progress, snapshot: snapshot.file, verdict: updated.verdict } };
}

export async function gradeExperiments({ experiments, snapshots, today, write = false }) {
  const files = (await readdir(experiments)).filter((file) => file.endsWith('.json')).sort();
  // Validate the whole set before any write so one bad file cannot cause a partial run.
  const entries = await Promise.all(files.map(async (file) => {
    const path = join(experiments, file);
    const experiment = await readJSON(path);
    const errors = experimentErrors(experiment, file);
    if (errors.length) throw new Error(`${path}: ${errors[0]}`);
    return { path, experiment };
  }));
  const register = registerErrors(entries.map(({ experiment }) => experiment));
  if (register.length) throw new Error(register.join('\n'));
  const snapshot = (await loadSnapshots(snapshots, today)).at(-1);
  const grades = entries.map(({ experiment }) => gradeExperiment(experiment, snapshot, today));
  for (const grade of grades) {
    const errors = experimentErrors(grade.experiment);
    if (errors.length) throw new Error(`${grade.experiment.id}: ${errors[0]}`);
  }
  if (write) {
    for (const [index, grade] of grades.entries()) {
      if (grade.changed) await writeFile(entries[index].path, `${JSON.stringify(grade.experiment, null, 2)}\n`);
    }
  }
  return { today, snapshot: snapshot.file, write, experiments: grades.map((grade) => grade.result) };
}

if (isMain(import.meta.url)) {
  try {
    console.log(JSON.stringify(await gradeExperiments(cliOptions({ write: true })), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
