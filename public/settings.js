/* ── Echo Settings ── */

// Carrier list mirrors sms_lkp_Carrier seed data (bitwise eCarrierId values).
// Hardcoded here so the form works without a round-trip to the API.
const CARRIERS = [
  { eCarrierId: 1, carrier: 'Bandwidth' },
  { eCarrierId: 2, carrier: 'Twilio'    },
  { eCarrierId: 4, carrier: 'Sinch'     },
  { eCarrierId: 8, carrier: 'Tychron'   },
];

// Structured field definitions for known carriers (keyed by eCarrierId).
// Carriers not listed here fall back to a raw JSON textarea.
const CARRIER_FIELDS = {
  1: [ // Bandwidth
    { key: 'accountId',     label: 'Account ID' },
    { key: 'apiToken',      label: 'API Token' },
    { key: 'apiSecret',     label: 'API Secret',      password: true },
    { key: 'applicationId', label: 'Application ID' },
  ],
  2: [ // Twilio
    { key: 'accountSid',          label: 'Account SID' },
    { key: 'authToken',           label: 'Auth Token',           password: true },
    { key: 'messagingServiceSid', label: 'Messaging Service SID' },
  ],
};

let carriers    = [];
let carrierApps = [];
let currentPhone = null;

/* ── Toast ── */

function showToast(msg, ok = true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-2xl text-sm font-medium shadow-lg z-50 '
    + (ok ? 'bg-slate-900 text-white' : 'bg-red-600 text-white');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

/* ── Helpers ── */

function formatPhoneNumber(num) {
  const d = String(num || '').replace(/\D/g, '');
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return d;
}

/* ── Data loading ── */

async function loadAll() {
  populateCarrierDropdown();
  await Promise.all([loadCarrierApps(), loadBusinessPhone()]);
}

function populateCarrierDropdown() {
  carriers = CARRIERS;
  const sel = document.getElementById('formCarrier');
  sel.innerHTML = '<option value="">— select carrier —</option>';
  for (const c of carriers) {
    const opt = document.createElement('option');
    opt.value = c.eCarrierId;
    opt.textContent = c.carrier;
    sel.appendChild(opt);
  }
}

async function loadCarrierApps() {
  const r = await fetch('/api/carrier-applications');
  if (!r.ok) return;
  const data = await r.json();
  carrierApps = data.items || [];
  renderAppList();
  populateAppSelect();
}

async function loadBusinessPhone() {
  // Always resolve the session number server-side (/api/me reads the HttpOnly cookie).
  const meRes = await fetch('/api/me');
  const meData = meRes.ok ? await meRes.json() : null;
  const sessionNumber = meData?.iBusinessNumber ?? null;

  const numEl  = document.getElementById('phoneNumberDisplay');
  const nameEl = document.getElementById('inputDisplayName');
  const selEl  = document.getElementById('selectCarrierApp');

  // Show the phone number from session immediately, even before DB record exists.
  numEl.textContent = sessionNumber ? formatPhoneNumber(sessionNumber) : '—';

  // Fetch the full business phone record (may not exist yet for new numbers).
  const r = await fetch('/api/business-phones');
  if (!r.ok) return;
  const data = await r.json();
  currentPhone = data.item || null;

  if (currentPhone) {
    nameEl.value = currentPhone.displayName || '';
    selEl.value  = currentPhone.iCarrierApplicationId || '';

    if (currentPhone.displayName) {
      document.getElementById('pageTitle').textContent = currentPhone.displayName + ' — Settings';
    }
  }
}

/* ── Business phone save ── */

async function saveBusinessPhone() {
  const displayName         = document.getElementById('inputDisplayName').value.trim();
  const iCarrierApplicationId = Number(document.getElementById('selectCarrierApp').value);
  if (!iCarrierApplicationId) {
    showToast('Select a carrier application first.', false);
    return;
  }
  const r = await fetch('/api/business-phones', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName, iCarrierApplicationId })
  });
  const data = await r.json();
  if (data.ok) {
    showToast('Phone settings saved.');
    await loadBusinessPhone();
  } else {
    showToast(data.error || 'Save failed.', false);
  }
}

/* ── Carrier app dropdown (business phone section) ── */

function populateAppSelect() {
  const sel = document.getElementById('selectCarrierApp');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— select —</option>';
  for (const app of carrierApps) {
    const opt = document.createElement('option');
    opt.value = app.iCarrierApplicationId;
    opt.textContent = app.name + ' (' + (app.carrier || '') + ')';
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
  // Restore from currentPhone if not manually changed
  if (!sel.value && currentPhone?.iCarrierApplicationId) {
    sel.value = currentPhone.iCarrierApplicationId;
  }
}

/* ── Carrier app list ── */

function renderAppList() {
  const container = document.getElementById('appList');
  if (carrierApps.length === 0) {
    container.innerHTML = '<div class="px-6 py-8 text-center text-sm text-slate-400">No carrier applications yet. Click New to add one.</div>';
    return;
  }
  container.innerHTML = '';
  for (const app of carrierApps) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between px-6 py-3.5';

    const info = document.createElement('div');
    const nameSpan = document.createElement('div');
    nameSpan.className = 'text-sm font-semibold text-slate-800';
    nameSpan.textContent = app.name;
    const carrierSpan = document.createElement('div');
    carrierSpan.className = 'text-xs text-slate-400 mt-0.5';
    carrierSpan.textContent = app.carrier || '';
    info.appendChild(nameSpan);
    info.appendChild(carrierSpan);

    const editBtn = document.createElement('button');
    editBtn.className = 'px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 text-xs font-medium transition-colors';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => openAppForm(app);

    row.appendChild(info);
    row.appendChild(editBtn);
    container.appendChild(row);
  }
}

/* ── Carrier app form ── */

function openAppForm(app) {
  const form     = document.getElementById('appForm');
  const title    = document.getElementById('appFormTitle');
  const idInput  = document.getElementById('formAppId');
  const nameInput = document.getElementById('formName');
  const carrierSel = document.getElementById('formCarrier');

  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (app) {
    title.textContent = 'Edit Carrier Application';
    idInput.value   = app.iCarrierApplicationId;
    nameInput.value = app.name;
    carrierSel.value = app.eCarrierId;
    renderSettingsFields(app.eCarrierId, app.jsonSettings || {});
  } else {
    title.textContent = 'New Carrier Application';
    idInput.value   = '';
    nameInput.value = '';
    carrierSel.value = '';
    renderSettingsFields(null, {});
  }
}

function closeAppForm() {
  document.getElementById('appForm').classList.add('hidden');
  document.getElementById('formAppId').value  = '';
  document.getElementById('formName').value   = '';
  document.getElementById('formCarrier').value = '';
  document.getElementById('fieldsGroup').innerHTML = '';
}

function onCarrierChange() {
  const eCarrierId = Number(document.getElementById('formCarrier').value) || null;
  renderSettingsFields(eCarrierId, {});
}

function renderSettingsFields(eCarrierId, existing) {
  const group = document.getElementById('fieldsGroup');
  group.innerHTML = '';
  if (!eCarrierId) return;

  const fieldDefs = CARRIER_FIELDS[eCarrierId];

  if (fieldDefs) {
    // Structured fields for known carrier
    for (const def of fieldDefs) {
      const wrap = document.createElement('div');
      const label = document.createElement('label');
      label.setAttribute('for', 'field-' + def.key);
      label.className = 'block text-xs font-medium text-slate-500 mb-1';
      label.textContent = def.label;

      const input = document.createElement('input');
      input.id   = 'field-' + def.key;
      input.type = def.password ? 'password' : 'text';
      input.dataset.settingKey = def.key;
      input.value = existing[def.key] || '';
      input.className = 'w-full px-3 py-2 rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-sm transition-all bg-white';
      input.placeholder = def.label;

      wrap.appendChild(label);
      wrap.appendChild(input);
      group.appendChild(wrap);
    }
  } else {
    // Raw JSON textarea for unknown carriers
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.setAttribute('for', 'field-json');
    label.className = 'block text-xs font-medium text-slate-500 mb-1';
    label.textContent = 'Settings (JSON)';

    const ta = document.createElement('textarea');
    ta.id = 'field-json';
    ta.rows = 6;
    ta.dataset.settingKey = '__json__';
    ta.value = Object.keys(existing).length ? JSON.stringify(existing, null, 2) : '';
    ta.className = 'w-full px-3 py-2 rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-sm font-mono transition-all bg-white';
    ta.placeholder = '{\n  "apiKey": "..."\n}';

    wrap.appendChild(label);
    wrap.appendChild(ta);
    group.appendChild(wrap);
  }
}

function collectSettings() {
  const eCarrierId = Number(document.getElementById('formCarrier').value) || null;
  if (!eCarrierId) return null;

  const fieldDefs = CARRIER_FIELDS[eCarrierId];
  if (fieldDefs) {
    const settings = {};
    for (const def of fieldDefs) {
      const el = document.getElementById('field-' + def.key);
      settings[def.key] = el ? el.value.trim() : '';
    }
    return settings;
  }

  // Raw JSON path
  const ta = document.getElementById('field-json');
  if (!ta) return {};
  try {
    return JSON.parse(ta.value);
  } catch {
    showToast('Invalid JSON in settings.', false);
    return null;
  }
}

async function saveCarrierApp() {
  const id         = document.getElementById('formAppId').value;
  const name       = document.getElementById('formName').value.trim();
  const eCarrierId = Number(document.getElementById('formCarrier').value) || 0;
  const jsonSettings = collectSettings();

  if (!name)       { showToast('Name is required.', false); return; }
  if (!eCarrierId) { showToast('Select a carrier.', false); return; }
  if (!jsonSettings) return; // collectSettings already showed error

  const url    = id ? `/api/carrier-applications/${id}` : '/api/carrier-applications';
  const method = id ? 'PUT' : 'POST';

  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, eCarrierId, jsonSettings })
  });
  const data = await r.json();
  if (data.ok) {
    showToast(id ? 'Application updated.' : 'Application created.');
    closeAppForm();
    await loadCarrierApps();
    // Re-select the saved app in the business phone dropdown if it was already selected
    if (currentPhone?.iCarrierApplicationId) {
      document.getElementById('selectCarrierApp').value = currentPhone.iCarrierApplicationId;
    }
  } else {
    showToast(data.error || 'Save failed.', false);
  }
}

/* ── Init ── */

loadAll();
