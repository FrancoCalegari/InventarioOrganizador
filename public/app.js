// Fallback de light-dismiss para navegadores sin soporte nativo de <dialog closedby="any">
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, dialog)) dialog.close();
    });
  }
}

const state = {
  currentUser: null,
  selectedUserId: null,
  tab: 'dashboard', // 'dashboard' | 'activos' | 'bajas'
  estado: 'activos',
  categoria: '',
  groupByCategory: true,
  q: '',
  items: [],
  allActiveItems: [], // para el selector de relaciones
  categorias: [], // [{ categoria, count }]
  selectedItems: new Map(),
  editingItemId: null,
  mediaQueue: [], // [{ blob, type, previewUrl, name }]
  formRelations: new Map(), // Map<child_id, { id, nombre, cantidad }>
  stream: null,
  pollTimer: null
};

// Referencias DOM - Auth
const authView = document.getElementById('auth-view');
const appView = document.getElementById('app-view');
const authTabLogin = document.getElementById('auth-tab-login');
const authTabRegister = document.getElementById('auth-tab-register');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const registerSubmitBtn = document.getElementById('register-submit-btn');

// Referencias DOM - Cabecera y Galería
const userRoleBadge = document.getElementById('user-role-badge');
const userEmailDisplay = document.getElementById('user-email-display');
const userSelect = document.getElementById('user-select');
const jobsBtn = document.getElementById('jobs-btn');
const newUserBtn = document.getElementById('new-user-btn');
const logoutBtn = document.getElementById('logout-btn');

const tabDashboard = document.getElementById('tab-dashboard');
const tabActivos = document.getElementById('tab-activos');
const tabBajas = document.getElementById('tab-bajas');
const countActivos = document.getElementById('count-activos');
const countBajas = document.getElementById('count-bajas');
const searchInput = document.getElementById('search-input');
const totalValuePill = document.getElementById('total-value-pill');
const toggleGroupSectionsBtn = document.getElementById('toggle-group-sections-btn');
const categoryFilterStrip = document.getElementById('category-filter-strip');
const dashboardBanner = document.getElementById('dashboard-banner');
const viewHeading = document.getElementById('view-heading');
const btnGoFullInventory = document.getElementById('btn-go-full-inventory');
const inventoryContainer = document.getElementById('inventory-container');
const guardadoEnList = document.getElementById('guardado-en-list');
const categoriasList = document.getElementById('categorias-list');

// Inputs de Multimedia y Modal de Alta/Edición
const quickCameraInput = document.getElementById('quick-camera-input');
const quickVideoInput = document.getElementById('quick-video-input');
const multiMediaInput = document.getElementById('multi-media-input');
const btnLaunchAdd = document.getElementById('btn-launch-add');

const addDialog = document.getElementById('add-dialog');
const addDialogTitle = document.getElementById('add-dialog-title');
const closeAddDialog = document.getElementById('close-add-dialog');
const addForm = document.getElementById('add-form');
const cameraVideo = document.getElementById('camera-video');
const mediaQueueStrip = document.getElementById('media-queue-strip');
const btnTakeCamera = document.getElementById('btn-take-camera');
const btnShutter = document.getElementById('btn-shutter');
const btnTakeVideo = document.getElementById('btn-take-video');
const btnPickFile = document.getElementById('btn-pick-file');
const relItemSelect = document.getElementById('rel-item-select');
const btnAddRelation = document.getElementById('btn-add-relation');
const relSelectedList = document.getElementById('rel-selected-list');
const uploadProgressWrap = document.getElementById('upload-progress-wrap');
const uploadProgressFill = document.getElementById('upload-progress-fill');
const addError = document.getElementById('add-error');
const submitAddBtn = document.getElementById('submit-add-btn');

// Modal Detalle, Usuarios, Lista y Cola
const detailDialog = document.getElementById('detail-dialog');
const closeDetailDialog = document.getElementById('close-detail-dialog');
const detailBody = document.getElementById('detail-body');

const userDialog = document.getElementById('user-dialog');
const userForm = document.getElementById('user-form');
const closeUserDialog = document.getElementById('close-user-dialog');
const userCreateError = document.getElementById('user-create-error');

const toggleSelectAllBtn = document.getElementById('toggle-select-all-btn');
const selectionBar = document.getElementById('selection-bar');
const selectionCountLabel = document.getElementById('selection-count-label');
const btnClearSelection = document.getElementById('btn-clear-selection');
const btnOpenListModal = document.getElementById('btn-open-list-modal');
const listDialog = document.getElementById('list-dialog');
const closeListDialog = document.getElementById('close-list-dialog');
const listCustomTitle = document.getElementById('list-custom-title');
const optIncludePrice = document.getElementById('opt-include-price');
const optIncludeRelations = document.getElementById('opt-include-relations');
const optIncludeDesc = document.getElementById('opt-include-desc');
const optIncludeDates = document.getElementById('opt-include-dates');
const listTextOutput = document.getElementById('list-text-output');
const shareFeedback = document.getElementById('share-feedback');
const btnCopyList = document.getElementById('btn-copy-list');
const btnShareList = document.getElementById('btn-share-list');

const jobsDialog = document.getElementById('jobs-dialog');
const closeJobsDialog = document.getElementById('close-jobs-dialog');
const jobsBody = document.getElementById('jobs-body');

const MOTIVO_LABELS = {
  vendido: 'Se vendió',
  desechado: 'Se desechó',
  roto: 'Se rompió'
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatMoney(val, moneda = 'ARS') {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  const formatted = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: num % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(num);
  return moneda === 'USD' ? `US$ ${formatted}` : `$ ${formatted} ARS`;
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 1. Autenticación
// ---------------------------------------------------------------------------
for (const btn of document.querySelectorAll('.toggle-pwd-btn')) {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.textContent = showing ? 'Mostrar' : 'Ocultar';
  });
}

authTabLogin.addEventListener('click', () => {
  authTabLogin.setAttribute('aria-selected', 'true');
  authTabRegister.setAttribute('aria-selected', 'false');
  loginForm.hidden = false;
  registerForm.hidden = true;
  loginError.hidden = true;
});

authTabRegister.addEventListener('click', () => {
  authTabLogin.setAttribute('aria-selected', 'false');
  authTabRegister.setAttribute('aria-selected', 'true');
  loginForm.hidden = true;
  registerForm.hidden = false;
  registerError.hidden = true;
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginSubmitBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al iniciar sesión.');
    setSessionUser(data);
  } catch (err) {
    loginError.textContent = err.message;
    loginError.hidden = false;
  } finally {
    loginSubmitBtn.disabled = false;
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.hidden = true;
  registerSubmitBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('register-email').value.trim(),
        password: document.getElementById('register-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al crear la cuenta.');
    setSessionUser(data);
  } catch (err) {
    registerError.textContent = err.message;
    registerError.hidden = false;
  } finally {
    registerSubmitBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  state.currentUser = null;
  state.selectedUserId = null;
  appView.hidden = true;
  authView.hidden = false;
  loginForm.reset();
});

function setSessionUser(user) {
  state.currentUser = user;
  state.selectedUserId = user.id;
  userRoleBadge.textContent = user.role;
  userRoleBadge.dataset.role = user.role;
  userEmailDisplay.textContent = user.email;

  const isAdmin = user.role === 'admin';
  userSelect.hidden = !isAdmin;
  newUserBtn.hidden = !isAdmin;
  jobsBtn.hidden = !isAdmin;

  authView.hidden = true;
  appView.hidden = false;
  refreshAll();
}

async function checkSession() {
  const res = await fetch('/api/auth/me');
  if (res.ok) setSessionUser(await res.json());
  else {
    authView.hidden = false;
    appView.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// 2. Compresión de Imágenes en Cliente (<canvas> WebP/JPEG) y Cola Local
// ---------------------------------------------------------------------------
async function compressImageToBlob(sourceFileOrVideo, maxDim = 1600, quality = 0.8) {
  let width = 0;
  let height = 0;
  let drawable = null;

  if (sourceFileOrVideo instanceof HTMLVideoElement) {
    width = sourceFileOrVideo.videoWidth || 640;
    height = sourceFileOrVideo.videoHeight || 480;
    drawable = sourceFileOrVideo;
  } else {
    const bitmap = await createImageBitmap(sourceFileOrVideo);
    width = bitmap.width;
    height = bitmap.height;
    drawable = bitmap;
  }

  if (width > maxDim || height > maxDim) {
    if (width >= height) {
      height = Math.round((height * maxDim) / width);
      width = maxDim;
    } else {
      width = Math.round((width * maxDim) / height);
      height = maxDim;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(drawable, 0, 0, width, height);
  if (drawable.close) drawable.close();

  const webpBlob = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality));
  if (webpBlob && webpBlob.type === 'image/webp') return webpBlob;
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
}

function enqueueMediaBlob(blob, name = 'captura') {
  const previewUrl = URL.createObjectURL(blob);
  const isVideo = blob.type.startsWith('video/');
  state.mediaQueue.push({
    blob,
    type: blob.type || (isVideo ? 'video/mp4' : 'image/webp'),
    previewUrl,
    name
  });
  renderMediaQueueStrip();
  addError.hidden = true;
}

function clearMediaQueue() {
  for (const m of state.mediaQueue) URL.revokeObjectURL(m.previewUrl);
  state.mediaQueue = [];
  renderMediaQueueStrip();
}

function renderMediaQueueStrip() {
  mediaQueueStrip.replaceChildren();
  state.mediaQueue.forEach((m, idx) => {
    const box = document.createElement('div');
    box.className = 'media-thumb-item';
    if (m.type.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.src = m.previewUrl;
      vid.muted = true;
      box.appendChild(vid);
    } else {
      const img = document.createElement('img');
      img.src = m.previewUrl;
      img.alt = m.name;
      box.appendChild(img);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'media-thumb-remove';
    del.textContent = '✕';
    del.title = 'Quitar archivo';
    del.addEventListener('click', () => {
      URL.revokeObjectURL(m.previewUrl);
      state.mediaQueue.splice(idx, 1);
      renderMediaQueueStrip();
    });
    box.appendChild(del);
    mediaQueueStrip.appendChild(box);
  });
}

function stopCameraStream() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  cameraVideo.srcObject = null;
  cameraVideo.hidden = true;
  btnShutter.hidden = true;
}

async function startLiveCamera() {
  addError.hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    quickCameraInput.click();
    return;
  }
  try {
    stopCameraStream();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false
    });
    state.stream = stream;
    cameraVideo.srcObject = stream;
    cameraVideo.hidden = false;
    btnShutter.hidden = false;
  } catch {
    quickCameraInput.click();
  }
}

// Subida por streaming con progreso (XMLHttpRequest)
function uploadSingleMedia(itemId, mediaItem, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/items/${itemId}/media`);
    xhr.setRequestHeader('Content-Type', mediaItem.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || 'Error subiendo archivo multimedia.'));
    };
    xhr.onerror = () => reject(new Error('Error de red al subir archivo.'));
    xhr.send(mediaItem.blob);
  });
}

// ---------------------------------------------------------------------------
// 3. Carga de Datos (Usuarios, Objetos, Ubicaciones)
// ---------------------------------------------------------------------------
async function loadUsers() {
  const res = await fetch('/api/users');
  if (!res.ok) return;
  const users = await res.json();

  userSelect.replaceChildren();
  for (const u of users) {
    const opt = document.createElement('option');
    opt.value = String(u.id);
    opt.textContent = `${u.email} (${u.role})`;
    if (u.id === state.selectedUserId) {
      opt.selected = true;
      countActivos.textContent = String(u.active_count || 0);
      countBajas.textContent = String(u.retired_count || 0);
    }
    userSelect.appendChild(opt);
  }
}

async function loadGuardadoEnSuggestions() {
  const userId = state.selectedUserId || state.currentUser.id;
  const res = await fetch(`/api/guardado-en?userId=${userId}`);
  if (!res.ok) return;
  const list = await res.json();
  guardadoEnList.replaceChildren();
  for (const loc of list) {
    const opt = document.createElement('option');
    opt.value = loc;
    guardadoEnList.appendChild(opt);
  }
}

async function loadCategorias() {
  const userId = state.selectedUserId || state.currentUser.id;
  const res = await fetch(`/api/categorias?userId=${userId}`);
  if (!res.ok) return;
  const { categorias, sugerencias } = await res.json();
  state.categorias = categorias || [];

  categoriasList.replaceChildren();
  for (const cat of sugerencias || []) {
    const opt = document.createElement('option');
    opt.value = cat;
    categoriasList.appendChild(opt);
  }
  renderCategoryStrip();
}

function renderCategoryStrip() {
  categoryFilterStrip.replaceChildren();
  const totalCount = state.categorias.reduce((acc, c) => acc + c.count, 0);

  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'cat-chip';
  allChip.setAttribute('aria-pressed', String(state.categoria === ''));
  allChip.textContent = `Todas (${totalCount})`;
  allChip.addEventListener('click', () => {
    state.categoria = '';
    renderCategoryStrip();
    loadItems();
  });
  categoryFilterStrip.appendChild(allChip);

  for (const c of state.categorias) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cat-chip';
    chip.setAttribute('aria-pressed', String(state.categoria === c.categoria));
    chip.textContent = `🏷️ ${c.categoria} (${c.count})`;
    chip.addEventListener('click', () => {
      state.categoria = state.categoria === c.categoria ? '' : c.categoria;
      renderCategoryStrip();
      loadItems();
    });
    categoryFilterStrip.appendChild(chip);
  }
}

async function loadItems() {
  const userId = String(state.selectedUserId || state.currentUser.id);
  const isDashboard = state.tab === 'dashboard';
  const estado = isDashboard ? 'activos' : state.tab;
  const params = new URLSearchParams({
    userId,
    estado,
    categoria: state.categoria,
    limit: isDashboard ? '10' : '0',
    q: state.q
  });
  const [res, activeRes] = await Promise.all([
    fetch(`/api/items?${params}`),
    fetch(`/api/items?userId=${userId}&estado=activos`)
  ]);
  if (!res.ok) return;
  state.items = await res.json();
  if (activeRes.ok) state.allActiveItems = await activeRes.json();
  renderGallery();
  schedulePendingMediaPoll();
}

async function refreshAll() {
  if (!state.currentUser) return;
  await Promise.all([loadUsers(), loadCategorias(), loadItems(), loadGuardadoEnSuggestions()]);
}

function schedulePendingMediaPoll() {
  clearTimeout(state.pollTimer);
  const anyPending = state.items.some((i) => i.media_pendientes > 0);
  if (anyPending) {
    state.pollTimer = setTimeout(() => loadItems(), 4000);
  }
}

// ---------------------------------------------------------------------------
// 4. Renderizado de la Galería
// ---------------------------------------------------------------------------
function computeTotalsText(items) {
  let ars = 0;
  let usd = 0;
  for (const item of items) {
    const unit = Number(item.precio) || 0;
    const qty = Number(item.cantidad) || 1;
    if (unit > 0) {
      if (item.moneda === 'USD') usd += unit * qty;
      else ars += unit * qty;
    }
  }
  const parts = [];
  if (ars > 0 || usd === 0) parts.push(formatMoney(ars, 'ARS'));
  if (usd > 0) parts.push(formatMoney(usd, 'USD'));
  return parts.join(' · ');
}

function createItemCard(item) {
  if (state.selectedItems.has(item.id)) state.selectedItems.set(item.id, item);

  const wrapper = document.createElement('div');
  wrapper.className = 'item-card-wrapper';

  const card = document.createElement('div');
  card.className = 'item-card';
  card.dataset.selected = String(state.selectedItems.has(item.id));
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Ver detalle de ${item.nombre}`);
  card.addEventListener('click', () => openItemDetail(item.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openItemDetail(item.id);
    }
  });

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  if (item.portada_url) {
    const img = document.createElement('img');
    img.src = item.portada_url;
    img.alt = item.nombre;
    img.loading = 'lazy';
    thumbWrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'thumb-placeholder';
    ph.textContent = item.media_pendientes > 0 ? '🎬' : '📦';
    thumbWrap.appendChild(ph);
  }

  const checkLabel = document.createElement('label');
  checkLabel.className = 'card-check-label';
  checkLabel.title = 'Seleccionar para lista';
  checkLabel.addEventListener('click', (e) => e.stopPropagation());
  const checkInput = document.createElement('input');
  checkInput.type = 'checkbox';
  checkInput.checked = state.selectedItems.has(item.id);
  checkInput.setAttribute('aria-label', `Seleccionar ${item.nombre}`);
  checkInput.addEventListener('change', () => {
    toggleItemSelection(item, checkInput.checked);
    card.dataset.selected = String(checkInput.checked);
  });
  checkLabel.appendChild(checkInput);
  thumbWrap.appendChild(checkLabel);

  if (item.cantidad > 1) {
    const qtyBadge = document.createElement('span');
    qtyBadge.className = 'badge-qty';
    qtyBadge.textContent = `×${item.cantidad}`;
    thumbWrap.appendChild(qtyBadge);
  }

  if (item.precio !== null && item.precio !== undefined) {
    const priceBadge = document.createElement('span');
    priceBadge.className = 'badge-price';
    priceBadge.textContent = formatMoney(item.precio, item.moneda);
    thumbWrap.appendChild(priceBadge);
  }

  if (item.motivo_baja) {
    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge-status';
    statusBadge.dataset.motivo = item.motivo_baja;
    statusBadge.textContent = MOTIVO_LABELS[item.motivo_baja] || item.motivo_baja;
    thumbWrap.appendChild(statusBadge);
  } else if (item.media_pendientes > 0) {
    const procBadge = document.createElement('span');
    procBadge.className = 'badge-status';
    procBadge.dataset.motivo = 'procesando';
    procBadge.textContent = '⏳ Video';
    thumbWrap.appendChild(procBadge);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  if (item.categoria) {
    const catBadge = document.createElement('span');
    catBadge.className = 'badge-cat';
    catBadge.textContent = item.categoria;
    body.appendChild(catBadge);
  }

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = item.nombre;
  body.appendChild(title);

  const brandModel = [item.marca, item.modelo].filter(Boolean).join(' · ');
  if (brandModel) {
    const sub = document.createElement('p');
    sub.className = 'card-sub';
    sub.textContent = brandModel;
    body.appendChild(sub);
  }

  if (item.guardado_en) {
    const loc = document.createElement('p');
    loc.className = 'card-sub';
    loc.textContent = `📍 ${item.guardado_en}`;
    body.appendChild(loc);
  }

  if (item.contiene?.length > 0) {
    const relChip = document.createElement('span');
    relChip.className = 'card-rel-chip';
    relChip.textContent = `📦 Contiene ${item.contiene.length}`;
    body.appendChild(relChip);
  }

  card.append(thumbWrap, body);
  wrapper.appendChild(card);
  return wrapper;
}

function renderGallery() {
  inventoryContainer.replaceChildren();
  totalValuePill.textContent = computeTotalsText(state.items);

  const isDashboard = state.tab === 'dashboard';
  dashboardBanner.hidden = !isDashboard;
  toggleGroupSectionsBtn.hidden = isDashboard;
  viewHeading.textContent = state.categoria
    ? `🕒 Últimos objetos en "${state.categoria}"`
    : '🕒 Últimos 10 objetos agregados';

  if (state.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const h2 = document.createElement('h2');
    h2.textContent =
      state.tab === 'bajas' ? 'No hay objetos dados de baja' : 'Sin objetos en esta vista';
    const p = document.createElement('p');
    p.textContent =
      state.tab === 'bajas'
        ? 'Aquí aparecerán los objetos que se vendieron, desecharon o rompieron.'
        : 'Pulsa "📸 Sacar Foto y Añadir Objeto" abajo para fotografiar y cargar un objeto.';
    empty.append(h2, p);
    inventoryContainer.appendChild(empty);
    updateSelectionUI();
    return;
  }

  // En pestaña Inventario Completo (o Bajas) con "Por Secciones" activo: separar por secciones de categoría
  if (!isDashboard && state.groupByCategory) {
    const byCat = new Map();
    for (const item of state.items) {
      const cat = item.categoria || 'General';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(item);
    }

    for (const [catName, catItems] of byCat) {
      const section = document.createElement('section');
      section.className = 'category-section';

      const header = document.createElement('div');
      header.className = 'category-section-header';

      const h3 = document.createElement('h3');
      h3.className = 'category-section-title';
      h3.textContent = `🏷️ ${catName} (${catItems.length})`;

      const subtotal = document.createElement('span');
      subtotal.className = 'summary-pill';
      subtotal.textContent = computeTotalsText(catItems);

      header.append(h3, subtotal);
      section.appendChild(header);

      const grid = document.createElement('div');
      grid.className = 'gallery-grid';
      for (const item of catItems) grid.appendChild(createItemCard(item));

      section.appendChild(grid);
      inventoryContainer.appendChild(section);
    }
  } else {
    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    for (const item of state.items) grid.appendChild(createItemCard(item));
    inventoryContainer.appendChild(grid);
  }

  updateSelectionUI();
}

// ---------------------------------------------------------------------------
// 5. Detalle del Objeto, Multimedia, Relaciones y Baja
// ---------------------------------------------------------------------------
function createMetaBox(label, value) {
  const box = document.createElement('div');
  box.className = 'meta-box';
  const lbl = document.createElement('span');
  lbl.className = 'meta-label';
  lbl.textContent = label;
  const val = document.createElement('span');
  val.className = 'meta-value';
  val.textContent = value;
  box.append(lbl, val);
  return box;
}

function createDetailSection(titleText, bodyText) {
  const sec = document.createElement('div');
  sec.className = 'detail-section';
  const h3 = document.createElement('h3');
  h3.textContent = titleText;
  const p = document.createElement('p');
  p.textContent = bodyText;
  sec.append(h3, p);
  return sec;
}

async function openItemDetail(itemId) {
  const res = await fetch(`/api/items/${itemId}`);
  if (!res.ok) return;
  const item = await res.json();

  detailBody.replaceChildren();
  document.getElementById('detail-dialog-title').textContent = item.nombre;

  // 1. Carrusel de fotos y videos
  if (item.media?.length > 0) {
    const carousel = document.createElement('div');
    carousel.className = 'media-carousel';

    item.media.forEach((m, idx) => {
      const slide = document.createElement('div');
      slide.className = 'media-slide';

      if (m.estado !== 'listo') {
        const waitBox = document.createElement('div');
        waitBox.style.cssText = 'aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;color:#fff;padding:1rem;text-align:center;';
        waitBox.textContent =
          m.estado === 'error'
            ? '❌ Error al comprimir el video'
            : '⏳ Video en cola de compresión (ffmpeg)...';
        slide.appendChild(waitBox);
      } else if (m.tipo === 'video') {
        const vid = document.createElement('video');
        vid.controls = true;
        vid.preload = 'metadata';
        vid.src = m.url;
        if (m.poster_url) vid.poster = m.poster_url;
        slide.appendChild(vid);
      } else {
        const img = document.createElement('img');
        img.src = m.url;
        img.alt = `${item.nombre} (${idx + 1})`;
        slide.appendChild(img);
      }

      const bar = document.createElement('div');
      bar.className = 'media-slide-bar';
      const info = document.createElement('span');
      info.textContent = `${idx === 0 ? '⭐ Portada' : `#${idx + 1}`} · ${m.tipo.toUpperCase()} ${formatBytes(m.bytes)}`;
      bar.appendChild(info);

      const btnGroup = document.createElement('div');
      btnGroup.style.display = 'flex';
      btnGroup.style.gap = '0.4rem';

      if (idx > 0 && m.estado === 'listo') {
        const btnPortada = document.createElement('button');
        btnPortada.type = 'button';
        btnPortada.className = 'icon-btn';
        btnPortada.style.minHeight = '30px';
        btnPortada.textContent = '⭐ Hacer portada';
        btnPortada.addEventListener('click', async () => {
          await fetch(`/api/media/${m.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ portada: true })
          });
          await openItemDetail(item.id);
          await loadItems();
        });
        btnGroup.appendChild(btnPortada);
      }

      if (item.media.length > 1) {
        const btnDelMedia = document.createElement('button');
        btnDelMedia.type = 'button';
        btnDelMedia.className = 'icon-btn';
        btnDelMedia.style.cssText = 'min-height:30px;color:#fca5a5;border-color:#7f1d1d;background:transparent;';
        btnDelMedia.textContent = '🗑️';
        btnDelMedia.addEventListener('click', async () => {
          await fetch(`/api/media/${m.id}`, { method: 'DELETE' });
          await openItemDetail(item.id);
          await loadItems();
        });
        btnGroup.appendChild(btnDelMedia);
      }

      bar.appendChild(btnGroup);
      slide.appendChild(bar);
      carousel.appendChild(slide);
    });

    detailBody.appendChild(carousel);
  }

  // Botón principal: Editar datos, subir más fotos/videos y relacionar objetos
  const editBar = document.createElement('div');
  editBar.style.marginBlockEnd = '0.9rem';
  const btnEdit = document.createElement('button');
  btnEdit.type = 'button';
  btnEdit.className = 'btn btn-primary';
  btnEdit.textContent = '✏️ Editar Datos, Fotos/Videos y Relaciones';
  btnEdit.addEventListener('click', () => {
    detailDialog.close();
    openEditModal(item);
  });
  editBar.appendChild(btnEdit);
  detailBody.appendChild(editBar);

  // 2. Grilla de características
  const metaGrid = document.createElement('div');
  metaGrid.className = 'meta-grid';
  metaGrid.append(
    createMetaBox('Categoría', item.categoria || 'General'),
    createMetaBox('Precio unitario', formatMoney(item.precio, item.moneda) || 'Sin precio'),
    createMetaBox('Cantidad', `${item.cantidad} ${item.cantidad === 1 ? 'unidad' : 'unidades'}`),
    createMetaBox('Marca / Modelo', [item.marca, item.modelo].filter(Boolean).join(' · ') || 'No especificado'),
    createMetaBox('Guardado en', item.guardado_en || 'No especificado'),
    createMetaBox('Fecha obtenido', item.fecha_obtenido)
  );
  detailBody.appendChild(metaGrid);

  // 3. Relaciones: "Contiene" y "Guardado dentro de"
  if (item.contiene?.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    const h3 = document.createElement('h3');
    h3.textContent = `📦 Contiene (${item.contiene.length} ${item.contiene.length === 1 ? 'objeto' : 'objetos'})`;
    sec.appendChild(h3);
    for (const c of item.contiene) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'rel-link-btn';
      chip.textContent = `${c.nombre} (×${c.cantidad})`;
      chip.addEventListener('click', () => openItemDetail(c.id));
      sec.appendChild(chip);
    }
    detailBody.appendChild(sec);
  }

  if (item.contenido_en?.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    const h3 = document.createElement('h3');
    h3.textContent = '📍 Está dentro de';
    sec.appendChild(h3);
    for (const p of item.contenido_en) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'rel-link-btn';
      chip.textContent = `${p.nombre} (×${p.cantidad})`;
      chip.addEventListener('click', () => openItemDetail(p.id));
      sec.appendChild(chip);
    }
    detailBody.appendChild(sec);
  }

  if (item.descripcion) detailBody.appendChild(createDetailSection('Descripción', item.descripcion));
  if (item.detalles) detailBody.appendChild(createDetailSection('Detalles relacionados', item.detalles));

  // 4. Dar de baja o Reactivar
  if (!item.fecha_baja) {
    const form = document.createElement('form');
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'radio-fieldset';
    const legend = document.createElement('legend');
    legend.textContent = 'Dar de baja del inventario';
    fieldset.appendChild(legend);

    const radioGrid = document.createElement('div');
    radioGrid.className = 'radio-grid';
    [
      { value: 'vendido', label: '💰 Se vendió' },
      { value: 'desechado', label: '🗑️ Se desechó' },
      { value: 'roto', label: '💔 Se rompió' }
    ].forEach((m, idx) => {
      const lbl = document.createElement('label');
      lbl.className = 'radio-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'motivo_baja';
      radio.value = m.value;
      if (idx === 0) radio.checked = true;
      const span = document.createElement('span');
      span.textContent = m.label;
      lbl.append(radio, span);
      radioGrid.appendChild(lbl);
    });
    fieldset.appendChild(radioGrid);

    const dateGroup = document.createElement('div');
    dateGroup.className = 'form-group';
    const dateLabel = document.createElement('label');
    dateLabel.htmlFor = 'baja-fecha-input';
    dateLabel.textContent = 'Fecha dado de baja';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.id = 'baja-fecha-input';
    dateInput.name = 'fecha_baja';
    dateInput.required = true;
    dateInput.value = todayISO();
    dateGroup.append(dateLabel, dateInput);

    let cascadeCheck = null;
    if (item.contiene?.length > 0) {
      const cascadeLabel = document.createElement('label');
      cascadeLabel.className = 'check-pill';
      cascadeLabel.style.marginBlockEnd = '0.85rem';
      cascadeCheck = document.createElement('input');
      cascadeCheck.type = 'checkbox';
      const span = document.createElement('span');
      span.textContent = `Dar de baja también los ${item.contiene.length} objetos que contiene`;
      cascadeLabel.append(cascadeCheck, span);
      form.append(fieldset, dateGroup, cascadeLabel);
    } else {
      form.append(fieldset, dateGroup);
    }

    const submitBaja = document.createElement('button');
    submitBaja.type = 'submit';
    submitBaja.className = 'btn btn-danger';
    submitBaja.style.width = '100%';
    submitBaja.textContent = 'Confirmar Baja';
    form.appendChild(submitBaja);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBaja.disabled = true;
      const fd = new FormData(form);
      await fetch(`/api/items/${item.id}/baja`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          motivo_baja: fd.get('motivo_baja'),
          fecha_baja: fd.get('fecha_baja'),
          incluir_contenido: Boolean(cascadeCheck?.checked)
        })
      });
      detailDialog.close();
      await refreshAll();
    });
    detailBody.appendChild(form);
  } else {
    const actionsRow = document.createElement('div');
    actionsRow.style.display = 'flex';
    actionsRow.style.gap = '0.6rem';

    const btnReactivar = document.createElement('button');
    btnReactivar.type = 'button';
    btnReactivar.className = 'btn btn-primary';
    btnReactivar.style.flex = '1';
    btnReactivar.textContent = '↩️ Devolver al Inventario';
    btnReactivar.addEventListener('click', async () => {
      btnReactivar.disabled = true;
      await fetch(`/api/items/${item.id}/baja`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reactivar: true })
      });
      detailDialog.close();
      await refreshAll();
    });

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn btn-danger';
    btnDelete.textContent = '🗑️ Borrar';
    btnDelete.addEventListener('click', async () => {
      btnDelete.disabled = true;
      await fetch(`/api/items/${item.id}`, { method: 'DELETE' });
      state.selectedItems.delete(item.id);
      detailDialog.close();
      await refreshAll();
    });

    actionsRow.append(btnReactivar, btnDelete);
    detailBody.appendChild(actionsRow);
  }

  if (!detailDialog.open) detailDialog.showModal();
}

// ---------------------------------------------------------------------------
// 6. Formulario de Alta / Edición y Selector de Relaciones ("Contiene")
// ---------------------------------------------------------------------------
function populateRelationsPicker() {
  relItemSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— Elegir objeto existente del inventario —';
  relItemSelect.appendChild(placeholder);

  for (const candidate of state.allActiveItems) {
    if (candidate.id === state.editingItemId) continue;
    if (state.formRelations.has(candidate.id)) continue;
    const opt = document.createElement('option');
    opt.value = String(candidate.id);
    const extra = [candidate.marca, candidate.modelo].filter(Boolean).join(' ');
    opt.textContent = extra ? `${candidate.nombre} (${extra})` : candidate.nombre;
    relItemSelect.appendChild(opt);
  }
}

function renderFormRelations() {
  relSelectedList.replaceChildren();
  populateRelationsPicker();

  for (const [childId, rel] of state.formRelations) {
    const row = document.createElement('div');
    row.className = 'rel-row';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `📦 ${rel.nombre}`;

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:0.4rem;';

    const qtyLabel = document.createElement('span');
    qtyLabel.style.fontSize = '0.8rem';
    qtyLabel.textContent = 'Cant:';

    const qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.step = '1';
    qtyInput.value = String(rel.cantidad);
    qtyInput.addEventListener('input', () => {
      rel.cantidad = Math.max(1, parseInt(qtyInput.value, 10) || 1);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn';
    delBtn.style.minHeight = '34px';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      state.formRelations.delete(childId);
      renderFormRelations();
    });

    right.append(qtyLabel, qtyInput, delBtn);
    row.append(nameSpan, right);
    relSelectedList.appendChild(row);
  }
}

btnAddRelation.addEventListener('click', () => {
  const childId = Number(relItemSelect.value);
  if (!childId) return;
  const found = state.allActiveItems.find((i) => i.id === childId);
  if (!found) return;
  state.formRelations.set(childId, { id: childId, nombre: found.nombre, cantidad: 1 });
  renderFormRelations();
});

function openCreateModal() {
  state.editingItemId = null;
  addDialogTitle.textContent = 'Añadir Objeto';
  submitAddBtn.textContent = 'Guardar en el Inventario';
  addForm.reset();
  clearMediaQueue();
  state.formRelations.clear();
  renderFormRelations();
  document.getElementById('item-categoria').value = state.categoria || 'Tecnología';
  document.getElementById('item-fecha-obtenido').value = todayISO();
  document.getElementById('item-cantidad').value = '1';
  addForm.querySelector('input[name="moneda"][value="ARS"]').checked = true;
  addError.hidden = true;
  uploadProgressWrap.hidden = true;
  if (!addDialog.open) addDialog.showModal();
}

function openEditModal(item) {
  state.editingItemId = item.id;
  addDialogTitle.textContent = `Editar: ${item.nombre}`;
  submitAddBtn.textContent = 'Guardar Cambios';
  addForm.reset();
  clearMediaQueue();
  state.formRelations.clear();
  for (const c of item.contiene || []) {
    state.formRelations.set(c.id, { id: c.id, nombre: c.nombre, cantidad: c.cantidad });
  }
  renderFormRelations();

  document.getElementById('item-nombre').value = item.nombre || '';
  document.getElementById('item-categoria').value = item.categoria || 'General';
  document.getElementById('item-cantidad').value = String(item.cantidad || 1);
  document.getElementById('item-marca').value = item.marca || '';
  document.getElementById('item-modelo').value = item.modelo || '';
  document.getElementById('item-guardado-en').value = item.guardado_en || '';
  document.getElementById('item-fecha-obtenido').value = item.fecha_obtenido || todayISO();
  document.getElementById('item-precio').value = item.precio ?? '';
  document.getElementById('item-descripcion').value = item.descripcion || '';
  document.getElementById('item-detalles').value = item.detalles || '';

  const monedaRadio = addForm.querySelector(`input[name="moneda"][value="${item.moneda || 'ARS'}"]`);
  if (monedaRadio) monedaRadio.checked = true;

  addError.hidden = true;
  uploadProgressWrap.hidden = true;
  if (!addDialog.open) addDialog.showModal();
}

btnLaunchAdd.addEventListener('click', () => {
  openCreateModal();
  if (window.matchMedia('(pointer: coarse)').matches) {
    quickCameraInput.click();
  } else {
    startLiveCamera();
  }
});

async function handleSelectedFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    if (file.type.startsWith('image/')) {
      const compressed = await compressImageToBlob(file);
      enqueueMediaBlob(compressed, file.name);
    } else if (file.type.startsWith('video/')) {
      enqueueMediaBlob(file, file.name);
    }
  }
}

quickCameraInput.addEventListener('change', async () => {
  await handleSelectedFiles(quickCameraInput.files);
  if (!addDialog.open) addDialog.showModal();
  quickCameraInput.value = '';
});

quickVideoInput.addEventListener('change', async () => {
  await handleSelectedFiles(quickVideoInput.files);
  if (!addDialog.open) addDialog.showModal();
  quickVideoInput.value = '';
});

multiMediaInput.addEventListener('change', async () => {
  await handleSelectedFiles(multiMediaInput.files);
  if (!addDialog.open) addDialog.showModal();
  multiMediaInput.value = '';
});

btnTakeCamera.addEventListener('click', () => startLiveCamera());

btnShutter.addEventListener('click', async () => {
  if (!state.stream) return;
  const compressed = await compressImageToBlob(cameraVideo);
  enqueueMediaBlob(compressed, 'camara.webp');
  stopCameraStream();
});

btnTakeVideo.addEventListener('click', () => {
  stopCameraStream();
  quickVideoInput.click();
});

btnPickFile.addEventListener('click', () => {
  stopCameraStream();
  multiMediaInput.click();
});

addDialog.addEventListener('close', () => stopCameraStream());
closeAddDialog.addEventListener('click', () => addDialog.close());
closeDetailDialog.addEventListener('click', () => detailDialog.close());
closeUserDialog.addEventListener('click', () => userDialog.close());
closeJobsDialog.addEventListener('click', () => jobsDialog.close());

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addError.hidden = true;

  const isEditing = Boolean(state.editingItemId);
  if (!isEditing && state.mediaQueue.length === 0) {
    addError.textContent = 'Agrega al menos una foto o video del objeto antes de guardar.';
    addError.hidden = false;
    return;
  }

  submitAddBtn.disabled = true;
  try {
    const fd = new FormData(addForm);
    const payload = {
      user_id: state.selectedUserId || state.currentUser.id,
      nombre: fd.get('nombre'),
      categoria: fd.get('categoria') || 'General',
      cantidad: Number(fd.get('cantidad')) || 1,
      marca: fd.get('marca'),
      modelo: fd.get('modelo'),
      guardado_en: fd.get('guardado_en'),
      fecha_obtenido: fd.get('fecha_obtenido'),
      precio: fd.get('precio'),
      moneda: fd.get('moneda') || 'ARS',
      descripcion: fd.get('descripcion'),
      detalles: fd.get('detalles'),
      relaciones: Array.from(state.formRelations.values()).map((r) => ({
        child_id: r.id,
        cantidad: r.cantidad
      }))
    };

    const url = isEditing ? `/api/items/${state.editingItemId}` : '/api/items';
    const method = isEditing ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const item = await res.json();
    if (!res.ok) throw new Error(item.error || 'No se pudo guardar el objeto.');

    if (state.mediaQueue.length > 0) {
      uploadProgressWrap.hidden = false;
      for (let i = 0; i < state.mediaQueue.length; i++) {
        await uploadSingleMedia(item.id, state.mediaQueue[i], (ratio) => {
          const pct = Math.round(((i + ratio) / state.mediaQueue.length) * 100);
          uploadProgressFill.style.width = `${pct}%`;
        });
      }
    }

    addDialog.close();
    clearMediaQueue();
    await refreshAll();
  } catch (err) {
    addError.textContent = err.message;
    addError.hidden = false;
  } finally {
    submitAddBtn.disabled = false;
    uploadProgressWrap.hidden = true;
    uploadProgressFill.style.width = '0%';
  }
});

// ---------------------------------------------------------------------------
// 7. Pestañas (Dashboard 10 últimos / Inventario Completo / Bajas), Categorías y Admin
// ---------------------------------------------------------------------------
function setActiveTab(tabName) {
  state.tab = tabName;
  tabDashboard.setAttribute('aria-selected', String(tabName === 'dashboard'));
  tabActivos.setAttribute('aria-selected', String(tabName === 'activos'));
  tabBajas.setAttribute('aria-selected', String(tabName === 'bajas'));
  loadItems();
}

tabDashboard.addEventListener('click', () => setActiveTab('dashboard'));
tabActivos.addEventListener('click', () => setActiveTab('activos'));
tabBajas.addEventListener('click', () => setActiveTab('bajas'));
btnGoFullInventory.addEventListener('click', () => setActiveTab('activos'));

toggleGroupSectionsBtn.addEventListener('click', () => {
  state.groupByCategory = !state.groupByCategory;
  toggleGroupSectionsBtn.setAttribute('aria-pressed', String(state.groupByCategory));
  toggleGroupSectionsBtn.textContent = state.groupByCategory
    ? '🗂️ Por Secciones'
    : '📋 Vista Plana';
  renderGallery();
});

searchInput.addEventListener('input', () => {
  state.q = searchInput.value.trim();
  loadItems();
});

userSelect.addEventListener('change', () => {
  state.selectedUserId = Number(userSelect.value);
  state.selectedItems.clear();
  updateSelectionUI();
  refreshAll();
});

newUserBtn.addEventListener('click', () => {
  userForm.reset();
  userCreateError.hidden = true;
  userDialog.showModal();
  document.getElementById('new-user-email').focus();
});

userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  userCreateError.hidden = true;
  const fd = new FormData(userForm);
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: document.getElementById('new-user-email').value.trim(),
      password: document.getElementById('new-user-password').value,
      role: fd.get('role')
    })
  });
  const data = await res.json();
  if (!res.ok) {
    userCreateError.textContent = data.error || 'Error creando usuario.';
    userCreateError.hidden = false;
    return;
  }
  state.selectedUserId = data.id;
  state.selectedItems.clear();
  updateSelectionUI();
  userDialog.close();
  await refreshAll();
});

jobsBtn.addEventListener('click', async () => {
  await renderJobsModal();
  if (!jobsDialog.open) jobsDialog.showModal();
});

async function renderJobsModal() {
  const res = await fetch('/api/jobs');
  if (!res.ok) return;
  const { resumen, jobs } = await res.json();
  jobsBody.replaceChildren();

  const summary = document.createElement('div');
  summary.className = 'meta-grid';
  summary.append(
    createMetaBox('Pendientes', String(resumen.pendiente || 0)),
    createMetaBox('Procesando', String(resumen.procesando || 0)),
    createMetaBox('Completados', String(resumen.listo || 0)),
    createMetaBox('Con error', String(resumen.error || 0))
  );
  jobsBody.appendChild(summary);

  if (jobs.length === 0) {
    const p = document.createElement('p');
    p.style.color = 'var(--text-muted)';
    p.textContent = 'No hay videos registrados en la cola de tareas.';
    jobsBody.appendChild(p);
    return;
  }

  for (const job of jobs) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    const h3 = document.createElement('h3');
    h3.textContent = `#${job.id} · ${job.item_nombre} (${job.estado.toUpperCase()})`;
    const p = document.createElement('p');
    p.style.fontSize = '0.84rem';
    p.textContent = `Intentos: ${job.intentos} · Tamaño: ${formatBytes(job.bytes)}${job.error ? `\nError: ${job.error}` : ''}`;
    sec.append(h3, p);

    if (job.estado === 'error') {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn';
      retryBtn.style.marginTop = '0.45rem';
      retryBtn.textContent = '🔄 Reintentar compresión';
      retryBtn.addEventListener('click', async () => {
        await fetch(`/api/jobs/${job.id}/reintentar`, { method: 'POST' });
        await renderJobsModal();
      });
      sec.appendChild(retryBtn);
    }
    jobsBody.appendChild(sec);
  }
}

// ---------------------------------------------------------------------------
// 8. Selección de Objetos y Generador de Lista en Texto para Compartir
// ---------------------------------------------------------------------------
function toggleItemSelection(item, selected) {
  if (selected) state.selectedItems.set(item.id, item);
  else state.selectedItems.delete(item.id);
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = state.selectedItems.size;
  const hasSelection = count > 0;
  selectionBar.hidden = !hasSelection;
  btnLaunchAdd.hidden = hasSelection;
  selectionCountLabel.textContent =
    count === 1 ? '1 objeto seleccionado' : `${count} objetos seleccionados`;

  const allVisibleSelected =
    state.items.length > 0 && state.items.every((it) => state.selectedItems.has(it.id));
  toggleSelectAllBtn.setAttribute('aria-pressed', String(allVisibleSelected));
  toggleSelectAllBtn.textContent = allVisibleSelected
    ? '☑️ Desmarcar visibles'
    : '☑️ Seleccionar visibles';
}

toggleSelectAllBtn.addEventListener('click', () => {
  if (state.items.length === 0) return;
  const allVisibleSelected = state.items.every((it) => state.selectedItems.has(it.id));
  for (const item of state.items) {
    if (allVisibleSelected) state.selectedItems.delete(item.id);
    else state.selectedItems.set(item.id, item);
  }
  renderGallery();
  updateSelectionUI();
});

btnClearSelection.addEventListener('click', () => {
  state.selectedItems.clear();
  renderGallery();
  updateSelectionUI();
});

function buildShareableText() {
  const items = Array.from(state.selectedItems.values());
  const title = (listCustomTitle.value || '').trim() || 'Lista de Inventario';
  const incPrice = optIncludePrice.checked;
  const incRel = optIncludeRelations.checked;
  const incDesc = optIncludeDesc.checked;
  const incDates = optIncludeDates.checked;

  const lines = [`📋 ${title} (${items.length} ${items.length === 1 ? 'objeto' : 'objetos'})`, '────────────────────'];

  items.forEach((item, idx) => {
    const qtyStr = item.cantidad > 1 ? ` ×${item.cantidad}` : '';
    const catStr = item.categoria ? `[${item.categoria}] ` : '';
    const brandModel = incDesc ? [item.marca, item.modelo].filter(Boolean).join(' ') : '';
    const brandStr = brandModel ? ` (${brandModel})` : '';
    const priceStr =
      incPrice && item.precio !== null && item.precio !== undefined
        ? ` — ${formatMoney(item.precio, item.moneda)}`
        : '';
    const statusStr = item.motivo_baja ? ` [${MOTIVO_LABELS[item.motivo_baja]}]` : '';

    lines.push(`${idx + 1}. ${catStr}${item.nombre}${qtyStr}${brandStr}${priceStr}${statusStr}`);

    if (incRel && item.contiene?.length > 0) {
      for (const child of item.contiene) {
        lines.push(`   ↳ ${child.nombre} ×${child.cantidad}`);
      }
    }
    if (incDesc && item.guardado_en) {
      lines.push(`   • Guardado en: ${item.guardado_en}`);
    }
    if (incDesc && item.descripcion) {
      lines.push(`   • ${item.descripcion}`);
    }
    if (incDesc && item.detalles) {
      lines.push(`   • Detalles: ${item.detalles}`);
    }
    if (incDates) {
      const dateInfo = item.fecha_baja
        ? `Obtenido: ${item.fecha_obtenido} | Baja: ${item.fecha_baja}`
        : `Obtenido: ${item.fecha_obtenido}`;
      lines.push(`   • ${dateInfo}`);
    }
  });

  if (incPrice && items.some((i) => i.precio !== null && i.precio !== undefined)) {
    lines.push('────────────────────');
    lines.push(`💰 Total: ${computeTotalsText(items)}`);
  }

  listTextOutput.value = lines.join('\n');
}

btnOpenListModal.addEventListener('click', () => {
  shareFeedback.hidden = true;
  buildShareableText();
  listDialog.showModal();
});

closeListDialog.addEventListener('click', () => listDialog.close());
listCustomTitle.addEventListener('input', buildShareableText);
optIncludePrice.addEventListener('change', buildShareableText);
optIncludeRelations.addEventListener('change', buildShareableText);
optIncludeDesc.addEventListener('change', buildShareableText);
optIncludeDates.addEventListener('change', buildShareableText);

btnCopyList.addEventListener('click', async () => {
  await navigator.clipboard.writeText(listTextOutput.value);
  shareFeedback.textContent = '✅ ¡Lista copiada al portapapeles!';
  shareFeedback.hidden = false;
});

btnShareList.addEventListener('click', async () => {
  const text = listTextOutput.value;
  const title = (listCustomTitle.value || '').trim() || 'Lista de Inventario';
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      shareFeedback.textContent = '✅ ¡Lista compartida!';
      shareFeedback.hidden = false;
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  await navigator.clipboard.writeText(text);
  shareFeedback.textContent = '✅ Copiado al portapapeles (listo para pegar y compartir).';
  shareFeedback.hidden = false;
});

checkSession();
