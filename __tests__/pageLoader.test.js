import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import nock from 'nock';
import pageLoader from '../src/index.js';

const getFixturePath = (dir, filename) => path.join(dir, filename);

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
    const expectedPath = getFixturePath(tempDir, expectedFilename);

    // la función debe devolver ruta absoluta
    expect(path.isAbsolute(resultPath)).toBe(true);
    expect(resultPath).toBe(path.resolve(expectedPath));

    // el archivo debe existir y contener el HTML descargado
    const saved = await fs.readFile(expectedPath, 'utf-8');
    expect(saved).toEqual(html);

    // asegura que el mock HTTP realmente fue llamado
    scope.done();
  });
});
