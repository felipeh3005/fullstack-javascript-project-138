import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';

// Reemplaza todo lo que NO sea letra/número por '-'
const sanitize = (value) => value.replace(/[^a-zA-Z0-9]/g, '-');

// Nombre del HTML principal: host+pathname -> .html
const makeHtmlFilenameFromUrl = (pageUrl) => {
  const { host, pathname } = new URL(pageUrl);
  return `${sanitize(`${host}${pathname}`)}.html`;
};

// Nombre de carpeta de recursos: igual que el html pero con _files
const makeFilesDirnameFromUrl = (pageUrl) => makeHtmlFilenameFromUrl(pageUrl).replace(/\.html$/, '_files');

// Recurso -> filename: host + path(sin ext) sanitizado + ext
// Si el recurso NO tiene ext se usa .html
const makeResourceFilename = (pageUrl, resourcePath) => {
  const { host } = new URL(pageUrl);

  const extFromPath = path.extname(resourcePath);
  const ext = extFromPath === '' ? '.html' : extFromPath;

  const withoutExt = extFromPath === '' ? resourcePath : resourcePath.slice(0, -extFromPath.length);

  const raw = `${host}${withoutExt}`;
  return `${sanitize(raw)}${ext}`;
};

// local solo si:
// - NO tiene protocolo (http/https/data)
// - y el host resultante (resuelto contra la pageUrl) es el mismo host de la página
const isLocalResource = (pageUrl, ref) => {
  if (!ref) return false;
  if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:')) return false;

  const pageHost = new URL(pageUrl).host;
  const resolved = new URL(ref, pageUrl);
  return resolved.host === pageHost;
};

// Construye URL absoluta del recurso
const toAbsoluteResourceUrl = (pageUrl, ref) => new URL(ref, pageUrl).toString();

// Descarga binaria genérica (sirve para png/jpg/css/js/html de canonical)
const downloadAndSave = (resourceUrl, destinationPath) =>
  axios.get(resourceUrl, { responseType: 'arraybuffer' })
    .then((res) => fs.writeFile(destinationPath, res.data));

// Extrae recursos del DOM (img/link/script)
const collectResources = (pageUrl, $) => {
  const resources = [];

  // img[src]
  $('img[src]').each((_, el) => {
    const node = $(el);
    const src = node.attr('src');
    if (isLocalResource(pageUrl, src)) resources.push({ node, attr: 'src', ref: src });
  });

  // script[src]
  $('script[src]').each((_, el) => {
    const node = $(el);
    const src = node.attr('src');
    if (isLocalResource(pageUrl, src)) resources.push({ node, attr: 'src', ref: src });
  });

  // link[href] solo rel stylesheet o canonical
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

export default (pageUrl, outputDir = process.cwd()) => {
  const htmlFilename = makeHtmlFilenameFromUrl(pageUrl);
  const filesDirname = makeFilesDirnameFromUrl(pageUrl);

  const htmlPath = path.join(outputDir, htmlFilename);
  const filesDirPath = path.join(outputDir, filesDirname);
  const absoluteHtmlPath = path.resolve(htmlPath);

  // 1) bajar HTML principal (texto)
  return axios.get(pageUrl)
    .then((response) => {
      const html = response.data;
      const $ = cheerio.load(html);

      // 2) detectar recursos locales
      const resources = collectResources(pageUrl, $);

      // Si no hay recursos, html tal cual
      if (resources.length === 0) {
        return fs.writeFile(htmlPath, html, 'utf-8').then(() => absoluteHtmlPath);
      }

      // 3) crear carpeta _files
      return fs.mkdir(filesDirPath, { recursive: true })
        .then(() => {
          // 4) descargar recursos en paralelo + reescribir html
          const tasks = resources.map(({ node, attr, ref }) => {
            const absUrl = toAbsoluteResourceUrl(pageUrl, ref);
            const filename = makeResourceFilename(pageUrl, ref);
            const resourcePath = path.join(filesDirPath, filename);

            // Reescribe el atributo en el DOM a ruta local (siempre con '/')
            node.attr(attr, path.posix.join(filesDirname, filename));

            return downloadAndSave(absUrl, resourcePath);
          });

          return Promise.all(tasks)
            .then(() => fs.writeFile(htmlPath, $.html(), 'utf-8'))
            .then(() => absoluteHtmlPath);
        });
    });
};
