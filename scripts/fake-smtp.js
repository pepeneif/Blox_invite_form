#!/usr/bin/env node
'use strict';

/**
 * Servidor SMTP de mentira para probar el formulario SIN mandar correo de verdad.
 * Acepta cualquier EHLO/MAIL/RCPT/DATA (y AUTH LOGIN si se le pide) y guarda el
 * mensaje recibido en un fichero. Uso:
 *
 *   node scripts/fake-smtp.js 2525 salida.eml
 */

const net = require('net');
const fs = require('fs');

const PORT = Number(process.argv[2] || 2525);
const OUT = process.argv[3] || 'captured-message.eml';

const server = net.createServer((socket) => {
  let inData = false;
  let buffer = '';
  let message = '';
  let authStage = 0;

  socket.setEncoding('utf8');
  socket.write('220 fake-smtp ready\r\n');

  socket.on('data', (chunk) => {
    buffer += chunk;

    if (inData) {
      const end = buffer.indexOf('\r\n.\r\n');
      if (end === -1) return;
      message += buffer.slice(0, end);
      buffer = buffer.slice(end + 5);
      inData = false;
      fs.writeFileSync(OUT, message);
      socket.write('250 2.0.0 OK queued as fake\r\n');
    }

    let index;
    while (!inData && (index = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const upper = line.toUpperCase();

      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-fake-smtp\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n');
      } else if (upper.startsWith('AUTH LOGIN')) {
        authStage = 1;
        socket.write('334 VXNlcm5hbWU6\r\n');
      } else if (authStage === 1) {
        authStage = 2;
        socket.write('334 UGFzc3dvcmQ6\r\n');
      } else if (authStage === 2) {
        authStage = 0;
        socket.write('235 2.7.0 Authentication successful\r\n');
      } else if (upper.startsWith('MAIL FROM')) {
        socket.write('250 2.1.0 OK\r\n');
      } else if (upper.startsWith('RCPT TO')) {
        socket.write('250 2.1.5 OK\r\n');
      } else if (upper === 'DATA') {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (upper.startsWith('QUIT')) {
        socket.write('221 2.0.0 Bye\r\n');
        socket.end();
      } else if (upper.startsWith('RSET')) {
        socket.write('250 2.0.0 OK\r\n');
      } else {
        socket.write('250 2.0.0 OK\r\n');
      }
    }
  });

  socket.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake-smtp on 127.0.0.1:${PORT}, escribiendo en ${OUT}`);
});
