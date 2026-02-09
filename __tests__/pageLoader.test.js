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

  test('downloads page and saves it into output directory', async () => {
    const url = 'https://codica.la/cursos';
    const html = '<html><head></head><body>Hello</body></html>';

    const scope = nock('https://codica.la')
      .get('/cursos')
      .reply(200, html);

    const resultPath = await pageLoader(url, tempDir);

    const expectedFilename = 'codica-la-cursos.html';
    const expectedPath = path.join(tempDir, expectedFilename);

    // la función debe devolver ruta absoluta
    expect(path.isAbsolute(resultPath)).toBe(true);
    expect(resultPath).toBe(path.resolve(expectedPath));

    // el archivo debe existir y contener el HTML descargado
    const saved = await fs.readFile(expectedPath, 'utf-8');
    expect(saved).toEqual(html);

    scope.done();
  });

  test('downloads images, saves them into _files dir and rewrites html (step 2)', async () => {
    const url = 'https://codica.la/cursos';

    // Fixture HTML (entrada)
    const html = `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <title>Cursos de Programación de Codica</title>
  </head>
  <body>
    <img src="/assets/professions/nodejs.png" alt="Ícono de la profesión de programador Node.js" />
    <h3>
      <a href="/professions/nodejs">Programador Node.js</a>
    </h3>
  </body>
</html>`;

    // “PNG” fake como binario
    const imageBinary = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG signature parcial

    const scope = nock('https://codica.la')
      .get('/cursos')
      .reply(200, html)
      .get('/assets/professions/nodejs.png')
      .reply(200, imageBinary, { 'Content-Type': 'image/png' });

    const resultPath = await pageLoader(url, tempDir);

    // HTML final esperado
    const expectedHtmlPath = path.join(tempDir, 'codica-la-cursos.html');
    expect(resultPath).toBe(path.resolve(expectedHtmlPath));

    // carpeta de recursos esperada
    const filesDir = path.join(tempDir, 'codica-la-cursos_files');

    // imagen esperada
    const expectedImagePath = path.join(
      filesDir,
      'codica-la-assets-professions-nodejs.png',
    );

    // verifica que el archivo existe y contiene el binario
    const savedImage = await fs.readFile(expectedImagePath);
    expect(savedImage.equals(imageBinary)).toBe(true);

    // verifica que el HTML fue reescrito para apuntar al recurso local
    const savedHtml = await fs.readFile(expectedHtmlPath, 'utf-8');
    expect(normalize(savedHtml)).toContain(
      normalize('<img src="codica-la-cursos_files/codica-la-assets-professions-nodejs.png"'),
    );

    scope.done();
  });
});
