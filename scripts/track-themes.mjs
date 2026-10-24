import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDate, isMain, readJSON } from './lib/analysis.mjs';
import { themeErrors } from './lib/contract.mjs';

export function trackOptions(args = process.argv.slice(2)) {
  const options = { root: '.' };
  while (args.length) {
    const flag = args.shift();
    if (['--root', '--date', '--values'].includes(flag) && args[0] && !args[0].startsWith('--')) options[flag.slice(2)] = args.shift();
    else throw new Error(`unknown or incomplete option: ${flag}`);
  }
  if (!isDate(options.date)) throw new Error('--date: expected a calendar date YYYY-MM-DD');
  if (!options.values) throw new Error('--values: expected a JSON file of {"<theme id>": {"value", "samples"}}');
  return options;
}

// Writes one history point per theme for date, replacing a point already on that date.
// Every open theme needs a value; every theme file is checked before any is written.
export async function trackThemes({ root, date, values }) {
  const directory = join(root, 'themes');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  const themes = await Promise.all(files.map((file) => readJSON(join(directory, file))));
  const ids = new Set(themes.map((theme) => theme.id));
  const problems = Object.keys(values).filter((id) => !ids.has(id)).map((id) => `values: ${id}: no themes/${id}.json`);
  const updated = themes.map((theme, i) => {
    const point = values[theme.id];
    if (point === undefined) {
      if (theme.status === 'open') problems.push(`values: missing open theme ${theme.id}`);
      return theme;
    }
    if (!theme.track) {
      problems.push(`themes/${files[i]}: track: missing; add the track block before tracking`);
      return theme;
    }
    const entry = { date, value: point?.value ?? null, samples: point?.samples };
    const history = [...theme.track.history.filter((item) => item.date !== date), entry].sort((a, b) => a.date.localeCompare(b.date));
    return { ...theme, track: { ...theme.track, history } };
  });
  updated.forEach((theme, i) => problems.push(...themeErrors(theme, files[i]).map((error) => `themes/${files[i]}: ${error}`)));
  if (problems.length) throw new Error(problems.join('\n'));
  const written = [];
  for (const [i, theme] of updated.entries()) {
    if (theme === themes[i]) continue;
    const path = join(directory, files[i]);
    const text = `${JSON.stringify(theme, null, 2)}\n`;
    if (await readFile(path, 'utf8') === text) continue;
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, text);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    written.push(files[i]);
  }
  return written;
}

if (isMain(import.meta.url)) {
  try {
    const options = trackOptions();
    const values = await readJSON(options.values);
    const written = await trackThemes({ ...options, values });
    console.log(written.length ? `Tracked ${options.date}: ${written.join(', ')}` : `Tracked ${options.date}: no change`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
