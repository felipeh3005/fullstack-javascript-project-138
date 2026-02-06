import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

// Convierte una URL en nombre de archivo:
const makeFilenameFromUrl = (url) => {
  // new URL(url) valida la URL y permite extraer host + pathname
  const { host, pathname } = new URL(url);

  // juntamos host + pathname
  const raw = `${host}${pathname}`;

  // reemplaza cualquier cosa que no sea alfanumérico por '-'
  const sanitized = raw.replace(/[^a-zA-Z0-9]/g, '-');

  // añade extensión requerida
  return `${sanitized}.html`;
};

export default (url, outputDir = process.cwd()) => {
  const filename = makeFilenameFromUrl(url);
  const filepath = path.join(outputDir, filename);
  const absolutePath = path.resolve(filepath);

  // axios.get devuelve una promesa con la respuesta
  return axios.get(url)
    .then((response) => {
      // response.data es el body (HTML)
      return fs.writeFile(filepath, response.data, 'utf-8');
    })
    .then(() => absolutePath);
};
