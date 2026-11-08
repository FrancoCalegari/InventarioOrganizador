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
  currentUser: null, // { id, email, role }
  selectedUserId: null,
  estado: 'activos',
  q: '',
  items: [],
  selectedItems: new Map(), // Map<item.id, item>
  capturedBlob: null,
  stream: null
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

// Referencias DOM - App
const userRoleBadge = document.getElementById('user-role-badge');
const userEmailDisplay = document.getElementById('user-email-display');
const userSelect = document.getElementById('user-select');
const newUserBtn = document.getElementById('new-user-btn');
const logoutBtn = document.getElementById('logout-btn');

const userDialog = document.getElementById('user-dialog');
const userForm = document.getElementById('user-form');
const closeUserDialog = document.getElementById('close-user-dialog');
const userCreateError = document.getElementById('user-create-error');

const tabActivos = document.getElementById('tab-activos');
const tabBajas = document.getElementById('tab-bajas');
const countActivos = document.getElementById('count-activos');
const countBajas = document.getElementById('count-bajas');
const searchInput = document.getElementById('search-input');
const totalValuePill = document.getElementById('total-value-pill');
const galleryGrid = document.getElementById('gallery-grid');

const quickCameraInput = document.getElementById('quick-camera-input');
const btnLaunchAdd = document.getElementById('btn-launch-add');
const addDialog = document.getElementById('add-dialog');
const closeAddDialog = document.getElementById('close-add-dialog');
const addForm = document.getElementById('add-form');
const photoPreview = document.getElementById('photo-preview');
const cameraVideo = document.getElementById('camera-video');
const btnTakeCamera = document.getElementById('btn-take-camera');
const btnShutter = document.getElementById('btn-shutter');
const btnPickFile = document.getElementById('btn-pick-file');
const addError = document.getElementById('add-error');
const submitAddBtn = document.getElementById('submit-add-btn');

const detailDialog = document.getElementById('detail-dialog');
const closeDetailDialog = document.getElementById('close-detail-dialog');
const detailBody = document.getElementById('detail-body');

// Referencias DOM - Selección y Lista en Texto
const toggleSelectAllBtn = document.getElementById('toggle-select-all-btn');
const selectionBar = document.getElementById('selection-bar');
const selectionCountLabel = document.getElementById('selection-count-label');
const btnClearSelection = document.getElementById('btn-clear-selection');
const btnOpenListModal = document.getElementById('btn-open-list-modal');
const listDialog = document.getElementById('list-dialog');
const closeListDialog = document.getElementById('close-list-dialog');
const listCustomTitle = document.getElementById('list-custom-title');
const optIncludePrice = document.getElementById('opt-include-price');
const optIncludeDesc = document.getElementById('opt-include-desc');
const optIncludeDates = document.getElementById('opt-include-dates');
const listTextOutput = document.getElementById('list-text-output');
const shareFeedback = document.getElementById('share-feedback');
const btnCopyList = document.getElementById('btn-copy-list');
const btnShareList = document.getElementById('btn-share-list');

const MOTIVO_LABELS = {
  vendido: 'Se vendió',
  desechado: 'Se desechó',
  roto: 'Se rompió'
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatCurrency(val) {
  if (val === null || val === undefined || val === '') return null;
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2
  }).format(Number(val));
}

// ---------------------------------------------------------------------------
// 1. Autenticación y Sistema de Usuarios
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

  authView.hidden = true;
  appView.hidden = false;
  refreshAll();
}

async function checkSession() {
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    const user = await res.json();
    setSessionUser(user);
  } else {
    authView.hidden = false;
    appView.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// 2. Compresión de Fotos en Cliente (<canvas>) y Cámara
// ---------------------------------------------------------------------------
async function compressImageToBlob(sourceFileOrVideo, maxDim = 1280, quality = 0.82) {
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

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

function setCapturedPhoto(blob) {
  state.capturedBlob = blob;
  stopCameraStream();
  if (photoPreview.dataset.url) URL.revokeObjectURL(photoPreview.dataset.url);
  const url = URL.createObjectURL(blob);
  photoPreview.dataset.url = url;
  photoPreview.src = url;
  photoPreview.hidden = false;
  addError.hidden = true;
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
    quickCameraInput.setAttribute('capture', 'environment');
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
    photoPreview.hidden = true;
    btnShutter.hidden = false;
  } catch {
    quickCameraInput.setAttribute('capture', 'environment');
    quickCameraInput.click();
  }
}

// ---------------------------------------------------------------------------
// 3. Carga de Usuarios e Inventario
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

async function loadItems() {
  const params = new URLSearchParams({
    userId: String(state.selectedUserId || state.currentUser.id),
    estado: state.estado,
    q: state.q
  });
  const res = await fetch(`/api/items?${params}`);
  if (!res.ok) return;
  state.items = await res.json();
  renderGallery();
}

async function refreshAll() {
  if (!state.currentUser) return;
  await Promise.all([loadUsers(), loadItems()]);
}

// ---------------------------------------------------------------------------
// 4. Galería y Vista de Detalle / Dar de Baja
// ---------------------------------------------------------------------------
function renderGallery() {
  galleryGrid.replaceChildren();

  const total = state.items.reduce((acc, item) => acc + (Number(item.precio) || 0), 0);
  totalValuePill.textContent = formatCurrency(total) || '$0.00';

  if (state.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.gridColumn = '1 / -1';
    const h2 = document.createElement('h2');
    h2.textContent =
      state.estado === 'activos' ? 'Sin objetos en el inventario' : 'No hay objetos dados de baja';
    const p = document.createElement('p');
    p.textContent =
      state.estado === 'activos'
        ? 'Pulsa "📸 Sacar Foto y Añadir Objeto" para fotografiar y cargar un objeto.'
        : 'Aquí aparecerán los objetos que se vendieron, desecharon o rompieron.';
    empty.append(h2, p);
    galleryGrid.appendChild(empty);
    updateSelectionUI();
    return;
  }

  for (const item of state.items) {
    // Actualizar datos del objeto si ya estaba seleccionado
    if (state.selectedItems.has(item.id)) {
      state.selectedItems.set(item.id, item);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'item-card-wrapper';

    const card = document.createElement('div');
    card.className = 'item-card';
    card.dataset.selected = String(state.selectedItems.has(item.id));
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Ver detalle de ${item.nombre}`);
    card.addEventListener('click', () => openItemDetail(item));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openItemDetail(item);
      }
    });

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';

    const img = document.createElement('img');
    img.src = item.foto_url;
    img.alt = item.nombre;
    img.loading = 'lazy';
    thumbWrap.appendChild(img);

    // Checkbox para seleccionar objetos y armar lista
    const checkLabel = document.createElement('label');
    checkLabel.className = 'card-check-label';
    checkLabel.title = 'Seleccionar para lista';
    checkLabel.addEventListener('click', (e) => e.stopPropagation());
    const checkInput = document.createElement('input');
    checkInput.type = 'checkbox';
    checkInput.checked = state.selectedItems.has(item.id);
    checkInput.setAttribute('aria-label', `Seleccionar ${item.nombre} para la lista`);
    checkInput.addEventListener('change', () => {
      toggleItemSelection(item, checkInput.checked);
      card.dataset.selected = String(checkInput.checked);
    });
    checkLabel.appendChild(checkInput);
    thumbWrap.appendChild(checkLabel);

    if (item.precio !== null && item.precio !== undefined) {
      const priceBadge = document.createElement('span');
      priceBadge.className = 'badge-price';
      priceBadge.textContent = formatCurrency(item.precio);
      thumbWrap.appendChild(priceBadge);
    }

    if (item.motivo_baja) {
      const statusBadge = document.createElement('span');
      statusBadge.className = 'badge-status';
      statusBadge.dataset.motivo = item.motivo_baja;
      statusBadge.textContent = MOTIVO_LABELS[item.motivo_baja] || item.motivo_baja;
      thumbWrap.appendChild(statusBadge);
    }

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = item.nombre;

    const meta = document.createElement('p');
    meta.className = 'card-meta';
    meta.textContent = item.fecha_baja
      ? `Baja: ${item.fecha_baja}`
      : `Obtenido: ${item.fecha_obtenido}`;

    body.append(title, meta);
    card.append(thumbWrap, body);
    wrapper.appendChild(card);
    galleryGrid.appendChild(wrapper);
  }
  updateSelectionUI();
}

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

function openItemDetail(item) {
  detailBody.replaceChildren();
  document.getElementById('detail-dialog-title').textContent = item.nombre;

  const img = document.createElement('img');
  img.className = 'detail-photo';
  img.src = item.foto_url;
  img.alt = item.nombre;
  detailBody.appendChild(img);

  const metaGrid = document.createElement('div');
  metaGrid.className = 'meta-grid';
  metaGrid.append(
    createMetaBox('Precio', formatCurrency(item.precio) || 'Sin precio'),
    createMetaBox('Fecha obtenido', item.fecha_obtenido),
    createMetaBox('Fecha carga al sistema', item.fecha_carga.slice(0, 16).replace('T', ' ')),
    createMetaBox(
      'Estado',
      item.fecha_baja
        ? `Dado de baja (${MOTIVO_LABELS[item.motivo_baja]} el ${item.fecha_baja})`
        : 'Activo en inventario'
    )
  );
  detailBody.appendChild(metaGrid);

  if (item.descripcion) detailBody.appendChild(createDetailSection('Descripción', item.descripcion));
  if (item.detalles) {
    detailBody.appendChild(createDetailSection('Detalles relacionados con el objeto', item.detalles));
  }

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

    const submitBaja = document.createElement('button');
    submitBaja.type = 'submit';
    submitBaja.className = 'btn btn-danger';
    submitBaja.style.width = '100%';
    submitBaja.textContent = 'Confirmar Baja';

    form.append(fieldset, dateGroup, submitBaja);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBaja.disabled = true;
      const fd = new FormData(form);
      await fetch(`/api/items/${item.id}/baja`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          motivo_baja: fd.get('motivo_baja'),
          fecha_baja: fd.get('fecha_baja')
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

  detailDialog.showModal();
}

// ---------------------------------------------------------------------------
// 5. Eventos del Formulario de Añadir y Admin
// ---------------------------------------------------------------------------
function openAddModal() {
  const dateField = document.getElementById('item-fecha-obtenido');
  if (!dateField.value) dateField.value = todayISO();
  if (!addDialog.open) addDialog.showModal();
}

btnLaunchAdd.addEventListener('click', () => {
  addForm.reset();
  document.getElementById('item-fecha-obtenido').value = todayISO();
  state.capturedBlob = null;
  photoPreview.hidden = true;
  addError.hidden = true;

  if (window.matchMedia('(pointer: coarse)').matches) {
    quickCameraInput.setAttribute('capture', 'environment');
    quickCameraInput.click();
  } else {
    openAddModal();
    startLiveCamera();
  }
});

quickCameraInput.addEventListener('change', async () => {
  const file = quickCameraInput.files?.[0];
  if (!file) return;
  const compressed = await compressImageToBlob(file);
  setCapturedPhoto(compressed);
  openAddModal();
  document.getElementById('item-nombre').focus();
  quickCameraInput.value = '';
});

btnTakeCamera.addEventListener('click', () => startLiveCamera());

btnShutter.addEventListener('click', async () => {
  if (!state.stream) return;
  const compressed = await compressImageToBlob(cameraVideo);
  setCapturedPhoto(compressed);
  document.getElementById('item-nombre').focus();
});

btnPickFile.addEventListener('click', () => {
  stopCameraStream();
  quickCameraInput.removeAttribute('capture');
  quickCameraInput.click();
});

addDialog.addEventListener('close', () => stopCameraStream());
closeAddDialog.addEventListener('click', () => addDialog.close());
closeDetailDialog.addEventListener('click', () => detailDialog.close());
closeUserDialog.addEventListener('click', () => userDialog.close());

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addError.hidden = true;

  if (!state.capturedBlob) {
    addError.textContent = 'Toma una foto del objeto o selecciona una imagen antes de guardar.';
    addError.hidden = false;
    return;
  }

  submitAddBtn.disabled = true;
  try {
    const formData = new FormData(addForm);
    formData.set('user_id', String(state.selectedUserId || state.currentUser.id));
    formData.set('foto', state.capturedBlob, 'objeto.jpg');

    const res = await fetch('/api/items', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar.');

    addDialog.close();
    state.estado = 'activos';
    tabActivos.setAttribute('aria-selected', 'true');
    tabBajas.setAttribute('aria-selected', 'false');
    await refreshAll();
  } catch (err) {
    addError.textContent = err.message;
    addError.hidden = false;
  } finally {
    submitAddBtn.disabled = false;
  }
});

tabActivos.addEventListener('click', () => {
  state.estado = 'activos';
  tabActivos.setAttribute('aria-selected', 'true');
  tabBajas.setAttribute('aria-selected', 'false');
  loadItems();
});

tabBajas.addEventListener('click', () => {
  state.estado = 'bajas';
  tabActivos.setAttribute('aria-selected', 'false');
  tabBajas.setAttribute('aria-selected', 'true');
  loadItems();
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

// ---------------------------------------------------------------------------
// 6. Selección de Objetos y Generador de Lista en Texto para Compartir
// ---------------------------------------------------------------------------
function toggleItemSelection(item, selected) {
  if (selected) {
    state.selectedItems.set(item.id, item);
  } else {
    state.selectedItems.delete(item.id);
  }
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
  const incDesc = optIncludeDesc.checked;
  const incDates = optIncludeDates.checked;

  const lines = [`📋 ${title} (${items.length} ${items.length === 1 ? 'objeto' : 'objetos'})`, '────────────────────'];
  let total = 0;

  items.forEach((item, idx) => {
    const priceNum = Number(item.precio) || 0;
    total += priceNum;
    const priceStr =
      incPrice && item.precio !== null && item.precio !== undefined
        ? ` — ${formatCurrency(item.precio)}`
        : '';
    const statusStr = item.motivo_baja ? ` [${MOTIVO_LABELS[item.motivo_baja]}]` : '';

    lines.push(`${idx + 1}. ${item.nombre}${priceStr}${statusStr}`);

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
    lines.push(`💰 Total: ${formatCurrency(total)}`);
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
optIncludeDesc.addEventListener('change', buildShareableText);
optIncludeDates.addEventListener('change', buildShareableText);

btnCopyList.addEventListener('click', async () => {
  const text = listTextOutput.value;
  await navigator.clipboard.writeText(text);
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
