import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';
import debug from 'debug';
import { createRequire } from 'module';
import { format } from 'node:util';
import {
  HttpError,
  NetworkError,
  FileSystemError,
} from './errors.js';

const debugLog = debug('page-loader');

const isDebugEnabled = () => {
  const envDebug = process.env.DEBUG || '';
  const isNamespaceEnabled = envDebug.includes('page-loader');
  const isRunningTestDebug = process.env.npm_lifecycle_event === 'test:debug';
  return isNamespaceEnabled || isRunningTestDebug;
};

const log = (...args) => {
  debugLog(...args);

  if (isDebugEnabled()) {
    process.stderr.write(`${format(...args)}\n`);
  }
};

const require = createRequire(import.meta.url);
const ListrModule = require('listr');
const Listr = ListrModule.default ?? ListrModule;

try {
  require('axios-debug-log/enable');
  log('axios debug logging enabled');
} catch (e) {
  log('axios debug logging not enabled');
}

const fetchOrThrow = (url, config = {}) => (
  axios.get(url, config)
    .then((res) => {
      if (res.status !== 200) {
        throw new HttpError(`HTTP ${res.status} when fetching ${url}`, {
          resourceUrl: url,
          status: res.status,
        });
      }
      return res;
    })
    .catch((err) => {
      if (err instanceof HttpError) throw err;

      if (err.response && err.response.status) {
        throw new HttpError(`HTTP ${err.response.status} when fetching ${url}`, {
          resourceUrl: url,
          status: err.response.status,
          cause: err,
        });
      }

      throw new NetworkError(`Network error when fetching ${url}`, {
        resourceUrl: url,
        cause: err,
      });
    })
);

const writeFileOrThrow = (filepath, data, encoding) => (
  fs.writeFile(filepath, data, encoding)
    .catch((err) => {
      throw new FileSystemError(`Cannot write file ${filepath}`, {
        filepath,
        cause: err,
      });
    })
);

const mkdirOrThrow = (dirpath) => (
  fs.mkdir(dirpath)
    .catch((err) => {
      throw new FileSystemError(`Cannot create directory ${dirpath}`, {
        filepath: dirpath,
        cause: err,
      });
    })
);

const sanitize = (value) => value.replace(/[^a-zA-Z0-9]/g, '-');

const makeHtmlFilenameFromUrl = (pageUrl) => {
  const { host, pathname } = new URL(pageUrl);
  return `${sanitize(`${host}${pathname}`)}.html`;
};

const makeFilesDirnameFromUrl = (pageUrl) => (
  makeHtmlFilenameFromUrl(pageUrl).replace(/\.html$/, '_files')
);

const makeResourceFilename = (pageUrl, resourceUrlOrRef) => {
  const { host } = new URL(pageUrl);

  const resolved = new URL(resourceUrlOrRef, pageUrl);
  const cleanPathname = resolved.pathname;

  const extFromPath = path.extname(cleanPathname);
  const ext = extFromPath === '' ? '.html' : extFromPath;

  const withoutExt = extFromPath === ''
    ? cleanPathname
    : cleanPathname.slice(0, -extFromPath.length);

  const raw = `${host}${withoutExt}`;
  return `${sanitize(raw)}${ext}`;
};

const isLocalResource = (pageUrl, ref) => {
  if (!ref) return false;

  const resolved = new URL(ref, pageUrl);
  if (resolved.protocol === 'data:') return false;

  const pageHost = new URL(pageUrl).host;
  return resolved.host === pageHost;
};

const toAbsoluteResourceUrl = (pageUrl, ref) => new URL(ref, pageUrl).toString();

const downloadAndSave = (resourceUrl, destinationPath) => (
  fetchOrThrow(resourceUrl, { responseType: 'arraybuffer' })
    .then((res) => writeFileOrThrow(destinationPath, res.data))
);

const collectResources = (pageUrl, $) => {
  const resources = [];

  $('img[src]').each((_, el) => {
    const node = $(el);
    const src = node.attr('src');
    if (isLocalResource(pageUrl, src)) resources.push({ node, attr: 'src', ref: src });
  });

  $('script[src]').each((_, el) => {
    const node = $(el);
    const src = node.attr('src');
    if (isLocalResource(pageUrl, src)) resources.push({ node, attr: 'src', ref: src });
  });

  $('link[href]').each((_, el) => {
    const node = $(el);
    const href = node.attr('href');
    const rel = (node.attr('rel') || '').toLowerCase();

    const isStylesheet = rel === 'stylesheet';
    const isCanonical = rel === 'canonical';

    if ((isStylesheet || isCanonical) && isLocalResource(pageUrl, href)) {
      resources.push({ node, attr: 'href', ref: href });
    }
  });

  return resources;
};

const downloadResources = (resourceJobs, showProgress) => {
  if (!showProgress) {
    return Promise.all(resourceJobs.map((job) => job.run()));
  }

  const tasks = resourceJobs.map((job) => ({
    title: job.title,
    task: () => job.run(),
  }));

  return new Listr(tasks, {
    concurrent: true,
    renderer: 'verbose',
  }).run();
};

export default (pageUrl, outputDir = process.cwd(), options = {}) => {
  const showProgress = options.progress === true;

  const htmlFilename = makeHtmlFilenameFromUrl(pageUrl);
  const filesDirname = makeFilesDirnameFromUrl(pageUrl);

  const htmlPath = path.join(outputDir, htmlFilename);
  const filesDirPath = path.join(outputDir, filesDirname);
  const absoluteHtmlPath = path.resolve(htmlPath);

  log('start: url=%s outputDir=%s', pageUrl, outputDir);
  log('paths: html=%s filesDir=%s', htmlPath, filesDirPath);

  return fetchOrThrow(pageUrl)
    .then((response) => {
      log(
        'html downloaded: status=%d bytes=%d',
        response.status,
        String(response.data).length,
      );

      const html = response.data;
      const $ = cheerio.load(html);

      const resources = collectResources(pageUrl, $);
      log('local resources found: %d', resources.length);

      if (resources.length === 0) {
        log('no resources found: saving html only');
        return writeFileOrThrow(htmlPath, html, 'utf-8')
          .then(() => absoluteHtmlPath);
      }

      return mkdirOrThrow(filesDirPath)
        .then(() => {
          const resourceJobs = resources.map(({ node, attr, ref }) => {
            const absUrl = toAbsoluteResourceUrl(pageUrl, ref);
            const filename = makeResourceFilename(pageUrl, ref);
            const resourcePath = path.join(filesDirPath, filename);

            node.attr(attr, path.posix.join(filesDirname, filename));

            return {
              title: absUrl,
              run: () => downloadAndSave(absUrl, resourcePath),
            };
          });

          return downloadResources(resourceJobs, showProgress)
            .then(() => writeFileOrThrow(htmlPath, $.html(), 'utf-8'))
            .then(() => absoluteHtmlPath);
        });
    })
    .catch((err) => {
      log('error occurred: %O', err);
      throw err;
    });
};
