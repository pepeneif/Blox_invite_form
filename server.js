#!/usr/bin/env node
'use strict';

/**
 * Blox_invite_form — servidor del formulario de contactos (ALPHA).
 *
 * Hace dos cosas:
 *   1. Sirve la carpeta ./public (la tabla tipo Excel: index.html + CSS + app.js).
 *   2. Expone POST /form/api/send: valida cada renglon y manda un correo con un
 *      elemento por renglon ("Nombre | Email | Telefono").
 *
 * No usa dependencias externas: solo modulos de Node (http, net, tls, fs, path,
 * crypto). Funciona en Linux y macOS con Node 18 o superior.
 *
 * Variables de entorno: ver .env.example y README.md.
 */

const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* .env (sin dependencias)                                             */
/* ------------------------------------------------------------------ */

// Carga .env de la raiz del proyecto si existe. Las variables ya definidas en
// el entorno tienen prioridad (asi systemd/docker pueden sobrescribir).
function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(process.env.ENV_FILE || path.join(__dirname, '.env'));

/* ------------------------------------------------------------------ */
/* Configuracion                                                       */
/* ------------------------------------------------------------------ */

const HOST = process.env.FORM_HOST || '127.0.0.1';
const PORT = Number(process.env.FORM_PORT || 8090);
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));

const SMTP_HOST = process.env.SMTP_HOST || '127.0.0.1';
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
// 'plain' (sin cifrar, tipico relay local), 'starttls' (25/587 con STARTTLS) o 'tls' (465).
const SMTP_SECURITY = (process.env.SMTP_SECURITY || 'plain').toLowerCase();
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_HELO = (process.env.SMTP_HELO || 'bloxcross.com').replace(/[\r\n]/g, '');

const FROM_ADDRESS = process.env.MAIL_FROM || 'bot@bloxcross.com';
const FROM_HEADER = (process.env.FROM_HEADER || 'Bot <bot@bloxcross.com>').replace(/[\r\n]/g, ' ');
const TO_ADDRESS = process.env.MAIL_TO || 'admin@bloxcross.com';
const SUBJECT_PREFIX = (process.env.MAIL_SUBJECT_PREFIX || 'Blox.Global — contacts').replace(/[\r\n]/g, ' ');

const MAX_ROWS = Number(process.env.MAX_ROWS || 200);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 128 * 1024);
const SMTP_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 15000);

const FIELD_ORDER = ['name', 'email', 'phone'];

// Mismas reglas que el cliente (public/app.js).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const PHONE_RE = /^\+?[0-9]+([ -][0-9]+)*$/;
const FORMAT_MESSAGE = 'Please correct the highlighted cells in the table.';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------ */
/* Validacion                                                          */
/* ------------------------------------------------------------------ */

function normalizeCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return text
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function sanitizeAddress(value) {
  return String(value)
    .replace(/[\r\n<>,]/g, '')
    .replace(/[^\x21-\x7E]/g, '')
    .trim();
}

function validateRows(rows) {
  if (!Array.isArray(rows)) return { error: 'Invalid payload' };
  if (rows.length > MAX_ROWS) return { error: `Too many rows (max ${MAX_ROWS})` };

  const completeRows = [];

  for (const rawRow of rows) {
    if (rawRow === null || rawRow === undefined) continue;

    const row = {};
    let filled = 0;

    for (const field of FIELD_ORDER) {
      row[field] = normalizeCell(rawRow[field]);
      if (row[field] !== '') filled += 1;
    }

    if (filled === 0) continue;
    if (filled < FIELD_ORDER.length) return { error: 'Missing data' };

    if (!EMAIL_RE.test(row.email) || !PHONE_RE.test(row.phone)) {
      return { error: FORMAT_MESSAGE };
    }

    completeRows.push(row);
  }

  if (completeRows.length === 0) return { error: 'No rows' };
  return { rows: completeRows };
}

/* ------------------------------------------------------------------ */
/* Construccion del mensaje                                            */
/* ------------------------------------------------------------------ */

function headerSafe(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

// Dot-stuffing: en SMTP, una linea del cuerpo que empieza por "." se duplica
// (si no, el receptor la toma por el final de los datos).
function dotStuffLines(text) {
  return String(text)
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

function localDomain() {
  const at = FROM_ADDRESS.indexOf('@');
  const domain = at >= 0 ? FROM_ADDRESS.slice(at + 1) : '';
  return domain || 'localhost';
}

// Texto plano (un renglon por contacto) + alternativa HTML sencilla.
function buildMessage(rows) {
  const now = new Date();
  const messageId = `<${crypto.randomUUID()}@${localDomain()}>`;
  const subject = `${SUBJECT_PREFIX} (${rows.length})`;

  const textBody = dotStuffLines(
    rows.map((row) => [row.name, row.email, row.phone].join(' | ')).join('\r\n')
  );

  const htmlRows = rows
    .map((row) => {
      const cells = [row.name, row.email, row.phone]
        .map((v) => `<td style="padding:4px 10px;border-bottom:1px solid #e2dccf">${escapeHtml(v)}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  const htmlBody = [
    '<html><body style="font-family:system-ui,sans-serif;color:#1a1a18">',
    `<p>${escapeHtml(subject)}</p>`,
    '<table style="border-collapse:collapse;font-size:14px">',
    '<thead><tr>',
    '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #c8bda8">Name</th>',
    '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #c8bda8">Email</th>',
    '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #c8bda8">Phone</th>',
    '</tr></thead><tbody>',
    htmlRows,
    '</tbody></table></body></html>'
  ].join('');

  const boundary = `b${crypto.randomUUID().replace(/-/g, '')}`;

  const headers = [
    `From: ${FROM_HEADER}`,
    `To: ${sanitizeAddress(TO_ADDRESS)}`,
    `Subject: ${headerSafe(subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    textBody,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    dotStuffLines(htmlBody),
    `--${boundary}--`
  ];

  return [...headers, '', ...parts].join('\r\n') + '\r\n.\r\n';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* Cliente SMTP                                                        */
/* ------------------------------------------------------------------ */

function smtpResponseError(reply, stage) {
  const error = new Error(`SMTP ${stage} failed: ${reply.code} ${reply.texts.join(' ').trim()}`);
  error.code = reply.code;
  error.stage = stage;
  return error;
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    let socket;
    const options = { host: SMTP_HOST, port: SMTP_PORT };

    if (SMTP_SECURITY === 'tls') {
      socket = tls.connect({ ...options, servername: SMTP_HOST }, () => resolve(socket));
    } else {
      socket = net.createConnection(options, () => resolve(socket));
    }

    socket.once('error', reject);
  });
}

function deliverMessage(message) {
  return new Promise((resolve, reject) => {
    let socket = null;
    let carry = '';
    let replyState = null;
    const ready = [];
    const waiters = [];
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      if (socket) socket.destroy();
      reject(error);
    }

    function succeed(finalReply) {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(finalReply);
    }

    function completeReply(reply) {
      if (waiters.length > 0) waiters.shift().res(reply);
      else ready.push(reply);
    }

    function readReply() {
      if (ready.length > 0) return Promise.resolve(ready.shift());
      return new Promise((res, rej) => waiters.push({ res, rej }));
    }

    function handleLine(line) {
      const match = /^(\d{3})([- ])(.*)$/.exec(line);
      if (!match) return;

      if (match[2] === '-') {
        if (!replyState) replyState = { code: match[1], texts: [match[3]] };
        else {
          replyState.code = match[1];
          replyState.texts.push(match[3]);
        }
        return;
      }

      if (replyState) {
        replyState.code = match[1];
        replyState.texts.push(match[3]);
        const reply = replyState;
        replyState = null;
        completeReply(reply);
      } else {
        completeReply({ code: match[1], texts: [match[3]] });
      }
    }

    function attach(sock) {
      socket = sock;
      socket.setEncoding('utf8');
      socket.setTimeout(SMTP_TIMEOUT_MS, () => fail(new Error('SMTP timeout')));

      socket.on('data', (chunk) => {
        carry += chunk;
        let index;
        while ((index = carry.indexOf('\r\n')) !== -1) {
          const line = carry.slice(0, index);
          carry = carry.slice(index + 2);
          handleLine(line);
        }
      });

      socket.on('error', fail);
      socket.on('end', () => {
        if (!settled) fail(new Error('SMTP connection closed early'));
      });
    }

    async function authenticate() {
      if (!SMTP_USER) return;

      // AUTH LOGIN: usuario y contrasena en base64, en dos pasos.
      const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

      socket.write('AUTH LOGIN\r\n');
      const userPrompt = await readReply();
      if (userPrompt.code !== '334') throw smtpResponseError(userPrompt, 'AUTH LOGIN');

      socket.write(`${b64(SMTP_USER)}\r\n`);
      const passPrompt = await readReply();
      if (passPrompt.code !== '334') throw smtpResponseError(passPrompt, 'AUTH user');

      socket.write(`${b64(SMTP_PASS)}\r\n`);
      const authReply = await readReply();
      if (!/^2/.test(authReply.code)) throw smtpResponseError(authReply, 'AUTH pass');
    }

    async function maybeStartTls() {
      if (SMTP_SECURITY !== 'starttls') return;

      socket.write('STARTTLS\r\n');
      const starttlsReply = await readReply();
      if (starttlsReply.code !== '220') throw smtpResponseError(starttlsReply, 'STARTTLS');

      const upgraded = await new Promise((res, rej) => {
        const tlsSocket = tls.connect(
          { socket, servername: SMTP_HOST, rejectUnauthorized: true },
          () => res(tlsSocket)
        );
        tlsSocket.once('error', rej);
      });

      carry = '';
      replyState = null;
      attach(upgraded);
    }

    async function run() {
      const base = await connectSocket();
      attach(base);

      try {
        const greeting = await readReply();
        if (greeting.code !== '220') throw smtpResponseError(greeting, 'greeting');

        socket.write(`EHLO ${SMTP_HELO}\r\n`);
        const ehlo = await readReply();
        if (!/^2/.test(ehlo.code)) throw smtpResponseError(ehlo, 'EHLO');

        await maybeStartTls();

        if (SMTP_SECURITY === 'starttls') {
          socket.write(`EHLO ${SMTP_HELO}\r\n`);
          const ehlo2 = await readReply();
          if (!/^2/.test(ehlo2.code)) throw smtpResponseError(ehlo2, 'EHLO (post-STARTTLS)');
        }

        await authenticate();

        socket.write(`MAIL FROM:<${sanitizeAddress(FROM_ADDRESS)}>\r\n`);
        const mail = await readReply();
        if (!/^2/.test(mail.code)) throw smtpResponseError(mail, 'MAIL FROM');

        socket.write(`RCPT TO:<${sanitizeAddress(TO_ADDRESS)}>\r\n`);
        const rcpt = await readReply();
        if (!/^2/.test(rcpt.code)) throw smtpResponseError(rcpt, 'RCPT TO');

        socket.write('DATA\r\n');
        const dataReply = await readReply();
        if (dataReply.code !== '354') throw smtpResponseError(dataReply, 'DATA');

        socket.write(message);
        const finalReply = await readReply();

        socket.write('QUIT\r\n');

        if (finalReply.code !== '250') throw smtpResponseError(finalReply, 'DATA final');
        succeed(finalReply);
      } catch (error) {
        fail(error);
      }
    }

    run().catch(fail);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function handleSend(payload) {
  const validation = validateRows(payload && payload.rows);
  if (validation.error) {
    return { status: 400, body: { ok: false, error: validation.error } };
  }

  const queueId = crypto.randomUUID();

  try {
    const message = buildMessage(validation.rows);
    await deliverMessage(message);
    console.log(`sent queueId=${queueId} rows=${validation.rows.length} to=${TO_ADDRESS}`);
    return { status: 200, body: { ok: true, queueId } };
  } catch (error) {
    const suffix = error.code ? ` (SMTP ${error.code})` : '';
    console.error(`smtp_error queueId=${queueId} message=${error.message}`);
    return { status: 500, body: { ok: false, error: `SMTP failed${suffix}` } };
  }
}

/* ------------------------------------------------------------------ */
/* Estaticos                                                           */
/* ------------------------------------------------------------------ */

function serveStatic(request, response) {
  const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);

  // Sin salir de PUBLIC_DIR (path traversal).
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(target, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    response.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* Servidor HTTP                                                       */
/* ------------------------------------------------------------------ */

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;

  function sendJson(status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }

  if (pathname === '/form/api/health') {
    return sendJson(200, { ok: true, to: TO_ADDRESS, security: SMTP_SECURITY });
  }

  if (pathname === '/form/api/send') {
    if (request.method !== 'POST') return sendJson(405, { ok: false, error: 'Method not allowed' });

    const chunks = [];
    let size = 0;
    let responded = false;

    function reply(status, body) {
      if (responded) return;
      responded = true;
      sendJson(status, body);
    }

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413, { ok: false, error: 'Payload too large' });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('error', () => reply(400, { ok: false, error: 'Bad request' }));

    request.on('end', async () => {
      if (responded) return;

      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { ok: false, error: 'Invalid JSON' });
      }

      try {
        const result = await handleSend(parsed);
        reply(result.status, result.body);
      } catch {
        reply(500, { ok: false, error: 'Internal error' });
      }
    });

    return undefined;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sendJson(404, { ok: false, error: 'Not found' });
  }

  return serveStatic(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Blox_invite_form listening on http://${HOST}:${PORT}`);
  console.log(`  static: ${PUBLIC_DIR}`);
  console.log(`  mail:   ${FROM_ADDRESS} -> ${TO_ADDRESS} via ${SMTP_HOST}:${SMTP_PORT} (${SMTP_SECURITY})`);
});
