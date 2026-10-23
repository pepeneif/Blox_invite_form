# AGENTS.md — cómo instalar Blox_invite_form

Nota para **Claude Code** o cualquier otro agente que reciba este repositorio y
tenga que dejarlo funcionando en una máquina Linux o macOS. Es un proyecto
pequeño y autocontenido: no hay build, ni dependencias que instalar, ni base de
datos.

## Lo esencial primero

1. **Node.js 18+** es el único requisito. Comprueba con `node --version`.
   Si falta:
   - macOS: `brew install node`
   - Debian/Ubuntu: `sudo apt-get install -y nodejs`
     (o el `nodesource` si la versión del sistema es menor de 18)
2. **Este proyecto no usa `npm install`.** `package.json` existe sólo para
   `npm start` y para declarar la versión de Node. No hay `node_modules`.
3. **No pidas credenciales SMTP si la máquina ya tiene un relay local**: si
   `127.0.0.1:25` acepta conexiones (Postfix, msmtp, exim…), no hace falta
   usuario ni contraseña.

## Instalación

### Camino corto (un servicio, con arranque automático)

```bash
git clone https://github.com/pepeneif/Blox_invite_form.git
cd Blox_invite_form
sudo ./scripts/install.sh
```

El instalador copia la aplicación a `/opt/blox-invite-form`, crea `.env` desde
`.env.example` si no existe y registra el servicio (systemd en Linux, launchd en
macOS). Para revertir: `sudo ./scripts/install.sh --uninstall`.

### Camino manual (sin tocar el sistema)

```bash
cp .env.example .env
$EDITOR .env          # revisa antes de arrancar
node server.js
```

Sirve la página en `http://127.0.0.1:8090/`.

## Configuración que hay que revisar antes de arrancar

Abre `.env` y comprueba, como mínimo:

- **`MAIL_TO`** — debe ser `admin@bloxcross.com` (o el destino que te pidan).
  Es la dirección a la que llegan los contactos del formulario.
- **`MAIL_FROM`** y **`FROM_HEADER`** — el remitente. Por defecto
  `bot@bloxcross.com`. El dominio del remitente debería tener SPF, DKIM y DMARC
  publicados, si no los correos acabarán en spam.
- **`SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURITY`** — el servidor que entrega el
  correo:
  - `SMTP_SECURITY=plain` → relay local, sin cifrar (lo habitual: `127.0.0.1:25`).
  - `SMTP_SECURITY=starttls` → proveedor externo en 587/25, con usuario y
    contraseña en `SMTP_USER` / `SMTP_PASS`.
  - `SMTP_SECURITY=tls` → TLS directo en el puerto 465.
- **`FORM_HOST`** — déjalo en `127.0.0.1` si vas a poner un proxy inverso delante.
  Usa `0.0.0.0` sólo si quieres exponerlo directamente.

## Cómo verificar que funciona de verdad

**Sin mandar correo real** (recomendado antes de tocar nada en producción):

```bash
./scripts/smoke-test.sh
```

Levanta un SMTP falso, arranca el servidor apuntándole, prueba la validación y
comprueba que el mensaje capturado lleva el destinatario correcto. Si termina en
`TODO OK`, el código está bien.

**Con el servicio ya instalado:**

```bash
curl -s http://127.0.0.1:8090/form/api/health
# {"ok":true,"to":"admin@bloxcross.com","security":"plain"}

curl -X POST http://127.0.0.1:8090/form/api/send \
  -H 'Content-Type: application/json' \
  -d '{"rows":[{"name":"Test","email":"test@example.com","phone":"+34 600 000 000"}]}'
# {"ok":true,"queueId":"…"}
```

Si el `queueId` sale, el SMTP aceptó el mensaje. En Linux puedes confirmarlo con
`journalctl -u blox-invite-form -n 20` (en macOS:
`tail -20 /var/log/blox-invite-form.log`).

## Trampas que ya nos han mordido

- **La página sirve `/form/api/send` con ruta absoluta.** Si montas la página en
  un subdirectorio distinto de `/` o cambias el prefijo, hay que ajustar el
  `fetch('/form/api/send')` de `public/app.js` **y** las rutas del servidor.
- **Si pones un proxy inverso, enruta `/form/api*` al servidor y sirve el resto
  como estático** (ver el ejemplo de Caddy en el README). Olvidar la regla de
  `/form/api*` hace que el botón `Send` devuelva la propia página HTML y falle.
- **El estado "Sent"/"Missing data" se oculta con `[hidden]`.** `form.css` define
  `.status{display:flex}`, que gana al `display:none` que el navegador aplica a
  `[hidden]`; por eso `page.css` lleva `.status[hidden]{display:none !important}`.
  No lo quites.
- **No metas credenciales en el repositorio.** `.env` está en `.gitignore`;
  usa `.env.example` para documentar variables nuevas.
- **El servidor no hace TLS de cara al público.** Para HTTPS, proxy inverso.

## Si el encargo incluye modificarlo

- La validación vive **duplicada** a propósito: en `public/app.js` (para el
  usuario) y en `server.js` (porque el servidor no se fía de la web). Si cambias
  una regla, cámbiala en las dos.
- Tras tocar CSS o JS, sube el sufijo de versión en `public/index.html`
  (`?v=…`) para que los navegadores no sirvan la copia vieja de la caché.
