#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'module';
import pageLoader from '../src/index.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

// Formatea un error de la librería en un mensaje entendible.
const formatCliError = (error) => {
  // Donde ocurrió el problema (URL o path)
  const resource = error.resourceUrl || error.filepath || 'unknown resource';

  // Los errores en la librería tienen name: HttpError/NetworkError/FileSystemError
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
  .action((url, options) => {
    pageLoader(url, options.output)
      .then((filepath) => {
        console.log(filepath);
      })
      .catch((error) => {
        console.error(formatCliError(error));

        process.exitCode = 1;
      });
  });

program.parse(process.argv);