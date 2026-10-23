'use strict';

(function () {
  const COLUMNS = [
    { key: 'name', placeholder: 'Full Name' },
    { key: 'email', placeholder: 'Email' },
    { key: 'phone', placeholder: 'Phone Number' }
  ];

  // Email: una "@" con texto a los dos lados y, despues de la "@", al menos dos
  // palabras separadas por un punto (p. ej. dominio.com).
  const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

  // Telefono: solo digitos; "+" unicamente al principio; "-" o espacio
  // unicamente ENTRE digitos (nunca al principio ni al final).
  const PHONE_RE = /^\+?[0-9]+([ -][0-9]+)*$/;

  const FIELDS = ['name', 'email', 'phone'];
  const FORMAT_MESSAGE = 'Please correct the highlighted cells in the table.';

  // EFECTO REVERTIBLE: al empezar a escribir en
  // la celda "Next Full Name" de un renglon nuevo, las celdas "Next Email" y
  // "Next Phone Number" de ESE renglon pasan inmediatamente a "Email" y
  // "Phone Number" para indicar que hay que rellenarlas.
  // Para desactivarlo basta poner esta constante en false (no toca nada mas).
  const DROP_NEXT_HINT_ON_TYPING = true;

  const sheetBody = document.getElementById('sheet-body');
  const statusEl = document.getElementById('status');
  const statusOk = statusEl.querySelector('.status-ok');
  const statusErr = statusEl.querySelector('.status-err');
  const clearBtn = document.querySelector('.btn-clear');
  const sendBtn = document.querySelector('.btn-send');

  let okTimer = null;

  // La primera fila usa la pista normal ("Full Name"); de la segunda en
  // adelante la pista lleva el prefijo "Next ".
  function createInput(column, number) {
    const placeholder = number > 1 ? `Next ${column.placeholder}` : column.placeholder;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell';
    input.dataset.col = column.key;
    input.placeholder = placeholder;
    input.dataset.plainHint = column.placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', placeholder);
    return input;
  }

  function createRow(number) {
    const row = document.createElement('div');
    row.className = 'row';

    const rowNum = document.createElement('span');
    rowNum.className = 'rownum';
    rowNum.textContent = String(number);

    row.appendChild(rowNum);
    COLUMNS.forEach((column) => row.appendChild(createInput(column, number)));
    return row;
  }

  function isEmptyRow(row) {
    return Array.from(row.querySelectorAll('input.cell'))
      .every((input) => input.value.trim() === '');
  }

  function renumberRows() {
    Array.from(sheetBody.querySelectorAll('.row')).forEach((row, index) => {
      row.querySelector('.rownum').textContent = String(index + 1);
    });
  }

  // Aplica (o no) el efecto de pistas descrito arriba a un renglon concreto.
  function applyNextHintDrop(row) {
    if (!DROP_NEXT_HINT_ON_TYPING) return;
    const index = Array.from(sheetBody.querySelectorAll('.row')).indexOf(row);
    if (index < 1) return; // solo renglones nuevos (2 en adelante)
    const nameInput = row.querySelector('input[data-col="name"]');
    const started = Boolean(nameInput && nameInput.value.trim() !== '');
    ['email', 'phone'].forEach((key) => {
      const input = row.querySelector(`input[data-col="${key}"]`);
      if (!input) return;
      const plain = input.dataset.plainHint;
      if (!plain) return;
      // Con texto en "Full Name" cae el "Next "; si se vacia, vuelve.
      input.placeholder = started ? plain : `Next ${plain}`;
    });
  }

  function focusFirstCell() {
    const first = sheetBody.querySelector('.row input.cell');
    if (first) first.focus();
  }

  function ensureTrailingRow() {
    while (sheetBody.lastElementChild && isEmptyRow(sheetBody.lastElementChild)) {
      sheetBody.removeChild(sheetBody.lastElementChild);
    }
    sheetBody.appendChild(createRow(sheetBody.children.length + 1));
    renumberRows();
  }

  function clearStatus() {
    if (okTimer) { clearTimeout(okTimer); okTimer = null; }
    statusEl.hidden = true;
    statusOk.hidden = true;
    statusErr.hidden = true;
    statusOk.textContent = 'Sent';
    statusErr.textContent = FORMAT_MESSAGE;
  }

  function showStatus(kind, message) {
    clearStatus();
    statusEl.hidden = false;
    if (kind === 'ok') {
      statusOk.hidden = false;
      statusOk.textContent = message || 'Sent';
    } else {
      statusErr.hidden = false;
      statusErr.textContent = message || FORMAT_MESSAGE;
    }
  }

  function markInvalid(inputs) {
    inputs.forEach((input) => input.classList.add('invalid'));
  }

  function clearMarks() {
    sheetBody.querySelectorAll('input.cell.invalid')
      .forEach((input) => input.classList.remove('invalid'));
  }

  function collectRows() {
    return Array.from(sheetBody.querySelectorAll('.row')).map((row) => {
      const inputs = {};
      row.querySelectorAll('input.cell').forEach((input) => { inputs[input.dataset.col] = input; });
      const values = {};
      FIELDS.forEach((key) => { values[key] = inputs[key].value.trim(); });
      return { inputs, values };
    });
  }

  // Devuelve el primer campo a corregir EN ORDEN de tabla: para un renglon
  // incompleto, el primer campo vacio; para un formato malo, la primera celda
  // marcada. Asi el foco del cursor va al primer caso a arreglar.
  function firstToFix(items) {
    for (const item of items) {
      const filled = FIELDS.filter((key) => item.values[key] !== '');
      if (filled.length === 0) continue;

      if (filled.length < FIELDS.length) {
        const emptyKey = FIELDS.find((key) => item.values[key] === '');
        return item.inputs[emptyKey];
      }

      const badKey = FIELDS.find((key) => {
        if (!item.values[key]) return false;
        if (key === 'email') return !EMAIL_RE.test(item.values.email);
        if (key === 'phone') return !PHONE_RE.test(item.values.phone);
        return false;
      });
      if (badKey) return item.inputs[badKey];
    }
    return null;
  }

  function validateRows(items) {
    const invalid = [];
    const complete = [];
    let hasPartial = false;
    let hasFormatError = false;

    items.forEach((item) => {
      const filled = FIELDS.filter((key) => item.values[key] !== '');
      if (filled.length === 0) return;

      if (filled.length < FIELDS.length) {
        hasPartial = true;
        return;
      }

      const bad = [];
      if (!EMAIL_RE.test(item.values.email)) bad.push('email');
      if (!PHONE_RE.test(item.values.phone)) bad.push('phone');

      if (bad.length > 0) {
        hasFormatError = true;
        bad.forEach((key) => invalid.push(item.inputs[key]));
        return;
      }

      complete.push(item.values);
    });

    const focusTarget = firstToFix(items);

    if (hasPartial) return { error: 'Missing data', focusTarget };
    if (hasFormatError) return { error: FORMAT_MESSAGE, invalid, focusTarget };
    if (complete.length === 0) return { error: 'No rows' };
    return { rows: complete };
  }

  async function send() {
    clearMarks();
    const validation = validateRows(collectRows());

    if (validation.invalid) markInvalid(validation.invalid);
    if (validation.error) {
      showStatus('err', validation.error);
      // Al haber celdas que corregir, el foco del cursor
      // se pone en el primer caso a arreglar.
      if (validation.focusTarget) {
        validation.focusTarget.focus();
        if (validation.focusTarget.scrollIntoView) {
          validation.focusTarget.scrollIntoView({ block: 'nearest' });
        }
      }
      return;
    }

    try {
      const response = await fetch('/form/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: validation.rows })
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = { ok: false, error: `HTTP ${response.status}` };
      }

      if (payload.ok) {
        // "Sent" un momento y 750 ms despues "Received".
        showStatus('ok', 'Sent');
        okTimer = setTimeout(() => {
          okTimer = null;
          if (!statusOk.hidden) statusOk.textContent = 'Received';
        }, 750);
      } else {
        showStatus('err', payload.error || `HTTP ${response.status}`);
      }
    } catch {
      showStatus('err', 'Could not reach the server');
    }
  }

  function clear() {
    sheetBody.innerHTML = '';
    sheetBody.appendChild(createRow(1));
    clearStatus();
    focusFirstCell();
  }

  sheetBody.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.matches('input.cell')) return;

    // Al corregir una celda marcada se le quita el resaltado.
    if (input.classList.contains('invalid')) input.classList.remove('invalid');

    // Efecto de pistas: al escribir en "Next Full Name" caen los "Next " de
    // Email/Telefono de ese mismo renglon.
    if (input.dataset.col === 'name') applyNextHintDrop(input.closest('.row'));

    ensureTrailingRow();
  });

  clearBtn.addEventListener('click', clear);
  sendBtn.addEventListener('click', send);

  clear();
})();
