import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import nock from 'nock';
import pageLoader from '../src/index.js';

const normalize = (str) => str.replace(/\s+/g, ' ').trim();

describe('pageLoader', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'page-loader-'));
  });

  test('downloads page, downloads local resources from img/link/script and rewrites html (step 3)', async () => {
    const url = 'https://codica.la/cursos';

    // Fixture HTML (entrada) con img + link + script + canonical
    const html = `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <title>Cursos de programación Codica</title>
    <link rel="stylesheet" media="all" href="https://cdn2.codica.la/assets/menu.css">
    <link rel="stylesheet" media="all" href="/assets/application.css">
    <link href="/cursos" rel="canonical">
  </head>
  <body>
    <img src="/assets/professions/nodejs.png" alt="Icono de la profesión de programador Node.js">
    <h3>
      <a href="/professions/nodejs">Programador Node.js</a>
    </h3>
    <script src="https://js.stripe.com/v3/"></script>
    <script src="/packs/js/runtime.js"></script>
  </body>
</html>`;

    // Binarios fake
    const imageBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG signature parcial
    const cssBinary = Buffer.from('body{background:#000}', 'utf-8');
    const jsBinary = Buffer.from('console.log("runtime")', 'utf-8');

    // - 1) HTML principal
    // - 2) link canonical (guardado como recurso HTML)
    const scope = nock('https://codica.la')
      .get('/cursos')
      .twice()
      .reply(200, html)
      .get('/assets/professions/nodejs.png')
      .reply(200, imageBinary, { 'Content-Type': 'image/png' })
      .get('/assets/application.css')
      .reply(200, cssBinary, { 'Content-Type': 'text/css' })
      .get('/packs/js/runtime.js')
      .reply(200, jsBinary, { 'Content-Type': 'application/javascript' });

    const resultPath = await pageLoader(url, tempDir);

    // HTML principal
    const expectedHtmlPath = path.join(tempDir, 'codica-la-cursos.html');
    expect(resultPath).toBe(path.resolve(expectedHtmlPath));

    // Carpeta _files
    const filesDir = path.join(tempDir, 'codica-la-cursos_files');

    // Archivos esperados en _files
    const expectedImagePath = path.join(filesDir, 'codica-la-assets-professions-nodejs.png');
    const expectedCssPath = path.join(filesDir, 'codica-la-assets-application.css');
    const expectedJsPath = path.join(filesDir, 'codica-la-packs-js-runtime.js');
    const expectedCanonicalHtmlPath = path.join(filesDir, 'codica-la-cursos.html');

    // Verifica que se guardaron los recursos
    expect((await fs.readFile(expectedImagePath)).equals(imageBinary)).toBe(true);
    expect((await fs.readFile(expectedCssPath)).equals(cssBinary)).toBe(true);
    expect((await fs.readFile(expectedJsPath)).equals(jsBinary)).toBe(true);

    // canonical se guarda como html (string original como binario)
    const canonicalSaved = await fs.readFile(expectedCanonicalHtmlPath, 'utf-8');
    expect(normalize(canonicalSaved)).toContain(normalize('<title>Cursos de programación Codica</title>'));

    // Verifica que el HTML fue reescrito
    const savedHtml = await fs.readFile(expectedHtmlPath, 'utf-8');

    // img local reescrito
    expect(normalize(savedHtml)).toContain(
      normalize('<img src="codica-la-cursos_files/codica-la-assets-professions-nodejs.png"'),
    );

    // css local reescrito (el cdn se ignora)
    expect(normalize(savedHtml)).toContain(
      normalize('<link rel="stylesheet" media="all" href="codica-la-cursos_files/codica-la-assets-application.css"'),
    );
    expect(normalize(savedHtml)).toContain(
      normalize('href="https://cdn2.codica.la/assets/menu.css"'),
    );

    // canonical reescrito a archivo local
    expect(normalize(savedHtml)).toContain(
      normalize('<link href="codica-la-cursos_files/codica-la-cursos.html" rel="canonical"'),
    );

    // script local reescrito (stripe se ignora)
    expect(normalize(savedHtml)).toContain(
      normalize('<script src="codica-la-cursos_files/codica-la-packs-js-runtime.js"></script>'),
    );
    expect(normalize(savedHtml)).toContain(
      normalize('<script src="https://js.stripe.com/v3/"></script>'),
    );

    scope.done();
  });

  test('throws HttpError when main page returns non-200', async () => {
    const url = 'https://codica.la/cursos';

    const scope = nock('https://codica.la')
      .get('/cursos')
      .reply(404, 'Not Found');

    await expect(pageLoader(url, tempDir))
      .rejects
      .toMatchObject({
        name: 'HttpError',
        status: 404,
        resourceUrl: url,
      });

    scope.done();
  });

  test('throws NetworkError on network failure', async () => {
    const url = 'https://codica.la/cursos';

    const scope = nock('https://codica.la')
      .get('/cursos')
      .replyWithError({ message: 'boom', code: 'ECONNREFUSED' });

    await expect(pageLoader(url, tempDir))
      .rejects
      .toMatchObject({
        name: 'NetworkError',
        resourceUrl: url,
      });

    scope.done();
  });

  test('throws FileSystemError when output dir does not exist', async () => {
    const url = 'https://codica.la/cursos';

    const html = '<html><head><title>Ok</title></head><body>Hi</body></html>';

    const scope = nock('https://codica.la')
      .get('/cursos')
      .reply(200, html);

    // Este directorio NO existe (y no lo vamos a crear)
    // En Windows esto es estable y no depende de permisos.
    const missingDir = path.join(tempDir, 'no-such-dir', 'nested');

    await expect(pageLoader(url, missingDir))
      .rejects
      .toMatchObject({
        name: 'FileSystemError',
      });

    scope.done();
  });
});
