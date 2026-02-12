import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';
import debug from 'debug';
import { createRequire } from 'module';
import { format } from 'node:util';
import { HttpError, NetworkError, FileSystemError } from './errors.js';

const debugLog = debug('page-loader');

const isDebugEnabled = () => {
  const envDebug = process.env.DEBUG || '';
  const isNamespaceEnabled = envDebug.includes('page-loader');
  const isRunningTestDebug = process.env.npm_lifecycle_event === 'test:debug';
  return isNamespaceEnabled || isRunningTestDebug;
};

// Logger visible: SOLO imprime si DEBUG incluye "page-loader" o en npm run test:debug
const log = (...args) => {
  debugLog(...args);

  if (isDebugEnabled()) {
    process.stderr.write(`${format(...args)}\n`);
  }
};

// axios-debug-log es CommonJS -> createRequire
const require = createRequire(import.meta.url);
try {
  require('axios-debug-log/enable');
  // Log para confirmar que el plugin de axios quedó habilitado (visible en test:debug)
  log('axios debug logging enabled');
} catch (e) {
  // Si no existe el paquete o falla su carga, no se rompe la app: solo se reporta en debug
  log('axios debug logging not enabled');
};

// Wrapper HTTP:
// - Si status != 200 => HttpError (con resourceUrl y status)
// - Si falla la red (sin response) => NetworkError
// Nota: seguimos con promesas, nada de async/await.
const fetchOrThrow = (url, config = {}) =>
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
      // Si ya es HttpError, lo dejamos pasar
      if (err instanceof HttpError) throw err;

      // axios: err.response existe cuando hay respuesta HTTP (por ejemplo 404, 500, etc.)
      if (err.response && err.response.status) {
        throw new HttpError(`HTTP ${err.response.status} when fetching ${url}`, {
          resourceUrl: url,
          status: err.response.status,
          cause: err,
        });
      }

      // Error de red (sin response): DNS, ECONNREFUSED, timeout, etc.
      throw new NetworkError(`Network error when fetching ${url}`, {
        resourceUrl: url,
        cause: err,
      });
    });

// Wrapper FS: writeFile con error amigable y con el path que falló
const writeFileOrThrow = (filepath, data, encoding) =>
  fs.writeFile(filepath, data, encoding)
    .catch((err) => {
      throw new FileSystemError(`Cannot write file ${filepath}`, { filepath, cause: err });
    });

// Wrapper FS: mkdir con error amigable y con el path que falló
const mkdirOrThrow = (dirpath) =>
  fs.mkdir(dirpath, { recursive: true })
    .catch((err) => {
      throw new FileSystemError(`Cannot create directory ${dirpath}`, { filepath: dirpath, cause: err });
    });

// Reemplaza todo lo que NO sea letra/número por '-'
const sanitize = (value) => value.replace(/[^a-zA-Z0-9]/g, '-');

// Nombre del HTML principal: host+pathname -> .html
const makeHtmlFilenameFromUrl = (pageUrl) => {
  const { host, pathname } = new URL(pageUrl);
  return `${sanitize(`${host}${pathname}`)}.html`;
};

// Nombre de carpeta de recursos: igual que el html pero con _files
const makeFilesDirnameFromUrl = (pageUrl) =>
  makeHtmlFilenameFromUrl(pageUrl).replace(/\.html$/, '_files');

// Recurso -> filename: host + path(sin ext) sanitizado + ext
// Si el recurso NO tiene ext se usa .html
const makeResourceFilename = (pageUrl, resourcePath) => {
  const { host } = new URL(pageUrl);

  const extFromPath = path.extname(resourcePath);
  const ext = extFromPath === '' ? '.html' : extFromPath;

  const withoutExt = extFromPath === ''
    ? resourcePath
    : resourcePath.slice(0, -extFromPath.length);

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
  // responseType arraybuffer: evita que axios intente interpretar binarios como texto y los corrompa
  fetchOrThrow(resourceUrl, { responseType: 'arraybuffer' })
    .then((res) => writeFileOrThrow(destinationPath, res.data));

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

  // Log de inicio: depura qué se está descargando y hacia dónde
  log('start: url=%s outputDir=%s', pageUrl, outputDir);
  // Log de rutas calculadas: para detectar errores de naming o paths en Windows
  log('paths: html=%s filesDir=%s', htmlPath, filesDirPath);

  // 1) bajar HTML principal (texto)
  return fetchOrThrow(pageUrl)
    .then((response) => {
      // Log de respuesta HTML: status y tamaño aproximado (no imprime el HTML completo)
      log('html downloaded: status=%d bytes=%d', response.status, String(response.data).length);

      const html = response.data;
      const $ = cheerio.load(html);

      // 2) detectar recursos locales
      const resources = collectResources(pageUrl, $);

      // Log de conteo de recursos: dice si el selector/criterio "local" está filtrando de más
      log('local resources found: %d', resources.length);

      // Si no hay recursos, html tal cual
      if (resources.length === 0) {
        // Log para dejar claro que se ejecutó el camino "solo HTML"
        log('no resources found: saving html only');
        return writeFileOrThrow(htmlPath, html, 'utf-8')
          .then(() => {
            // Log de confirmación de guardado (ruta absoluta es lo que devuelve la función)
            log('saved html: %s', absoluteHtmlPath);
            return absoluteHtmlPath;
          });
      }

      // 3) crear carpeta _files
      return mkdirOrThrow(filesDirPath)
        .then(() => {
          // Log de creación de directorio: si falla por permisos/ruta
          log('created files dir: %s', filesDirPath);

          // 4) descargar recursos en paralelo + reescribir HTML
          const tasks = resources.map(({ node, attr, ref }) => {
            const absUrl = toAbsoluteResourceUrl(pageUrl, ref);
            const filename = makeResourceFilename(pageUrl, ref);
            const resourcePath = path.join(filesDirPath, filename);

            // Log por recurso: muestra qué URL se descarga y dónde se guarda
            log('download resource: %s -> %s', absUrl, resourcePath);

            // Reescribe el atributo en el DOM a ruta local (siempre con '/')
            // path.posix.join fuerza '/' incluso en Windows, porque dentro del HTML son rutas tipo URL
            node.attr(attr, path.posix.join(filesDirname, filename));

            return downloadAndSave(absUrl, resourcePath);
          });

          return Promise.all(tasks)
            .then(() => {
              // Log cuando todos los recursos terminaron (si se queda colgado, fue en descargas)
              log('all resources downloaded: %d', tasks.length);
              return writeFileOrThrow(htmlPath, $.html(), 'utf-8');
            })
            .then(() => {
              // Log final de éxito: el caller recibe esta ruta absoluta
              log('saved final html: %s', absoluteHtmlPath);
              return absoluteHtmlPath;
            });
        });
    })
    .catch((err) => {
      // Log completo del error: stack, mensaje y propiedades extra
      log('error occurred: %O', err);
      // error para que el caller (CLI/tests) lo maneje como corresponda
      throw err;
    });
};