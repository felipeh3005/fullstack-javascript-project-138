import axios from 'axios'; // HTTP client para descargar HTML y recursos
import fs from 'fs/promises'; // API async de filesystem
import path from 'path'; // utilidades de paths (Windows/Linux)
import * as cheerio from 'cheerio'; // parser HTML tipo jQuery
import debug from 'debug'; // logger por namespaces
import { createRequire } from 'module'; // para require() en ESM
import { format } from 'node:util'; // formateo tipo printf para logs
import { HttpError, NetworkError, FileSystemError } from './errors.js'; // errores tipados del proyecto

const debugLog = debug('page-loader'); // namespace principal de debug

const isDebugEnabled = () => {
  const envDebug = process.env.DEBUG || ''; // lee DEBUG (puede venir vacío)
  const isNamespaceEnabled = envDebug.includes('page-loader'); // activa si DEBUG incluye page-loader
  const isRunningTestDebug = process.env.npm_lifecycle_event === 'test:debug'; // atajo para npm run test:debug
  return isNamespaceEnabled || isRunningTestDebug; // true si cualquiera aplica
};

// Logger visible: SOLO imprime si DEBUG incluye "page-loader" o en npm run test:debug
const log = (...args) => {
  debugLog(...args); // manda al sistema debug (si está habilitado)

  if (isDebugEnabled()) { // si está habilitado el modo visible
    process.stderr.write(`${format(...args)}\n`); // escribe a STDERR para no contaminar STDOUT
  }
};

// axios-debug-log es CommonJS -> createRequire
const require = createRequire(import.meta.url); // habilita require() en este módulo ESM

// listr es CommonJS -> createRequire
const ListrModule = require('listr'); // carga listr desde CommonJS
const Listr = ListrModule.default ?? ListrModule; // soporta export default o module.exports

try {
  require('axios-debug-log/enable'); // hookea axios para logs (si está instalado)
  log('axios debug logging enabled'); // log visible si aplica
} catch (e) {
  log('axios debug logging not enabled'); // no rompe el programa si falta
}

// Wrapper HTTP:
// - Si status != 200 => HttpError (con resourceUrl y status)
// - Si falla la red (sin response) => NetworkError
// Nota: seguimos con promesas, nada de async/await.
const fetchOrThrow = (url, config = {}) =>
  axios.get(url, config) // hace GET con axios
    .then((res) => { // si axios respondió
      if (res.status !== 200) { // si no es 200
        throw new HttpError(`HTTP ${res.status} when fetching ${url}`, { // lanza error tipado
          resourceUrl: url, // url que falló
          status: res.status, // status devuelto
        });
      }
      return res; // status 200 => devuelve la respuesta
    })
    .catch((err) => { // axios falló
      if (err instanceof HttpError) throw err; // si ya es HttpError, se propaga

      if (err.response && err.response.status) { // axios con response (404/500/etc)
        throw new HttpError(`HTTP ${err.response.status} when fetching ${url}`, { // error HTTP tipado
          resourceUrl: url, // url que falló
          status: err.response.status, // status recibido
          cause: err, // causa original
        });
      }

      throw new NetworkError(`Network error when fetching ${url}`, { // error de red (sin response)
        resourceUrl: url, // url que falló
        cause: err, // causa original (ENOTFOUND/ECONNREFUSED/etc)
      });
    });

// Wrapper FS: writeFile con error amigable y con el path que falló
const writeFileOrThrow = (filepath, data, encoding) =>
  fs.writeFile(filepath, data, encoding) // intenta escribir el archivo
    .catch((err) => { // si falla
      throw new FileSystemError(`Cannot write file ${filepath}`, { // error tipado de FS
        filepath, // ruta que falló
        cause: err, // causa original (ENOENT/EACCES/etc)
      });
    });

// - Si outputDir no existe => esto debe fallar
// - *_files dentro de un outputDir ya existente.
const mkdirOrThrow = (dirpath) =>
  fs.mkdir(dirpath) // crea SOLO el último nivel
    .catch((err) => { // si falla
      throw new FileSystemError(`Cannot create directory ${dirpath}`, { // error tipado de FS
        filepath: dirpath, // reutilizamos 'filepath' para compatibilidad
        cause: err, // causa original
      });
    });

// Reemplaza todo lo que NO sea letra/número por '-'
const sanitize = (value) => value.replace(/[^a-zA-Z0-9]/g, '-');

// Nombre del HTML principal: host+pathname -> .html
const makeHtmlFilenameFromUrl = (pageUrl) => {
  const { host, pathname } = new URL(pageUrl); // parsea host y pathname
  return `${sanitize(`${host}${pathname}`)}.html`; // genera nombre final
};

// Nombre de carpeta de recursos: igual que el html pero con _files
const makeFilesDirnameFromUrl = (pageUrl) =>
  makeHtmlFilenameFromUrl(pageUrl).replace(/\.html$/, '_files'); // reemplaza extensión por _files

// Recurso -> filename: host + path(sin ext) sanitizado + ext
// Si el recurso NO tiene ext se usa .html
const makeResourceFilename = (pageUrl, resourceUrlOrRef) => {
  const { host } = new URL(pageUrl); // host base de la página

  // (Windows): si viene con ?query o #hash, NO puede ir al nombre del archivo.
  const resolved = new URL(resourceUrlOrRef, pageUrl); // resuelve relativo/absoluto
  const cleanPathname = resolved.pathname; // SOLO pathname, sin ?query ni #hash

  const extFromPath = path.extname(cleanPathname); // extrae extensión desde pathname limpio
  const ext = extFromPath === '' ? '.html' : extFromPath; // si no hay extensión => .html

  const withoutExt = extFromPath === ''
    ? cleanPathname // sin extensión, usamos pathname tal cual
    : cleanPathname.slice(0, -extFromPath.length); // quitamos la extensión si existe

  const raw = `${host}${withoutExt}`; // construimos base: host + path
  return `${sanitize(raw)}${ext}`; // sanitizamos y pegamos la extensión
};

// local solo si:
// - NO es data:
// - y el host resultante (resuelto contra la pageUrl) es el mismo host de la página
const isLocalResource = (pageUrl, ref) => {
  if (!ref) return false; // sin valor, no hay recurso
  const resolved = new URL(ref, pageUrl); // resuelve el ref (relativo o absoluto)
  if (resolved.protocol === 'data:') return false; // data: nunca se descarga

  const pageHost = new URL(pageUrl).host; // host de la página
  return resolved.host === pageHost; // local si el host coincide exactamente
};

// Construye URL absoluta del recurso
const toAbsoluteResourceUrl = (pageUrl, ref) => new URL(ref, pageUrl).toString(); // normaliza a string absoluta

// Descarga binaria genérica (sirve para png/jpg/css/js/html de canonical)
const downloadAndSave = (resourceUrl, destinationPath) =>
  fetchOrThrow(resourceUrl, { responseType: 'arraybuffer' }) // arraybuffer evita corrupción de binarios
    .then((res) => writeFileOrThrow(destinationPath, res.data)); // guarda el buffer en disco

// Extrae recursos del DOM (img/link/script)
const collectResources = (pageUrl, $) => {
  const resources = []; // lista de trabajos a descargar

  // img[src]
  $('img[src]').each((_, el) => {
    const node = $(el); // envuelve el elemento
    const src = node.attr('src'); // toma src
    if (isLocalResource(pageUrl, src)) resources.push({ node, attr: 'src', ref: src }); // agrega si es local
  });

  // script[src]
  $('script[src]').each((_, el) => {
    const node = $(el); // envuelve el elemento
    const src = node.attr('src'); // toma src
    if (isLocalResource(pageUrl, src)) resources.push({ node, attr: 'src', ref: src }); // agrega si es local
  });

  // link[href] solo rel stylesheet o canonical
  $('link[href]').each((_, el) => {
    const node = $(el); // envuelve el elemento
    const href = node.attr('href'); // toma href
    const rel = (node.attr('rel') || '').toLowerCase(); // toma rel en minúsculas

    const isStylesheet = rel === 'stylesheet'; // detecta CSS
    const isCanonical = rel === 'canonical'; // detecta canonical

    if ((isStylesheet || isCanonical) && isLocalResource(pageUrl, href)) { // filtra por tipo y local
      resources.push({ node, attr: 'href', ref: href }); // agrega si aplica
    }
  });

  return resources; // devuelve la lista
};

// Ejecuta descargas de recursos:
// - Con progreso: Listr concurrent (verbose)
// - Sin progreso: Promise.all (igual concurrent)
const downloadResources = (resourceJobs, showProgress) => {
  if (!showProgress) { // si no queremos UI
    return Promise.all(resourceJobs.map((job) => job.run())); // descarga todo en paralelo sin spinners
  }

  const tasks = resourceJobs.map((job) => ({
    title: job.title, // se muestra en la UI
    task: () => job.run(), // función que ejecuta la descarga
  }));

  return new Listr(tasks, { // crea lista de tareas con Listr
    concurrent: true, // paralelo
    renderer: 'verbose', // modo visible (líneas start/completed)
  }).run(); // ejecuta
};

export default (pageUrl, outputDir = process.cwd(), options = {}) => {
  // CLAVE: la librería por defecto NO muestra progreso.
  // El CLI es el que decide pasar { progress: true/false }.
  const showProgress = options.progress === true; // solo true explícito activa Listr

  const htmlFilename = makeHtmlFilenameFromUrl(pageUrl); // nombre de html principal
  const filesDirname = makeFilesDirnameFromUrl(pageUrl); // nombre de carpeta _files

  const htmlPath = path.join(outputDir, htmlFilename); // path destino del html
  const filesDirPath = path.join(outputDir, filesDirname); // path destino de la carpeta
  const absoluteHtmlPath = path.resolve(htmlPath); // path absoluto para retorno final

  log('start: url=%s outputDir=%s', pageUrl, outputDir); // log inicio
  log('paths: html=%s filesDir=%s', htmlPath, filesDirPath); // log rutas

  return fetchOrThrow(pageUrl) // descarga HTML principal
    .then((response) => {
      log('html downloaded: status=%d bytes=%d', response.status, String(response.data).length); // log HTML

      const html = response.data; // contenido HTML
      const $ = cheerio.load(html); // parsea HTML

      const resources = collectResources(pageUrl, $); // detecta recursos locales
      log('local resources found: %d', resources.length); // log cantidad

      if (resources.length === 0) { // si no hay recursos
        log('no resources found: saving html only'); // log camino corto
        return writeFileOrThrow(htmlPath, html, 'utf-8') // guarda HTML principal
          .then(() => {
            log('saved html: %s', absoluteHtmlPath); // log guardado
            return absoluteHtmlPath; // devuelve path final
          });
      }

      return mkdirOrThrow(filesDirPath) // crea carpeta _files (fallará si outputDir no existe)
        .then(() => {
          log('created files dir: %s', filesDirPath); // log carpeta creada

          const resourceJobs = resources.map(({ node, attr, ref }) => { // crea jobs por recurso
            const absUrl = toAbsoluteResourceUrl(pageUrl, ref); // URL absoluta
            const filename = makeResourceFilename(pageUrl, ref); // nombre seguro (sin ? ni #)
            const resourcePath = path.join(filesDirPath, filename); // destino en disco

            log('download resource: %s -> %s', absUrl, resourcePath); // log por recurso

            node.attr(attr, path.posix.join(filesDirname, filename)); // reescribe el HTML con path tipo URL

            return { // job final para downloader
              title: absUrl, // título visible en listr
              run: () => downloadAndSave(absUrl, resourcePath), // descarga + guarda
            };
          });

          return downloadResources(resourceJobs, showProgress) // descarga con o sin progreso (ambos concurrentes)
            .then(() => {
              log('all resources downloaded: %d', resourceJobs.length); // log final recursos
              return writeFileOrThrow(htmlPath, $.html(), 'utf-8'); // guarda HTML reescrito
            })
            .then(() => {
              log('saved final html: %s', absoluteHtmlPath); // log final
              return absoluteHtmlPath; // devuelve resultado
            });
        });
    })
    .catch((err) => {
      log('error occurred: %O', err); // log error completo si debug habilitado
      throw err; // siempre re-lanzamos para que el CLI decida cómo imprimir/salir
    });
};
