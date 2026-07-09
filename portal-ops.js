// ══════════════════════════════════════════════════════════════
// TIERRAMOR OPS PORTAL — app.js
// Organizado por secciones: CONFIG · STATE · UTILS · API · AUTH ·
// UI/NAV · FORMS · REPORTS · INVENTORY · CHECKLISTS · MANUALS ·
// SCHEDULES · BOOT
// ══════════════════════════════════════════════════════════════

// ── CONFIG ──
const WEBHOOK = 'https://script.google.com/macros/s/AKfycbzGws5rH9g8si9f6efuqIBVrLE6TMQY6D1g8VlMXod43aWMxarDCd1JaxvDA5sOFn1T/exec';

// ── STATE ──
// Estado centralizado. Se mantienen las variables CU/CD/USERS/etc. para no romper
// referencias existentes en el resto del archivo, pero se accede/actualiza a través
// de AppState para tener un único punto de verdad y facilitar auditoría futura.
let CU = null, CD = null, pendingCL = null, activeRec = null, checkedMap = {};
let USERS = [];
let COLABS_LIMP  = [];
let COLABS_MANTO = [];
let ALL_COLABS   = [];

const AppState = {
  get currentUser() { return CU; },
  set currentUser(v) { CU = v; },
  get currentDept() { return CD; },
  set currentDept(v) { CD = v; },
  get users() { return USERS; },
  set users(v) { USERS = v; },
  get colabsLimpieza() { return COLABS_LIMP; },
  set colabsLimpieza(v) { COLABS_LIMP = v; },
  get colabsMantenimiento() { return COLABS_MANTO; },
  set colabsMantenimiento(v) { COLABS_MANTO = v; },
  get allColabs() { return ALL_COLABS; },
  set allColabs(v) { ALL_COLABS = v; },
};

// ── UTILS ──

// Evita desfases de zona horaria: usa la fecha local del navegador,
// no la UTC (new Date().toISOString() siempre es UTC).
function todayLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().split('T')[0];
}

// Escapa HTML para evitar XSS al insertar datos externos (Sheets/formularios)
// dentro de innerHTML.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Convierte un File a base64 (sin el prefijo data:...;base64,) para enviarlo
// a Apps Script, que lo puede decodificar y guardar en Drive.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const base64 = String(result).split(',')[1] || '';
      resolve({ name: file.name, mimeType: file.type || 'image/jpeg', data: base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Recolecta y convierte a base64 todas las fotos adjuntadas en un grupo del
// widget de fotos. Devuelve { ok, fotos, error }.
async function getPhotosPayload(groupId) {
  const files = (window._photos && window._photos[groupId]) ? window._photos[groupId] : [];
  if (!files.length) return { ok: true, fotos: [] };
  try {
    const fotos = await Promise.all(files.map(f => fileToBase64(f)));
    return { ok: true, fotos };
  } catch (e) {
    return { ok: false, error: 'No se pudieron procesar una o más fotos.' };
  }
}

function clearPhotoGroup(groupId) {
  if (window._photos) window._photos[groupId] = [];
  const prev = document.getElementById('prev-' + groupId);
  if (prev) prev.innerHTML = '';
  updatePhotoLabel(groupId, 3);
}

// ── API ──

async function loadConfigColabs() {
  try {
    const res  = await fetch(WEBHOOK + '?action=get_colabs');
    const data = await res.json();
    if (data.ok && data.colabs) {
      window._configColabs = data.colabs;
    } else {
      window._configColabs = [];
    }
  } catch(e) {
    window._configColabs = [];
  }
}

// Envío genérico al backend. Devuelve SIEMPRE un objeto { ok, error, ...resto }.
// Solo se considera éxito si el backend responde explícitamente { ok: true }.
async function sendToSheets(payload) {
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'text/plain' }
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* respuesta no-JSON */ }
    if (data && data.ok) {
      return Object.assign({ ok: true }, data);
    }
    return { ok: false, error: (data && data.error) ? data.error : 'El servidor no confirmó el envío. Intenta de nuevo.' };
  } catch (e) {
    console.error('Error enviando a Sheets:', e);
    return { ok: false, error: 'No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.' };
  }
}

function setLoading(txt) {
  document.getElementById('loading-txt').textContent = txt || 'Cargando...';
  document.getElementById('loading-overlay').classList.remove('hidden');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

// ── GUEST REPORTS ──

async function loadGuestReports(deptFilter) {
  // Reintenta hasta que el elemento exista en el DOM (máx 10 intentos x 200ms)
  let el = null;
  for (let i = 0; i < 10; i++) {
    el = document.getElementById('guest-reports-list');
    if (el) break;
    await new Promise(r => setTimeout(r, 200));
  }
  if (!el) return;
  try {
    const res  = await fetch(WEBHOOK + '?action=get_guest_reports');
    const data = await res.json();
    if (data.ok) {
      let reportes = data.reportes || [];
      // Cada colaborador (Limpieza/Mantenimiento) solo ve los reportes de
      // huésped que le corresponden a su departamento. El admin ve todos
      // (deptFilter no se pasa desde renderHome).
      if (deptFilter) reportes = reportes.filter(r => ((r.departamento || 'Mantenimiento').toString().trim()) === deptFilter);
      renderGuestReports(reportes);
    }
  } catch(e) {}
}

function renderGuestReports(reportes) {
  const el = document.getElementById('guest-reports-list');
  if (!el) return;
  window._guestData = {};
  reportes.forEach(r => { window._guestData[r.id] = r; });
  if (!reportes.length) { el.innerHTML = ''; return; }
  el.innerHTML = reportes.map(r => {
    let fechaStr = r.timestamp || '';
    if (fechaStr.length > 10) {
      try { fechaStr = new Date(fechaStr).toISOString().slice(0,10); } catch(e) { fechaStr = fechaStr.slice(0,10); }
    }
    const idAttr  = escapeHtml(r.id);
    const desc    = escapeHtml(r.descripcion || 'Sin descripción');
    const area    = escapeHtml(r.area || '');
    const fecha   = escapeHtml(fechaStr);
    return `<div class="rbtn" style="border-left-color:#717F7E;cursor:pointer;" id="gr-row-${idAttr}" onclick="openGuestModal('${idAttr}')">
      <div style="flex:1;">
        <div style="font-size:.82rem;font-family:var(--font-sans);color:var(--cream);font-weight:500;margin-bottom:.15rem;">${desc}</div>
        <div style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);">${area} · ${fecha}</div>
      </div>
      <span class="arr">›</span>
    </div>`;
  }).join('');
}

function openGuestModal(id) {
  const r = window._guestData?.[id];
  if (!r) return;
  document.getElementById('guest-modal-desc').textContent  = r.descripcion || '—';
  document.getElementById('guest-modal-area').textContent  = r.area || '—';
  document.getElementById('guest-modal-fecha').textContent = r.timestamp ? r.timestamp.slice(0,10) : '—';
  const btn = document.getElementById('guest-modal-btn');
  btn.onclick = () => { completarGuestReport(id); closeGuestModal(); };
  document.getElementById('guest-modal').classList.add('show');
}

function closeGuestModal() {
  document.getElementById('guest-modal').classList.remove('show');
}

async function completarGuestReport(id) {
  const row = document.getElementById('gr-row-' + id);
  if (row) row.style.opacity = '0.5';
  const res = await sendToSheets({ type:'completar_guest_report', id, usuario: CU?.usuario || '', colaborador: CU?.nombre || '' });
  if (res.ok) {
    if (row) row.remove();
  } else {
    if (row) row.style.opacity = '1';
    alert('No se pudo marcar el reporte como completado: ' + (res.error || 'error desconocido') + '. Intenta de nuevo.');
  }
}

// ── AVERÍAS ──

async function loadAverias() {
  const list = document.getElementById('averias-list');
  try {
    const res  = await fetch(WEBHOOK + '?action=get_averias');
    const data = await res.json();
    if (!list) return; // el usuario ya navegó a otra pantalla
    if (data.ok && data.averias) {
      renderAverias(data.averias);
    } else {
      list.innerHTML = `<div style="text-align:center;padding:1rem;font-size:.78rem;font-family:sans-serif;color:rgba(232,226,209,0.4);">No se pudieron cargar las averías.</div>`;
    }
  } catch(e) {
    if (list) list.innerHTML = `<div style="text-align:center;padding:1rem;font-size:.78rem;font-family:sans-serif;color:rgba(232,226,209,0.4);">No se pudieron cargar las averías.</div>`;
  }
}

function renderAverias(averias) {
  const list = document.getElementById('averias-list');
  if (!list) return;
  if (!averias.length) {
    list.innerHTML = `<div style="text-align:center;padding:1rem;font-size:.78rem;font-family:sans-serif;color:rgba(232,226,209,0.4);font-style:italic;">No hay averías pendientes </div>`;
    return;
  }
  window._averiasData = {};
  averias.forEach(a => { window._averiasData[a.id] = a; });
  const prioColor = { 'Urgente':'#E07A5F', 'Prioridad':'#C17A5A', 'Programar':'#9A9560' };
  list.innerHTML = averias.map(a => {
    const tituloRaw = a.averia || a.descripcion || a.area || a.cluster || '—';
    const subtituloRaw = [a.fecha ? a.fecha.slice(0,10) : '', a.cluster || a.area || ''].filter(Boolean).join(' · ');
    const idAttr = escapeHtml(a.id);
    const titulo = escapeHtml(tituloRaw);
    const subtitulo = escapeHtml(subtituloRaw);
    const color = prioColor[a.prioridad] || 'var(--clay)';
    return `<div class="rbtn" style="border-left-color:${color};cursor:pointer;" id="av-row-${idAttr}" onclick="openAveriaModal('${idAttr}')">
      <div style="flex:1;">
        <div style="font-size:.82rem;font-family:var(--font-sans);color:var(--cream);font-weight:500;margin-bottom:.15rem;">${titulo}</div>
        <div style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);">${subtitulo}</div>
      </div>
      <span class="arr">›</span>
    </div>`;
  }).join('');
}

function openAveriaModal(id) {
  const a = window._averiasData?.[id];
  if (!a) return;
  const prioColor = { 'Urgente':'#E07A5F', 'Prioridad':'#C17A5A', 'Programar':'#9A9560' };
  const prioBg    = { 'Urgente':'rgba(224,122,95,0.15)', 'Prioridad':'rgba(193,122,90,0.15)', 'Programar':'rgba(154,149,96,0.15)' };
  const prioIcon  = { 'Urgente':'', 'Prioridad':'', 'Programar':'' };
  const prior = a.prioridad || 'Programar';

  const priorEl = document.getElementById('averia-modal-prior');
  priorEl.textContent = `${prioIcon[prior]||''} ${prior}`;
  priorEl.style.color = prioColor[prior] || 'var(--clay)';
  priorEl.style.background = prioBg[prior] || 'rgba(153,92,68,0.15)';

  document.getElementById('averia-modal-titulo').textContent = a.averia || a.descripcion || '—';
  document.getElementById('averia-modal-desc').textContent  = a.descripcion || a.averia || 'Sin descripción adicional.';
  document.getElementById('averia-modal-area').textContent  = a.cluster || a.area || '—';
  const fechaRaw = a.fecha || a.timestamp || '';
  const fechaDisplay = fechaRaw.length > 10 ? fechaRaw.slice(0,10) : fechaRaw;
  document.getElementById('averia-modal-fecha').textContent = fechaDisplay || '—';

  const btn = document.getElementById('averia-modal-btn');
  btn.onclick = () => { marcarAveriaCompletada(id); closeAveriaModal(); };

  document.getElementById('averia-modal').classList.add('show');
}

function closeAveriaModal() {
  document.getElementById('averia-modal').classList.remove('show');
}

async function marcarAveriaCompletada(id) {
  const row = document.getElementById('av-row-' + id);
  if (row) row.style.opacity = '0.5';
  const res = await sendToSheets({ type:'actualizar_averia', id });
  if (res.ok) {
    if (row) row.remove();
  } else {
    if (row) row.style.opacity = '1';
    alert('No se pudo marcar la avería como completada: ' + (res.error || 'error desconocido') + '. Intenta de nuevo.');
  }
}

// ── SOLICITUDES DE HUÉSPED (Lavandería / Transporte / Tours) ──
// Vienen del guest-portal.html (mini-app del huésped) y usan el mismo patrón
// que las averías: se listan pendientes y se marcan como completadas contra
// el backend, sin asumir éxito hasta que este lo confirme.

const SOLICITUD_CONFIG = {
  'LAVANDERIA':     { action:'get_laundry_requests', color:'#8FACA9',
    titulo:(s)=> s['Nombre Huésped'] || '—',
    sub:(s)=> `Hab. ${s['Habitación']||'—'}${s['Hora de Recogida']?' · '+s['Hora de Recogida']:''}` },
  'TRANSPORTE':     { action:'get_transport_requests', color:'#8FACA9',
    titulo:(s)=> s['Destino'] || '—',
    sub:(s)=> `${s['Nombre Huésped']||''} · Hab. ${s['Habitación']||''}${s['Fecha']?' · '+s['Fecha']:''}${s['Hora']?' '+s['Hora']:''}` },
  'TOUR REQUESTS':  { action:'get_tour_requests', color:'#C17A5A',
    titulo:(s)=> s['Tour'] || '—',
    sub:(s)=> `${s['Nombre Huésped']||''} · Hab. ${s['Habitación']||''}${s['Fecha Preferida']?' · '+s['Fecha Preferida']:''}` },
};

async function loadSolicitudes(hoja, containerId) {
  const cfg = SOLICITUD_CONFIG[hoja];
  if (!cfg) return;
  let el = null;
  for (let i = 0; i < 10; i++) {
    el = document.getElementById(containerId);
    if (el) break;
    await new Promise(r => setTimeout(r, 200));
  }
  if (!el) return;
  try {
    const res  = await fetch(WEBHOOK + '?action=' + cfg.action);
    const data = await res.json();
    if (data.ok) renderSolicitudes(hoja, containerId, data.solicitudes || []);
    else el.innerHTML = `<div style="text-align:center;padding:.75rem;font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.4);">No se pudieron cargar.</div>`;
  } catch (e) {
    el.innerHTML = `<div style="text-align:center;padding:.75rem;font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.4);">No se pudieron cargar.</div>`;
  }
}

function renderSolicitudes(hoja, containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const cfg = SOLICITUD_CONFIG[hoja];
  const prefix = 'sol-' + hoja.replace(/\s+/g,'') + '-';
  window._solicitudesData = window._solicitudesData || {};
  window._solicitudesData[hoja] = {};
  items.forEach(s => { window._solicitudesData[hoja][s.id] = s; });

  if (!items.length) {
    el.innerHTML = `<div style="text-align:center;padding:.75rem;font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.35);font-style:italic;">Sin solicitudes pendientes</div>`;
    return;
  }
  el.innerHTML = items.map(s => {
    const idAttr = escapeHtml(s.id);
    return `<div class="rbtn" style="border-left-color:${cfg.color};" id="${prefix}${idAttr}">
      <div style="flex:1;">
        <div style="font-size:.82rem;font-family:var(--font-sans);color:var(--cream);font-weight:500;margin-bottom:.15rem;">${escapeHtml(cfg.titulo(s))}</div>
        <div style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);">${escapeHtml(cfg.sub(s))}</div>
      </div>
      <button onclick="marcarSolicitudCompletada('${hoja}','${idAttr}')" style="background:rgba(118,114,78,.2);border:1px solid rgba(118,114,78,.3);border-radius:8px;color:#A8A870;font-size:.65rem;padding:.35rem .65rem;cursor:pointer;flex-shrink:0;"></button>
    </div>`;
  }).join('');
}

async function marcarSolicitudCompletada(hoja, id) {
  const rowId = 'sol-' + hoja.replace(/\s+/g,'') + '-' + id;
  const row = document.getElementById(rowId);
  if (row) row.style.opacity = '0.5';
  const res = await sendToSheets({ type: 'completar_solicitud', hoja, id });
  if (res.ok) {
    if (row) row.remove();
  } else {
    if (row) row.style.opacity = '1';
    alert('No se pudo marcar como completada: ' + (res.error || 'error desconocido') + '. Intenta de nuevo.');
  }
}

// ── AUTH / SESIÓN ──
//
// La autenticación real (comparar usuario + contraseña) ocurre en el backend
// (Apps Script, acción POST "login"). El frontend nunca recibe ni maneja
// password_hash: get_usuarios ahora solo trae usuario, nombre, iniciales, rol
// y departamento (ver notas de cambios en Apps Script).

async function loadUsers(skipShowLogin) {
  try {
    setLoading('Cargando usuarios...');
    const res  = await fetch(`${WEBHOOK}?action=get_usuarios`);
    const data = await res.json();
    if (data.ok && data.usuarios && data.usuarios.length) {
      USERS = data.usuarios;
      COLABS_LIMP  = USERS.filter(u => u.departamento === 'limpieza').map(u => u.nombre);
      COLABS_MANTO = USERS.filter(u => u.departamento === 'mantenimiento').map(u => u.nombre);
      ALL_COLABS   = USERS.filter(u => u.rol === 'colaborador').map(u => u.nombre);
    }
  } catch(e) {
    console.warn('No se pudo cargar usuarios desde Sheets.');
  } finally {
    hideLoading();
    // Si ya se restauró una sesión válida desde localStorage, no interrumpir
    // mostrando la pantalla de login por encima.
    if (!skipShowLogin) show('ls');
  }
}

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0,0);
}
function nav(to) {
  stopRec();
  if (to === 'home') {
    if (CU && CU.rol !== 'admin') { renderDeptHome(); show('home'); }
    else { renderHome(); show('home'); }
  }
  else if (to === 'dept') openDept(CD);
}

function showCompletado(backFn, msg) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:var(--brown);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:999;padding:2rem;text-align:center;';
  const msgHtml = msg ? `<div style="color:var(--tm);font-size:.8rem;font-family:sans-serif;margin-bottom:1.5rem;line-height:1.5;">${escapeHtml(msg)}</div>` : '<div style="margin-bottom:1.5rem;"></div>';
  overlay.innerHTML = `
    <div style="color:var(--cream);font-size:1.4rem;font-style:italic;margin-bottom:.5rem;">Completado</div>
    ${msgHtml}
    <button style="background:var(--clay);border:none;border-radius:10px;padding:.85rem 2rem;color:var(--cream);font-size:.95rem;font-family:sans-serif;cursor:pointer;">
      Volver
    </button>`;
  overlay.querySelector('button').onclick = () => { overlay.remove(); if(backFn) backFn(); };
  document.body.appendChild(overlay);
  setTimeout(() => { if(overlay.parentElement) { overlay.remove(); if(backFn) backFn(); } }, 2500);
}

function goBack() {
  if (CU && CU.rol !== 'admin') { renderDeptHome(); show('home'); }
  else { nav('dept'); }
}

async function doLogin() {
  const u = document.getElementById('lu').value.trim().toLowerCase();
  const p = document.getElementById('lp').value;
  const btn = document.getElementById('btn-login');
  const errEl = document.getElementById('lerr');
  errEl.textContent = '';
  if (!u || !p) { errEl.textContent = 'Ingresa usuario y contraseña.'; return; }

  btn.textContent = 'Verificando...';
  btn.disabled = true;

  const res = await sendToSheets({ type: 'login', usuario: u, password: p });

  btn.textContent = 'Ingresar';
  btn.disabled = false;

  if (res.ok && res.usuario) {
    // Solo se guarda el usuario mínimo devuelto por el backend (sin password_hash).
    CU = res.usuario;
    try { localStorage.setItem('tm_session', JSON.stringify(CU)); } catch(e) {}
    errEl.textContent = '';
    document.getElementById('lp').value = '';
    if (CU.rol === 'admin') {
      renderHome();
      show('home');
    } else {
      renderDeptHome();
      show('home');
    }
    startGuestReportAlerts();
  } else {
    errEl.textContent = res.error && res.error !== 'El servidor no confirmó el envío. Intenta de nuevo.'
      ? res.error
      : 'Usuario o contraseña incorrectos.';
  }
}

function logout() { CU = null; stopRec(); stopGuestReportAlerts(); try { localStorage.removeItem('tm_session'); } catch(e) {} show('ls'); }

// ── ALERTAS EN PANTALLA: nuevos reportes de huésped (averías) ──
//
// Mientras el portal esté abierto y con sesión de Mantenimiento (o admin),
// se consulta get_guest_reports cada cierto tiempo. Si aparece un reporte
// de huésped que no se había visto en esta sesión, se muestra un banner
// en pantalla. Limitación real: si nadie tiene el portal abierto en ese
// momento, el aviso no llega — esto no sustituye una notificación push
// ni un correo; es un refuerzo visual para cuando el equipo está conectado.

const GUEST_ALERT_POLL_MS = 45000; // cada 45s
let _guestAlertSeenIds = null; // null = aún no se ha establecido la base
let _guestAlertTimer = null;

function startGuestReportAlerts() {
  stopGuestReportAlerts();
  if (!CU) return;
  // Solo Mantenimiento (quienes atienden las averías) y administradores.
  if (CU.departamento !== 'mantenimiento' && CU.rol !== 'admin') return;

  requestNotificationPermission_();

  _guestAlertSeenIds = null;
  pollGuestReportsForAlert(); // primera pasada: solo establece la base, sin alertar
  _guestAlertTimer = setInterval(pollGuestReportsForAlert, GUEST_ALERT_POLL_MS);
}

function stopGuestReportAlerts() {
  if (_guestAlertTimer) { clearInterval(_guestAlertTimer); _guestAlertTimer = null; }
  _guestAlertSeenIds = null;
}

async function pollGuestReportsForAlert() {
  if (!CU) return;
  try {
    const res  = await fetch(WEBHOOK + '?action=get_guest_reports');
    const data = await res.json();
    if (!data.ok || !data.reportes) return;

    if (_guestAlertSeenIds === null) {
      // Primera carga de esta sesión: registra lo que ya existe, sin avisar
      // (evita alertar por reportes que ya estaban pendientes antes de entrar).
      _guestAlertSeenIds = new Set(data.reportes.map(r => r.id));
      return;
    }

    const nuevos = data.reportes.filter(r => !_guestAlertSeenIds.has(r.id));
    nuevos.forEach(r => {
      _guestAlertSeenIds.add(r.id);
      showGuestReportAlertBanner(r);
    });
  } catch (e) {
    // Fallo de red silencioso: se reintenta en el próximo ciclo.
  }
}

function showGuestReportAlertBanner(reporte) {
  const id = 'guest-alert-' + (reporte.id || Date.now());
  if (document.getElementById(id)) return;

  const banner = document.createElement('div');
  banner.id = id;
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;'
    + 'background:#E07A5F;color:white;font-family:var(--font-sans);'
    + 'padding:.85rem 1rem;display:flex;align-items:center;gap:.75rem;'
    + 'box-shadow:0 4px 14px rgba(0,0,0,0.3);cursor:pointer;'
    + 'animation:guestAlertSlideIn .25s ease-out;';
  banner.innerHTML = `
    <span style="font-size:1.2rem;flex-shrink:0;"></span>
    <div style="flex:1;line-height:1.35;">
      <div style="font-size:.82rem;font-weight:600;">Nueva avería reportada por un huésped</div>
      <div style="font-size:.75rem;opacity:.9;">${escapeHtml(reporte.descripcion || 'Sin descripción')} — ${escapeHtml(reporte.area || '')}</div>
    </div>
    <button aria-label="Cerrar" style="background:none;border:none;color:white;font-size:1.3rem;cursor:pointer;line-height:1;padding:0 .25rem;">×</button>
  `;

  const cerrar = () => { if (banner.parentElement) banner.remove(); };
  banner.querySelector('button').onclick = (ev) => { ev.stopPropagation(); cerrar(); };
  banner.onclick = () => {
    cerrar();
    if (CU.rol === 'admin') { renderHome(); } else { renderDeptHome(); }
    show('home');
  };

  document.body.appendChild(banner);
  setTimeout(cerrar, 10000);
  playGuestAlertSound_();
  fireNativeNotification_(reporte);
}

// ── Notificaciones nativas del sistema (requieren permiso del navegador) ──
//
// A diferencia del banner (que solo se ve con la pestaña abierta y activa),
// una notificación nativa puede aparecer aunque Chrome esté en segundo plano
// (no cerrado). En celular esto depende del sistema operativo y puede no
// llegar si Chrome fue suspendido — sigue sin ser tan confiable como un
// correo, pero es un paso mejor que solo el banner.

function notificationsSupported_() {
  return typeof Notification !== 'undefined';
}

// Se llama tras un login exitoso (gesto real del usuario: el clic en
// "Ingresar"), que es cuando los navegadores permiten mostrar el diálogo
// de permiso de forma más confiable.
function requestNotificationPermission_() {
  if (!notificationsSupported_()) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(() => { updateNotifPermButton_(); });
  }
}

function fireNativeNotification_(reporte) {
  if (!notificationsSupported_() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(' Nueva avería reportada por un huésped', {
      body: (reporte.descripcion || 'Sin descripción') + ' — ' + (reporte.area || ''),
      icon: './Tierramor_Logomark_Stamp.png',
      tag: 'guest-averia-' + (reporte.id || Date.now()), // evita duplicados de la misma avería
    });
    n.onclick = () => {
      try { window.focus(); } catch(e) {}
      if (CU && CU.rol === 'admin') { renderHome(); } else { renderDeptHome(); }
      show('home');
      n.close();
    };
  } catch (e) { /* algunos navegadores/SO pueden bloquearlo silenciosamente */ }
}

// Botón manual "Activar notificaciones", por si el usuario no respondió el
// permiso durante el login (o entró con una sesión ya guardada, donde no
// hay un gesto de clic fresco para pedirlo automáticamente). Se inserta en
// la tarjeta de perfil solo para Mantenimiento/admin, y solo si aplica.
function notifPermButtonHtml_() {
  if (!CU || (CU.departamento !== 'mantenimiento' && CU.rol !== 'admin')) return '';
  if (!notificationsSupported_()) return '';
  if (Notification.permission === 'granted') return '';
  if (Notification.permission === 'denied') {
    return `<div style="font-size:.6rem;color:rgba(232,226,209,0.35);margin-top:.3rem;"> Notificaciones bloqueadas — actívalas desde la configuración del navegador</div>`;
  }
  return `<button id="notif-perm-btn" onclick="requestNotificationPermission_()" style="margin-top:.4rem;background:none;border:1px solid rgba(232,226,209,0.18);border-radius:8px;padding:.3rem .65rem;color:rgba(232,226,209,0.6);font-family:var(--font-sans);font-size:.65rem;cursor:pointer;"> Activar notificaciones de averías</button>`;
}

function updateNotifPermButton_() {
  const holder = document.getElementById('notif-perm-holder');
  if (holder) holder.innerHTML = notifPermButtonHtml_();
}

// Beep corto generado por audio, sin depender de ningún archivo externo.
// Los navegadores pueden bloquear audio sin interacción previa del usuario;
// si falla, el banner visual sigue funcionando igual.
function playGuestAlertSound_() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) { /* audio bloqueado o no soportado: se ignora */ }
}

// Inyecta la animación del banner una sola vez.
(function injectGuestAlertStyles_() {
  const style = document.createElement('style');
  style.textContent = '@keyframes guestAlertSlideIn { from { transform: translateY(-100%); } to { transform: translateY(0); } }';
  document.head.appendChild(style);
})();

// ── HOME / NAVEGACIÓN POR DEPARTAMENTO ──

function renderHome() {
  const isAdmin = CU.rol === 'admin';
  const deptLabel = { limpieza:'Limpieza', mantenimiento:'Mantenimiento', proveeduria:'Proveduría y Transportes', seguridad:'Seguridad', all:'Todos los Departamentos' };

  document.getElementById('home-profile').innerHTML = `
    <div class="lc">
      <div class="adm">
        <div class="pav">${escapeHtml(CU.iniciales)}</div>
        <div>
          <span class="pnm">${escapeHtml(CU.nombre.split(' ').slice(0,2).join(' '))}</span>
          <span class="pub-label">${escapeHtml(deptLabel[CU.departamento]||CU.departamento)} · ${escapeHtml(CU.rol)}</span>
        </div>
        <div class="pub-icon">
          <a href="https://app.talentify.cr/" target="_blank" class="actl">Talentify</a>
          <button class="sico" onclick="logout()">Salir</button>
        </div>
      </div>
      <div id="notif-perm-holder">${notifPermButtonHtml_()}</div>
    </div>
    <div class="swrap">
      <img src="./Tierramor_Logomark_Stamp.png" alt="Tierramor" style="height:14px;opacity:0.28;filter:brightness(2);">&nbsp;<span class="mst" style="vertical-align:middle;">·&nbsp; Portal Operativo</span>
    </div>`;

  const deptCfg = {
    limpieza:      { lbl:'Limpieza',                 sub:'Manuales, checklists e inventarios',   ico:'HK', cls:'a' },
    mantenimiento: { lbl:'Mantenimiento',             sub:'Manuales preventivos y reportes',      ico:'MT', cls:'b' },
    proveeduria:   { lbl:'Proveduría y Transportes', sub:'Calendario y recursos operativos',      ico:'PT', cls:'c' },
    seguridad:     { lbl:'Seguridad',                sub:'Protocolos y reportes de incidencias',  ico:'SG', cls:'d' },
  };

  const showDepts = isAdmin ? ['limpieza','mantenimiento','proveeduria','seguridad'] : [CU.departamento];
  const GUEST_SECTION = `<div id="guest-reports-section" style="margin-bottom:1rem;">
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;padding:.45rem .7rem;background:rgba(113,127,126,0.15);border:1px solid rgba(113,127,126,0.25);border-radius:8px;">
      <span style="font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:#8FACA9;font-family:var(--font-sans);"> Reportes de Huéspedes</span>
    </div>
    <div id="guest-reports-list"></div>
  </div>`;

  // Solicitudes de Tour del guest-portal — solo Admin las gestiona.
  const TOURS_SECTION = isAdmin ? `<div id="tours-section" style="margin-bottom:1rem;">
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;padding:.45rem .7rem;background:rgba(193,122,90,0.15);border:1px solid rgba(193,122,90,0.25);border-radius:8px;">
      <span style="font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:#C17A5A;font-family:var(--font-sans);"> Solicitudes de Tours</span>
    </div>
    <div id="tour-requests-list"></div>
  </div>` : '';

  const STAT_HTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:1.2rem;">
    <div class="stat-blue" style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:12px;padding:.9rem;text-align:center;">
      <div style="font-size:.55rem;text-transform:uppercase;letter-spacing:.18em;color:rgba(113,127,126,0.7);font-family:var(--font-sans);margin-bottom:.35rem;">Esta semana</div>
      <div style="font-size:2rem;font-family:var(--font-serif);font-style:italic;color:rgba(232,226,209,0.3);">—</div>
      <div style="font-size:.6rem;font-family:var(--font-sans);color:rgba(232,226,209,0.3);">% cumplimiento</div>
    </div>
    <div class="stat-green" style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:12px;padding:.9rem;text-align:center;">
      <div style="font-size:.55rem;text-transform:uppercase;letter-spacing:.18em;color:rgba(118,114,78,0.7);font-family:var(--font-sans);margin-bottom:.35rem;">Este mes</div>
      <div style="font-size:2rem;font-family:var(--font-serif);font-style:italic;color:rgba(232,226,209,0.3);">—</div>
      <div style="font-size:.6rem;font-family:var(--font-sans);color:rgba(232,226,209,0.3);">% cumplimiento</div>
    </div>
  </div>`;

  let btns = GUEST_SECTION + TOURS_SECTION + STAT_HTML + `<div class="sec-lbl lbl-blue">${isAdmin ? 'Departamentos' : 'Tu área de trabajo'}</div>`;

  if (isAdmin) {
    btns += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:.75rem;">`;
  }

  showDepts.forEach(d => {
    const c = deptCfg[d];
    if (!c) return;
    btns += `<button class="dept-btn dept-${d}" onclick="openDept('${d}')">
      <div class="dico ${c.cls}">${c.ico}</div>
      <div class="dinf"><h3>${c.lbl}</h3></div>
    </button>`;
  });

  if (isAdmin) {
    btns += `</div>`;
  }

  if (isAdmin) {
    btns += `<button class="dept-btn" onclick="openTeamPerformance()">
      <div class="dico d">DE</div>
      <div class="dinf"><h3>Desempeño del Equipo</h3><p>Cumplimiento por colaborador</p></div>
      <span class="dbadge adm">Admin</span>
    </button>
    <button class="dept-btn" onclick="openReports()">
      <div class="dico d">RP</div>
      <div class="dinf"><h3>Reportes</h3><p>Revisión de reportes enviados</p></div>
      <span class="dbadge adm">Admin</span>
    </button>`;
  } else {
    btns += `<button class="dept-btn" onclick="openMyPerformance()">
      <div class="dico d" style="background:rgba(115,81,69,.15);">DE</div>
      <div class="dinf"><h3>Mi Desempeño</h3><p>KPIs, cumplimiento y reportes</p></div>
      <span class="dbadge adm">Personal</span>
    </button>`;
  }

  document.getElementById('home-depts').innerHTML = btns + '<div class="tm-page-footer"><img src="./Tierramor_Emblem-Brown.png" alt="" style="height:36px;opacity:0.18;filter:brightness(2);"></div>';
  setTimeout(() => loadGuestReports(), 300); // admin ve reportes de huésped de ambos departamentos
  if (isAdmin) setTimeout(() => loadSolicitudes('TOUR REQUESTS', 'tour-requests-list'), 300);
}

// ── DEPT HOME (no-admin) ──
function renderDeptHome() {
  const deptCfg = {
    limpieza:      { lbl:'Limpieza',                 sub:'Manuales, checklists e inventarios',  ico:'HK', cls:'a' },
    mantenimiento: { lbl:'Mantenimiento',             sub:'Manuales preventivos y reportes',     ico:'MT', cls:'b' },
    proveeduria:   { lbl:'Proveduría y Transportes', sub:'Calendario y recursos operativos',     ico:'PT', cls:'c' },
    seguridad:     { lbl:'Seguridad',                sub:'Protocolos y reportes de incidencias', ico:'SG', cls:'d' },
  };
  const d = CU.departamento;
  CD = d; // establece el dept activo para que nav('dept') funcione
  const cfg = deptCfg[d] || { lbl:d, sub:'', ico:'OP', cls:'a' };
  document.getElementById('home').className = 'screen home-' + d;

  document.getElementById('home-profile').innerHTML = `
    <div class="lc">
      <div class="adm">
        <div class="pav">${escapeHtml(CU.iniciales)}</div>
        <div>
          <span class="pnm">${escapeHtml(CU.nombre.split(' ').slice(0,2).join(' '))}</span>
          <span class="pub-label">${escapeHtml(cfg.lbl)} · colaborador</span>
        </div>
        <div class="pub-icon">
          <a href="https://app.talentify.cr/" target="_blank" class="actl">Talentify</a>
          <button class="sico" onclick="logout()">Salir</button>
        </div>
      </div>
      <div id="notif-perm-holder">${notifPermButtonHtml_()}</div>
    </div>
    <div class="swrap">
      <img src="./Tierramor_Logomark_Stamp.png" alt="Tierramor" style="height:14px;opacity:0.28;filter:brightness(2);">&nbsp;<span class="mst" style="vertical-align:middle;">·&nbsp; Portal Operativo</span>
    </div>`;

  const dept = DEPTS[d];
  // El bloque de "Reportes de Huéspedes" ahora solo aplica a Limpieza y
  // Mantenimiento (los únicos departamentos que el huésped puede elegir en
  // el guest-portal). Seguridad y Proveeduría ya no lo ven.
  const GUEST_BAND = (d === 'limpieza' || d === 'mantenimiento') ? `<div style="margin-bottom:.75rem;">
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;padding:.45rem .7rem;background:rgba(113,127,126,0.15);border:1px solid rgba(113,127,126,0.25);border-radius:8px;">
      <span style="font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:#8FACA9;font-family:var(--font-sans);"> Reportes de Huéspedes</span>
    </div>
    <div id="guest-reports-list"><div style="text-align:center;padding:.5rem;font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.35);">Cargando...</div></div>
  </div>` : '';

  // Solicitudes de servicio del guest-portal: Lavandería  Limpieza, Transporte  Proveeduría.
  const SERVICE_BAND = (d === 'limpieza') ? `<div style="margin-bottom:.75rem;">
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;padding:.45rem .7rem;background:rgba(143,172,169,0.15);border:1px solid rgba(143,172,169,0.25);border-radius:8px;">
      <span style="font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:#8FACA9;font-family:var(--font-sans);"> Solicitudes de Lavandería</span>
    </div>
    <div id="laundry-requests-list"><div style="text-align:center;padding:.5rem;font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.35);">Cargando...</div></div>
  </div>` : (d === 'proveeduria') ? `<div style="margin-bottom:.75rem;">
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;padding:.45rem .7rem;background:rgba(143,172,169,0.15);border:1px solid rgba(143,172,169,0.25);border-radius:8px;">
      <span style="font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:#8FACA9;font-family:var(--font-sans);"> Solicitudes de Transporte</span>
    </div>
    <div id="transport-requests-list"><div style="text-align:center;padding:.5rem;font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.35);">Cargando...</div></div>
  </div>` : '';

  let btns = GUEST_BAND + SERVICE_BAND + `<div class="sec-lbl" style="margin-top:.5rem;">Tu área de trabajo</div>`;

  if (dept) {
    dept.resources.forEach(r => {
      btns += `<button class="dept-btn" onclick="openResource('${r.id}','${r.title}','${r.type||'doc'}')">
        <div class="dico ${cfg.cls}">${cfg.ico}</div>
        <div class="dinf"><h3>${r.title}</h3><p>${r.desc||''}</p></div>
        
      </button>`;
    });
    if (dept.reports.length) {
      btns += `<div class="sec-lbl" style="margin-top:.6rem;">Reportes</div>`;
      dept.reports.forEach(r => {
        btns += `<button class="rbtn ${r.cls}" onclick="openForm('${r.form}')">
          <div class="rdot"></div><span>${r.label}</span>
        </button>`;
      });
    }
  }

  if (d === 'mantenimiento') {
    btns += `<div class="sec-lbl" style="margin-top:.75rem;">Averías Pendientes</div>
      <div id="averias-list"><div style="text-align:center;padding:1rem;font-size:.78rem;font-family:sans-serif;color:rgba(232,226,209,0.4);">Cargando...</div></div>`;
  }

  document.getElementById('home-depts').innerHTML = btns + '<div class="tm-page-footer"><img src="./Tierramor_Emblem-Brown.png" alt="" style="height:36px;opacity:0.18;filter:brightness(2);"></div>';
  // Reportes de huésped filtrados por el departamento de este colaborador
  // (Limpieza solo ve los suyos, Mantenimiento solo los suyos).
  if (d === 'limpieza' || d === 'mantenimiento') {
    const deptLabelReporte = d === 'limpieza' ? 'Limpieza' : 'Mantenimiento';
    loadGuestReports(deptLabelReporte);
  }
  if (d === 'mantenimiento') loadAverias();
  if (d === 'limpieza') loadSolicitudes('LAVANDERIA', 'laundry-requests-list');
  if (d === 'proveeduria') loadSolicitudes('TRANSPORTE', 'transport-requests-list');
}

const DEPTS = {
  limpieza: {
    label: 'Limpieza',
    resources: [
      { id:'manual-limp',   title:'Manual de Limpieza General', desc:'Procedimientos y estándares', type:'doc' },
      { id:'inventarios',   title:'Inventarios',                 desc:'Control de insumos',           type:'inventarios' },
      { id:'insumos-limp',  title:'Insumos',                     desc:'Catálogo y solicitud',          type:'insumos' },
      { id:'frases-en',     title:'Frases Comunes en Inglés',     desc:'Interacciones rápidas con huéspedes' },
      { id:'cal-limpieza',  title:'Calendario',                   desc:'Turnos y eventos del equipo',  type:'cal' },
    ],
    reports: [
      { label:'Reporte de Área',        form:'reporte-area', cls:'' },
      { label:'Repaso de Habitaciones', form:'repaso-hab',   cls:'' },
      { label:'Reporte de Avería',      form:'averia',       cls:'averia' },
      { label:'Reunión de Operaciones', form:'reunion',      cls:'' },
    ]
  },
  mantenimiento: {
    label: 'Mantenimiento',
    resources: [
      { id:'manual-prev',       title:'Manual de Mantenimiento', desc:'Estándares y procedimientos',   type:'doc' },
      { id:'mapa-propiedad',    title:'Mapa de la Propiedad',    desc:'Vista aérea · Clusters y zonas', type:'mapa' },
      { id:'operacion-piscina', title:'Operación de Piscina',    desc:'Checklist y parámetros',        type:'piscina' },
      { id:'cal-manto-multi',   title:'Calendarios de Mantenimiento', desc:'Tareas programadas y eventos', type:'cal-multi' },
    ],
    reports: [
      { label:'Inspección de Cluster',   form:'averia-cluster', cls:'' },
      { label:'Reporte de Trabajo',      form:'trabajo',    cls:'' },
      { label:'Reporte de Agua',         form:'agua',       cls:'' },
      { label:'Reporte de Avería',       form:'averia',     cls:'averia' },
      { label:'Solicitud de Materiales', form:'materiales', cls:'materiales' },
      { label:'Reunión de Operaciones',  form:'reunion',    cls:'' },
    ]
  },
  proveeduria: {
    label: 'Proveduría y Transportes',
    resources: [
      { id:'cal-transporte', title:'Calendario de Transportes', desc:'Viajes y logística',             type:'cal' },
      { id:'proveedores',    title:'Catálogo de Proveedores',   desc:'Contactos, productos y crédito', type:'proveedores' },
    ],
    reports: [
      { label:'Solicitud de Herramientas', form:'herramientas',  cls:'' },
      { label:'Uso de Cuadraciclo',        form:'cuadraciclo',   cls:'' },
      { label:'Reporte de Avería',         form:'averia',        cls:'averia' },
      { label:'Reunión de Operaciones',    form:'reunion',       cls:'' },
    ]
  },
  seguridad: {
    label: 'Seguridad',
    resources: [
      { id:'manual-seg',    title:'Manual de Seguridad',    desc:'Próximamente disponible' },
      { id:'checklist-seg', title:'Checklist de Seguridad', desc:'Próximamente disponible' },
    ],
    reports: [
      { label:'Reporte de Incidencia', form:'incidencia', cls:'averia' },
    ]
  },
};

function openDept(dept) {
  CD = dept;
  const d = DEPTS[dept];
  if (!d) return;
  document.getElementById('dept').className = 'screen dept-' + dept;
  document.getElementById('dept-title').textContent = d.label;
  document.getElementById('rgrid').innerHTML = d.resources.map(r =>
    `<div class="gcard" onclick="openResource('${r.id}','${r.title}','${r.type||'doc'}')">
      <div class="ct">${r.title}</div><div class="cd">${r.desc||''}</div>
    </div>`).join('');
  const avSec = document.getElementById('averias-section');
  if (dept === 'mantenimiento') {
    avSec.innerHTML = `<div class="glbl">Averías Pendientes</div><div id="averias-list"><div style="text-align:center;padding:1rem;font-size:.78rem;font-family:sans-serif;color:rgba(232,226,209,0.4);">Cargando...</div></div>`;
    loadAverias();
  } else {
    avSec.innerHTML = '';
  }  const rl   = document.getElementById('rlist');
  const rlbl = document.getElementById('rlist-lbl');
  if (d.reports.length) {
    rlbl.style.display = '';
    rl.innerHTML = d.reports.map(r =>
      `<button class="rbtn ${r.cls}" onclick="openForm('${r.form}')">
        <div class="rdot"></div><span>${r.label}</span>
      </button>`).join('');
  } else {
    rlbl.style.display = 'none';
    rl.innerHTML = '';
  }
  show('dept');
}

function filterCards() {
  const el = document.getElementById('si');
  if (!el) return;
  const q = el.value.toLowerCase();
  document.querySelectorAll('.gcard').forEach(c => {
    c.style.display = c.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

// ── RECURSOS / FRASES / REPASO DE HABITACIONES ──

function openResource(id, title, type) {
  if (type === 'checklist')   { openChecklistMenu(id); return; }
  if (type === 'cal')         { openCalendar(id); return; }
  if (type === 'cal-multi')   { openCalendarMultiManto(); return; }
  if (type === 'mapa')        { openMapaTierramor(); return; }
  if (type === 'inventarios') { openInventarios(); return; }
  if (type === 'proveedores') { openProveedores(); return; }
  if (type === 'piscina')     { openOperacionPiscina(); return; }
  if (type === 'insumos')     { openInsumosLimp(); return; }
  if (type === 'schedule')    { openScheduleDelDia(); return; }
  if (id === 'frases-en') {
    const FRASES = [
      { sec:'Saludos rápidos', items:[
        ['Good morning!','¡Buenos días!','Gud mórning!'],
        ['Good afternoon!','¡Buenas tardes!','Gud afternún!'],
        ['How are you doing?','¿Cómo está?','Jáu ar iú dúing?'],
      ]},
      { sec:'Sí / No / Cortesía', items:[
        ['Yes, of course.','Sí, claro.','Iés, of cors.'],
        ['One moment, please.','Un momento, por favor.','Uán móument, plis.'],
        ["You're welcome.",'Con gusto / De nada.','Iór uélcom.'],
        ['No problem at all.','No hay ningún problema.','Nóu próblem at ol.'],
      ]},
      { sec:'Entendimiento', items:[
        ['Sorry, could you repeat that?','Disculpe, ¿puede repetir eso?','Sóri, cud iú ripít dat?'],
        ["I don't speak English very well.",'No hablo inglés muy bien.','Ai dont spik ínglish véri uél.'],
        ["I'll find someone who speaks English.",'Voy a buscar a alguien que hable inglés.','Áil fáind samuán ju spiks ínglish.'],
      ]},
      { sec:'Ofrecer ayuda', items:[
        ['Can I help you with that?','¿Puedo ayudarle con eso?','Can ai jelp iú uíz dat?'],
        ['Right this way, please.','Por aquí, por favor.','Ráit dis uéi, plis.'],
        ['Follow me, please.','Sígame, por favor.','Fólou mi, plis.'],
      ]},
      { sec:'Ubicación rápida', items:[
        ["It's right over there.",'Está justo allá.','Its ráit óuver der.'],
        ["It's this way.",'Es por aquí.','Its dis uéi.'],
        ['Just around the corner.','Justo a la vuelta.','Yost eráund de córner.'],
      ]},
      { sec:'Cierre de interacción', items:[
        ['Enjoy your stay!','¡Disfrute su estadía!','Enyói iór stéi!'],
        ['Have a great day!','¡Que tenga un buen día!','Jav e gréit déi!'],
        ['See you later!','¡Nos vemos luego!','Sii iú léiter!'],
      ]},
    ];
    const html = FRASES.map(group => `
      <div class="sec-band band-blue">${group.sec}</div>
      ${group.items.map(([en,es,pron]) => `
        <div style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:10px;padding:.8rem .9rem;margin-bottom:.5rem;">
          <div style="font-family:var(--font-serif);font-style:italic;font-size:1rem;color:var(--cream);margin-bottom:.3rem;">${en}</div>
          <div style="font-size:.78rem;font-family:var(--font-sans);color:rgba(232,226,209,0.65);margin-bottom:.2rem;">${es}</div>
          <div style="font-size:.72rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);font-style:italic;"> ${pron}</div>
        </div>`).join('')}
    `).join('');
    setConScreen('Frases Comunes en Inglés', () => goBack(), html);
    return;
  }

  setConScreen(title, () => goBack(), getDocContent(id, title));
}

function openRepasoHab(habitacion) {
  const today = todayLocal();
  const colabOpts = COLABS_LIMP.map(n=>`<option${CU&&n===CU.nombre?' selected':''}>${escapeHtml(n)}</option>`).join('');
  const backFn = () => openForm('repaso-hab');
  setConScreen(`Repaso — ${habitacion}`, backFn,
    `<div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1rem;">Registra el repaso de esta habitación</div>
     <div class="fg"><label>Colaboradora</label>
       <select id="rh-colab"><option value="">— Seleccionar —</option>${colabOpts}</select>
     </div>
     <div class="fg"><label>Fecha</label>
       <input type="date" id="rh-fecha" value="${today}">
     </div>
     <div class="fg"><label>Observaciones</label>
       ${aw('rh-notas','Estado de la habitación, observaciones, incidencias...')}
     </div>
     ${photoUploadWidget('rh-photos')}
     <button class="btn-sub" id="rh-btn" onclick="submitRepasoHab('${habitacion}')">Enviar Repaso</button>
     <div class="fnote">Los datos se guardarán en Google Sheets</div>
     <div class="err-msg" id="rh-err"><p>Error al enviar. Intenta de nuevo.</p></div>`
  );
}

async function submitRepasoHab(habitacion) {
  const colab = document.getElementById('rh-colab')?.value;
  if (!colab) { alert('Por favor selecciona la colaboradora.'); return; }
  const btn = document.getElementById('rh-btn');
  btn.disabled = true; btn.textContent = 'Enviando...';

  const fotosRes = await getPhotosPayload('rh-photos');
  if (!fotosRes.ok) {
    document.getElementById('rh-err').querySelector('p').textContent = fotosRes.error;
    document.getElementById('rh-err').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Enviar Repaso';
    return;
  }

  const datos = {
    colaborador: colab,
    fecha:       document.getElementById('rh-fecha')?.value || '',
    habitacion,
    obs:         document.getElementById('ta-rh-notas')?.value || '',
    fotos:       fotosRes.fotos,
  };
  const res = await sendToSheets({
    type: 'reporte', usuario: CU.usuario, departamento: 'limpieza',
    tipo: 'repaso-hab', datos
  });
  if (res.ok) {
    clearPhotoGroup('rh-photos');
    showCompletado(() => openForm('repaso-hab'));
  } else {
    document.getElementById('rh-err').querySelector('p').textContent = (res.error || 'Error al enviar. Intenta de nuevo.');
    document.getElementById('rh-err').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Enviar Repaso';
  }
}

let matCount = 1;
function matRow(idx) {
  const unidades = ['Unidad','Paquete','Kilo (kg)','Gramo (g)','Litro (L)','Mililitro (mL)','Galón','Rollo','Caja','Bolsa','Par','Metro','Otro'];
  return `<div id="mat-row-${idx}" style="display:grid;grid-template-columns:1.8fr .8fr 1fr auto;gap:.4rem;margin-bottom:.55rem;align-items:center;">
    <input type="text" id="mat-item-${idx}" placeholder="Material o herramienta" style="background:#fafaf8;border:1px solid rgba(84,66,54,.2);border-radius:8px;padding:.6rem .7rem;font-size:.85rem;font-family:sans-serif;color:#3d2f26 !important;-webkit-text-fill-color:#3d2f26 !important;outline:none;">
    <input type="number" id="mat-qty-${idx}" placeholder="Cant." min="1" style="background:#fafaf8;border:1px solid rgba(84,66,54,.2);border-radius:8px;padding:.6rem .7rem;font-size:.85rem;font-family:sans-serif;color:#3d2f26 !important;-webkit-text-fill-color:#3d2f26 !important;outline:none;">
    <select id="mat-unit-${idx}" style="background:#fafaf8;border:1px solid rgba(84,66,54,.2);border-radius:8px;padding:.6rem .5rem;font-size:.78rem;font-family:sans-serif;color:var(--brown);outline:none;appearance:none;">${unidades.map(u=>`<option value="${u}" style="color:#3d2f26;background:#fafaf8;">${u}</option>`).join('')}</select>
    ${idx > 0 ? `<button onclick="removeMatRow(${idx})" style="width:28px;height:28px;border-radius:50%;border:1.5px solid rgba(84,66,54,.2);background:none;color:var(--tm);font-size:1rem;cursor:pointer;line-height:1;">×</button>` : '<div style="width:28px;"></div>'}
  </div>`;
}
function addMatRow() { document.getElementById('mat-list').insertAdjacentHTML('beforeend', matRow(matCount)); matCount++; }
function removeMatRow(idx) { document.getElementById('mat-row-' + idx)?.remove(); }

let avcCount = 0;
function avcRow(idx) {
  return `<div id="avc-row-${idx}" style="background:#fafaf8;border:1px solid rgba(84,66,54,.15);border-radius:10px;padding:.75rem;margin-bottom:.6rem;">
    <div style="display:flex;gap:.4rem;align-items:flex-start;margin-bottom:.5rem;">
      <input type="text" id="avc-averia-${idx}" placeholder="Avería (ej: Fuga de agua)" style="flex:1;background:white;border:1px solid rgba(84,66,54,.2);border-radius:8px;padding:.6rem .7rem;font-size:.85rem;font-family:sans-serif;color:var(--brown);outline:none;">
      <select id="avc-prior-${idx}" style="width:120px;background:white;border:1px solid rgba(84,66,54,.2);border-radius:8px;padding:.6rem .4rem;font-size:.75rem;font-family:sans-serif;color:var(--brown);outline:none;appearance:none;">
        <option value="Urgente"> Urgente</option>
        <option value="Prioridad"> Prioridad</option>
        <option value="Programar"> Programar</option>
      </select>
      <button onclick="removeAvcRow(${idx})" style="width:32px;height:32px;flex-shrink:0;border-radius:50%;border:1.5px solid rgba(84,66,54,.2);background:none;color:var(--tm);font-size:1rem;cursor:pointer;line-height:1;${idx===0?'visibility:hidden;':''}">×</button>
    </div>
    <textarea id="avc-desc-${idx}" placeholder="Descripción de la avería..." style="width:100%;background:white;border:1px solid rgba(84,66,54,.2);border-radius:8px;padding:.6rem .7rem;font-size:.82rem;font-family:sans-serif;color:var(--brown);outline:none;resize:none;height:54px;line-height:1.4;margin-bottom:.5rem;"></textarea>
    <div style="border:1.5px dashed rgba(84,66,54,.2);border-radius:8px;padding:.5rem;text-align:center;font-size:.68rem;font-family:sans-serif;color:rgba(84,66,54,.4);"> Foto de esta avería — próximamente</div>
  </div>`;
}
function addAvcRow() { document.getElementById('avc-list').insertAdjacentHTML('beforeend', avcRow(avcCount)); avcCount++; }
function removeAvcRow(idx) { document.getElementById('avc-row-' + idx)?.remove(); }

function openInsumosLimp() {
  setConScreen('Insumos', () => goBack(),
    `<div style="font-size:.78rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1.2rem;">Gestión de insumos del departamento de Limpieza</div>
     <div class="gcard" onclick="openCatalogoProductos()" style="margin-bottom:.7rem;">
       <div class="ct">Catálogo de Productos</div>
       <div class="cd">Insumos aprobados para uso en Tierramor</div>
     </div>
     <div class="gcard" onclick="openSolicitudInsumos()">
       <div class="ct">Solicitud de Insumos</div>
       <div class="cd">Solicita los insumos que necesitas</div>
     </div>`);
}

function setConScreen(title, backFn, html) {
  document.getElementById('con-title').textContent = title;
  document.getElementById('con-back').onclick = backFn;
  document.getElementById('conbody').innerHTML = html;
  show('con-screen');
}

function getDocContent(id, title) {
  if (id === 'manual-limp') return renderManualLimp();
  if (id === 'manual-prev') return renderManualManto();
  return `<div class="cs"><div class="csi"></div><h3>${escapeHtml(title)}</h3><p>El contenido estará disponible aquí próximamente.</p></div>`;
}

const CAL_IDS = {
  'cal-limpieza':   'c_054c31b4e8e09f946d99b72bf667d10578fd7db7427906dd3604c39926371484@group.calendar.google.com',
  'cal-manto':      'c_13962be80e3d98529a539831bf1b832b9f1839925686f69f57b2bf86dc06984e@group.calendar.google.com',
  'cal-manto2':     'c_60a16386fb2ab8d0fe5741796d9f76100dd4ef3e8a36120837aa4ad2ca85ba00@group.calendar.google.com',
  'cal-transporte': 'c_3d9aa6550f8f2406c869c3f26c6c5779ddbadcacae515f94bbd8b8818ae27d12@group.calendar.google.com',
};
const CAL_LABELS = { 'cal-limpieza':'Limpieza', 'cal-manto':'Mantenimiento', 'cal-manto2':'Mantenimiento', 'cal-transporte':'Proveduría y Transportes' };

function openCalendar(id) {
  const calId = CAL_IDS[id], label = CAL_LABELS[id];
  const src = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calId)}&ctz=America%2FCosta_Rica&showTitle=0&showNav=1&showDate=1&showPrint=0&showTabs=0&showCalendars=0&mode=MONTH&bgcolor=%23E8E2D1&color=%23995C44`;
  setConScreen(`Calendario — ${label}`, () => goBack(),
    `<div style="font-size:.75rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);font-style:italic;margin-bottom:.9rem;">Calendario de ${label} · Solo lectura</div>
     <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:12px;overflow:hidden;">
       <iframe src="${src}" style="border:none;width:100%;height:520px;display:block;" frameborder="0" scrolling="no"></iframe>
     </div>
     <div style="font-size:.68rem;font-family:var(--font-sans);color:rgba(232,226,209,0.35);text-align:center;margin-top:.75rem;line-height:1.5;">Para agregar o editar eventos, hazlo directamente en Google Calendar.</div>`);
}

function openCalendarMultiManto() {
  const ids = ['cal-manto', 'cal-manto2'];
  const blocks = ids.map(id => {
    const calId = CAL_IDS[id];
    const src = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calId)}&ctz=America%2FCosta_Rica&showTitle=0&showNav=1&showDate=1&showPrint=0&showTabs=0&showCalendars=0&mode=MONTH&bgcolor=%23E8E2D1&color=%23995C44`;
    return `<div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:12px;overflow:hidden;margin-bottom:1.2rem;">
       <iframe src="${src}" style="border:none;width:100%;height:480px;display:block;" frameborder="0" scrolling="no"></iframe>
     </div>`;
  }).join('');
  setConScreen('Calendarios de Mantenimiento', () => goBack(),
    `<div style="font-size:.75rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);font-style:italic;margin-bottom:.9rem;">Tareas programadas y eventos · Solo lectura</div>
     ${blocks}
     <div style="font-size:.68rem;font-family:var(--font-sans);color:rgba(232,226,209,0.35);text-align:center;margin-top:.25rem;line-height:1.5;">Para agregar o editar eventos, hazlo directamente en Google Calendar.</div>`);
}

function openProveedores() {
  setConScreen('Catálogo de Proveedores', () => goBack(),
    `<div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1rem;">Directorio de proveedores activos de Tierramor</div>
     <div class="cs"><h3>Próximamente disponible</h3><p>El catálogo de proveedores estará aquí.</p></div>`);
}

// ── INVENTARIOS ──

const ROPA_ITEMS = ['Topper Individual','Topper Matrimonial','Topper King','Forro de cama Individual','Forro de cama Queen','Forro de cama King','Sábana Individual','Sábana Queen','Sábana King','Cubre Duvet Individual','Cubre Duvet Queen','Cubre Duvet King','Duvet Individual','Duvet Queen','Duvet King','Pie de cama','Forro de almohada Standard','Forro de almohada King','Almohada Standard','Almohada King','Almohadones de Decoración','Toallas','Puente de Cama','Alfombra de Bambú','Alfombra de Fibra de Coco','Mosquitero Individual','Mosquitero King'];
const PROPS_MALOCA   = ['Matts de yoga negros','Blocks de yoga','Correas de yoga','Almohadones (Bolsters)','Candelas','Alfombras de yute'];
const PROPS_CAMPAMENTO = ['Tiendas de campaña','Hamacas','Colchones inflables'];

const PROPS_MOVEMENT = ['Matts de yoga verdes','Blocks de yoga','Correas de yoga','Silla de suelo','Almohadones (Bolsters)','Cojines redondos','Cojines grandes','Cojines medianos','Bases de incienso','Proyector','Parlantes'];

function openInventarios() {
  setConScreen('Inventarios', () => goBack(),
    `<div style="font-size:.78rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1.2rem;">Selecciona el inventario a registrar</div>
     <div class="gcard" onclick="openRopaCama()" style="margin-bottom:.7rem;"><div class="ct">Inventario Ropa de Cama</div><div class="cd">Sábanas, fundas, cobijas, duvets y más</div></div>
     <div class="gcard" onclick="openPropsMenu()" style="margin-bottom:.7rem;"><div class="ct">Inventario Wellness</div><div class="cd">Colchonetas, bloques, correas y accesorios</div></div>
     <div class="gcard" onclick="openCampamentoInv()"><div class="ct">Inventario Campamento</div><div class="cd">Tiendas, hamacas y colchones inflables</div></div>`);
}

function openRopaCama() {
  document.getElementById('con-title').textContent = 'Ropa de Cama';
  document.getElementById('con-back').onclick = () => openInventarios();
  document.getElementById('conbody').innerHTML = `
    <div class="fg"><label>Responsable</label>
      <select id="inv-colab"><option value="">— Seleccionar —</option>${COLABS_LIMP.map(n=>`<option>${escapeHtml(n)}</option>`).join('')}</select></div>
    <div class="fg"><label>Fecha</label><input type="date" id="inv-fecha" value="${todayLocal()}"></div>
    ${ROPA_ITEMS.map((item,i) => `
      <div class="inv-item">
        <span class="inv-name">${item}</span>
        <div class="inv-qty">
          <button onclick="adjQty('rc-${i}',-1)">−</button>
          <input type="number" id="rc-${i}" value="0" min="0">
          <button onclick="adjQty('rc-${i}',1)">+</button>
        </div>
      </div>`).join('')}
    <div class="fg" style="margin-top:1rem"><label>Observaciones</label>${aw('inv-obs','Artículos dañados, faltantes...')}</div>
    ${photoUploadWidget('inv-photos')}
    <button class="btn-sub" id="inv-sub" onclick="submitInventario('ropa-cama')">Guardar Inventario</button>
    <div class="ok-msg" id="inv-ok"><p>Inventario guardado correctamente.</p></div>
    <div class="err-msg" id="inv-err"><p>Error al guardar. Intenta de nuevo.</p></div>`;
  show('con-screen');
}

function openPropsMenu() {
  document.getElementById('con-title').textContent = 'Inventario Wellness';
  document.getElementById('con-back').onclick = () => openInventarios();
  document.getElementById('conbody').innerHTML = `
    <div style="font-size:.78rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1.2rem;">Selecciona el espacio a inventariar</div>
    <div class="gcard" onclick="openPropsForm('maloca')" style="margin-bottom:.7rem;"><div class="ct">Props Maloca</div><div class="cd">Matts, blocks, correas y bolsters</div></div>
    <div class="gcard" onclick="openPropsForm('movement')"><div class="ct">Props Estudio de Movimiento</div><div class="cd">Matts, blocks, correas, cojines y sillas</div></div>`;
  show('con-screen');
}

function openPropsForm(space) {
  const items = space === 'maloca' ? PROPS_MALOCA : PROPS_MOVEMENT;
  const title = space === 'maloca' ? 'Props Maloca' : 'Props Estudio de Movimiento';
  document.getElementById('con-title').textContent = title;
  document.getElementById('con-back').onclick = () => openPropsMenu();
  document.getElementById('conbody').innerHTML = `
    <div class="fg"><label>Responsable</label>
      <select id="inv-colab"><option value="">— Seleccionar —</option>${COLABS_LIMP.map(n=>`<option>${escapeHtml(n)}</option>`).join('')}</select></div>
    <div class="fg"><label>Fecha</label><input type="date" id="inv-fecha" value="${todayLocal()}"></div>
    ${items.map((item,i) => `
      <div class="inv-item">
        <span class="inv-name">${item}</span>
        <div class="inv-qty">
          <button onclick="adjQty('pr-${i}',-1)">−</button>
          <input type="number" id="pr-${i}" value="0" min="0">
          <button onclick="adjQty('pr-${i}',1)">+</button>
        </div>
      </div>`).join('')}
    <div class="fg" style="margin-top:1rem"><label>Observaciones</label>${aw('inv-obs','Artículos dañados, faltantes...')}</div>
    ${photoUploadWidget('inv-photos')}
    <button class="btn-sub" id="inv-sub" onclick="submitInventario('props-${space}')">Guardar Inventario</button>
    <div class="ok-msg" id="inv-ok"><p>Inventario guardado correctamente.</p></div>
    <div class="err-msg" id="inv-err"><p>Error al guardar. Intenta de nuevo.</p></div>`;
  show('con-screen');
}

function adjQty(id, delta) {
  const el = document.getElementById(id);
  if (el) el.value = Math.max(0, (parseInt(el.value)||0) + delta);
}

function openCampamentoInv() {
  document.getElementById('con-title').textContent = 'Inventario Campamento';
  document.getElementById('con-back').onclick = () => openInventarios();
  document.getElementById('conbody').innerHTML = `
    <div class="fg"><label>Responsable</label>
      <select id="inv-colab"><option value="">— Seleccionar —</option>${ALL_COLABS.map(n=>`<option>${escapeHtml(n)}</option>`).join('')}</select></div>
    <div class="fg"><label>Fecha</label><input type="date" id="inv-fecha" value="${todayLocal()}"></div>
    ${PROPS_CAMPAMENTO.map((item,i) => `
      <div class="inv-item">
        <span class="inv-name">${item}</span>
        <div class="inv-qty">
          <button onclick="adjQty('camp-${i}',-1)">−</button>
          <input type="number" id="camp-${i}" value="0" min="0">
          <button onclick="adjQty('camp-${i}',1)">+</button>
        </div>
      </div>`).join('')}
    <div class="fg" style="margin-top:1rem"><label>Observaciones</label>${aw('inv-obs','Estado del equipo, piezas faltantes...')}</div>
    <button class="btn-sub" id="inv-btn" onclick="submitCampamentoInv()">Guardar Inventario</button>
    <div class="fnote">Los datos se guardarán en Google Sheets</div>
    <div class="ok-msg" id="inv-ok"><p>Inventario guardado correctamente.</p></div>
    <div class="err-msg" id="inv-err"><p>Error al guardar. Intenta de nuevo.</p></div>`;
  show('con-screen');
}

async function submitCampamentoInv() {
  const colab = document.getElementById('inv-colab')?.value;
  if (!colab) { alert('Por favor selecciona el responsable.'); return; }
  const items = PROPS_CAMPAMENTO.map((item,i) => ({
    item, cantidad: parseInt(document.getElementById(`camp-${i}`)?.value||'0')
  }));
  const btn = document.getElementById('inv-btn');
  btn.disabled = true; btn.textContent = 'Guardando...';
  const res = await sendToSheets({
    type: 'inventario', usuario: CU.usuario, tipo: 'campamento',
    colaborador: colab,
    fecha: document.getElementById('inv-fecha')?.value || '',
    observaciones: document.getElementById('ta-inv-obs')?.value || '',
    items
  });
  if (res.ok) { showCompletado(() => openInventarios()); }
  else {
    document.getElementById('inv-err').querySelector('p').textContent = (res.error || 'Error al guardar. Intenta de nuevo.');
    document.getElementById('inv-err').style.display='block';
    btn.disabled=false; btn.textContent='Guardar Inventario';
  }
}

async function submitInventario(type) {
  const colab = document.getElementById('inv-colab')?.value;
  if (!colab) { alert('Por favor selecciona el responsable.'); return; }
  const prefix = type.startsWith('props') ? 'pr' : 'rc';
  const sourceItems = type === 'ropa-cama' ? ROPA_ITEMS : type === 'props-maloca' ? PROPS_MALOCA : PROPS_MOVEMENT;
  const items = sourceItems.map((name, i) => ({
    item: name,
    cantidad: parseInt(document.getElementById(`${prefix}-${i}`)?.value) || 0
  }));
  const btn = document.getElementById('inv-sub');
  btn.disabled = true; btn.textContent = 'Guardando...';

  const fotosRes = await getPhotosPayload('inv-photos');
  if (!fotosRes.ok) {
    document.getElementById('inv-err').querySelector('p').textContent = fotosRes.error;
    document.getElementById('inv-err').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Guardar Inventario';
    return;
  }

  const res = await sendToSheets({
    type:'inventario', usuario:CU.usuario, tipo:type,
    colaborador: colab,
    fecha:document.getElementById('inv-fecha')?.value||'', items,
    observaciones:document.getElementById('ta-inv-obs')?.value||'',
    fotos: fotosRes.fotos,
  });
  if (res.ok) {
    clearPhotoGroup('inv-photos');
    showCompletado(() => goBack());
  } else {
    document.getElementById('inv-err').querySelector('p').textContent = (res.error || 'Error al guardar. Intenta de nuevo.');
    document.getElementById('inv-err').style.display = 'block';
    btn.disabled=false;
    btn.textContent='Guardar Inventario';
  }
}

// ── FOTOGRAFÍAS (subida real) ──
// Las fotos se guardan en memoria como File hasta el envío del formulario;
// en ese momento se convierten a base64 y se adjuntan al payload. El backend
// (Apps Script) las sube a Google Drive y guarda las URLs resultantes en Sheets.
// Si una foto falla al procesarse, el envío se detiene y se muestra el error
// real — nunca se indica éxito sin que el backend lo confirme.

function photoUploadWidget(groupId, minPhotos=3) {
  return `<div class="fg">
    <label>Fotografías <span id="photo-lbl-${groupId}" style="font-size:.62rem;color:rgba(232,226,209,0.45);font-weight:normal;">— mínimo ${minPhotos} fotos</span></label>
    <div class="photo-upload-box" onclick="document.getElementById('file-${groupId}').click()">
      <input type="file" id="file-${groupId}" accept="image/*" multiple capture="environment" onchange="handlePhotoUpload(event,'${groupId}',${minPhotos})">
      <div style="font-size:.82rem;font-family:var(--font-sans);color:rgba(232,226,209,0.6);">Toca para <strong style="color:var(--cream);">tomar o adjuntar fotos</strong></div>
      <div style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,0.35);margin-top:.2rem;">Se guardarán en Google Drive al enviar</div>
    </div>
    <div class="photo-preview" id="prev-${groupId}" style="display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.5rem;"></div>
  </div>`;
}

function handlePhotoUpload(event, groupId, minPhotos=3) {
  const files = Array.from(event.target.files);
  const preview = document.getElementById('prev-' + groupId);
  if (!window._photos) window._photos = {};
  if (!window._photos[groupId]) window._photos[groupId] = [];
  files.forEach((file) => {
    window._photos[groupId].push(file);
    const reader = new FileReader();
    reader.onload = e => {
      const thumb = document.createElement('div');
      thumb.style.cssText = 'position:relative;';
      const img = document.createElement('img');
      img.src = e.target.result;
      img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:8px;border:1.5px solid rgba(232,226,209,0.2);';
      const idxAtClick = window._photos[groupId].length - 1;
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.style.cssText = 'position:absolute;top:-5px;right:-5px;width:18px;height:18px;border-radius:50%;background:#E07A5F;border:none;color:white;font-size:.65rem;cursor:pointer;line-height:1;';
      delBtn.onclick = () => removePhoto(groupId, idxAtClick, thumb);
      thumb.appendChild(img);
      thumb.appendChild(delBtn);
      preview.appendChild(thumb);
      updatePhotoLabel(groupId, minPhotos);
    };
    reader.readAsDataURL(file);
  });
  // Permite volver a seleccionar el mismo archivo si se elimina y se re-adjunta.
  event.target.value = '';
}

function removePhoto(groupId, idx, el) {
  if (window._photos && window._photos[groupId]) {
    window._photos[groupId].splice(idx, 1);
    el.remove();
    updatePhotoLabel(groupId, 3);
  }
}

function updatePhotoLabel(groupId, minPhotos) {
  const count = (window._photos && window._photos[groupId] || []).length;
  const lbl = document.getElementById('photo-lbl-' + groupId);
  if (!lbl) return;
  const ok = count >= minPhotos;
  lbl.textContent = count === 0
    ? `— mínimo ${minPhotos} fotos`
    : ok ? `— ${count} foto(s) ` : `— ${count}/${minPhotos} fotos`;
  lbl.style.color = ok ? 'rgba(154,149,96,0.8)' : 'rgba(232,226,209,0.45)';
}

// ── PISCINA ──

function openOperacionPiscina() {
  setConScreen('Operación de Piscina', () => goBack(),
    `<div style="font-size:.78rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1.2rem;">Selecciona la acción a realizar</div>
     <div class="gcard" onclick="openChecklistPiscina()"><div class="ct">Checklist de Parámetros</div><div class="cd">pH · ORP · Sal PPM · Fotos</div></div>`);
}

// Convierte la fecha/hora actual a formato local compatible con
// <input type="datetime-local">, evitando el desfase de toISOString() (UTC).
function nowLocalDatetime() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0,16);
}

function openChecklistPiscina() {
  const today = new Date();
  const day = today.getDay();
  const scheduled = [1,2,4,5].includes(day);
  const dayNames = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const insumos = ['Sal','Clarificante','Alguicida GLB','Ácido Muriático','Cloro granulado'];
  const units = ['kg','g','litros','ml','galones','onzas','dosis','shots','Pichinga','Bolsa'];
  const unitOpts = units.map(u=>`<option>${u}</option>`).join('');
  const inputStyle = 'color:var(--cream);background:rgba(255,255,255,0.07);border:1px solid rgba(232,226,209,0.14);border-radius:8px;padding:.6rem .75rem;font-size:.85rem;font-family:var(--font-sans);outline:none;width:100%;';

  document.getElementById('con-title').textContent = 'Parámetros de Piscina';
  document.getElementById('con-back').onclick = () => openOperacionPiscina();
  document.getElementById('conbody').innerHTML = `
    ${!scheduled ? `<div class="doc-note"> Hoy es ${dayNames[day]}. El checklist de piscina se realiza Lunes, Martes, Jueves y Viernes.</div>` : ''}

    <div class="cl-header-info">
      <div class="cl-area-name">Parámetros de Piscina</div>
      <div class="fg" style="margin-bottom:.6rem"><label>Encargado</label>
        <select id="pisc-colab"><option value="">— Seleccionar —</option>${COLABS_MANTO.map(n=>`<option>${escapeHtml(n)}</option>`).join('')}</select></div>
      <div class="fg" style="margin-bottom:0"><label>Fecha y hora</label>
        <input type="datetime-local" id="pisc-fecha" value="${nowLocalDatetime()}"></div>
    </div>

    <!-- SENSOR PARAMS -->
    <div style="background:rgba(255,255,255,0.07);border:1px solid rgba(232,226,209,0.12);border-radius:10px;padding:1rem;margin-bottom:.75rem;">
      <div class="cl-area-name" style="margin-bottom:.75rem;">Parámetros del Agua</div>
      <div class="fg" style="margin-bottom:.9rem;">
        <label>pH</label>
        <input type="number" id="pisc-ph" step="0.1" min="0" max="14" placeholder="Ej: 7.4" style="${inputStyle}">
        <div style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);margin-top:.3rem;">Rango ideal: 7.2 – 7.6</div>
      </div>
      <div class="fg" style="margin-bottom:.9rem;">
        <label>ORP (mV)</label>
        <input type="number" id="pisc-orp" step="1" placeholder="Ej: 720" style="${inputStyle}">
        <div style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);margin-top:.3rem;">Rango ideal: 650 – 750 mV</div>
      </div>
      <div class="fg" style="margin-bottom:0">
        <label>Sal PPM</label>
        <input type="number" id="pisc-sal" step="10" placeholder="Ej: 3200" style="${inputStyle}">
        <div style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);margin-top:.3rem;">Mínimo requerido: 3,000 PPM</div>
      </div>
    </div>

    <!-- MANUAL TESTS -->
    <div style="background:rgba(255,255,255,0.07);border:1px solid rgba(232,226,209,0.12);border-radius:10px;padding:1rem;margin-bottom:.75rem;">
      <div class="cl-area-name" style="margin-bottom:.75rem;">Pruebas Manuales</div>
      <div class="frow" style="gap:.6rem;">
        <div class="fg" style="margin-bottom:.9rem;flex:1;">
          <label>PH</label>
          <input type="number" id="pisc-ph-man" step="0.1" min="0" max="14" placeholder="Ej: 7.4" style="${inputStyle}">
        </div>
        <div class="fg" style="margin-bottom:.9rem;flex:1;">
          <label>Alcalinidad Total</label>
          <input type="number" id="pisc-alc" step="1" placeholder="ppm" style="${inputStyle}">
        </div>
        <div class="fg" style="margin-bottom:0;flex:1;">
          <label>Dureza Cálcica</label>
          <input type="number" id="pisc-dur" step="1" placeholder="ppm" style="${inputStyle}">
        </div>
      </div>
    </div>

    <!-- INSUMOS -->
    <div style="background:rgba(255,255,255,0.07);border:1px solid rgba(232,226,209,0.12);border-radius:10px;padding:1rem;margin-bottom:.75rem;">
      <div class="cl-area-name" style="margin-bottom:.75rem;">Insumos Agregados</div>
      ${insumos.map((ins,i) => `
        <div style="margin-bottom:.65rem;">
          <label style="font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(232,226,209,0.5);display:block;margin-bottom:.35rem;">${ins}</label>
          <div style="display:flex;gap:.4rem;align-items:center;">
            <input type="number" id="pisc-ins-qty-${i}" step="0.1" min="0" placeholder="0" style="${inputStyle}width:auto;flex:1;">
            <select id="pisc-ins-unit-${i}" style="background:rgba(255,255,255,0.07);border:1px solid rgba(232,226,209,0.14);border-radius:8px;padding:.6rem .5rem;font-size:.8rem;font-family:var(--font-sans);color:var(--cream);outline:none;appearance:none;width:110px;">
              ${unitOpts}
            </select>
          </div>
        </div>`).join('')}
    </div>

    <!-- OBS -->
    <div class="fg"><label>Observaciones</label>${aw('pisc-obs','Observaciones sobre el estado del agua, equipos o área...')}</div>
    ${photoUploadWidget('pisc-photos')}
    <button class="btn-sub" id="pisc-sub" onclick="submitPiscina()">Enviar Reporte de Piscina</button>
    <div class="ok-msg" id="pisc-ok"></div>
    <div class="err-msg" id="pisc-err"><p>Error al enviar. Intenta de nuevo.</p></div>
  `;
}


async function submitPiscina() {
  const colab = document.getElementById('pisc-colab')?.value;
  if (!colab) { alert('Por favor selecciona el encargado.'); return; }
  const btn = document.getElementById('pisc-sub');
  btn.disabled = true; btn.textContent = 'Enviando...';

  const ph  = document.getElementById('pisc-ph')?.value  || '';
  const orp = document.getElementById('pisc-orp')?.value || '';
  const sal = document.getElementById('pisc-sal')?.value || '';
  const phMan = document.getElementById('pisc-ph-man')?.value || '';
  const alc   = document.getElementById('pisc-alc')?.value || '';
  const dur   = document.getElementById('pisc-dur')?.value || '';

  const insNombres = ['Sal','Clarificante','Alguicida GLB','Ácido Muriático','Cloro granulado'];
  const insumos = insNombres.map((nombre, i) => ({
    nombre,
    cantidad: document.getElementById(`pisc-ins-qty-${i}`)?.value || '0',
    unidad:   document.getElementById(`pisc-ins-unit-${i}`)?.value || '',
  }));

  const alertas = [];
  if (ph  && (parseFloat(ph)  < 7.2 || parseFloat(ph)  > 7.6)) alertas.push(`pH fuera de rango (${ph})`);
  if (orp && (parseInt(orp)   < 650 || parseInt(orp)   > 750)) alertas.push(`ORP fuera de rango (${orp} mV)`);
  if (sal && parseInt(sal) < 3000) alertas.push(`Sal por debajo del mínimo (${sal} PPM)`);

  const fotosRes = await getPhotosPayload('pisc-photos');
  if (!fotosRes.ok) {
    document.getElementById('pisc-err').querySelector('p').textContent = fotosRes.error;
    document.getElementById('pisc-err').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Enviar Reporte de Piscina';
    return;
  }

  const res = await sendToSheets({
    type: 'reporte', usuario: CU.usuario, departamento: 'mantenimiento', tipo: 'piscina',
    datos: {
      colaborador: colab,
      fecha: document.getElementById('pisc-fecha')?.value || '',
      ph, orp, sal,
      ph_manual: phMan, alcalinidad: alc, dureza: dur,
      insumos: JSON.stringify(insumos),
      alertas: alertas.join(' · '),
      obs: document.getElementById('ta-pisc-obs')?.value || '',
      fotos: fotosRes.fotos,
    }
  });

  if (res.ok) {
    clearPhotoGroup('pisc-photos');
    const msg = alertas.length ? `Reporte enviado.\n ${alertas.join('\n')}` : 'Reporte de piscina enviado correctamente.';
    showCompletado(() => goBack(), msg);
  } else {
    document.getElementById('pisc-err').querySelector('p').textContent = (res.error || 'Error al enviar. Intenta de nuevo.');
    document.getElementById('pisc-err').style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Enviar Reporte de Piscina';
  }
}

// ── CAMPO DE OBSERVACIONES CON DICTADO (aw helper) ──
// IMPORTANTE: aw(id, ph) siempre crea un <textarea id="ta-${id}">. Cualquier
// código que lea el valor DEBE usar ese mismo prefijo "ta-" (ver submits arriba
// y abajo). Este era el origen del bug donde varias observaciones no se guardaban.
function aw(id, ph) {
  return `<div class="aw">
    <textarea id="ta-${id}" placeholder="${ph}" style="width:100%;border:none;border-bottom:1px solid rgba(232,226,209,.1);padding:.7rem .85rem;font-size:.88rem;font-family:var(--font-sans);color:var(--cream);background:transparent;outline:none;resize:none;height:72px;line-height:1.5;"></textarea>
    <div class="bclr">
      <button class="bmk" id="mic-${id}" onclick="toggleMic('${id}')"></button>
      <span id="ms-${id}" style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,.4);flex:1;"></span>
    </div>
  </div>`;
}
function toggleMic(wid) { if (activeRec&&activeRec.wid===wid){stopRec();return;} stopRec(); startRec(wid); }
function startRec(wid) {
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if (!SR){setMs(wid,' Navegador no soporta dictado',false);return;}
  const rec=new SR(); rec.lang='es-CR'; rec.continuous=true; rec.interimResults=true;
  const btn=document.getElementById('mic-'+wid),ta=document.getElementById('ta-'+wid);
  if (!btn||!ta) return;
  btn.classList.add('rec'); btn.innerHTML='Detener'; setMs(wid,' Grabando...',true);
  let base=ta.value;
  rec.onresult=e=>{let fi='',in2='';for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)fi+=e.results[i][0].transcript+' ';else in2+=e.results[i][0].transcript;}if(fi)base+=fi;ta.value=base+in2;};
  rec.onerror=()=>{setMs(wid,'Error al grabar.',false);cleanMic(wid);activeRec=null;};
  rec.onend=()=>{ta.value=base.trim();setMs(wid,' Guardado.',false);cleanMic(wid);activeRec=null;};
  rec.start(); activeRec={rec,wid}; btn.onclick=()=>stopRec();
}
function stopRec(){if(activeRec){try{activeRec.rec.stop();}catch(e){}cleanMic(activeRec.wid);activeRec=null;}}
function setMs(wid,msg,on){const el=document.getElementById('ms-'+wid);if(!el)return;el.textContent=msg;on?el.classList.add('on'):el.classList.remove('on');}
function cleanMic(wid){const b=document.getElementById('mic-'+wid);if(!b)return;b.classList.remove('rec');b.innerHTML='';b.onclick=()=>toggleMic(wid);}

// ── FORMULARIOS GENÉRICOS (openForm / submitForm) ──

// Config de validación mínima por formulario. Los ids listados se validan
// como "no vacíos" antes de enviar (además de la validación de colaborador,
// que ya se hace siempre). Esto cubre el objetivo de validar campos mínimos
// (descripción, área, prioridad, etc.) sin bloquear formularios que son
// legítimamente opcionales (p. ej. reunión de operaciones = solo asistencia).
const FORM_REQUIRED = {
  'reporte-area': [{ id:'f-area', label:'Área completada' }],
  trabajo:        [{ id:'f-area', label:'Área' }, { id:'ta-desc', label:'Descripción' }],
  agua:           [],
  averia:         [{ id:'f-averia', label:'Avería' }, { id:'f-area', label:'Área o ubicación' }, { id:'ta-desc', label:'Descripción' }],
  materiales:     [],
  herramientas:   [{ id:'f-area', label:'Herramienta' }],
  cuadraciclo:    [{ id:'f-area', label:'Cuadraciclo' }, { id:'f-desc', label:'Kilometraje inicial' }],
  reunion:        [],
  incidencia:     [{ id:'f-ubic', label:'Ubicación' }, { id:'ta-desc', label:'Descripción' }],
};

function openForm(formId) {
  stopRec();
  if (!window._photos) window._photos = {};
  window._photos['form-photos'] = [];
  const today = todayLocal();
  const limp  = `<select id="f-colab"><option value="">— Seleccionar —</option>${COLABS_LIMP.map(n=>`<option${CU&&n===CU.nombre?' selected':''}>${escapeHtml(n)}</option>`).join('')}</select>`;
  const manto = `<select id="f-colab"><option value="">— Seleccionar —</option>${COLABS_MANTO.map(n=>`<option${CU&&n===CU.nombre?' selected':''}>${escapeHtml(n)}</option>`).join('')}</select>`;
  const all   = `<select id="f-colab"><option value="">— Seleccionar —</option>${ALL_COLABS.map(n=>`<option${CU&&n===CU.nombre?' selected':''}>${escapeHtml(n)}</option>`).join('')}</select>`;

  var FORMS = {
    'reporte-area': { title:'Reporte de Área', dept:'limpieza', btnCls:'', html:
      `<div class="fg"><label>Colaboradora</label>${limp}</div>
       <div class="frow"><div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
       <div class="fg"><label>Hora</label><input type="time" id="f-hora" value="${new Date().toTimeString().slice(0,5)}"></div></div>
       <div class="fg"><label>Rol</label><select id="f-rol"><option value="Rol 1">Rol 1</option><option value="Rol 2">Rol 2</option></select></div>
       <div class="fg"><label>Área completada</label><select id="f-area">
         <option>Salón de Cocina y Recepción</option><option>Baños</option><option>Duchas</option>
         <option>Juice Bar</option><option>Lounge / Deck</option><option>Estudio de Movimiento</option>
         <option>Maloca y Baños</option><option>Cocina de Residentes</option><option>Baños 7600</option>
         <option>Baños de Madera</option><option>Baños de Teca</option><option>Baños de Bahareque</option>
         <option>Duchas de Bahareque</option><option>Deck de Piscina</option><option>Casita Azul</option>
         <option>Lavandería</option><option>Terralab y Bodega</option><option>Oficina</option>
       </select></div>
       <div class="fg"><label>Estado del área</label><select id="f-estado">
         <option value="Completada"> Completada</option>
         <option value="Incidencia"> Incidencia</option>
         <option value="No completada"> No completada</option>
       </select></div>
       <div class="fg"><label>Observaciones</label>${aw('obs','Describe incidencias o situaciones relevantes...')}</div>
       ${photoUploadWidget('form-photos')}` },
    'repaso-hab': { title:'Repaso de Habitaciones', dept:'limpieza', btnCls:'', html:
      `<div style="font-size:.78rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1rem;">Selecciona la habitación a reportar</div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">
         ${['Toensmeier','Hemenway','Primavesi','Salatin','Shiva','Savory','Yeomans','Fukuoka','Mollison','Lancaster','Götsch','Holzer','Ingham','Carson'].map(hab=>`
           <div class="gcard" onclick="openRepasoHab('${hab}')" style="padding:.85rem .8rem;cursor:pointer;">
             <div class="ct" style="font-size:.9rem;">${hab}</div>
             <div class="cd">Toca para reportar</div>
           </div>`).join('')}
       </div>` },
    trabajo: { title:'Reporte de Trabajo', dept:'mantenimiento', btnCls:'', html:
      `<div class="fg"><label>Colaborador</label>${manto}</div>
       <div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
       <div class="fg"><label>Área</label><input type="text" id="f-area" placeholder="Área o ubicación del trabajo..."></div>
       <div class="fg"><label>Estado</label><select id="f-estado"><option>Completado</option><option>En progreso</option><option>Pendiente</option></select></div>
       <div class="fg"><label>Prioridad</label><select id="f-prior"><option>Normal</option><option>Urgente</option><option>Programado</option></select></div>
       <div class="fg"><label>Descripción</label>${aw('desc','Describe el trabajo realizado...')}</div>
       <div class="fg"><label>Materiales utilizados</label>${aw('mat','Lista de materiales o herramientas usadas...')}</div>
       <div class="fg"><label>Observaciones</label>${aw('obs','Observaciones adicionales...')}</div>
       ${photoUploadWidget('form-photos')}` },

    'averia-cluster': { title:'Inspección de Cluster', dept:'mantenimiento', btnCls:'', html:
      `<div class="doc-note" style="margin-bottom:1rem;"> Inspecciona un cluster y registra las averías encontradas. Puedes enviar sin novedades.</div>
       <div class="fg"><label>Colaborador</label>${manto}</div>
       <div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
       <div class="fg"><label>Cluster</label><select id="f-cluster">
         <option value="Cluster 1">Cluster 1</option>
         <option value="Cluster 2">Cluster 2</option>
         <option value="Cluster 3">Cluster 3</option>
         <option value="Cluster 4">Cluster 4</option>
       </select></div>
       <div class="sec-lbl" style="margin-top:.5rem;">Averías encontradas</div>
       <div id="avc-list">${avcRow(0)}</div>
       <button onclick="addAvcRow()" style="width:100%;margin-top:.25rem;margin-bottom:.5rem;background:none;border:1.5px dashed rgba(153,92,68,.3);border-radius:8px;padding:.65rem;color:var(--clay);font-size:.82rem;font-family:sans-serif;cursor:pointer;">+ Agregar otra avería</button>
       ${photoUploadWidget('form-photos')}` },

    agua: { title:'Reporte de Agua', dept:'mantenimiento', btnCls:'', html:
      `<div class="fg"><label>Colaborador</label>${manto}</div>
       <div class="frow"><div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
       <div class="fg"><label>Hora</label><input type="time" id="f-hora" value="${new Date().toTimeString().slice(0,5)}"></div></div>
       <div class="sec-lbl" style="margin-top:.5rem;">Lecturas de medidores</div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;">
         <div class="fg"><label>M1 — Salida tanque del pozo (casitas)</label><input type="number" id="f-m1" placeholder="0" step="0.1"></div>
         <div class="fg"><label>M2 — Entrada tanques en la loma</label><input type="number" id="f-m2" placeholder="0" step="0.1"></div>
         <div class="fg"><label>M3 — Frente baños del Templo</label><input type="number" id="f-m3" placeholder="0" step="0.1"></div>
         <div class="fg"><label>M4 — Entrada tanque agua potable (bodega)</label><input type="number" id="f-m4" placeholder="0" step="0.1"></div>
         <div class="fg"><label>M5 — Tanques piscina izquierda</label><input type="number" id="f-m5" placeholder="0" step="0.1"></div>
         <div class="fg"><label>M6 — Tanques piscina derecha</label><input type="number" id="f-m6" placeholder="0" step="0.1"></div>
         <div class="fg"><label>M7 — Tubería principal piscina</label><input type="number" id="f-m7" placeholder="0" step="0.1"></div>
       </div>
       <div class="fg"><label>Observaciones</label>${aw('obs','Anomalías, fugas o situaciones a reportar...')}</div>
       ${photoUploadWidget('form-photos')}` },
    averia: { title:'Reporte de Avería', dept: CD||'mantenimiento', btnCls:'averia', html:
      `<div class="doc-note" style="margin-bottom:1rem;"> Reporta averías o fallas que requieren atención.</div>
       <div class="fg"><label>Colaborador</label>${all}</div>
       <div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
       <div class="fg"><label>Avería</label><input type="text" id="f-averia" placeholder="Ej: Fuga de agua, llave dañada..."></div>
       <div class="fg"><label>Prioridad</label><select id="f-prior"><option value="Urgente"> Urgente — Riesgo inmediato</option><option value="Prioridad"> Prioridad — Resolver en 24h</option><option value="Programar"> Programar — Deterioro menor</option></select></div>
       <div class="fg"><label>Área o ubicación</label><input type="text" id="f-area" placeholder="¿Dónde ocurre la avería?"></div>
       <div class="fg"><label>Descripción</label>${aw('desc','Describe la avería con el mayor detalle posible...')}</div>
       ${photoUploadWidget('form-photos')}` },

    materiales: { title:'Solicitud de Materiales', dept:'mantenimiento', btnCls:'materiales', html:
      `<div class="fg"><label>Colaborador</label>${manto}</div>
       <div class="frow"><div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
       <div class="fg"><label>Prioridad</label><select id="f-prior"><option value="Normal">Normal</option><option value="Urgente">Urgente</option></select></div></div>
       <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;margin-bottom:1rem;">
         <div class="cl-sec-title" style="margin-bottom:.8rem;">Materiales solicitados</div>
         <div id="mat-list">${matRow(0)}</div>
         <button onclick="addMatRow()" style="width:100%;margin-top:.75rem;background:none;border:1.5px dashed rgba(153,92,68,.3);border-radius:8px;padding:.65rem;color:var(--clay);font-size:.82rem;font-family:sans-serif;cursor:pointer;">+ Agregar otro material</button>
       </div>
       <div class="fg"><label>Observaciones</label>${aw('obs','Uso específico, urgencia u otras notas...')}</div>
       ${photoUploadWidget('form-photos')}` },
    herramientas: { title:'Solicitud de Herramientas', dept:'proveeduria', btnCls:'', html:
      `<div class="fg"><label>Nombre</label>
         <select id="f-colab"><option value="">— Seleccionar —</option></select>
       </div>
       <div class="frow">
         <div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
         <div class="fg"><label>Hora</label><input type="time" id="f-hora" value="${new Date().toTimeString().slice(0,5)}"></div>
       </div>
       <div class="fg"><label>Herramienta</label><input type="text" id="f-area" placeholder="Nombre de la herramienta..."></div>
       <div class="fg"><label>Estado</label>
         <select id="f-estado">
           <option value="Bueno">Bueno</option>
           <option value="Regular">Regular</option>
           <option value="Dañado">Dañado</option>
           <option value="Faltante">Faltante</option>
         </select>
       </div>
       <div class="fg"><label>Observaciones</label>${aw('obs','Detalles adicionales...')}</div>` },

    cuadraciclo: { title:'Uso de Cuadraciclo', dept:'proveeduria', btnCls:'', html:
      `<div class="fg"><label>Nombre</label>
         <select id="f-colab"><option value="">— Seleccionar —</option></select>
       </div>
       <div class="frow">
         <div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
         <div class="fg"><label>Hora</label><input type="time" id="f-hora" value="${new Date().toTimeString().slice(0,5)}"></div>
       </div>
       <div class="fg"><label>Cuadraciclo</label>
         <select id="f-area">
           <option value="Cuadraciclo de la finca">Cuadraciclo de la finca</option>
           <option value="Cuadraciclo Líderes">Cuadraciclo Líderes</option>
         </select>
       </div>
       <div class="fg"><label>Kilometraje inicial</label><input type="number" id="f-desc" placeholder="0" min="0" step="1"></div>
       <div class="fg"><label>Observaciones</label>${aw('obs','Condiciones del cuadraciclo, ruta u otras notas...')}</div>
       ${photoUploadWidget('form-photos')}` },

    reunion: { title:'Reunión de Operaciones', dept: CD||'limpieza', btnCls:'', html:
      `<div class="doc-note" style="margin-bottom:1rem;"> Confirmación de asistencia · Reunión semanal de operaciones</div>
       <div class="fg"><label>Colaborador</label>${all}</div>
       <div class="frow"><div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
       <div class="fg"><label>Hora</label><input type="time" id="f-hora" value="${new Date().toTimeString().slice(0,5)}"></div></div>
       <div style="background:rgba(118,114,78,.08);border:1px solid rgba(118,114,78,.2);border-radius:10px;padding:1rem;text-align:center;margin:.5rem 0 .8rem;">
         <div style="font-size:1rem;font-family:sans-serif;color:var(--green);font-weight:600;margin-bottom:.25rem;">Confirmar Asistencia</div>
         <div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);">Al enviar quedará registrada tu asistencia</div>
       </div>` },
    incidencia: { title:'Reporte de Incidencia', dept:'seguridad', btnCls:'red', html:
      `<div class="doc-note" style="margin-bottom:1rem;"> Reporta cualquier incidencia de seguridad de inmediato</div>
       <div class="frow"><div class="fg"><label>Fecha</label><input type="date" id="f-fecha" value="${today}"></div>
       <div class="fg"><label>Hora</label><input type="time" id="f-hora"></div></div>
       <div class="fg"><label>Reportado por</label>
         <select id="f-colab"><option value="">— Seleccionar —</option>${USERS.filter(u=>u.departamento==='seguridad').map(u=>`<option>${escapeHtml(u.nombre)}</option>`).join('')}</select></div>
       <div class="fg"><label>Tipo de incidencia</label>
         <select id="f-prior"><option>Accidente</option><option>Incidente de seguridad</option><option>Daño a propiedad</option><option>Situación de riesgo</option><option>Otro</option></select></div>
       <div class="fg"><label>Ubicación</label><input type="text" id="f-ubic" placeholder="¿Dónde ocurrió?"></div>
       <div class="fg"><label>Descripción</label>${aw('desc','Describe la incidencia con el mayor detalle posible...')}</div>
       <div class="fg"><label>Acciones inmediatas tomadas</label>${aw('obs','¿Qué se hizo de inmediato?...')}</div>
       ${photoUploadWidget('form-photos')}` },
  };

  const f = FORMS[formId];
  if (!f) return;

  if (formId === 'materiales') matCount = 1;
  if (formId === 'averia-cluster') avcCount = 1;

  if (formId === 'herramientas' || formId === 'cuadraciclo') {
    setTimeout(() => {
      const sel = document.getElementById('f-colab');
      if (!sel) return;
      const colabs = window._configColabs || [];
      if (colabs.length === 0) {
        loadConfigColabs().then(() => {
          const freshColabs = window._configColabs || [];
          freshColabs.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n; opt.textContent = n;
            sel.appendChild(opt);
          });
        });
      } else {
        colabs.forEach(n => {
          const opt = document.createElement('option');
          opt.value = n; opt.textContent = n;
          sel.appendChild(opt);
        });
      }
    }, 100);
  }

  if (formId === 'repaso-hab') {
    const habs = ['Toensmeier','Hemenway','Primavesi','Salatin','Shiva','Savory','Yeomans','Fukuoka','Mollison','Lancaster','Götsch','Holzer','Ingham','Carson'];
    const grid = habs.map(hab =>
      `<div class="gcard" onclick="openRepasoHab('${hab}')" style="padding:.85rem .8rem;cursor:pointer;">
        <div class="ct" style="font-size:.9rem;">${hab}</div>
        <div class="cd">Toca para reportar</div>
      </div>`).join('');
    setConScreen('Repaso de Habitaciones', () => goBack(),
      `<div style="font-size:.78rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1rem;">Selecciona la habitación a reportar</div>
       <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">${grid}</div>`);
    return;
  }

  document.getElementById('ft').textContent = f.title;
  document.getElementById('fs-back').onclick = () => goBack();
  document.getElementById('fbody').innerHTML = `
    <h2 style="font-size:1.05rem;font-weight:normal;font-style:italic;color:rgba(232,226,209,0.35);margin-bottom:1.1rem;">${f.title}</h2>
    ${f.html}
    <button class="btn-sub ${f.btnCls}" id="btn-sub" onclick="submitForm('${formId}','${f.dept}')">Enviar</button>
    <div class="fnote">Los datos se guardarán en Google Sheets</div>
    <div class="ok-msg" id="ok-msg"><p>Enviado correctamente.</p></div>
    <div class="err-msg" id="err-msg"><p>Error al enviar. Intenta de nuevo.</p></div>`;
  show('fs');
}

async function submitForm(formId, dept) {
  stopRec();
  const colab = document.getElementById('f-colab')?.value;
  if (!colab) { alert('Por favor selecciona el colaborador.'); return; }

  // Validación mínima por formulario
  const required = FORM_REQUIRED[formId] || [];
  for (const req of required) {
    const el = document.getElementById(req.id);
    const val = el ? el.value.trim() : '';
    if (!val) { alert(`Por favor completa el campo: ${req.label}.`); return; }
  }
  if (formId === 'averia-cluster') {
    // Se permite enviar sin novedades, no se exige nada extra aquí.
  }

  const btn = document.getElementById('btn-sub');
  btn.disabled = true; btn.textContent = 'Enviando...';

  const fotosRes = await getPhotosPayload('form-photos');
  if (!fotosRes.ok) {
    document.getElementById('err-msg').querySelector('p').textContent = fotosRes.error;
    document.getElementById('err-msg').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Enviar';
    return;
  }

  const datos = {
    colaborador:colab, fecha:document.getElementById('f-fecha')?.value||'',
    rol:document.getElementById('f-rol')?.value||'', prior:document.getElementById('f-prior')?.value||'',
    averia:document.getElementById('f-averia')?.value||'',
    obs:document.getElementById('ta-obs')?.value||'', desc:document.getElementById('ta-desc')?.value||document.getElementById('f-desc')?.value||'',
    mat:document.getElementById('ta-mat')?.value||'', area:document.getElementById('f-area')?.value||document.getElementById('f-ubic')?.value||'',
    estado:document.getElementById('f-est')?.value||document.getElementById('f-estado')?.value||'',
    fotos: fotosRes.fotos,
  };
  const horaEl = document.getElementById('f-hora');
  if (horaEl) datos.hora = horaEl.value || '';

  if (formId==='agua') {
    ['m1','m2','m3','m4','m5','m6','m7'].forEach(m=>{datos[m]=document.getElementById(`f-${m}`)?.value||'';});
  }
  if (formId === 'materiales') {
    const items = [];
    for (let i = 0; i < matCount; i++) {
      const el = document.getElementById('mat-row-' + i);
      if (!el) continue;
      const item = document.getElementById('mat-item-' + i)?.value?.trim();
      const qty  = document.getElementById('mat-qty-' + i)?.value;
      const unit = document.getElementById('mat-unit-' + i)?.value || 'Unidad';
      if (item) items.push({ item, qty: qty || '1', unit });
    }
    if (!items.length) {
      document.getElementById('err-msg').querySelector('p').textContent = 'Agrega al menos un material antes de enviar.';
      document.getElementById('err-msg').style.display = 'block';
      btn.disabled = false; btn.textContent = 'Enviar';
      return;
    }
    datos.items = items;
    matCount = 1;
  }

  if (formId === 'repaso-hab') {
    const HABS = ['Toensmeier','Hemenway','Primavesi','Salatin','Shiva','Savory','Yeomans','Fukuoka','Mollison','Lancaster','Götsch','Holzer','Ingham','Carson'];
    datos.habitaciones = HABS.map((nombre, i) => ({
      nombre,
      repasada: document.getElementById(`hab-cb-${i}`)?.classList.contains('checked') || false,
      nota: document.getElementById(`hab-nota-${i}`)?.value || ''
    }));
  }

  if (formId === 'averia-cluster') {
    datos.cluster = document.getElementById('f-cluster')?.value || '';
    const items = [];
    for (let i = 0; i < avcCount; i++) {
      const row = document.getElementById('avc-row-' + i);
      if (!row) continue;
      const averia = document.getElementById('avc-averia-' + i)?.value?.trim();
      const desc   = document.getElementById('avc-desc-' + i)?.value?.trim();
      const prior  = document.getElementById('avc-prior-' + i)?.value || 'Programar';
      if (averia || desc) items.push({ averia: averia || '', descripcion: desc || '', prioridad: prior });
    }
    datos.items = items;
    avcCount = 1;
  }

  const payloadType = (formId === 'materiales' || formId === 'herramientas' || formId === 'cuadraciclo')
    ? 'solicitud-insumos' : 'reporte';
  const res = await sendToSheets({type:payloadType,usuario:CU.usuario,departamento:dept,tipo:formId,datos});
  if (res.ok){
    clearPhotoGroup('form-photos');
    showCompletado(() => goBack());
  } else {
    document.getElementById('err-msg').querySelector('p').textContent = (res.error || 'Error al enviar. Intenta de nuevo.');
    document.getElementById('err-msg').style.display='block';
    btn.disabled=false;
    btn.textContent='Enviar';
  }
}

// ── CHECKLISTS DE MANTENIMIENTO (por cluster) ──

const iBasico = ['Conexión eléctrica principal funcionando','Funcionamiento de outlets eléctricos','Funcionamiento de luces (internas y externas)','Funcionamiento de abanico(s) / ventilador(es)','Funcionamiento de llavines y cerraduras','Funcionamiento de ventanas (abren, cierran, traban correctamente)','Daños visibles en estructura (paredes, cielo raso, piso, puertas)','Presencia de humedad, manchas de agua o filtraciones','Presencia de plagas o nidos de insectos','Estado de basureros (limpios, con bolsa, tapados)'];
const iBano  = [...iBasico,'Funcionamiento de ducha (presión y temperatura)','Funcionamiento de grifo del lavatorio','Estado de la caja de aserrín (nivel adecuado, sin mal olor)','Funcionamiento del inodoro / sistema de compostaje','Presencia de fugas o taponamientos visibles','Reposición de papel higiénico, jabón y toallas','Estado de espejos y accesorios de baño'];
const iCasita= [...iBasico,'Funcionamiento de ducha (presión y temperatura de agua)','Estado del mosquitero (sin roturas ni separaciones)','Estado del colchón y textiles (sin manchas, sin humedad)','Funcionamiento de cerrojo interior de privacidad','Estado de repisas, mesa y mobiliario','Visibilidad desde exterior (privacidad del huésped)'];


const CL_MANTO_CLUSTERS = [
  { id:'transito', name:'Tránsito Constante', sub:'Oficina · Juice Bar · Salón de Cocina y Recepción — Inspección mensual',
    note:' Las áreas de tránsito constante tienen inspecciones de mantenimiento mensuales.',
    areas:[
      { id:'oficina',   name:'Oficina',   items:[...iBasico,'Funcionamiento de equipos de cómputo','Estado de router / conectividad','Funcionamiento del aire acondicionado (si aplica)','Estado de impresora y periféricos','Cables organizados, sin riesgos de tropiezo'] },
      { id:'juicebar',  name:'Juice Bar', items:[...iBasico,'Funcionamiento de licuadora / extractor','Estado de refrigeradora o nevera de bebidas','Funcionamiento del grifo / toma de agua','Estado de barra exterior','Stock visible de insumos (reportar faltantes)'] },
      { id:'salon-rec', name:'Salón de Cocina y Recepción', items:[...iBasico,'Estado de mostrador y mobiliario','Estado de filtro de agua'] },
    ]},
  { id:'cluster1', name:'Cluster 1', sub:'Bodega · Terralab · Puente · Movement Studio · Lounge · Duchas · Baños Principales',
    areas:[
      { id:'storage',    name:'Storage / Bodega', items:[...iBasico,'Organización visible del almacenamiento','Estado de estantes y anclajes','Presencia de plagas en productos almacenados','Insumos críticos en stock adecuado'] },
      { id:'terralab',   name:'Terralab', items:[...iBasico,'Estado de equipos y herramientas de laboratorio','Funcionamiento de equipos de refrigeración (si aplica)','Organización y etiquetado de insumos','Ventilación adecuada'] },
      { id:'bridge',     name:'Hanging Bridge', note:' Estructura de seguridad crítica.', items:['Estado de cables o estructura de soporte','Estado de tablones o superficie de paso','Barandas firmes y sin daños','Sin presencia de humedad excesiva','Iluminación del puente funcionando (si aplica)'] },
      { id:'movement',   name:'Movement Studio', items:[...iBasico,'Estado del piso','Estado de espejos','Funcionamiento de equipo de sonido','Estado de colchonetas / props','Espacio libre de obstáculos'] },
      { id:'lounge',     name:'Lounge / Deck', items:[...iBasico,'Estado de muebles y tapizado','Estado de hamacas o mobiliario exterior','Estado del deck (sin tablas sueltas, astillas o daños)','Iluminación exterior funcionando'] },
      { id:'duchas-main',name:'Duchas Principales', items:iBano },
      { id:'banos-main', name:'Baños Principales',  items:iBano },
    ]},
  { id:'cluster2', name:'Cluster 2', sub:'Toensmeier · Baños 7600 · Baños de la Teca · Lancaster · Götsch · Holzer · Cocina Residentes · Ingham · Carson',
    areas:[
      { id:'toensmeier', name:'Toensmeier', items:iCasita }, { id:'banos7600', name:'Baños 7600', items:iBano }, { id:'banos-teca', name:'Baños de la Teca', items:iBano },
      { id:'lancaster', name:'Lancaster', items:iCasita }, { id:'gotsch', name:'Götsch', items:iCasita }, { id:'holzer', name:'Holzer', items:iCasita },
      { id:'cocina-res', name:'Cocina de Residentes', items:[...iBasico,'Funcionamiento de quemadores / cocina','Funcionamiento de extractor de olores','Estado de refrigeradora','Funcionamiento de lavaplatos y grifo','Presencia de fugas bajo el fregadero','Estado de superficies de preparación','Almacenamiento correcto de alimentos e insumos'] },
      { id:'ingham', name:'Ingham', items:iCasita }, { id:'carson', name:'Carson', items:iCasita },
    ]},
  { id:'cluster3', name:'Cluster 3', sub:'Baño de Madera · Hememway · Primavesi · Salatin · Shiva · Savory · Yeomans · Fukuoka · Mollison',
    areas:[
      { id:'bath-wood', name:'Baño de Madera', items:iBano }, { id:'hememway', name:'Hememway', items:iCasita }, { id:'primavesi', name:'Primavesi', items:iCasita },
      { id:'salatin', name:'Salatin', items:iCasita }, { id:'shiva', name:'Shiva', items:iCasita }, { id:'savory', name:'Savory', items:iCasita },
      { id:'yeomans', name:'Yeomans', items:iCasita }, { id:'fukuoka', name:'Fukuoka', items:iCasita }, { id:'mollison', name:'Mollison', items:iCasita },
    ]},
  { id:'cluster4', name:'Cluster 4', sub:'Starhawk · Crawford · Eisenstein · Doherty · Macy · Baños Bahareque · Wex Camp · Maloca',
    areas:[
      { id:'starhawk', name:'Starhawk', items:iCasita }, { id:'crawford', name:'Crawford', items:iCasita }, { id:'eisenstein', name:'Eisenstein', items:iCasita },
      { id:'doherty', name:'Doherty', items:iCasita }, { id:'macy', name:'Macy', items:iCasita },
      { id:'bah-bath', name:'Baños de Bahareque', note:'Únicos baños de habitaciones con ducha.', items:[...iBano,'Paredes de bahareque sin grietas ni humedad penetrante'] },
      { id:'wex-camp', name:'Wex Camp', items:[...iBasico,'Estado de carpa o estructura temporal','Estado de tarima o base elevada','Ventilación e iluminación adecuadas','Funcionamiento del sistema sanitario asociado'] },
      { id:'maloca-ev', name:'Maloca', note:' Espacio de alta significancia cultural.', items:[...iBasico,'Estado de estructura de techo','Estado de bambú o madera estructural expuesta','Estado del piso','Funcionamiento de sistema de audio','Estado del baño y bodega asociados'] },
      { id:'maloca-bath', name:'Maloca Bathroom', items:iBano },
      { id:'maloca-st', name:'Maloca Storage', items:[...iBasico,'Organización visible del almacenamiento','Estado de estantes y anclajes','Presencia de plagas en productos almacenados','Insumos críticos en stock adecuado'] },
    ]},
  { id:'diario', name:'Atención Diaria', sub:'Piscina · Sistemas de Agua · Casita Azul',
    areas:[
      { id:'piscina-mt', name:'Piscina', note:'El sistema arranca a 20 PSI y cae a 10 PSI. Nunca debe superar los 25 PSI.', items:['Estado de estructura, deck, duchas y enchapado','Estado inicial del sistema de bombeo y filtración','Niveles químicos: Sal PPM (mín. 3000), pH, ORP','Revisión de canastillas','Revisión visual de canastilla de bomba','Aspirado y llenado de piscina','Niveles químicos finales: Sal PPM (mín. 3000), pH, ORP'] },
      { id:'agua-sys', name:'Sistemas de Agua', items:['Nivel de agua visible o indicado en el sistema','Presencia de fugas, humedad inusual o manchas en tuberías','Estado físico del tanque o estructura','Lectura del medidor correspondiente','Presión del sistema (normal / baja / alta)','Estado de tapas y sellos','Funcionamiento de válvulas de corte','Presencia de vectores o contaminantes externos','Registro completado en formulario'] },
      { id:'casita-azul', name:'Casita Azul', items:iBasico },
    ]},
];

function openChecklistMenu(resourceId) {
  document.getElementById('cl-title').textContent = 'Checklist';
  document.getElementById('cl-back').onclick = () => goBack();
  let html = `<div class="glbl">Selecciona el cluster a inspeccionar</div>`;
  CL_MANTO_CLUSTERS.forEach(cl => {
    html += `<div class="cluster-card" onclick="promptChecklist('${cl.id}','mantenimiento')">
      <div class="cc-title">${cl.name}</div><div class="cc-sub">${cl.sub}</div>
      ${cl.note ? `<div style="font-size:.67rem;font-family:sans-serif;color:var(--clay);margin-top:.3rem;">${cl.note}</div>` : ''}
    </div>`;
  });
  document.getElementById('cl-body').innerHTML = html;
  show('cl-screen');
}

function promptChecklist(id, dept) {
  startChecklist(id, dept);
}

function closeModal(){document.getElementById('modal').classList.remove('show');pendingCL=null;}
function confirmChecklist(){document.getElementById('modal').classList.remove('show');if(pendingCL)startChecklist(pendingCL.id,pendingCL.dept);}

function clItem(ai, ii, item) {
  return `<div class="cl-item">
    <div class="cl-cb" id="cb-${ai}-${ii}" onclick="toggleCl(${ai},${ii})"></div>
    <div style="flex:1;">
      <div class="cl-txt">${escapeHtml(item)}</div>
      <div class="cl-note"><input type="text" id="cn-${ai}-${ii}" placeholder="Nota (opcional)..."></div>
    </div>
  </div>`;
}
function toggleCl(ai, ii) {
  const key = `${ai}-${ii}`;
  checkedMap[key] = !checkedMap[key];
  const cb = document.getElementById(`cb-${ai}-${ii}`);
  if (cb) cb.classList.toggle('checked', checkedMap[key]);
  updateClProgress();
}
function updateClProgress() {
  const total = document.querySelectorAll('.cl-cb').length;
  const done  = Object.values(checkedMap).filter(Boolean).length;
  const bar = document.getElementById('prog-bar');
  const txt = document.getElementById('prog-txt');
  if (bar) bar.style.width = total ? `${(done/total*100)}%` : '0%';
  if (txt) txt.textContent = `${done} / ${total} ítems completados`;
}

function startChecklist(id, dept) {
  checkedMap={};
  const obj = CL_MANTO_CLUSTERS.find(cl=>cl.id===id);
  if (!obj) return;
  const name = obj.name;
  let total = 0;
  obj.areas.forEach(area => { total += area.items.length; });

  let sectionsHtml = '';
  if(obj.note) sectionsHtml += `<div class="doc-note">${obj.note}</div>`;
  obj.areas.forEach((area,ai) => {
    sectionsHtml += `<div class="cl-section"><div class="cl-sec-title">${area.name}${area.note ? ` — <span style="color:var(--clay);font-size:.65rem;">${area.note}</span>` : ''}</div>${area.items.map((item,ii)=>clItem(ai,ii,item)).join('')}</div>`;
  });

  const colabOpts = COLABS_MANTO.map(n=>`<option>${escapeHtml(n)}</option>`).join('');
  document.getElementById('cl-title').textContent = name;
  document.getElementById('cl-back').onclick = () => openChecklistMenu('checklist-manto');
  document.getElementById('cl-body').innerHTML = `
    <div class="cl-header-info">
      <div class="cl-area-name">${name}</div>
      <div class="fg" style="margin-bottom:.6rem"><label>Encargado</label><select id="cl-colab"><option value="">— Seleccionar —</option>${colabOpts}</select></div>
      <div class="fg" style="margin-bottom:0"><label>Fecha</label><input type="date" id="cl-fecha" value="${todayLocal()}"></div>
    </div>
    <div class="cl-prog-txt" id="prog-txt">0 / ${total} ítems completados</div>
    <div class="cl-progress"><div class="cl-prog-bar" id="prog-bar" style="width:0%"></div></div>
    ${sectionsHtml}
    <div class="fg" style="margin-top:.5rem"><label>Observaciones generales</label>${aw('cl-obs','Observaciones generales...')}</div>
    ${photoUploadWidget('cl-photos')}
    <button class="btn-sub" id="cl-submit" onclick="submitChecklist('${id}','${dept}')">Enviar Reporte de Inspección</button>
    <div class="fnote">Los datos se guardarán en Google Sheets</div>
    <div class="ok-msg" id="cl-ok"><p>Reporte de inspección enviado correctamente.</p></div>
    <div class="err-msg" id="cl-err"><p>Error al enviar. Intenta de nuevo.</p></div>`;
  show('cl-screen');
}

async function submitChecklist(id,dept){
  const colab=document.getElementById('cl-colab')?.value;
  if(!colab){alert('Por favor selecciona el encargado.');return;}
  const obj = CL_MANTO_CLUSTERS.find(cl=>cl.id===id);
  if (!obj) return;
  const allItems=[];
  obj.areas.forEach((area,ai)=>{
    area.items.forEach((item,ii)=>allItems.push({
      item, checked:!!checkedMap[`${ai}-${ii}`],
      nota:document.getElementById(`cn-${ai}-${ii}`)?.value||''
    }));
  });
  const btn=document.getElementById('cl-submit');btn.disabled=true;btn.textContent='Enviando...';

  const fotosRes = await getPhotosPayload('cl-photos');
  if (!fotosRes.ok) {
    document.getElementById('cl-err').querySelector('p').textContent = fotosRes.error;
    document.getElementById('cl-err').style.display = 'block';
    btn.disabled = false; btn.textContent = 'Enviar Reporte de Inspección';
    return;
  }

  const res=await sendToSheets({
    type:'checklist', usuario:CU.usuario, departamento:dept, tipo:'checklist',
    datos: {
      colaborador: colab,
      area: obj.name,
      fecha: document.getElementById('cl-fecha')?.value||'',
      total: allItems.length, completados: allItems.filter(i=>i.checked).length,
      observaciones: document.getElementById('ta-cl-obs')?.value||'',
      items: allItems,
      fotos: fotosRes.fotos,
    },
  });
  checkedMap={};
  if(res.ok){
    clearPhotoGroup('cl-photos');
    showCompletado(() => goBack());
  } else {
    document.getElementById('cl-err').querySelector('p').textContent = (res.error || 'Error al enviar. Intenta de nuevo.');
    document.getElementById('cl-err').style.display='block';
    btn.disabled=false;
    btn.textContent='Enviar Reporte de Inspección';
  }
}

// ── DESEMPEÑO (dials SVG) ──

const BLOB_COLORS=['#717F7E','#995C44','#76724E','#735145','#544236','#8a6a52'];
const BLOB_LIGHT=['rgba(113,127,126,.45)','rgba(153,92,68,.42)','rgba(118,114,78,.4)','rgba(115,81,69,.4)','rgba(84,66,54,.38)','rgba(138,106,82,.38)'];
const DEPT_LABEL={limpieza:'Limpieza',mantenimiento:'Mantenimiento',proveeduria:'Proveduría y Transportes',seguridad:'Seguridad'};

function dialSVG(score,pct,color,blobColors,w,r){
  const cx=w/2,cy=w/2,circ=2*Math.PI*r,dash=circ*(pct/100),fs1=Math.round(r*.38),fs2=Math.round(r*.13),ty1=cy-4,ty2=cy+Math.round(r*.2),sw=Math.round(r*.1),bry=cy-r-8,brx=Math.round(r*.35),bry2=Math.round(r*.15);
  const blobs=blobColors.map((bc,i)=>'<ellipse cx="'+cx+'" cy="'+bry+'" rx="'+brx+'" ry="'+bry2+'" fill="'+bc+'" transform="rotate('+(i*60)+' '+cx+' '+cy+')"/>').join('');
  return '<svg width="'+w+'" height="'+w+'" viewBox="0 0 '+w+' '+w+'">'+blobs+'<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="rgba(232,226,209,.12)" stroke-width="'+sw+'"/><circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="'+sw+'" stroke-dasharray="'+dash+' '+circ+'" stroke-dashoffset="'+(circ*.25)+'" stroke-linecap="round" transform="rotate(-90 '+cx+' '+cy+')"/><text x="'+cx+'" y="'+ty1+'" text-anchor="middle" font-family="Cormorant,Georgia,serif" font-size="'+fs1+'" font-weight="700" fill="#E8E2D1">'+score+'</text><text x="'+cx+'" y="'+ty2+'" text-anchor="middle" font-family="Jost,sans-serif" font-size="'+fs2+'" fill="rgba(232,226,209,0.45)">cumplimiento</text></svg>';
}

function openMyPerformance(){
  const colabs=USERS.filter(u=>u.rol==='colaborador');
  const idx=colabs.findIndex(u=>u.usuario===CU.usuario);
  const color=BLOB_COLORS[idx%BLOB_COLORS.length];
  const blobC=BLOB_LIGHT.map((_,j)=>BLOB_LIGHT[(idx+j)%BLOB_LIGHT.length]);
  const backFn = () => { if(CU.rol==='admin'){renderHome();}else{renderDeptHome();} show('home'); };
  setConScreen('Mi Desempeño', backFn,`
    <div style="text-align:center;margin-bottom:1.2rem;">${dialSVG('—',0,color,blobC,210,80)}
      <div style="font-size:1.15rem;font-style:italic;color:var(--cream);margin-top:.25rem;font-family:var(--font-serif);">${escapeHtml(CU.nombre)}</div>
      <div style="font-size:.65rem;font-family:var(--font-sans);color:rgba(232,226,209,0.42);text-transform:uppercase;letter-spacing:.12em;margin-top:.2rem;">${escapeHtml(DEPT_LABEL[CU.departamento]||CU.departamento)}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:1rem;">
      <div class="stat-blue" style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:12px;padding:.9rem;text-align:center;">
        <div style="font-size:.55rem;text-transform:uppercase;letter-spacing:.18em;color:rgba(113,127,126,0.7);font-family:var(--font-sans);margin-bottom:.4rem;">Esta semana</div>
        <div style="font-size:2rem;font-family:var(--font-serif);font-style:italic;color:rgba(232,226,209,0.3);">—</div>
        <div style="font-size:.6rem;font-family:var(--font-sans);color:rgba(232,226,209,0.3);">% cumplimiento</div>
      </div>
      <div class="stat-green" style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:12px;padding:.9rem;text-align:center;">
        <div style="font-size:.55rem;text-transform:uppercase;letter-spacing:.18em;color:rgba(118,114,78,0.7);font-family:var(--font-sans);margin-bottom:.4rem;">Este mes</div>
        <div style="font-size:2rem;font-family:var(--font-serif);font-style:italic;color:rgba(232,226,209,0.3);">—</div>
        <div style="font-size:.6rem;font-family:var(--font-sans);color:rgba(232,226,209,0.3);">% cumplimiento</div>
      </div>
    </div>
    <button class="dept-btn" onclick="openPeerEval()" style="margin-bottom:.65rem;width:100%;"><div class="dico a" style="background:rgba(113,127,126,.15);color:var(--blue);">EP</div><div class="dinf"><h3>Evaluación de Pares</h3><p>Evalúa el desempeño de tus compañeros</p></div><span class="dbadge on" style="background:rgba(113,127,126,.15);color:var(--blue);">Mensual</span></button>
    <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;"><div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tm);font-family:sans-serif;margin-bottom:.5rem;">KPIs pendientes de definición por administración</div></div>`);
}

function openTeamPerformance(){
  const team=USERS.filter(u=>u.rol==='colaborador');
  const grid=team.map((u,i)=>{const color=BLOB_COLORS[i%BLOB_COLORS.length];const blobC=BLOB_LIGHT.map((_,j)=>BLOB_LIGHT[(i+j)%BLOB_LIGHT.length]);const nombreCorto=escapeHtml(u.nombre.split(' ').slice(0,2).join(' '));const deptoLbl=escapeHtml(DEPT_LABEL[u.departamento]||u.departamento);return `<div onclick="openPersonDetail('${escapeHtml(u.usuario)}')" style="background:rgba(255,255,255,0.06);border:1px solid rgba(232,226,209,0.1);border-radius:16px;padding:1.1rem .7rem;text-align:center;cursor:pointer;transition:all 0.18s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.06)'">${dialSVG('—',0,color,blobC,140,54)}<div style="font-size:.88rem;font-family:'Cormorant',Georgia,serif;font-style:italic;color:var(--cream);line-height:1.3;margin-bottom:.25rem;">${nombreCorto}</div><div style="font-size:.58rem;font-family:var(--font-sans);color:rgba(232,226,209,0.4);text-transform:uppercase;letter-spacing:.1em;">${deptoLbl}</div></div>`;}).join('');
  setConScreen('Desempeño del Equipo',()=>{renderHome();show('home');},`
    <div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1.2rem;">Cumplimiento semanal · ${new Date().toLocaleDateString('es-CR',{month:'long',year:'numeric'})}</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.85rem;">${grid}</div>
    <div style="font-size:.68rem;font-family:sans-serif;color:var(--tm);text-align:center;margin-top:1.2rem;font-style:italic;">Los porcentajes se actualizarán cuando los KPIs estén definidos</div>`);
}

function openPersonDetail(username){
  const u=USERS.find(x=>x.usuario===username);if(!u)return;
  const colabs=USERS.filter(x=>x.rol==='colaborador');const idx=colabs.findIndex(x=>x.usuario===username);
  const color=BLOB_COLORS[idx%BLOB_COLORS.length];const blobC=BLOB_LIGHT.map((_,j)=>BLOB_LIGHT[(idx+j)%BLOB_LIGHT.length]);
  document.getElementById('con-title').textContent=u.nombre.split(' ').slice(0,2).join(' ');
  document.getElementById('con-back').onclick=()=>openTeamPerformance();
  document.getElementById('conbody').innerHTML=`<div style="text-align:center;padding:1rem 0;">${dialSVG('—',0,color,blobC,180,68)}<div style="font-size:1.1rem;font-style:italic;color:var(--brown);margin-top:.25rem;">${escapeHtml(u.nombre)}</div><div style="font-size:.7rem;font-family:sans-serif;color:var(--tm);text-transform:uppercase;letter-spacing:.1em;margin-top:.2rem;">${escapeHtml(DEPT_LABEL[u.departamento]||u.departamento)}</div></div><div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;"><div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tm);font-family:sans-serif;margin-bottom:.5rem;">KPIs pendientes de definición</div></div>`;
  show('con-screen');
}

function openReports(){
  document.getElementById('rep-body').innerHTML=`<div style="text-align:center;padding:2rem;font-family:sans-serif;color:var(--tm);font-style:italic;">Los reportes enviados aparecerán aquí una vez conectado el dashboard de lectura.</div>`;
  show('rep-screen');
}

// ── MANUALES (contenido estático de referencia) ──

function mkStepsMT(steps){return steps.map(([t,d],i)=>`<div style="display:flex;gap:.75rem;margin-bottom:.85rem;align-items:flex-start;"><div style="width:26px;height:26px;background:var(--clay);border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-size:.72rem;font-family:sans-serif;font-weight:600;flex-shrink:0;margin-top:.1rem;">${i+1}</div><div><div style="font-size:.82rem;font-family:sans-serif;font-weight:600;color:var(--cream);margin-bottom:.25rem;">${t}</div><div style="font-size:.78rem;font-family:sans-serif;color:rgba(232,226,209,0.7);line-height:1.5;">${d}</div></div></div>`).join('');}
function mkAreaLimp(sub,steps,criterios){return `<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">${sub}</div>`+mkStepsMT(steps)+`<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Criterios de limpieza esperada</div>${criterios.map(cr=>`<div class="crit-row"> ${cr}</div>`).join('')}</div>`;}
function mkRolTable(rows){return `<div style="border-radius:8px;overflow:hidden;border:1px solid rgba(232,226,209,0.1);">${rows.map(([day,t1,a1,t2,a2],i)=>`<div style="background:${i%2===0?'rgba(255,255,255,0.05)':'rgba(255,255,255,0.03)'};padding:.65rem .8rem;border-bottom:1px solid rgba(232,226,209,0.06);"><div style="font-size:.75rem;font-family:sans-serif;font-weight:600;color:var(--cream);margin-bottom:.35rem;">${day}</div><div style="display:flex;gap:.5rem;flex-wrap:wrap;"><span style="font-size:.65rem;font-family:sans-serif;background:rgba(113,127,126,0.2);color:#8FACA9;padding:.15rem .45rem;border-radius:20px;">${t1}</span><span style="font-size:.7rem;font-family:sans-serif;color:rgba(232,226,209,0.7);flex:1;line-height:1.4;">${a1}</span></div>${t2?`<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.3rem;"><span style="font-size:.65rem;font-family:sans-serif;background:rgba(153,92,68,0.2);color:#C17A5A;padding:.15rem .45rem;border-radius:20px;">${t2}</span><span style="font-size:.7rem;font-family:sans-serif;color:rgba(232,226,209,0.7);flex:1;line-height:1.4;">${a2}</span></div>`:''}</div>`).join('')}</div>`;}

const SHARED_CONTENT={
  depto:`<p style="font-size:.82rem;font-family:sans-serif;color:rgba(232,226,209,0.8);line-height:1.6;margin-bottom:1rem;">El Departamento de Operaciones es el eje funcional que sostiene la experiencia en Tierramor.</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">${[['Housekeeping','Limpieza, higiene y presentación de todos los espacios.'],['Mantenimiento','Inspección, prevención y atención de fallas.'],['Proveduría','Gestión de insumos, compras e inventario.'],['Seguridad','Resguardo de personas y bienes.']].map(([t,d])=>`<div style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:10px;padding:.85rem .8rem;"><div style="font-size:.75rem;font-weight:600;font-family:sans-serif;color:var(--clay);margin-bottom:.25rem;">${t}</div><div style="font-size:.73rem;font-family:sans-serif;color:rgba(232,226,209,0.6);line-height:1.4;">${d}</div></div>`).join('')}</div>`,
  'marco-principios':`<div style="font-size:.82rem;font-family:sans-serif;color:rgba(232,226,209,0.8);font-weight:600;margin-bottom:.6rem;">Permacultura — 12 Principios de Holmgren</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:.55rem;">${[['1. Observar e interactuar','Relacionarse con la naturaleza para diseñar soluciones.'],['2. Capturar energía','Usar recursos en su momento de abundancia.'],['3. Obtener rendimiento','El trabajo debe generar resultados útiles.'],['4. Autorregulación','Desalentar comportamientos inapropiados.'],['5. Usar renovables','Hacer el mejor uso de recursos abundantes.'],['6. No producir desperdicios','Valorar y aprovechar todos los recursos.'],['7. Diseñar desde los patrones','Usar los patrones de la naturaleza como base.'],['8. Integrar en vez de segregar','Colocar elementos en relaciones correctas.'],['9. Soluciones pequeñas','Los sistemas pequeños son más fáciles de mantener.'],['10. Usar la diversidad','La diversidad reduce la vulnerabilidad.'],['11. Usar los bordes','La interfaz es donde ocurren los eventos interesantes.'],['12. Responder al cambio','Intervenir en el momento correcto.']].map(([t,d])=>`<div style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:9px;padding:.75rem .7rem;"><div style="font-size:.7rem;font-weight:600;font-family:sans-serif;color:#9A9560;margin-bottom:.2rem;">${t}</div><div style="font-size:.68rem;font-family:sans-serif;color:rgba(232,226,209,0.55);line-height:1.4;">${d}</div></div>`).join('')}</div>`,
};

const MANUAL_LMP_CONTENT={
  roles:`<div style="font-size:.78rem;font-family:sans-serif;color:rgba(232,226,209,0.7);margin-bottom:1rem;">El equipo opera en dos roles con asignaciones semanales rotativas.</div>
    <div style="background:rgba(113,127,126,0.1);border:1px solid rgba(113,127,126,0.2);border-radius:10px;padding:.9rem;margin-bottom:1rem;"><div style="font-size:.85rem;font-weight:600;font-family:sans-serif;color:#8FACA9;margin-bottom:.6rem;font-style:italic;">Rol 1</div>${mkRolTable([['Lunes','7:00 AM','Salón de Cocina y Recepción · Baños principales','12:30 PM','Casita Azul · Lavandería'],['Martes','7:00 AM','Salón · Baños 7600 · Oficina · Maloca · Casitas Cluster 3','12:30 PM','Shiva · Savory · Yeomans · Fukuoka · Mollison'],['Miércoles','','LIBRE','',''],['Jueves','7:00 AM','Salón · Baños 7600 · Terralab · Maloca · Baños Bahareque','12:30 PM','Lancaster · Götsch · Holzer · Ingham · Carson'],['Viernes','7:00 AM','Salón · Duchas principales · Lavado tubos','12:30 PM','Baños Principales · Lounge · Starhawk · Eisenstein · Macy']])}</div>
    <div style="background:rgba(153,92,68,0.08);border:1px solid rgba(153,92,68,0.2);border-radius:10px;padding:.9rem;"><div style="font-size:.85rem;font-weight:600;font-family:sans-serif;color:#C17A5A;margin-bottom:.6rem;font-style:italic;">Rol 2</div>${mkRolTable([['Lunes','7:00 AM','Deck de Piscina · Baños 7600 · Reunión de Operaciones','12:30 PM','Baños de Teca · Bodega de HK'],['Martes','7:00 AM','Baños principales · Juice Bar · Terralab · Maloca · Baños Bahareque · Cocina','12:30 PM','Lancaster · Götsch · Holzer · Ingham · Carson'],['Miércoles','7:00 AM','Salón · Duchas principales · Baños · Baños 7600 · Cocina · Lounge','12:30 PM','Limpieza de Vidrios · Casita Azul'],['Jueves','','LIBRE','',''],['Viernes','7:00 AM','Baños principales · Baños 7600 · Lavado de salón','12:30 PM','Baños de Teca · Movement Studio · Sillas Juice Bar · Crawford · Doherty']])}</div>`,

  'criterios-todo':`<div style="font-size:.82rem;font-family:sans-serif;color:rgba(232,226,209,0.8);font-weight:600;margin-bottom:.6rem;">Criterios de Housekeeping</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:1.2rem;">${[['OBSERVABLE','Cualquier persona puede verificar el resultado.'],['REPETIBLE','No depende de quién limpió.'],['SUFICIENTE','Efectivo sin obsesión.'],['SOSTENIBLE','Se mantiene sin agotar al equipo.']].map(([t,d])=>`<div style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:10px;padding:.85rem .8rem;"><div style="font-size:.72rem;font-weight:600;font-family:sans-serif;color:var(--clay);letter-spacing:.06em;margin-bottom:.25rem;">${t}</div><div style="font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.65);line-height:1.4;">${d}</div></div>`).join('')}</div>${mkStepsMT([['Revisión del Rol','Llegar puntualmente y revisar la asignación de áreas del día.'],['Preparación Personal','Uniforme limpio, zapatos cerrados, cabello recogido.'],['Revisión del Equipo','Trapos limpios, escoba, trapeador, guantes, desinfectante, bolsas de basura.'],['Inspección Visual','Pasar por las áreas asignadas e identificar zonas prioritarias.'],['Coordinación','Comunicar si se necesita apoyo o falta algún insumo.']])}`,

  oficina:mkAreaLimp('Área administrativa',[['Revisión Previa','Confirmar sin reuniones. Anunciarse al entrar.'],['Superficies','Quitar polvo de escritorios, repisas y lámparas. Desinfectar teléfonos e interruptores.'],['Pisos','Barrer y trapear con desinfectante suave.'],['Basureros','Vaciar cuando el área lo requiera.'],['Revisión Final','Luces y aires apagados si no se usan.']],['Ninguna superficie con polvo ni manchas','Pisos secos y sin marcas','Escritorios libres de residuos','Basureros vacíos','Olor neutro'])+`<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Ninguna superficie con polvo ni manchas</div><div class="crit-row"> Pisos secos y sin marcas</div><div class="crit-row"> Escritorios libres de residuos</div><div class="crit-row"> Basureros vacíos</div></div>`,
  juicebar:mkAreaLimp('Área exterior de servicio',[['Revisión Inicial','Confirmar sin huéspedes.'],['Superficies','Limpiar mesas y barra. Desinfectar zonas de alto contacto.'],['Pisos','Barrer y trapear. Retirar hojas del exterior.'],['Basureros','Vaciar cuando el área lo requiera.'],['Presentación','Alinear mesas y sillas.']],['Ningún residuo visible','Mobiliario alineado y seco','Basureros limpios y tapados','Área fresca y lista'])+`<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Ningún residuo visible</div><div class="crit-row"> Mobiliario alineado y seco</div><div class="crit-row"> Basureros limpios y tapados</div></div>`,
  recepcion:mkAreaLimp('Punto de bienvenida',[['Revisión Inicial','Confirmar sin check-in en proceso.'],['Superficies','Quitar polvo del mostrador, mesas y sillas. Desinfectar áreas de alto contacto.'],['Pisos','Barrer y trapear con desinfectante neutro.'],['Revisión Final','Alinear sillas, cerrar cajones.']],['Ningún rastro de polvo ni basura','Mobiliario ordenado y seco','Olor agradable y fresco','Área lista para recibir huéspedes'])+`<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Ningún rastro de polvo ni basura</div><div class="crit-row"> Mobiliario ordenado y seco</div><div class="crit-row"> Área lista para recibir huéspedes</div></div>`,
  comedor:mkAreaLimp('Área de alimentación',[['Revisión Inicial','Verificar sin personas. Retirar platos olvidados.'],['Superficies','Limpiar mesas y sillas con paño húmedo y desinfectante.'],['Pisos','Barrer restos de comida. Trapear con desinfectante.'],['Basureros','Vaciar cuando el área lo requiera.']],['Mesas sin residuos, secas y desinfectadas','Sillas limpias y alineadas','Piso sin restos ni humedad','Basureros vacíos'])+`<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Mesas sin residuos, secas y desinfectadas</div><div class="crit-row"> Sillas limpias y alineadas</div><div class="crit-row"> Piso sin restos ni humedad</div></div>`,
  templo:`<div class="doc-note" style="margin-bottom:.9rem;"> Espacio de alta sensibilidad. Limpiar con discreción.</div>`+mkAreaLimp('Estudio de Movimiento',[['Revisión Inicial','Confirmar sin actividades. Verificar velas encendidas.'],['Superficies','Quitar polvo suavemente. No mover objetos de altar.'],['Piso','Barrer con escoba suave. Trapear con desinfectante neutro.'],['Revisión Final','Verificar que todo esté en su lugar.']],['Superficies libres de polvo','Piso limpio y seco','Cojines alineados, altares intactos','Olor natural y fresco'])+`<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Superficies libres de polvo</div><div class="crit-row"> Piso limpio y seco</div><div class="crit-row"> Cojines alineados, altares intactos</div></div>`,
  lounge:mkAreaLimp('Lounge',[['Revisión Inicial','Verificar si hay personas.'],['Superficies','Quitar polvo de mesas, repisas. Desinfectar superficies de alto contacto.'],['Pisos','Barrer incluyendo debajo de escritorios. Trapear con desinfectante.'],['Basureros','Vaciar cuando el área lo requiera.']],['Superficies libres de polvo y manchas','Pisos secos sin residuos','Mobiliario alineado y ordenado','Basureros vacíos'])+`<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Superficies libres de polvo y manchas</div><div class="crit-row"> Pisos secos sin residuos</div><div class="crit-row"> Mobiliario alineado y ordenado</div></div>`,
  maloca:mkAreaLimp('Espacio ceremonial y de eventos',[['Revisión Inicial','Confirmar sin actividades. Verificar objetos ceremoniales.'],['Superficies','Limpiar postes y vigas accesibles con paño seco. Retirar telarañas.'],['Piso','Barrer completamente incluyendo bordes y esquinas.'],['Alrededores','Recoger hojas y ramas del área exterior inmediata.']],['Espacio libre de residuos y hojas','Piso barrido y en buen estado','Sin telarañas visibles','Área lista para uso o ceremonia'])+`<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Espacio libre de residuos y hojas</div><div class="crit-row"> Piso barrido y en buen estado</div><div class="crit-row"> Sin telarañas visibles</div></div>`,
  'duchas-limp':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Duchas Principales</div><div class="doc-note" style="margin-bottom:.9rem;"> Confirmar sin personas antes de limpiar.</div>${mkStepsMT([['Revisión Inicial','Confirmar sin personas. Verificar agua caliente y buena presión.'],['Limpieza de ducha','Limpiar paredes, grifos y desagüe. Retirar residuos de jabón y cabello.'],['Suelo y drenaje','Barrer y trapear el área. Verificar que el drenaje no esté tapado.'],['Aserrín e inodoro','Verificar capa de aserrín. Limpiar área del inodoro.'],['Reposición','Reponer papel higiénico, jabón y toallas.'],['Revisión Final','Espejos limpios, área seca y con buen olor.']])}<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Ducha limpia y sin residuos</div><div class="crit-row"> Piso seco y sin agua estancada</div><div class="crit-row"> Aserrín suficiente, área sin olores</div><div class="crit-row"> Papel, jabón y toallas abastecidos</div></div>`,
  'banos-limp':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Baños Principales</div><div class="doc-note" style="margin-bottom:.9rem;"> Confirmar sin personas antes de limpiar.</div>${mkStepsMT([['Revisión Inicial','Confirmar sin personas. Identificar zonas que requieren atención.'],['Lavamanos','Limpiar lavamanos, grifos, espejos y repisas. Desinfectar manijas.'],['Aserrín e inodoro','Verificar capa de aserrín. Limpiar área del inodoro.'],['Piso','Barrer completamente. Trapear con agua y desinfectante.'],['Reposición','Reponer papel higiénico, jabón y toallas.']])}<div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Antes de salir, verifica:</div><div class="crit-row"> Aserrín suficiente, área sin olores</div><div class="crit-row"> Lavamanos y espejos limpios</div><div class="crit-row"> Piso seco y sin residuos</div><div class="crit-row"> Papel, jabón y toallas abastecidos</div></div>`,

  'casitas-madera':(function(){
    const cas=[{id:'toensmeier',nombre:'Toensmeier',m2:60,cama:'King',cap:2},{id:'hemenway',nombre:'Hemenway',m2:60,cama:'King',cap:2},{id:'primavesi',nombre:'Primavesi',m2:60,cama:'King',cap:4},{id:'salatin',nombre:'Salatin',m2:60,cama:'King',cap:4},{id:'shiva',nombre:'Shiva',m2:60,cama:'King',cap:2},{id:'savory',nombre:'Savory',m2:50,cama:'Twin',cap:2},{id:'yeomans',nombre:'Yeomans',m2:50,cama:'Twin',cap:2},{id:'fukuoka',nombre:'Fukuoka',m2:50,cama:'Twin',cap:2},{id:'mollison',nombre:'Mollison',m2:50,cama:'Twin',cap:2},{id:'lancaster',nombre:'Lancaster',m2:50,cama:'Dorm',cap:4},{id:'gotsch',nombre:'Götsch',m2:50,cama:'Twin',cap:2},{id:'holzer',nombre:'Holzer',m2:50,cama:'Twin',cap:2},{id:'ingham',nombre:'Ingham',m2:50,cama:'Twin',cap:2},{id:'carson',nombre:'Carson',m2:50,cama:'Twin',cap:2}];
    const pasos=[['Ingreso y Protocolo','Consultar lista de habitaciones ocupadas. Tocar 3 veces y anunciarse.'],['Ventilación Inicial','Abrir puertas y ventanas. Revisar humedad u olores inusuales.'],['Cama y Textiles','Retirar sábanas solo si checkout. Forro ajustado  sábana  duvet centrado.  NO colocar toallas sobre la cama.'],['Superficies','Quitar polvo. Desinfectante neutro. No usar cloro sobre madera.'],['Piso','Barrer completamente. Trapear sin exceso de humedad.'],['Revisión Final','Cama perfectamente hecha. Mobiliario alineado. Olor fresco.']];
    const criterios=['Olor fresco y natural','Piso limpio y seco','Cama impecablemente presentada','Área lista para recibir huésped'];
    window._casitasMadera={casitas:cas,pasos,criterios};
    return `<div style="font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.4);font-style:italic;margin-bottom:1rem;">Selecciona la casita a preparar</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">${cas.map(x=>`<div class="gcard" onclick="openCasitaDetalle('madera','${x.id}')" style="padding:.85rem .8rem;"><div class="ct" style="font-size:.9rem;">${x.nombre}</div><div class="cd">${x.cama} · ${x.m2}m² · ${x.cap} huéspedes</div></div>`).join('')}</div>`;
  })(),

  'casitas-bah':(function(){
    const cas=[{id:'starhawk',nombre:'Starhawk',m2:50,cama:'Queen',cap:2},{id:'crawford',nombre:'Crawford',m2:50,cama:'Queen',cap:2},{id:'einsestein',nombre:'Einsestein',m2:50,cama:'Queen',cap:2},{id:'doherty',nombre:'Doherty',m2:50,cama:'Queen',cap:2},{id:'macy',nombre:'Macy',m2:50,cama:'Queen',cap:2}];
    const pasos=[['Ingreso y Protocolo','Consultar lista. Tocar 3 veces y anunciarse.'],['Ventilación Inicial','Abrir puertas y ventanas. Cuidado con humedad en bahareque.'],['Cama y Textiles','Retirar sábanas solo si checkout.  NO colocar toallas sobre la cama.'],['Superficies','No usar cloro. Cuidado en superficies de barro.'],['Piso','Barrer completamente. Trapear sin exceso de humedad.'],['Revisión Final','Cama perfectamente hecha. Materiales sin daños por humedad.']];
    const criterios=['Olor fresco y natural','Piso limpio y seco','Cama impecablemente presentada','Materiales naturales sin daños'];
    window._casitasBah={casitas:cas,pasos,criterios};
    return `<div style="font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.4);font-style:italic;margin-bottom:1rem;">Selecciona la casita a preparar</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">${cas.map(x=>`<div class="gcard" onclick="openCasitaDetalle('bah','${x.id}')" style="padding:.85rem .8rem;"><div class="ct" style="font-size:.9rem;">${x.nombre}</div><div class="cd">${x.cama} · ${x.m2}m² · ${x.cap} huéspedes</div></div>`).join('')}</div>`;
  })(),
};

const MANUAL_LMP_SECS = [
  { id:'depto',          title:'Departamento de Operaciones' },
  { id:'marco-principios', title:'Marco de Principios' },
  { id:'criterios-todo', title:'Criterios, Preparación y Procedimientos Generales' },
  { divider:'Áreas Comunes' },
  { id:'oficina',        title:'Oficina' },
  { id:'juicebar',       title:'Juice Bar' },
  { id:'recepcion',      title:'Recepción' },
  { id:'comedor',        title:'Cocina' },
  { id:'templo',         title:'Estudio de Movimiento' },
  { id:'lounge',         title:'Lounge' },
  { id:'maloca',         title:'Maloca' },
  { id:'duchas-limp',    title:'Duchas' },
  { id:'banos-limp',     title:'Baños' },
  { divider:'Habitaciones' },
  { id:'casitas-madera', title:'Casitas de Madera' },
  { id:'casitas-bah',    title:'Casitas de Bahareque' },
];

function renderManualLimp(){
  let html = `<div class="sec-band band-blue">Estándares, procedimientos y criterios de limpieza · Versión 2.0 · 2025</div>`;
  let inGrid = false;

  MANUAL_LMP_SECS.forEach((s, idx) => {
    if (s.divider) {
      if (inGrid) { html += `</div>`; inGrid = false; }
      html += `<div class="sec-band band-blue">${s.divider}</div>`;
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:.75rem;">`;
      inGrid = true;
    } else {
      if (!inGrid) {
        html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:.75rem;">`;
        inGrid = true;
      }
      html += `<div class="gcard" onclick="openManualSectionByIdx('limp',${idx})" style="margin-bottom:0;">
        <div class="ct" style="font-size:.9rem;">${s.title}</div>
      </div>`;
    }
  });

  if (inGrid) html += `</div>`;
  return html;
}
function openCatalogoProductos(){
  setConScreen('Catálogo de Productos',()=>openInsumosLimp(),
    `<div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:.75rem;">Productos aprobados por efectividad, seguridad y compatibilidad con materiales naturales.</div>
     <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;overflow:hidden;">
       <div style="display:grid;grid-template-columns:1.4fr 1.5fr 1.3fr;background:var(--brown);padding:.55rem .75rem;gap:.5rem;color:var(--cream);">${['Producto','Uso principal','Precauciones'].map(h=>`<div style="font-size:.65rem;text-transform:uppercase;letter-spacing:.07em;color:var(--cream);font-family:sans-serif;">${h}</div>`).join('')}</div>
       ${[['Jabón líquido Florex','Higiene personal y lavado de superficies generales','Evitar contacto con ojos. Uso externo.'],['Detergente Lavaropa Florex','Lavado de ropa y textiles de cama','No mezclar con cloro. Enjuagar bien.'],['Gel de baño sábila','Higiene corporal en duchas de huéspedes','Uso externo. Evitar contacto con ojos.'],['Shampoo sábila','Higiene capilar en duchas de huéspedes','Uso externo. Evitar contacto con ojos.'],['Cera líquida antideslizante Blanca','Tratamiento y protección de pisos de madera y bahareque','Aplicar en capa delgada. Dejar secar antes de transitar.'],['Silicon abrillantador Florex','Lustre y protección de superficies de madera y plástico','No aplicar en pisos transitables. Evitar inhalación.'],['Cloro 4% Florex','Desinfección de baños y superficies de alto contacto','No mezclar con otros productos. Ventilar el área. Usar guantes.'],['Blanqueador para ropa Florex','Blanqueado de textiles blancos y de cama','Solo en ropa blanca. No mezclar con otros químicos.'],['Suavizante de ropa','Suavizado de textiles y sábanas en lavandería','No usar en microfibra. No sobredosificar.'],['Desinfectante Florex','Desinfección de superficies en baños, cocinas y áreas comunes','Respetar la dilución indicada. Usar guantes.'],['Bolsa jumbo transparente','Recolección y traslado de basura general','Cambiar cuando sea necesario, no por rutina fija.'],['Bolsas naranjas jumbo','Identificación de residuos orgánicos o especiales','Mantener separadas de otros residuos.'],['Bolsas blancas pequeñas','Basureros de habitaciones y baños','Reemplazar cuando el área lo requiera, no cuando estén llenas.'],].map(([p,u,pr],i)=>`<div style="display:grid;grid-template-columns:1.4fr 1.5fr 1.3fr;padding:.55rem .75rem;gap:.5rem;background:${i%2===0?'white':'#faf8f4'};border-bottom:1px solid rgba(84,66,54,.05);"><div style="font-size:.78rem;font-family:sans-serif;font-weight:600;color:var(--brown);">${p}</div><div style="font-size:.73rem;font-family:sans-serif;color:var(--brown);">${u}</div><div style="font-size:.68rem;font-family:sans-serif;color:var(--tm);line-height:1.4;">${pr}</div></div>`).join('')}
     </div>`);
}

function openSolicitudInsumos(){
  const today=todayLocal();
  document.getElementById('con-title').textContent='Solicitud de Insumos';
  document.getElementById('con-back').onclick=()=>openInsumosLimp();
  document.getElementById('conbody').innerHTML=`
    <div style="font-size:.78rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:1rem;">Agrega todos los insumos que necesitas en esta solicitud.</div>
    <div class="fg"><label>Solicitante</label><select id="ins-colab"><option value="">— Seleccionar —</option>${COLABS_LIMP.map(n=>`<option${CU&&n===CU.nombre?' selected':''}>${escapeHtml(n)}</option>`).join('')}</select></div>
    <div class="fg"><label>Fecha</label><input type="date" id="ins-fecha" value="${today}"></div>
    <div class="fg"><label>Prioridad</label><select id="ins-prior"><option value="Normal">Normal</option><option value="Urgente">Urgente</option></select></div>
    <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;margin-bottom:1rem;">
      <div class="cl-sec-title" style="margin-bottom:.8rem;">Insumos solicitados</div>
      <div id="ins-list">${insRow(0)}</div>
      <button onclick="addInsRow()" style="width:100%;margin-top:.75rem;background:none;border:1.5px dashed rgba(153,92,68,.3);border-radius:8px;padding:.65rem;color:var(--clay);font-size:.82rem;font-family:sans-serif;cursor:pointer;">+ Agregar otro insumo</button>
    </div>
    <div class="fg"><label>Observaciones</label>${aw('ins-obs','Urgencia, uso específico, notas adicionales...')}</div>
    <button class="btn-sub" id="ins-sub" onclick="submitSolicitudInsumos()">Enviar Solicitud</button>
    <div class="fnote">La solicitud se enviará a administración</div>
    <div class="ok-msg" id="ins-ok"><p>Solicitud enviada correctamente.</p></div>
    <div class="err-msg" id="ins-err"><p>Error al enviar. Intenta de nuevo.</p></div>`;
  show('con-screen');
}

let insCount=1;
function insRow(idx){
  const unidades=['Unidad','Paquete','Kilo (kg)','Gramo (g)','Litro (L)','Mililitro (mL)','Galón','Rollo','Caja','Bolsa','Par','Docena','Metro','Pichinga','Otro'];
  const iStyle='background:#fafaf8;border:1px solid rgba(84,66,54,.2);border-radius:8px;padding:.6rem .7rem;font-size:.85rem;font-family:sans-serif;color:#3d2f26 !important;-webkit-text-fill-color:#3d2f26 !important;outline:none;';
  const sStyle='background:#fafaf8;border:1px solid rgba(84,66,54,.2);border-radius:8px;padding:.6rem .5rem;font-size:.78rem;font-family:sans-serif;color:#3d2f26 !important;-webkit-text-fill-color:#3d2f26 !important;outline:none;appearance:none;';
  return `<div id="ins-row-${idx}" style="display:grid;grid-template-columns:1.8fr .8fr 1fr auto;gap:.4rem;margin-bottom:.55rem;align-items:center;"><input type="text" id="ins-item-${idx}" placeholder="Insumo" style="${iStyle}"><input type="number" id="ins-qty-${idx}" placeholder="Cant." min="1" style="${iStyle}"><select id="ins-unit-${idx}" style="${sStyle}">${unidades.map(u=>`<option value="${u}" style="color:#3d2f26;background:#fafaf8;">${u}</option>`).join('')}</select>${idx>0?`<button onclick="removeInsRow(${idx})" style="width:28px;height:28px;border-radius:50%;border:1.5px solid rgba(84,66,54,.2);background:none;color:var(--tm);font-size:1rem;cursor:pointer;line-height:1;">×</button>`:'<div style="width:28px;"></div>'}</div>`;
}
function addInsRow(){document.getElementById('ins-list').insertAdjacentHTML('beforeend',insRow(insCount));insCount++;}
function removeInsRow(idx){document.getElementById('ins-row-'+idx)?.remove();}

async function submitSolicitudInsumos(){
  const colab=document.getElementById('ins-colab')?.value;
  if(!colab){alert('Por favor selecciona el solicitante.');return;}
  const items=[];
  for(let i=0;i<insCount;i++){const el=document.getElementById('ins-row-'+i);if(!el)continue;const item=document.getElementById('ins-item-'+i)?.value?.trim();const qty=document.getElementById('ins-qty-'+i)?.value;const unit=document.getElementById('ins-unit-'+i)?.value||'Unidad';if(item)items.push({item,qty:qty||'1',unit});}
  if(!items.length){alert('Por favor agrega al menos un insumo.');return;}
  const btn=document.getElementById('ins-sub');btn.disabled=true;btn.textContent='Enviando...';
  const res=await sendToSheets({type:'solicitud-insumos',usuario:CU.usuario,departamento:'limpieza',tipo:'solicitud-insumos',datos:{colaborador:colab,fecha:document.getElementById('ins-fecha')?.value||'',prior:document.getElementById('ins-prior')?.value||'',items,obs:document.getElementById('ta-ins-obs')?.value||''}});
  if(res.ok){
    insCount=1;
    showCompletado(() => goBack());
  } else {
    document.getElementById('ins-err').querySelector('p').textContent = (res.error || 'Error al enviar. Intenta de nuevo.');
    document.getElementById('ins-err').style.display='block';
    btn.disabled=false;
    btn.textContent='Enviar Solicitud';
  }
}

// ── MANUAL DE MANTENIMIENTO (contenido estático) ──

const MANUAL_MT_SECS = [
  { id:'depto',          title:'Departamento de Operaciones' },
  { id:'marco-principios', title:'Marco de Principios' },
  { id:'prep-seg-rep',   title:'Preparación, Seguridad y Reportes' },
  { divider:'Áreas Comunes' },
  { id:'organizacion-mt', title:'Organización de la Propiedad' },
  { id:'inspeccion-areas-mt', title:'Inspección Áreas Comunes' },
  { id:'bridge-mt',      title:'Hanging Bridge' },
  { id:'banos-mt',       title:'Baños' },
  { id:'agua',           title:'Sistemas de Agua' },
  { divider:'Habitaciones' },
  { id:'casitas-madera-mt', title:'Casitas de Madera' },
  { id:'casitas-bah-mt',    title:'Casitas de Bahareque' },
];


const MANUAL_MT_CONTENT={
  intro:`<p style="font-size:.82rem;font-family:sans-serif;color:rgba(232,226,209,0.8);line-height:1.6;margin-bottom:.8rem;">Este manual establece los estándares de mantenimiento para Tierramor.</p>`,
  'prep-seg-rep':`<div style="font-size:.82rem;font-family:sans-serif;color:rgba(232,226,209,0.8);font-weight:600;margin-bottom:.6rem;">Criterios Generales</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:1.2rem;">${[['PREVENTIVO','Identificar problemas antes de que se conviertan en fallas.'],['DOCUMENTADO','Toda anomalía se registra. Lo que no se escribe no existe.'],['OPORTUNO','Una intervención a tiempo evita daños mayores.'],['SEGURO','No intervenir en sistemas mayores sin autorización.']].map(([t,d])=>`<div style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:10px;padding:.85rem .8rem;"><div style="font-size:.72rem;font-weight:600;font-family:sans-serif;color:var(--clay);letter-spacing:.06em;margin-bottom:.25rem;">${t}</div><div style="font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.65);line-height:1.4;">${d}</div></div>`).join('')}</div>${mkStepsMT([['Preparación Personal','Uniforme limpio, calzado cerrado y equipo de protección disponible.'],['Revisión del Equipo','Kit de herramientas: llaves, destornilladores, linterna, cinta métrica.'],['Inspección Visual Inicial','Al llegar a cada área: observar antes de tocar. Detectar anomalías.'],['Registro y Comunicación','Toda anomalía debe registrarse. Clasificar: URGENTE / PRIORIDAD / PROGRAMAR.']])}<div class="crit-box" style="margin-top:1rem;"><div class="crit-lbl">Clasificación de Anomalías</div><div class="crit-row"> URGENTE — Riesgo para personas o falla crítica. Reportar de inmediato.</div><div class="crit-row"> PRIORIDAD — Falla sin riesgo inmediato. Resolver en 24h.</div><div class="crit-row"> PROGRAMAR — Deterioro menor. Incluir en lista semanal.</div></div>`,
  'organizacion-mt':`<div class="sec-lbl" style="margin-top:0;">Clusters de Inspección</div>${[
    ['Tránsito Constante','Oficina · Juice Bar · Salón de Cocina y Recepción — Inspección mensual'],
    ['Cluster 1','Bodega · Terralab · Puente · Movement Studio · Lounge · Duchas · Baños Principales'],
    ['Cluster 2','Toensmeier · Baños 7600 · Baños de la Teca · Lancaster · Götsch · Holzer · Cocina Residentes · Ingham · Carson'],
    ['Cluster 3','Baño de Madera · Hememway · Primavesi · Salatin · Shiva · Savory · Yeomans · Fukuoka · Mollison'],
    ['Cluster 4','Starhawk · Crawford · Eisenstein · Doherty · Macy · Baños Bahareque · Wex Camp · Maloca'],
    ['Atención Diaria','Piscina · Sistemas de Agua · Casita Azul'],
  ].map(([t,d])=>`<div style="background:rgba(255,255,255,0.055);border-left:3px solid var(--clay);border-radius:0 10px 10px 0;padding:.85rem 1rem;margin-bottom:.55rem;">
    <div style="font-family:var(--font-serif);font-style:italic;font-size:1rem;color:var(--cream);margin-bottom:.25rem;">${t}</div>
    <div style="font-size:.78rem;font-family:var(--font-sans);color:rgba(232,226,209,0.55);line-height:1.45;">${d}</div>
  </div>`).join('')}`,
  'inspeccion-areas-mt':`<div style="font-size:.75rem;font-family:var(--font-sans);font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección mensual · Tránsito Constante y Cluster 1</div>
  ${mkStepsMT([
    ['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas. Humedad, plagas.'],
    ['Equipos','Funcionamiento de equipos propios del área (refrigeración, cómputo, sonido, etc).'],
    ['Estado general','Condición de mobiliario, superficies y stock visible. Reportar faltantes o daños.'],
  ])}
  <div class="crit-box" style="margin-top:1rem;">
    <div class="crit-lbl">Esta guía aplica a las siguientes áreas</div>
    ${['Oficina','Juice Bar','Cocina','Estudio de Movimiento','Storage / Bodega','Terralab','Lounge','Duchas'].map(a=>`<div class="crit-row">• ${a}</div>`).join('')}
  </div>
  <div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'oficina-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección mensual · Tránsito Constante</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas. Detectar humedad, plagas o daños.'],['Equipos','Funcionamiento de equipos de cómputo, router, aire acondicionado, impresora.'],['Organización','Cables organizados sin riesgos de tropiezo. Basureros limpios con bolsa.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'juicebar-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección mensual · Tránsito Constante</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas. Humedad, plagas.'],['Equipos','Funcionamiento de licuadora/extractor, refrigeradora, grifo.'],['Estado general','Estado de barra exterior. Stock visible — reportar faltantes.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'cocina-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección mensual · Tránsito Constante</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas.'],['Equipos de cocina','Funcionamiento de quemadores, extractor, refrigeradora, lavaplatos y grifo.'],['Estado general','Estado de mostrador. Estado de filtro de agua. Fugas bajo el fregadero.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'estudio-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección · Cluster 1</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas.'],['Equipos y mobiliario','Estado del piso, espejos, equipo de sonido, colchonetas y props.'],['Espacio','Libre de obstáculos. Ventilación adecuada.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'storage-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección · Cluster 1</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas.'],['Almacenamiento','Organización visible, estado de estantes. Presencia de plagas en productos.'],['Stock','Insumos críticos en nivel adecuado.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'terralab-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección · Cluster 1</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas.'],['Equipos','Estado de equipos de laboratorio, refrigeración, organización.'],['Ventilación','Ventilación adecuada del espacio.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'bridge-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección · Cluster 1 ·  Estructura de seguridad crítica</div><div class="doc-note" style="margin-bottom:.75rem;"> Inspeccionar con atención. Cualquier anomalía estructural es URGENTE.</div>${mkStepsMT([['Estructura de soporte','Estado de cables o estructura. Barandas firmes y sin daños.'],['Superficie de paso','Estado de tablones. Sin deterioro, astillas o piezas sueltas.'],['Condiciones','Sin humedad excesiva. Iluminación del puente funcionando.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'lounge-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección · Cluster 1</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas.'],['Mobiliario','Estado de muebles, tapizado, hamacas o mobiliario exterior.'],['Deck','Estado del deck: sin tablas sueltas ni astillas. Iluminación exterior.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'duchas-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección · Cluster 1</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas.'],['Ducha y agua','Funcionamiento de ducha (presión y temperatura), grifo del lavatorio. Fugas o taponamientos.'],['Baño seco','Estado de la caja de aserrín, funcionamiento del inodoro. Espejos y accesorios.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  'banos-mt':`<div style="font-size:.75rem;font-family:sans-serif;font-style:italic;color:rgba(232,226,209,0.4);margin-bottom:1rem;">Inspección · Cluster 1</div>${mkStepsMT([['Eléctrico y estructura','Conexión eléctrica, outlets, luces, ventiladores, llavines, ventanas.'],['Ducha y agua','Funcionamiento de ducha, grifo del lavatorio. Fugas o taponamientos.'],['Baño seco','Estado de la caja de aserrín, funcionamiento del inodoro. Espejos y accesorios.']])}<div class="crit-box" style="margin-top:.5rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`,
  agua:`<div class="doc-note" style="margin-bottom:.8rem;"> Ante cualquier anomalía en sistemas de agua, reportar de inmediato.</div>${[['M1','Pozo Principal','Salida del tanque a la par del pozo — envía agua a las casitas'],['M2','Tanques Ojoche','Entrada de los tanques en la loma'],['M4','Tanque Potable','Entrada del tanque a la par de la bodega'],['M5','Tanques Piscina Izq.','Tanques de la piscina, mano izquierda'],['M6','Tanques Piscina Der.','Tanques de la piscina, mano derecha'],['M7','Tubería Principal Piscina','Tubería de abastecimiento del pozo hacia tanques de piscina']].map(([m,n,d])=>`<div style="background:rgba(255,255,255,0.055);border:1px solid rgba(232,226,209,0.09);border-radius:8px;padding:.7rem;margin-bottom:.45rem;display:flex;gap:.7rem;align-items:flex-start;"><span style="font-size:.68rem;font-family:sans-serif;font-weight:600;color:var(--clay);min-width:28px;">${m}</span><div><div style="font-size:.8rem;font-family:sans-serif;color:var(--cream);font-weight:500;">${n}</div><div style="font-size:.7rem;font-family:sans-serif;color:rgba(232,226,209,0.5);">${d}</div></div></div>`).join('')}<div class="doc-note" style="margin-top:.5rem;"> Sin medidor activo: Tanques Pozo Principal · Tanques Bahareque · Pozo Maloca — registro visual.</div>`,

  'casitas-madera-mt':(function(){
    const cas=[{id:'toensmeier-mt',nombre:'Toensmeier',m2:60,cama:'King',cap:2},{id:'hemenway-mt',nombre:'Hemenway',m2:60,cama:'King',cap:2},{id:'primavesi-mt',nombre:'Primavesi',m2:60,cama:'King',cap:4},{id:'salatin-mt',nombre:'Salatin',m2:60,cama:'King',cap:4},{id:'shiva-mt',nombre:'Shiva',m2:60,cama:'King',cap:2},{id:'savory-mt',nombre:'Savory',m2:50,cama:'Twin',cap:2},{id:'yeomans-mt',nombre:'Yeomans',m2:50,cama:'Twin',cap:2},{id:'fukuoka-mt',nombre:'Fukuoka',m2:50,cama:'Twin',cap:2},{id:'mollison-mt',nombre:'Mollison',m2:50,cama:'Twin',cap:2},{id:'lancaster-mt',nombre:'Lancaster',m2:50,cama:'Dorm',cap:4},{id:'gotsch-mt',nombre:'Götsch',m2:50,cama:'Twin',cap:2},{id:'holzer-mt',nombre:'Holzer',m2:50,cama:'Twin',cap:2},{id:'ingham-mt',nombre:'Ingham',m2:50,cama:'Twin',cap:2},{id:'carson-mt',nombre:'Carson',m2:50,cama:'Twin',cap:2}];
    window._casitasMaderaMT=cas;
    return `<div style="font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.4);font-style:italic;margin-bottom:1rem;">Selecciona la casita a inspeccionar</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">${cas.map(x=>`<div class="gcard" onclick="openCasitaDetalleMT('madera','${x.id}')" style="padding:.85rem .8rem;"><div class="ct" style="font-size:.9rem;">${x.nombre}</div><div class="cd">${x.cama} · ${x.m2}m² · ${x.cap} huéspedes</div></div>`).join('')}</div>`;
  })(),

  'casitas-bah-mt':(function(){
    const cas=[{id:'starhawk-mt',nombre:'Starhawk',m2:50,cama:'Queen',cap:2},{id:'crawford-mt',nombre:'Crawford',m2:50,cama:'Queen',cap:2},{id:'einsestein-mt',nombre:'Einsestein',m2:50,cama:'Queen',cap:2},{id:'doherty-mt',nombre:'Doherty',m2:50,cama:'Queen',cap:2},{id:'macy-mt',nombre:'Macy',m2:50,cama:'Queen',cap:2}];
    window._casitasBahMT=cas;
    return `<div style="font-size:.75rem;font-family:sans-serif;color:rgba(232,226,209,0.4);font-style:italic;margin-bottom:1rem;">Selecciona la casita a inspeccionar</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">${cas.map(x=>`<div class="gcard" onclick="openCasitaDetalleMT('bah','${x.id}')" style="padding:.85rem .8rem;"><div class="ct" style="font-size:.9rem;">${x.nombre}</div><div class="cd">${x.cama} · ${x.m2}m² · ${x.cap} huéspedes</div></div>`).join('')}</div>`;
  })(),
};

function renderManualManto(){
  let html = `<div class="sec-band band-clay">Estándares, procedimientos e inspecciones · Versión 2.0 · 2025</div>`;
  let inGrid = false;

  MANUAL_MT_SECS.forEach((s, idx) => {
    if (s.divider) {
      if (inGrid) { html += `</div>`; inGrid = false; }
      html += `<div class="sec-band band-clay">${s.divider}</div>`;
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:.75rem;">`;
      inGrid = true;
    } else {
      if (!inGrid) {
        html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-bottom:.75rem;">`;
        inGrid = true;
      }
      html += `<div class="gcard" onclick="openManualSectionByIdx('manto',${idx})" style="margin-bottom:0;">
        <div class="ct" style="font-size:.9rem;">${s.title}</div>
      </div>`;
    }
  });

  if (inGrid) html += `</div>`;
  return html;
}

function openCasitaDetalleMT(tipo, casitaId) {
  const allCasitas = tipo === 'madera' ? window._casitasMaderaMT : window._casitasBahMT;
  const casita = allCasitas.find(c => c.id === casitaId);
  if (!casita) return;
  const backTitle = tipo === 'madera' ? 'Casitas de Madera' : 'Casitas de Bahareque';
  const backKey   = tipo === 'madera' ? 'casitas-madera-mt' : 'casitas-bah-mt';
  const items = ['Conexión eléctrica principal funcionando','Funcionamiento de outlets eléctricos','Funcionamiento de luces (internas y externas)','Funcionamiento de abanico(s) / ventilador(es)','Funcionamiento de llavines y cerraduras','Funcionamiento de ventanas (abren, cierran, traban correctamente)','Daños visibles en estructura (paredes, cielo raso, piso, puertas)','Presencia de humedad, manchas de agua o filtraciones','Presencia de plagas o nidos de insectos','Estado de basureros (limpios, con bolsa, tapados)','Funcionamiento de ducha (presión y temperatura de agua)','Estado del mosquitero (sin roturas ni separaciones)','Estado del colchón y textiles (sin manchas, sin humedad)','Funcionamiento de cerrojo interior de privacidad','Estado de repisas, mesa y mobiliario','Visibilidad desde exterior (privacidad del huésped)'];
  const html = `
    <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;margin-bottom:1rem;">
      <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tm);font-family:sans-serif;margin-bottom:.75rem;">Características</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.5rem;">
        ${[['Tipo de cama',casita.cama],['Metros cuadrados',casita.m2+' m²'],['Capacidad',casita.cap+' huéspedes']].map(([lbl,val])=>`<div style="background:#faf8f4;border-radius:8px;padding:.65rem .7rem;text-align:center;"><div style="font-size:.62rem;font-family:sans-serif;color:var(--tm);text-transform:uppercase;letter-spacing:.07em;margin-bottom:.3rem;">${lbl}</div><div style="font-size:.88rem;font-family:sans-serif;font-weight:600;color:var(--brown);">${val}</div></div>`).join('')}
      </div>
    </div>
    <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tm);font-family:sans-serif;margin-bottom:.75rem;">Checklist de inspección</div>
    ${items.map(item=>`<div class="cl-item" style="border-bottom:1px solid rgba(84,66,54,.06);padding:.5rem 0;"><div style="width:20px;height:20px;border:1.5px solid rgba(153,92,68,.3);border-radius:5px;flex-shrink:0;margin-top:.1rem;"></div><div style="font-size:.82rem;font-family:sans-serif;color:var(--brown);line-height:1.4;margin-left:.75rem;">${item}</div></div>`).join('')}
    <div class="crit-box" style="margin-top:.75rem;"><div class="crit-lbl">Registrar anomalías como</div><div class="crit-row"> URGENTE ·  PRIORIDAD ·  PROGRAMAR</div></div>`;
  setConScreen(casita.nombre,
    () => openManualSection('manto', backKey, backTitle),
    `<div class="doc-viewer">${html}</div>`);
}

function openCasitaDetalle(tipo, casitaId) {
  const data   = tipo === 'madera' ? window._casitasMadera : window._casitasBah;
  const casita = data.casitas.find(c => c.id === casitaId);
  if (!casita) return;
  const backTitle = tipo === 'madera' ? 'Casitas de Madera' : 'Casitas de Bahareque';
  const backKey   = tipo === 'madera' ? 'casitas-madera' : 'casitas-bah';
  const html = `
    <div class="doc-note" style="margin-bottom:.9rem;"> Privacidad del huésped: tocar 3 veces y anunciarse. Nunca entrar sin verificar ocupación.</div>
    <div style="background:rgba(255,255,255,0.07);border:1px solid rgba(232,226,209,0.1);border-radius:10px;padding:1rem;margin-bottom:1rem;">
      <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tm);font-family:sans-serif;margin-bottom:.75rem;">Características</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.5rem;">
        ${[['Tipo de cama', casita.cama],['Metros cuadrados', casita.m2 + ' m²'],['Capacidad', casita.cap + ' huéspedes']].map(([lbl,val])=>`<div style="background:rgba(255,255,255,0.06);border-radius:8px;padding:.65rem .7rem;text-align:center;"><div style="font-size:.62rem;font-family:sans-serif;color:var(--tm);text-transform:uppercase;letter-spacing:.07em;margin-bottom:.3rem;">${lbl}</div><div style="font-size:.88rem;font-family:sans-serif;font-weight:600;color:var(--brown);">${val}</div></div>`).join('')}
      </div>
    </div>
    <div style="background:#faf8f4;border:1.5px dashed rgba(153,92,68,.25);border-radius:10px;padding:1.2rem;text-align:center;margin-bottom:1rem;">
      <div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);">Foto próximamente disponible</div>
    </div>
    <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--tm);font-family:sans-serif;margin-bottom:.75rem;">Procedimiento de limpieza</div>
    ${mkStepsMT(data.pasos)}
    <div class="crit-box" style="margin-top:.5rem;">
      <div class="crit-lbl">Antes de salir, verifica:</div>
      ${data.criterios.map(c=>`<div class="crit-row"> ${c}</div>`).join('')}
    </div>`;
  setConScreen(casita.nombre,
    () => openManualSection('limp', backKey, backTitle),
    `<div class="doc-viewer">${html}</div>`);
}

function openMapaTierramor() {
  setConScreen('Mapa de la Propiedad',
    () => goBack(),
    `<div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);font-style:italic;margin-bottom:.75rem;">Vista aérea · Tierramor, Santa Cruz, Guanacaste</div>
     <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:12px;overflow:hidden;">
       <img src="./mapa-tierramor.jpg" alt="Mapa de Tierramor" style="width:100%;height:auto;display:block;"
         onerror="this.parentElement.innerHTML='<div style=\'padding:2rem;text-align:center;font-family:sans-serif;color:var(--tm);\'><div style=\'font-size:2rem;margin-bottom:.75rem;\'></div><div style=\'font-size:.82rem;\'>Sube <strong>mapa-tierramor.jpg</strong> al repo de GitHub.</div></div>'">
     </div>
     <div style="font-size:.68rem;font-family:sans-serif;color:var(--tm);text-align:center;margin-top:.75rem;">Toca la imagen para ampliarla</div>`);
}

function openManualSectionByIdx(manual, idx) {
  const secs = manual === 'limp' ? MANUAL_LMP_SECS : MANUAL_MT_SECS;
  const s = secs[idx];
  if (!s || s.divider) return;
  openManualSection(manual, s.id, s.title);
}

function openManualSection(manual, sectionId, title) {
  const content = SHARED_CONTENT[sectionId] || (manual==='limp' ? MANUAL_LMP_CONTENT[sectionId] : MANUAL_MT_CONTENT[sectionId]);
  if (!content) return;
  const backFn = manual==='limp'
    ? () => setConScreen('Manual de Housekeeping', ()=>goBack(), renderManualLimp())
    : () => setConScreen('Manual de Mantenimiento', ()=>goBack(), renderManualManto());
  setConScreen(title, backFn, `<div class="doc-viewer">${content}</div>`);
}

// ── EVALUACIÓN DE PARES ──

function openPeerEval() {
  const today = todayLocal();
  const peers = ALL_COLABS.filter(n => n !== CU.nombre);
  document.getElementById('con-title').textContent = 'Evaluación de Pares';
  document.getElementById('con-back').onclick = () => openMyPerformance();
  document.getElementById('conbody').innerHTML = `
    <div class="doc-note" style="margin-bottom:1rem;"> Respuestas confidenciales · Solo las consulta administración<br>
    <span style="font-size:.68rem;">Incidencia: Mensual 20% · Trimestral 30%</span></div>
    <div class="cl-header-info">
      <div class="fg" style="margin-bottom:.6rem"><label>Compañero/a evaluado/a</label>
        <select id="ep-evaluado"><option value="">— Seleccionar —</option>${peers.map(n=>`<option>${escapeHtml(n)}</option>`).join('')}</select></div>
      <div class="fg" style="margin-bottom:.6rem"><label>Tipo de período</label>
        <select id="ep-tipo"><option value="Mensual">Mensual</option><option value="Trimestral Q1">Trimestral Q1</option><option value="Trimestral Q2">Trimestral Q2</option><option value="Trimestral Q3">Trimestral Q3</option><option value="Trimestral Q4">Trimestral Q4</option></select></div>
      <div class="fg" style="margin-bottom:0"><label>Fecha</label><input type="date" id="ep-fecha" value="${today}"></div>
    </div>
    <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;margin-bottom:.75rem;">
      <div class="cl-sec-title">Valoración por Competencias</div>
      <div style="font-size:.68rem;font-family:sans-serif;color:var(--tm);margin-bottom:.9rem;">1 = Necesita mejorar · 2 = En desarrollo · 3 = Cumple · 4 = Bueno · 5 = Excelente</div>
      ${[['ep-colab','Colaboración y trabajo en equipo','Apoya a los demás, comparte información, no crea fricciones'],['ep-resp','Responsabilidad y puntualidad','Cumple sus tareas a tiempo, respeta los acuerdos del equipo'],['ep-com','Comunicación efectiva','Se expresa con claridad, escucha bien, evita malentendidos'],['ep-actitud','Actitud y energía positiva','Contribuye a un buen ambiente, afronta retos con disposición'],['ep-calidad','Calidad del trabajo','Su desempeño diario cumple o supera el estándar de Tierramor'],].map(([id,label,desc])=>`
        <div style="margin-bottom:1rem;">
          <div style="font-size:.82rem;font-family:sans-serif;font-weight:600;color:var(--brown);margin-bottom:.15rem;">${label}</div>
          <div style="font-size:.7rem;font-family:sans-serif;color:var(--tm);margin-bottom:.4rem;">${desc}</div>
          <div style="display:flex;gap:.5rem;">${[1,2,3,4,5].map(n=>`<label style="flex:1;text-align:center;cursor:pointer;"><input type="radio" name="${id}" value="${n}" style="display:none;"><div class="ep-star" data-id="${id}" data-val="${n}" style="background:#faf8f4;border:1.5px solid rgba(84,66,54,.15);border-radius:8px;padding:.5rem .2rem;font-size:.75rem;font-family:sans-serif;color:var(--tm);text-align:center;cursor:pointer;transition:all .15s;">${n}<br><span style="font-size:.6rem;"></span></div></label>`).join('')}</div>
        </div>`).join('')}
    </div>
    <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;margin-bottom:.75rem;">
      <div class="cl-sec-title">Comportamientos Observados</div>
      ${[['ep-b1','Apoyó a un compañero/a sin que se lo pidieran'],['ep-b2','Comunicó un problema a tiempo antes de que escalara'],['ep-b3','Propuso alguna mejora o idea para el equipo'],['ep-b4','Mantuvo una actitud positiva incluso bajo presión'],['ep-b5','Generó algún conflicto innecesario con el equipo'],].map(([id,label])=>`
        <div style="margin-bottom:.75rem;">
          <div style="font-size:.82rem;font-family:sans-serif;color:var(--brown);margin-bottom:.35rem;">${label}</div>
          <div style="display:flex;gap:.5rem;">${['Sí','No','A veces'].map(opt=>`<label style="flex:1;text-align:center;cursor:pointer;"><input type="radio" name="${id}" value="${opt}" style="display:none;"><div class="ep-opt" data-id="${id}" data-val="${opt}" style="background:#faf8f4;border:1.5px solid rgba(84,66,54,.15);border-radius:8px;padding:.45rem .2rem;font-size:.75rem;font-family:sans-serif;color:var(--tm);text-align:center;cursor:pointer;transition:all .15s;">${opt}</div></label>`).join('')}</div>
        </div>`).join('')}
    </div>
    <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;margin-bottom:.75rem;">
      <div class="cl-sec-title">Preguntas Abiertas</div>
      <div class="fg" style="margin-bottom:.9rem;"><label> ¿Qué hace especialmente bien esta persona en el equipo?</label>${aw('ep-bien','Sé específico/a — ayuda a reconocer fortalezas reales...')}</div>
      <div class="fg" style="margin-bottom:0"><label> ¿En qué área podría mejorar?</label>${aw('ep-mejorar','Feedback constructivo — sin ataques personales...')}</div>
    </div>
    <div style="background:white;border:1px solid rgba(84,66,54,.1);border-radius:10px;padding:1rem;margin-bottom:.75rem;">
      <div class="cl-sec-title">Valoración Global</div>
      <div style="font-size:.82rem;font-family:sans-serif;color:var(--brown);margin-bottom:.6rem;">¿Recomendarías a esta persona para un rol de mayor responsabilidad?</div>
      <div style="display:flex;gap:.7rem;">
        <label style="flex:1;cursor:pointer;"><input type="radio" name="ep-rec" value="Sí" style="display:none;"><div class="ep-opt" data-id="ep-rec" data-val="Sí" style="background:#faf8f4;border:1.5px solid rgba(84,66,54,.15);border-radius:8px;padding:.65rem;font-size:.82rem;font-family:sans-serif;color:var(--tm);text-align:center;cursor:pointer;"> Sí, la recomiendo</div></label>
        <label style="flex:1;cursor:pointer;"><input type="radio" name="ep-rec" value="No" style="display:none;"><div class="ep-opt" data-id="ep-rec" data-val="No" style="background:#faf8f4;border:1.5px solid rgba(84,66,54,.15);border-radius:8px;padding:.65rem;font-size:.82rem;font-family:sans-serif;color:var(--tm);text-align:center;cursor:pointer;"> No por ahora</div></label>
      </div>
      <div class="fg" style="margin-top:.9rem;margin-bottom:0"><label>Comentario adicional (opcional)</label>
        ${aw('ep-comentario','Comentario adicional...')}
      </div>
    </div>
    <button class="btn-sub" id="ep-sub" onclick="submitPeerEval()">Enviar Evaluación</button>
    <div class="fnote"> Respuestas confidenciales — solo las consulta administración</div>
    <div class="ok-msg" id="ep-ok"><p>Evaluación enviada correctamente.</p></div>
    <div class="err-msg" id="ep-err"><p>Error al enviar. Intenta de nuevo.</p></div>`;
  setTimeout(()=>{
    document.querySelectorAll('.ep-star, .ep-opt').forEach(el=>{
      el.addEventListener('click',()=>{
        const id=el.dataset.id,val=el.dataset.val;
        document.querySelectorAll(`[data-id="${id}"]`).forEach(e=>{e.style.background='#faf8f4';e.style.borderColor='rgba(84,66,54,.15)';e.style.color='var(--tm)';e.style.fontWeight='normal';});
        el.style.background='var(--clay)';el.style.borderColor='var(--clay)';el.style.color='white';el.style.fontWeight='600';
        const radio=document.querySelector(`input[name="${id}"][value="${val}"]`);if(radio)radio.checked=true;
      });
    });
  },100);
  show('con-screen');
}

async function submitPeerEval(){
  const evaluado=document.getElementById('ep-evaluado')?.value;
  if(!evaluado){alert('Por favor selecciona al compañero/a a evaluar.');return;}
  const getRadio=name=>{const el=document.querySelector(`input[name="${name}"]:checked`);return el?el.value:'';};
  const competencias={colaboracion:getRadio('ep-colab'),responsabilidad:getRadio('ep-resp'),comunicacion:getRadio('ep-com'),actitud:getRadio('ep-actitud'),calidad:getRadio('ep-calidad')};
  const comportamientos={apoyo_sin_pedirlo:getRadio('ep-b1'),comunico_problemas:getRadio('ep-b2'),propuso_mejoras:getRadio('ep-b3'),actitud_bajo_presion:getRadio('ep-b4'),genero_conflictos:getRadio('ep-b5')};
  const vals=Object.values(competencias).filter(Boolean);
  const promedio=vals.length?(vals.reduce((a,b)=>a+parseInt(b),0)/vals.length).toFixed(1):'—';
  const btn=document.getElementById('ep-sub');btn.disabled=true;btn.textContent='Enviando...';
  const res=await sendToSheets({type:'evaluacion',usuario:CU.usuario,departamento:CU.departamento,tipo:'evaluacion-pares',datos:{evaluador:CU.nombre,evaluado,periodo:document.getElementById('ep-tipo')?.value||'',fecha:document.getElementById('ep-fecha')?.value||'',competencias,promedio,comportamientos,fortalezas:document.getElementById('ta-ep-bien')?.value||'',mejoras:document.getElementById('ta-ep-mejorar')?.value||'',recomendacion:getRadio('ep-rec'),comentario:document.getElementById('ta-ep-comentario')?.value||''}});
  if(res.ok){
    showCompletado(() => goBack());
  } else {
    document.getElementById('ep-err').querySelector('p').textContent = (res.error || 'Error al enviar. Intenta de nuevo.');
    document.getElementById('ep-err').style.display='block';
    btn.disabled=false;
    btn.textContent='Enviar Evaluación';
  }
}

// ── HORARIOS (SCHEDULES) ──

function getScheduleActivo() {
  const hoy = new Date();
  const inicioResidencies = new Date('2026-07-04');
  return hoy >= inicioResidencies ? 'residencies' : 'general';
}

const SCHEDULE_GENERAL = {
  rol1: {
    lunes: [
      { hora: '7:00 AM',  tarea: 'Salón de Cocina y Recepción' },
      { hora: '7:30 AM',  tarea: 'Baños Principales' },
      { hora: '8:00 AM',  tarea: 'DESAYUNO' },
      { hora: '8:30 AM',  tarea: 'Duchas Principales' },
      { hora: '9:00 AM',  tarea: 'Reunión de Operaciones' },
      { hora: '9:30 AM',  tarea: 'Reunión de Operaciones' },
      { hora: '10:00 AM', tarea: 'Lounge / Deck' },
      { hora: '10:30 AM', tarea: 'Lounge / Deck' },
      { hora: '11:00 AM', tarea: 'Cocina de Residentes' },
      { hora: '11:30 AM', tarea: 'Salón de Cocina y Recepción' },
      { hora: '12:00 PM', tarea: 'ALMUERZO' },
      { hora: '12:30 PM', tarea: 'Casita Azul' },
      { hora: '1:00 PM',  tarea: 'Casita Azul' },
      { hora: '1:30 PM',  tarea: 'Lavandería' },
      { hora: '2:00 PM',  tarea: 'Lavandería' },
      { hora: '2:30 PM',  tarea: 'Mollison - Ingham' },
    ],
    martes: [
      { hora: '7:00 AM',  tarea: 'Salón de Cocina y Recepción' },
      { hora: '7:30 AM',  tarea: 'Baños 7600 / Baños de Madera' },
      { hora: '8:00 AM',  tarea: 'DESAYUNO' },
      { hora: '8:30 AM',  tarea: 'Oficina' },
      { hora: '9:00 AM',  tarea: 'Maloca y Baños' },
      { hora: '9:30 AM',  tarea: 'Maloca y Baños' },
      { hora: '10:00 AM', tarea: 'Toensmeier' },
      { hora: '10:30 AM', tarea: 'Hemenway' },
      { hora: '11:00 AM', tarea: 'Primavesi' },
      { hora: '11:30 AM', tarea: 'Salatin' },
      { hora: '12:00 PM', tarea: 'ALMUERZO' },
      { hora: '12:30 PM', tarea: 'Shiva' },
      { hora: '1:00 PM',  tarea: 'Savory' },
      { hora: '1:30 PM',  tarea: 'Yeomans' },
      { hora: '2:00 PM',  tarea: 'Fukuoka' },
      { hora: '2:30 PM',  tarea: 'Mollison - Ingham' },
    ],
    miercoles: null,
    jueves: [
      { hora: '7:00 AM',  tarea: 'Salón de Cocina y Recepción' },
      { hora: '7:30 AM',  tarea: 'Baños 7600 / Baños de Madera' },
      { hora: '8:00 AM',  tarea: 'DESAYUNO' },
      { hora: '8:30 AM',  tarea: 'Terralab y Bodega' },
      { hora: '9:00 AM',  tarea: 'Maloca y Baños' },
      { hora: '9:30 AM',  tarea: 'Maloca y Baños' },
      { hora: '10:00 AM', tarea: 'Baños de Bahareque' },
      { hora: '10:30 AM', tarea: 'Baños de Bahareque' },
      { hora: '11:00 AM', tarea: 'Duchas de Bahareque' },
      { hora: '11:30 AM', tarea: 'Salón de Cocina y Recepción' },
      { hora: '12:00 PM', tarea: 'ALMUERZO' },
      { hora: '12:30 PM', tarea: 'Lancaster' },
      { hora: '1:00 PM',  tarea: 'Götsch' },
      { hora: '1:30 PM',  tarea: 'Holzer' },
      { hora: '2:00 PM',  tarea: 'Ingham - Carson' },
      { hora: '2:30 PM',  tarea: 'Repaso Baño de Madera + Baños Principales' },
    ],
    viernes: [
      { hora: '7:00 AM',  tarea: 'Salón de Cocina y Recepción' },
      { hora: '7:30 AM',  tarea: 'Duchas Principales' },
      { hora: '8:00 AM',  tarea: 'DESAYUNO' },
      { hora: '8:30 AM',  tarea: 'Lavado Tubos de Baño' },
      { hora: '9:00 AM',  tarea: 'Maloca y Baños' },
      { hora: '9:30 AM',  tarea: 'Maloca y Baños' },
      { hora: '10:00 AM', tarea: 'Starhawk' },
      { hora: '10:30 AM', tarea: 'Einsestein' },
      { hora: '11:00 AM', tarea: 'Macy' },
      { hora: '11:30 AM', tarea: 'Salón de Cocina y Recepción' },
      { hora: '12:00 PM', tarea: 'ALMUERZO' },
      { hora: '12:30 PM', tarea: 'Baños Principales' },
      { hora: '1:00 PM',  tarea: 'Lounge / Deck' },
      { hora: '1:30 PM',  tarea: 'Sillas Juice Bar' },
      { hora: '2:00 PM',  tarea: 'Repaso Baños Principales' },
      { hora: '2:30 PM',  tarea: 'Repaso Baños Principales' },
    ],
    sabado: null,
    domingo: null,
  },
  rol2: {
    lunes: [
      { hora: '7:00 AM',  tarea: 'Deck de Piscina' },
      { hora: '7:30 AM',  tarea: 'Deck de Piscina' },
      { hora: '8:00 AM',  tarea: 'DESAYUNO' },
      { hora: '8:30 AM',  tarea: 'Baños 7600 / Baños de Madera' },
      { hora: '9:00 AM',  tarea: 'Reunión de Operaciones' },
      { hora: '9:30 AM',  tarea: 'Reunión de Operaciones' },
      { hora: '10:00 AM', tarea: 'Toensmeier' },
      { hora: '10:30 AM', tarea: 'Movement Studio' },
      { hora: '11:00 AM', tarea: 'Salón de Cocina y Recepción' },
      { hora: '11:30 AM', tarea: 'Salón de Cocina y Recepción' },
      { hora: '12:00 PM', tarea: 'ALMUERZO' },
      { hora: '12:30 PM', tarea: 'Baños de Teca' },
      { hora: '1:00 PM',  tarea: 'Bodega de HK' },
      { hora: '1:30 PM',  tarea: 'Bodega de HK' },
      { hora: '2:00 PM',  tarea: 'Repaso Baños Principales' },
      { hora: '2:30 PM',  tarea: 'Repaso Baños Principales' },
    ],
    martes: [
      { hora: '7:00 AM',  tarea: 'Baños Principales' },
      { hora: '7:30 AM',  tarea: 'Juice Bar' },
      { hora: '8:00 AM',  tarea: 'DESAYUNO' },
      { hora: '8:30 AM',  tarea: 'Terralab y Bodega' },
      { hora: '9:00 AM',  tarea: 'Maloca y Baños' },
      { hora: '9:30 AM',  tarea: 'Maloca y Baños' },
      { hora: '10:00 AM', tarea: 'Baños de Bahareque' },
      { hora: '10:30 AM', tarea: 'Lancaster' },
      { hora: '11:00 AM', tarea: 'Götsch' },
      { hora: '11:30 AM', tarea: 'Salón de Cocina y Recepción' },
      { hora: '12:00 PM', tarea: 'ALMUERZO' },
      { hora: '12:30 PM', tarea: 'Holzer' },
      { hora: '1:00 PM',  tarea: 'Ingham' },
      { hora: '1:30 PM',  tarea: 'Carson' },
      { hora: '2:00 PM',  tarea: 'Baños 7600 / Baños de Madera' },
      { hora: '2:30 PM',  tarea: 'Repaso Baño de Madera + Baños Principales' },
    ],
    miercoles: [
      { hora: '7:00 AM',  tarea: 'Salón de Cocina y Recepción' },
      { hora: '7:30 AM',  tarea: 'Duchas Principales' },
      { hora: '8:00 AM',  tarea: 'DESAYUNO' },
      { hora: '8:30 AM',  tarea: 'Baños Principales' },
      { hora: '9:00 AM',  tarea: 'Baños 7600 / Baños de Madera' },
      { hora: '9:30 AM',  tarea: 'Cocina de Residentes' },
      { hora: '10:00 AM', tarea: 'Lounge / Deck' },
      { hora: '10:30 AM', tarea: 'Movement Studio' },
      { hora: '11:00 AM', tarea: 'Salón de Cocina y Recepción' },
      { hora: '11:30 AM', tarea: 'Salón de Cocina y Recepción' },
      { hora: '12:00 PM', tarea: 'ALMUERZO' },
      { hora: '12:30 PM', tarea: 'Limpieza de Vidrios General' },
      { hora: '1:00 PM',  tarea: 'Limpieza de Vidrios General' },
      { hora: '1:30 PM',  tarea: 'Limpieza de Vidrios General' },
      { hora: '2:00 PM',  tarea: 'Casita Azul' },
      { hora: '2:30 PM',  tarea: 'Mollison - Ingham' },
    ],
    jueves: null,
    viernes: [
      { hora: '7:00 AM',  tarea: 'Baños Principales' },
      { hora: '7:30 AM',  tarea: 'Baños 7600 / Baños de Madera' },
      { hora: '8:00 AM',  tarea: 'DESAYUNO' },
      { hora: '8:30 AM',  tarea: 'Lavado de Salón' },
      { hora: '9:00 AM',  tarea: 'Maloca y Baños' },
      { hora: '9:30 AM',  tarea: 'Maloca y Baños' },
      { hora: '10:00 AM', tarea: 'Crawford' },
      { hora: '10:30 AM', tarea: 'Hemenway' },
      { hora: '11:00 AM', tarea: 'Primavesi' },
      { hora: '11:30 AM', tarea: 'Salatin' },
      { hora: '12:00 PM', tarea: 'ALMUERZO' },
      { hora: '12:30 PM', tarea: 'Baños de Teca' },
      { hora: '1:00 PM',  tarea: 'Movement Studio' },
      { hora: '1:30 PM',  tarea: 'Sillas Juice Bar' },
      { hora: '2:00 PM',  tarea: 'Doherty' },
      { hora: '2:30 PM',  tarea: 'Fukuoka' },
    ],
    sabado: null,
    domingo: null,
  }
};

const SCHEDULE_RESIDENCIES = {
  rol1: {
    lunes:    null,
    martes:   null,
    miercoles:null,
    jueves:   null,
    viernes:  null,
    sabado:   null,
    domingo:  null,
  },
  rol2: {
    lunes:    null,
    martes:   null,
    miercoles:null,
    jueves:   null,
    viernes:  null,
    sabado:   null,
    domingo:  null,
  }
};

function openScheduleDelDia() {
  setConScreen('Actividades del Día', () => goBack(), renderScheduleDelDia());
}

function renderScheduleDelDia() {
  const scheduleActivo = getScheduleActivo();
  const schedule = scheduleActivo === 'general' ? SCHEDULE_GENERAL : SCHEDULE_RESIDENCIES;
  const etiquetaHtml = scheduleActivo === 'general'
    ? `<span class="dbadge off" style="font-size:.65rem;margin-left:.5rem;">Schedule General</span>`
    : `<span class="dbadge on" style="font-size:.65rem;margin-left:.5rem;">Residencies</span>`;

  const hoy = new Date();
  const dayIdx = hoy.getDay();
  const dayKeys = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const dayNames = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const dayKey = dayKeys[dayIdx];
  const dayName = dayNames[dayIdx];

  const tareasR1 = schedule.rol1[dayKey];
  const tareasR2 = schedule.rol2[dayKey];

  const esFinDeSemana = (dayIdx === 0 || dayIdx === 6);
  if (scheduleActivo === 'general' && esFinDeSemana) {
    return `
      <div style="display:flex;align-items:center;margin-bottom:1rem;">
        <div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);font-style:italic;">Hoy es ${dayName}</div>
        ${etiquetaHtml}
      </div>
      <div class="cs"><div class="csi"></div><h3>No hay tareas programadas para hoy</h3><p>El schedule de limpieza corre de lunes a viernes.</p></div>`;
  }

  function renderCol(tareas, rolLabel, color) {
    const header = `<div style="font-size:.72rem;font-weight:600;font-family:sans-serif;color:${color};text-transform:uppercase;letter-spacing:.08em;margin-bottom:.6rem;">${rolLabel}</div>`;
    if (!tareas) {
      return header + `<div style="background:rgba(118,114,78,.08);border:1px solid rgba(118,114,78,.2);border-radius:10px;padding:1rem;text-align:center;"><div style="font-size:.82rem;font-family:sans-serif;color:var(--green);font-weight:600;">Día libre</div></div>`;
    }
    const rows = tareas.map(({hora, tarea}) => {
      const isBreak = tarea === 'DESAYUNO' || tarea === 'ALMUERZO';
      const isReunion = tarea === 'Reunión de Operaciones';
      let bg = 'white', textColor = 'var(--brown)', fontWeight = 'normal', borderStyle = '1px solid rgba(84,66,54,.08)';
      if (isBreak) { bg = 'rgba(118,114,78,.08)'; textColor = 'var(--green)'; fontWeight = '600'; borderStyle = '1px solid rgba(118,114,78,.2)'; }
      else if (isReunion) { bg = 'rgba(113,127,126,.08)'; textColor = 'var(--blue)'; borderStyle = '1px solid rgba(113,127,126,.2)'; }
      return `<div style="background:${bg};border:${borderStyle};border-radius:8px;padding:.55rem .7rem;margin-bottom:.35rem;display:flex;align-items:center;gap:.6rem;">
        <span style="font-size:.65rem;font-family:sans-serif;color:var(--tm);min-width:52px;flex-shrink:0;">${hora}</span>
        <span style="font-size:.78rem;font-family:sans-serif;color:${textColor};font-weight:${fontWeight};line-height:1.3;">${tarea}</span>
      </div>`;
    }).join('');
    return header + rows;
  }

  return `
    <div style="display:flex;align-items:center;margin-bottom:1rem;">
      <div style="font-size:.75rem;font-family:sans-serif;color:var(--tm);font-style:italic;">Hoy es ${dayName}</div>
      ${etiquetaHtml}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;">
      <div>${renderCol(tareasR1, 'Rol 1', 'var(--blue)')}</div>
      <div>${renderCol(tareasR2, 'Rol 2', 'var(--clay)')}</div>
    </div>`;
}

// ── ARRANQUE ──

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-login').addEventListener('click', doLogin);
  document.getElementById('lp').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('dept-back').addEventListener('click', () => nav('home'));
  document.getElementById('dept-out').addEventListener('click', logout);
  document.getElementById('fs-back').addEventListener('click', () => goBack());
  document.getElementById('fs-out').addEventListener('click', logout);
  document.getElementById('cl-out').addEventListener('click', logout);
  document.getElementById('con-out').addEventListener('click', logout);
  document.getElementById('rep-back').addEventListener('click', () => nav('home'));
  document.getElementById('rep-out').addEventListener('click', logout);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', confirmChecklist);

  // Restaura la sesión desde localStorage (solo datos mínimos: usuario, nombre,
  // iniciales, rol, departamento — nunca password_hash, que ya no viaja al
  // frontend en ningún momento).
  let restoredSession = false;
  try {
    const saved = localStorage.getItem('tm_session');
    if (saved) {
      const savedUser = JSON.parse(saved);
      if (savedUser && savedUser.usuario) {
        CU = savedUser;
        CD = savedUser.departamento;
        restoredSession = true;
        if (CU.rol !== 'admin') { renderDeptHome(); } else { renderHome(); }
        show('home');
        startGuestReportAlerts();
      }
    }
  } catch(e) {}

  // IMPORTANTE: se le indica a loadUsers() si ya existe una sesión restaurada
  // para que NO muestre la pantalla de login por encima (bug original: loadUsers
  // llamaba show('ls') incondicionalmente al terminar, ocultando la sesión
  // restaurada).
  loadUsers(restoredSession).then(() => {
    loadConfigColabs();
    // Revalida la sesión restaurada en segundo plano una vez llegan datos
    // frescos de usuarios. Solo se actualiza el usuario local; nunca se fuerza
    // el cierre de sesión por un problema transitorio de red o de la hoja.
    if (restoredSession && USERS && USERS.length > 0) {
      const match = USERS.find(u => u.usuario === CU.usuario);
      if (match) {
        CU = match;
        CD = match.departamento;
        try { localStorage.setItem('tm_session', JSON.stringify(CU)); } catch(e) {}
      }
    }
  }).catch(() => { loadConfigColabs(); });
});
