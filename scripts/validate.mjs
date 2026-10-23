import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { feedOptions, planFeed } from './build-feed.mjs';
import { isMain } from './lib/analysis.mjs';
import { schemaErrors } from './lib/contract.mjs';

// Every input must match its schema, and every built file must match a fresh build.
export async function validate({ root, today }) {
  const plan = await planFeed({ root, today });
  const problems = [...plan.problems];
  for (const [file, text] of plan.files) {
    const expected = JSON.parse(text);
    let actual;
    try {
      actual = JSON.parse(await readFile(join(root, file), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (file === 'insights/latest.json') {
      if (JSON.stringify(actual?.journey) !== JSON.stringify(expected.journey)) {
        problems.push(`${file}: journey: differs from the newest snapshot; run npm run build-feed`);
      }
      continue;
    }
    if (file === 'digests/index.json' && actual !== undefined) {
      // Check the saved index itself before comparing it with a fresh build.
      const errors = Array.isArray(actual)
        ? actual.flatMap((entry, i) => schemaErrors(entry, 'digest.schema.json').map((error) => `[${i}].${error}`))
        : ['(root): expected array'];
      if (errors.length) {
        problems.push(...errors.map((error) => `${file}: ${error}`));
        continue;
      }
    }
    if (file === 'feed/latest.json' && actual) {
      // Check the saved file itself before ignoring its timestamp for the freshness comparison.
      const errors = schemaErrors(actual, 'feed.schema.json');
      if (errors.length) {
        problems.push(...errors.map((error) => `${file}: ${error}`));
        continue;
      }
      actual = { ...actual, generatedAt: expected.generatedAt };
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${file}: missing or stale; run npm run build-feed`);
  }
  return problems;
}

if (isMain(import.meta.url)) {
  try {
    const problems = await validate(feedOptions());
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else console.log('All insights, experiments, reach, digest and feed files are valid.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
