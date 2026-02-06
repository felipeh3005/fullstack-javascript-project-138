#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'module';
import pageLoader from '../src/index.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

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
        console.error(error.message);
        process.exitCode = 1;
      });
  });

program.parse(process.argv);
