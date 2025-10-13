import fs from 'fs';
import path from 'path';

export async function guardarStreamEnArchivo(stream, nombreArchivo = 'audio.ogg') {
  const tempDir = path.resolve('temp');
  const filePath = path.join(tempDir, nombreArchivo);

  // Crear la carpeta si no existe
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const writeStream = fs.createWriteStream(filePath);

  return new Promise((resolve, reject) => {
    stream.pipe(writeStream);
    writeStream.on('finish', () => resolve(filePath));
    writeStream.on('error', (err) => reject(err));
  });
}
