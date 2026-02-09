import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';

// --------------
// Naming helpers
// --------------

const sanitize = (value) => value.replace(/[^a-zA-Z0-9]/g, '-');

const makeHtmlFilenameFromUrl = (pageUrl) => {
  const { host, pathname } = new URL(pageUrl);
  return `${sanitize(`${host}${pathname}`)}.html`;
};

const makeFilesDirnameFromUrl = (pageUrl) => {
  const htmlName = makeHtmlFilenameFromUrl(pageUrl);
  return htmlName.replace(/\.html$/, '_files');
};

const makeResourceFilename = (pageUrl, resourcePath) => {
  // resourcePath puede ser "/assets/professions/nodejs.png"
  // Queremos: "codica-la-assets-professions-nodejs.png"
  const { host } = new URL(pageUrl);
  const ext = path.extname(resourcePath) || '';
  const withoutExt = resourcePath.replace(ext, '');
  const raw = `${host}${withoutExt}`; // "codica.la/assets/professions/nodejs"
  return `${sanitize(raw)}${ext}`;
};

const isLocalResource = (src) => {
  // local: empieza con "/" o es relativo (no tiene protocolo)
  // ignoramos "http://", "https://", "data:"
  return src
    && !src.startsWith('http://')
    && !src.startsWith('https://')
    && !src.startsWith('data:');
};

const toAbsoluteResourceUrl = (pageUrl, src) => new URL(src, pageUrl).toString();

// -------------------
// Main loader function
// -------------------

export default (pageUrl, outputDir = process.cwd()) => {
  const htmlFilename = makeHtmlFilenameFromUrl(pageUrl);
  const filesDirname = makeFilesDirnameFromUrl(pageUrl);

  const htmlPath = path.join(outputDir, htmlFilename);
  const filesDirPath = path.join(outputDir, filesDirname);
  const absoluteHtmlPath = path.resolve(htmlPath);

  // 1) bajar HTML
  return axios.get(pageUrl)
    .then((response) => {
      const html = response.data;

      // 2) parsear HTML
      const $ = cheerio.load(html);

      // 3) encontrar imágenes locales
      const imgElements = $('img[src]')
        .toArray()
        .map((el) => $(el))
        .filter((el) => isLocalResource(el.attr('src')));

      // si no hay imágenes locales, guardamos HTML tal cual
      if (imgElements.length === 0) {
        return fs.writeFile(htmlPath, html, 'utf-8').then(() => absoluteHtmlPath);
      }

      // 4) crear carpeta _files
      return fs.mkdir(filesDirPath, { recursive: true })
        .then(() => {
          // 5) descargar y guardar cada imagen (promesas en paralelo)
          const downloads = imgElements.map((img) => {
            const src = img.attr('src');

            const resourceUrl = toAbsoluteResourceUrl(pageUrl, src);
            const resourceFilename = makeResourceFilename(pageUrl, src);
            const resourcePath = path.join(filesDirPath, resourceFilename);

            // reescribe el src en el DOM a ruta local
            img.attr('src', path.posix.join(filesDirname, resourceFilename));

            // descarga binaria (arraybuffer) y guarda
            return axios.get(resourceUrl, { responseType: 'arraybuffer' })
              .then((res) => fs.writeFile(resourcePath, res.data));
          });

          return Promise.all(downloads)
            .then(() => {
              // 6) guardar HTML ya modificado
              const updatedHtml = $.html();
              return fs.writeFile(htmlPath, updatedHtml, 'utf-8');
            })
            .then(() => absoluteHtmlPath);
        });
    });
};
