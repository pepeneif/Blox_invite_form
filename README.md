# Blox_invite_form

**ALPHA — primera versión.** Pequeño formulario web para recoger los datos de
contacto de las personas a las que Blox.Global quiere invitar: una tabla tipo
hoja de Excel con tres columnas `[Full Name] [Email] [Phone Number]` donde se
escriben los renglones y se pulsan `[Clear]` y `[Send]`.

Al enviar, el servidor manda **un correo por cada renglón** a la dirección
configurada — por defecto **`admin@bloxcross.com`** — con el formato:

```
Nombre | Email | Teléfono
```

Es un proyecto **autocontenido**: no hay dependencias que instalar, no hay
build, y no necesita PHP, Apache ni nginx. Sólo Node.js.

---

## Qué contiene

| Ruta | Qué es |
|---|---|
| `public/index.html` | La página del formulario. |
| `public/app.js` | Tabla dinámica, validación de cliente y estados. |
| `public/form.css` | Estilo de la tabla (capa "Excel"). |
| `public/ledger.css` | Tokens de color y tipografía. |
| `public/page.css` | Envoltura de página y ajustes finos. |
| `server.js` | Sirve `public/` y expone `POST /form/api/send`. Sin dependencias. |
| `.env.example` | Plantilla de configuración: cópiala a `.env`. |
| `scripts/install.sh` | Instalador para Linux (systemd) y macOS (launchd). |
| `scripts/fake-smtp.js` | Servidor SMTP falso para probar sin mandar correo. |
| `scripts/smoke-test.sh` | Prueba de humo de extremo a extremo, sin correo real. |
| `AGENTS.md` | Nota para Claude Code u otro agente que tenga que instalarlo. |

---

## Instalación rápida

Requisitos: **Node.js 18 o superior** y acceso al menos a un servidor SMTP.

```bash
git clone https://github.com/pepeneif/Blox_invite_form.git
cd Blox_invite_form
cp .env.example .env
# edita .env (ver abajo)
node server.js
```

Y abre `http://127.0.0.1:8090/`.

### Instalación como servicio (Linux / macOS)

```bash
sudo ./scripts/install.sh
```

Copia la aplicación a `/opt/blox-invite-form`, crea el `.env` si no existe y
levanta el servicio (systemd en Linux, launchd en macOS) con arranque automático
y reinicio ante fallos. Para quitarlo:

```bash
sudo ./scripts/install.sh --uninstall
```

### Probar sin mandar correo de verdad

```bash
./scripts/smoke-test.sh
```

Levanta un SMTP falso, arranca el servidor apuntando a él, comprueba la
validación y verifica que el mensaje sale con el destinatario correcto.

---

## Configuración (`.env`)

| Variable | Por defecto | Para qué |
|---|---|---|
| `FORM_HOST` | `127.0.0.1` | Interfaz donde escucha el servidor. `0.0.0.0` para exponerlo sin proxy. |
| `FORM_PORT` | `8090` | Puerto del servidor. |
| `SMTP_HOST` | `127.0.0.1` | Servidor SMTP que entrega el correo. |
| `SMTP_PORT` | `25` | Puerto SMTP. |
| `SMTP_SECURITY` | `plain` | `plain` (relay local, sin cifrar), `starttls` (587/25) o `tls` (465). |
| `SMTP_USER` / `SMTP_PASS` | vacío | Credenciales SMTP. Vacío en un relay local. |
| `SMTP_HELO` | `bloxcross.com` | Nombre con el que el servidor saluda (EHLO). |
| `MAIL_FROM` | `bot@bloxcross.com` | Remitente del sobre (`MAIL FROM`). |
| `FROM_HEADER` | `Bot <bot@bloxcross.com>` | Remitente visible en el cliente de correo. |
| `MAIL_TO` | **`admin@bloxcross.com`** | **Destino: aquí llegan los contactos del formulario.** |
| `MAIL_SUBJECT_PREFIX` | `Blox.Global — contacts` | Prefijo del asunto; el total de contactos se añade al final. |

### Ejemplos de SMTP

**Relay local** (Postfix, msmtp, sendmail… escuchando en `127.0.0.1:25`):

```env
SMTP_HOST=127.0.0.1
SMTP_PORT=25
SMTP_SECURITY=plain
SMTP_USER=
SMTP_PASS=
```

**Proveedor externo con STARTTLS y login** (Gmail, SES, Mailgun…):

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=apikey-o-usuario
SMTP_PASS=la-contrasena-o-clave
```

**TLS directo (puerto 465):**

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURITY=tls
SMTP_USER=usuario
SMTP_PASS=contrasena
```

---

## API

El servidor expone dos rutas:

**`GET /form/api/health`** — comprobación rápida.

```json
{ "ok": true, "to": "admin@bloxcross.com", "security": "plain" }
```

**`POST /form/api/send`** — recibe los renglones del formulario.

```bash
curl -X POST http://127.0.0.1:8090/form/api/send \
  -H 'Content-Type: application/json' \
  -d '{"rows":[{"name":"Ana López","email":"ana@example.com","phone":"+34 600 123 456"}]}'
```

- Éxito: `{"ok":true,"queueId":"…"}` (con `200`).
- Fallo: `{"ok":false,"error":"…"}` con `400` (datos) o `500` (SMTP).

Reglas de validación, aplicadas **igual** en el cliente y en el servidor (el
servidor no se fía de la web: un `POST` directo también se valida):

- **Teléfono** — sólo dígitos; `+` únicamente al principio; `-` o espacio
  únicamente **entre** dígitos. `+34 600 123 456` y `600-123-456` valen;
  `abc`, `123456+`, `-123456` no.
- **Email** — una `@` con texto a los dos lados y, tras la `@`, al menos dos
  palabras separadas por un punto. `jose.test@example.com` vale; `a@b` no.
- Un renglón con algún campo pero no los tres → `Missing data` y no se envía nada.
- Máximo 200 renglones y 128 KB por petición (configurable).

---

## Detalles de comportamiento de la web

- Al escribir en el primer campo de un renglón aparece un renglón nuevo.
- De la segunda fila en adelante las pistas son `Next Full Name`, `Next Email`,
  `Next Phone Number`; al empezar a escribir en `Next Full Name` de un renglón
  nuevo, sus celdas de email y teléfono pasan a `Email` y `Phone Number`.
- El foco se pone solo en la celda `A1` al cargar y tras `[Clear]`.
- Si el envío falla por formato, la celda culpable se marca en rojo y el foco
  salta al primer caso a corregir.
- Tras un envío correcto pone `Sent` y, 750 ms después, `Received`.

---

## Poner HTTPS delante

El servidor habla HTTP plano a propósito: lo normal es dejarlo escuchando en
`127.0.0.1` y poner un proxy inverso. Ejemplo con **Caddy**:

```
form.example.com {
    handle /form/api* {
        reverse_proxy 127.0.0.1:8090
    }
    handle {
        root * /opt/blox-invite-form/public
        file_server
    }
}
```

---

## Hoja de ruta

Esto es un **alpha** deliberadamente pequeño. Lo previsto para versiones
posteriores:

1. **Conectar con la API de Blox** para alimentarla directamente, en lugar de
   depender del correo como único canal.
2. **API propia del proyecto**, para que otros sistemas puedan enviar
   programáticamente los nombres y datos de contacto de la gente a la que se le
   va a mandar una invitación, y completar así el onboarding oficial con
   Blox.Global sin pasar por la tabla.

---

## Notas y trampas conocidas

- El correo sale con el `From` que pongas en `.env`. Si el dominio del remitente
  no tiene **SPF, DKIM y DMARC** publicados, es fácil que los correos caigan en
  spam; conviene configurarlos en el DNS.
- Sin PHP: este proyecto usa Node para hablar SMTP porque el caso original corría
  en un host sin PHP. Si tu entorno ya tiene un `sendmail`/`mail` funcional,
  también sirve — apunta el servidor SMTP a él.
- El servidor no maneja TLS de cara al público: para HTTPS usa un proxy inverso.

## Licencia

MIT.
