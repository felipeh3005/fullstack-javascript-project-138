#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'module';
import pageLoader from '../src/index.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

const formatCliError = (error) => {
  const resource = error.resourceUrl || error.filepath || 'unknown resource';

  if (error.name === 'HttpError') {
    const status = error.status || (error.cause && error.cause.response && error.cause.response.status);
    return `Error: HTTP ${status ?? 'unknown'} while fetching ${resource}`;
  }

  if (error.name === 'NetworkError') {
    const code = error.cause && error.cause.code ? ` (${error.cause.code})` : '';
    return `Error: Network problem while fetching ${resource}${code}`;
  }

  if (error.name === 'FileSystemError') {
    const code = error.cause && error.cause.code ? ` (${error.cause.code})` : '';
    return `Error: File system problem: ${error.message}${code}`;
  }

  return `Error: ${error.message}`;
};

program
  .name('page-loader')
  .description('Page loader utility')
  .version(version)
  .argument('<url>')
  .option('-o, --output [dir]', 'output dir', process.cwd())
  // 👇 esto SÍ funciona siempre en commander: crea options.progress = false si lo pasas
  .option('--no-progress', 'disable download progress')
  .action((url, options) => {
    pageLoader(url, options.output, { progress: options.progress })
      .then((filepath) => {
        console.log(filepath);
      })
      .catch((error) => {
        console.error(formatCliError(error));
        process.exitCode = 1;
      });
  });

program.parse(process.argv);
