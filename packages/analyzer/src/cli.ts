#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { discoverProjects, indexProject } from './index.js';

try {
  const { values, positionals } = parseArgs({
    options: { project: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [command, repository] = positionals;
  if (positionals.length !== 2 || !repository || !['discover', 'index'].includes(command ?? '') ||
      (command === 'discover' && values.project !== undefined)) {
    throw new Error('Usage: acip discover <repository> | acip index <repository> [--project <relative-tsconfig-path>]');
  }
  const result = command === 'discover' ? discoverProjects(repository) : indexProject(repository, values.project);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`acip: ${error instanceof Error ? error.message : 'Indexing failed'}\n`);
  process.exitCode = 1;
}
