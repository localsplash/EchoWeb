/* ── Echo Messages – client JS ── */

const MEDIA_BASE_URL = (window.ECHO_CONFIG && window.ECHO_CONFIG.MEDIA_BASE_URL) || 'https://media.echo.wisp.net';
const MAX_FILE_SIZE = 3.5 * 1024 * 1024; // 3.5 MB
const MAX_FILES = 10;

let currentCustomer = null;
let draftingNew = false;
// Array of draft media entries for the active conversation.
// Each entry: { draftMediaId?, displayName, contentType, contentLength,
//   storagePath?, thumbnailPath?, status: 'uploading'|'ready'|'error',
//   localPreviewUrl?, abortController?, error? }
let pendingDraftMedia = [];

/* ── Helpers ── */

function normalizeNum(v) {
  const d = String(v || '').replace(/\D/g, '');
  return (d.length === 11 && d.startsWith('1')) ? d.slice(1) : d;
}

function formatPhoneNumber(num) {
  const d = String(num).replace(/\D/g, '');
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return d;
}

// Rewrite a phone field in place to (XXX) XXX-XXXX as the user types or pastes.
// Everything that isn't a digit is dropped, so "(714) 684-6530", "+1 714 684
// 6530" and "WISP 7146846530" all land on the same ten digits. The field carries
// no maxlength — an attribute cap counts the punctuation and letters too, which
// is what used to truncate pasted numbers.
function formatPhoneField(el) {
  const d = normalizeNum(el.value).slice(0, 10);
  if (d.length <= 3) el.value = d;
  else if (d.length <= 6) el.value = '(' + d.slice(0, 3) + ') ' + d.slice(3);
  else el.value = '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
}

// Conversation list: one short line in a narrow column, so the date alone is
// enough — the thread is one tap away for the detail.
function formatTime(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  if (isNaN(d)) return dt;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clockTime(d);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function clockTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Message bubbles: always carry a clock time. "Yesterday" on its own says
// nothing about whether a customer wrote at 9am or 11pm, which is exactly what
// you want to know when reading a thread back (#14).
function formatMessageTime(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  if (isNaN(d)) return dt;
  const time = clockTime(d);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday ' + time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  return date + ', ' + time;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getInitials(num) {
  const d = String(num).replace(/\D/g, '');
  return d.slice(0, 2);
}

function getAvatarColor(num) {
  const palettes = [
    ['bg-violet-100', 'text-violet-700'],
    ['bg-emerald-100', 'text-emerald-700'],
    ['bg-amber-100', 'text-amber-700'],
    ['bg-rose-100', 'text-rose-700'],
    ['bg-cyan-100', 'text-cyan-700'],
    ['bg-indigo-100', 'text-indigo-700'],
    ['bg-orange-100', 'text-orange-700'],
    ['bg-teal-100', 'text-teal-700'],
  ];
  const d = String(num).replace(/\D/g, '');
  const hash = d.split('').reduce((a, c) => ((a << 5) - a + Number(c)) | 0, 0);
  return palettes[Math.abs(hash) % palettes.length];
}

const EVENT_FAILED = 8;

const MESSAGE_STATUS = {
  1: { icon: '\u{1F4E9}', label: 'Received' },
  2: { icon: '\u{1F553}', label: 'Sending' },
  4: { icon: '\u2705', label: 'Delivered' },
  // Forbidden sign rather than a red cross: a cross reads as "close/dismiss"
  // next to the per-message Delete button.
  [EVENT_FAILED]: { icon: '\u26D4', label: 'Failed to deliver' }
};

function statusForEvent(e) {
  return MESSAGE_STATUS[Number(e)] || { icon: '\u{1F4AC}', label: 'Message' };
}

// Human-readable reason for a failed send. The carrier detail rides along on the
// message as errorDescription/iErrorCode; older rows have neither.
function failureDetail(m) {
  const desc = String(m.errorDescription || '').trim();
  const code = m.iErrorCode ? String(m.iErrorCode).trim() : '';
  if (desc) return code ? desc + ' (carrier error ' + code + ')' : desc;
  if (code) return 'Carrier error ' + code;
  return 'The carrier could not deliver this message.';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/* ── File type icon SVGs (vanilla JS, no React) ── */

function getFileIconSvg(contentType) {
  const ct = (contentType || '').toLowerCase();

  // PDF
  if (ct === 'application/pdf')
    return '<svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/><text x="7" y="18" font-size="6" fill="currentColor" font-weight="bold">PDF</text></svg>';

  // Audio
  if (ct.startsWith('audio/'))
    return '<svg class="w-8 h-8 text-purple-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z"/></svg>';

  // Video (fallback when no thumbnail)
  if (ct.startsWith('video/'))
    return '<svg class="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25z"/></svg>';

  // Image (fallback when no thumbnail)
  if (ct.startsWith('image/'))
    return '<svg class="w-8 h-8 text-green-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21z"/></svg>';

  // Archive
  if (ct.includes('zip') || ct.includes('rar') || ct.includes('7z') || ct.includes('tar') || ct.includes('gzip'))
    return '<svg class="w-8 h-8 text-yellow-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"/></svg>';

  // Spreadsheet
  if (ct.includes('excel') || ct.includes('spreadsheet') || ct.includes('csv'))
    return '<svg class="w-8 h-8 text-green-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0112 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M13.125 12h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125M20.625 12c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5M12 14.625v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 14.625c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m0 0v1.5"/></svg>';

  // Word doc
  if (ct.includes('word') || ct.includes('document') || ct === 'text/plain' || ct === 'application/rtf')
    return '<svg class="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg>';

  // Generic file
  return '<svg class="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg>';
}

/* ── Panel switching (mobile) ── */

function showPanel(name) {
  const sidebar = document.getElementById('sidebar');
  const thread = document.getElementById('thread');
  if (name === 'list') {
    sidebar.classList.remove('hidden');
    sidebar.classList.add('flex');
    thread.classList.remove('flex');
    thread.classList.add('hidden');
  } else {
    sidebar.classList.add('hidden');
    sidebar.classList.remove('flex');
    thread.classList.remove('hidden');
    thread.classList.add('flex');
  }
}

/* ── Thread header state ── */

function setThreadHeader() {
  const title = document.getElementById('threadTitle');
  const input = document.getElementById('customerInput');
  const menu = document.getElementById('threadMenu');
  const avatar = document.getElementById('threadAvatar');
  const empty = document.getElementById('emptyState');

  if (draftingNew) {
    title.classList.add('hidden');
    input.classList.remove('hidden');
    input.classList.add('flex');
    menu.classList.add('hidden');
    avatar.classList.add('hidden');
    if (empty) empty.innerHTML = '<p class="text-slate-400 text-sm">Enter a customer number and start typing</p>';
    input.focus();
  } else if (currentCustomer) {
    title.classList.remove('hidden');
    title.textContent = formatPhoneNumber(currentCustomer);
    input.classList.add('hidden');
    input.classList.remove('flex');
    menu.classList.remove('hidden');
    menu.classList.add('inline-flex');
    const [avBg, avText] = getAvatarColor(currentCustomer);
    avatar.className = `w-9 h-9 rounded-full ${avBg} ${avText} font-semibold text-sm flex items-center justify-center flex-shrink-0`;
    avatar.textContent = getInitials(currentCustomer);
  } else {
    title.classList.remove('hidden');
    title.textContent = 'Select a conversation';
    input.classList.add('hidden');
    input.classList.remove('flex');
    menu.classList.add('hidden');
    avatar.classList.add('hidden');
  }
}

/* ── Auth ── */

async function logout() {
  await fetch('/logout', { method: 'POST' });
  location.href = '/';
}

/* ── New conversation ── */

function startNew() {
  draftingNew = true;
  currentCustomer = null;
  var msgs = document.getElementById('messages');
  msgs.innerHTML = '<div id="emptyState" class="m-auto text-center py-12"><p class="text-slate-400 text-sm">Enter a customer number and start typing</p></div>';
  document.getElementById('compose').style.display = 'flex';
  clearAttachments();
  setThreadHeader();
  showPanel('thread');
}

/* ── Conversation list ── */

async function loadConversations() {
  const r = await fetch('/api/conversations');
  if (r.status === 401) {
    const root = document.getElementById('conversations');
    if (root) root.innerHTML = '<div class="p-6 text-sm text-slate-500">Please enter your business number to continue.</div>';
    const compose = document.getElementById('compose');
    if (compose) compose.style.display = 'none';
    draftingNew = false;
    currentCustomer = null;
    setThreadHeader();
    stopLiveUpdates('session expired');
    return;
  }
  if (!r.ok) { console.error('Failed to load conversations', r.status); return; }
  const data = await r.json();
  const root = document.getElementById('conversations');
  // A background refresh redraws this list; someone scrolled down it should
  // not be thrown back to the top every thirty seconds.
  const listScroll = root.scrollTop;
  root.innerHTML = '';

  for (const c of data.items) {
    const isActive = !draftingNew && String(c.iCustomerNumber) === String(currentCustomer);
    const isUnread = Number(c.unreadCount || 0) > 0;

    const el = document.createElement('div');
    el.className = 'flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 active:bg-slate-100 transition-colors'
      + (isActive ? ' bg-blue-50 shadow-[inset_3px_0_0_#3b82f6]' : '');
    el.onclick = () => openConversation(c.iCustomerNumber);

    const [avatarBg, avatarText] = getAvatarColor(c.iCustomerNumber);
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold flex-shrink-0'
      + (isUnread ? ' bg-blue-600 text-white' : (' ' + avatarBg + ' ' + avatarText));
    avatarDiv.textContent = getInitials(c.iCustomerNumber);

    const content = document.createElement('div');
    content.className = 'flex-1 min-w-0';

    const topRow = document.createElement('div');
    topRow.className = 'flex items-baseline justify-between gap-2';

    const numSpan = document.createElement('span');
    numSpan.className = 'text-sm truncate' + (isUnread ? ' font-bold text-slate-900' : ' font-semibold text-slate-800');
    numSpan.textContent = formatPhoneNumber(c.iCustomerNumber);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'text-xs flex-shrink-0' + (isUnread ? ' text-blue-600 font-semibold' : ' text-slate-400');
    timeSpan.textContent = formatTime(c.lastAt);

    topRow.appendChild(numSpan);
    topRow.appendChild(timeSpan);

    const preview = document.createElement('div');
    const lastFailed = Number(c.lastEventType) === EVENT_FAILED;
    preview.className = 'text-sm truncate mt-0.5'
      + (lastFailed ? ' text-red-600' : (isUnread ? ' font-semibold text-slate-700' : ' text-slate-500'));
    preview.textContent = (lastFailed ? MESSAGE_STATUS[EVENT_FAILED].icon + ' ' : '') + (c.lastText || '');

    content.appendChild(topRow);
    content.appendChild(preview);

    const badge = document.createElement('div');
    if (isUnread) {
      badge.className = 'w-5 h-5 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0';
      badge.textContent = c.unreadCount;
    }

    el.appendChild(avatarDiv);
    el.appendChild(content);
    if (isUnread) el.appendChild(badge);
    root.appendChild(el);
  }

  root.scrollTop = listScroll;
}

/* ── Thread menu ── */

function toggleThreadMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('threadMenuDropdown');
  dd.classList.toggle('hidden');
}

async function threadMenuAction(action) {
  document.getElementById('threadMenuDropdown').classList.add('hidden');
  if (!currentCustomer) return;

  if (action === 'unread') {
    await fetch('/api/conversations/' + currentCustomer + '/mark-unread', { method: 'POST' });
    await loadConversations();
  }
  if (action === 'delete' && confirm('Delete entire conversation?')) {
    await fetch('/api/conversations/' + currentCustomer, { method: 'DELETE' });
    currentCustomer = null;
    draftingNew = false;
    document.getElementById('messages').innerHTML = '<div id="emptyState" class="m-auto text-center px-8"><div class="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-4"><svg class="w-8 h-8 text-blue-300" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg></div><p class="text-slate-500 text-sm font-medium">No conversation selected</p><p class="text-slate-400 text-xs mt-1">Choose a patient from the list or start a new message</p></div>';
    document.getElementById('compose').style.display = 'none';
    setThreadHeader();
    await loadConversations();
  }
}

document.addEventListener('click', () => {
  const dd = document.getElementById('threadMenuDropdown');
  if (dd) dd.classList.add('hidden');
});

/* ── Media rendering helpers ── */

function renderMediaItem(item) {
  const ct = (item.contentType || '').toLowerCase();
  const mediaUrl = MEDIA_BASE_URL + (item.storagePath || '');
  const thumbUrl = item.thumbnailPath ? MEDIA_BASE_URL + item.thumbnailPath : null;

  const container = document.createElement('div');
  container.className = 'mt-2';

  // Image with thumbnail
  if (thumbUrl && ct.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = thumbUrl;
    img.alt = item.displayName || 'Image';
    img.className = 'rounded-lg max-w-48 max-h-48 object-cover cursor-pointer hover:opacity-90 transition-opacity';
    img.onclick = () => window.open(mediaUrl, '_blank');
    container.appendChild(img);
    return container;
  }

  // Video with thumbnail
  if (thumbUrl && ct.startsWith('video/')) {
    const videoWrap = document.createElement('div');
    videoWrap.className = 'relative max-w-48 cursor-pointer group';
    videoWrap.onclick = () => window.open(mediaUrl, '_blank');

    const thumb = document.createElement('img');
    thumb.src = thumbUrl;
    thumb.alt = item.displayName || 'Video';
    thumb.className = 'rounded-lg max-w-48 max-h-48 object-cover';

    const playOverlay = document.createElement('div');
    playOverlay.className = 'absolute inset-0 flex items-center justify-center bg-black/30 rounded-lg group-hover:bg-black/40 transition-colors';
    playOverlay.innerHTML = '<svg class="w-10 h-10 text-white drop-shadow-lg" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';

    videoWrap.appendChild(thumb);
    videoWrap.appendChild(playOverlay);
    container.appendChild(videoWrap);
    return container;
  }

  // Generic file (no thumbnail or non-visual type)
  const fileCard = document.createElement('a');
  fileCard.href = mediaUrl;
  fileCard.target = '_blank';
  fileCard.className = 'flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100 transition-colors max-w-64';

  const iconDiv = document.createElement('div');
  iconDiv.className = 'flex-shrink-0';
  iconDiv.innerHTML = getFileIconSvg(ct);

  const info = document.createElement('div');
  info.className = 'min-w-0';
  const nameEl = document.createElement('div');
  nameEl.className = 'text-xs font-medium text-slate-700 truncate';
  nameEl.textContent = item.displayName || 'Attachment';
  const sizeEl = document.createElement('div');
  sizeEl.className = 'text-[11px] text-slate-400';
  sizeEl.textContent = formatFileSize(item.iContentLength);
  info.appendChild(nameEl);
  info.appendChild(sizeEl);

  fileCard.appendChild(iconDiv);
  fileCard.appendChild(info);
  container.appendChild(fileCard);
  return container;
}

/* ── Open conversation ── */

async function openConversation(customer, skipRead) {
  draftingNew = false;
  currentCustomer = String(customer);
  setThreadHeader();
  showPanel('thread');
  clearAttachments();

  // Restore draft (text + attachments)
  const txt = document.getElementById('text');
  if (!skipRead) {
    const { text, draftMediaIds } = readDraft(customer);
    txt.value = text || '';
    if (draftMediaIds.length > 0) {
      pendingDraftMedia = await rehydrateDraftMedia(customer, draftMediaIds);
      renderAttachmentPreviews();
      saveDraftMediaIds();
    }
  }

  const r = await fetch('/api/conversations/' + customer + '/messages');
  const data = await r.json();
  const box = document.getElementById('messages');
  renderMessages(customer, data.items || [], box);
  box.scrollTop = box.scrollHeight;
  document.getElementById('compose').style.display = 'flex';

  if (!skipRead) {
    await fetch('/api/conversations/' + customer + '/read', { method: 'POST' });
    await loadConversations();
  }
}

/**
 * Draw a thread's messages into `box`.
 *
 * Split out of openConversation so a background refresh can redraw the
 * transcript without going anywhere near the composer — no draft text, no
 * attachments, no read-marking. See refreshOpenThread().
 */
function renderMessages(customer, items, box) {
  box.innerHTML = '';
  // Drawing is the one place that knows what is on screen, so it is the place
  // that records it — the refresh path compares against this to decide whether
  // a redraw is needed at all.
  threadSignature = signatureOf(items);
  threadMessageIds = new Set(items.map((m) => m.iMessageId));

  for (const m of items) {
    const isInbound = Number(m.bInbound) === 1;
    const wrapper = document.createElement('div');
    wrapper.className = 'flex flex-col max-w-[75%] md:max-w-[65%] msg-anim'
      + (isInbound ? ' items-start self-start' : ' items-end self-end');

    const isFailed = Number(m.eMessageEventTypeID) === EVENT_FAILED;

    const bubble = document.createElement('div');
    bubble.className = isInbound
      ? 'bg-white border border-slate-100 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm text-slate-800 shadow-sm'
      : 'bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm shadow-sm';
    // A failed send keeps its bubble colour but gains a red outline, so it reads
    // as undelivered at a glance instead of only via the small status icon.
    if (isFailed) bubble.className += ' ring-2 ring-red-400';

    // Message text
    if (m.text) {
      const textDiv = document.createElement('div');
      textDiv.innerHTML = escapeHtml(m.text);
      bubble.appendChild(textDiv);
    }

    // Media attachments
    if (m.media && m.media.length > 0) {
      for (const item of m.media) {
        bubble.appendChild(renderMediaItem(item));
      }
    }

    const meta = document.createElement('div');
    meta.className = 'flex items-center gap-2 mt-1 px-1';

    const timeEl = document.createElement('span');
    timeEl.className = 'text-[11px] text-slate-400';
    timeEl.textContent = formatMessageTime(m.dtCreated);
    // The full date and time, for anything the short form leaves out.
    if (m.dtCreated) {
      const exact = new Date(m.dtCreated);
      if (!isNaN(exact)) timeEl.title = exact.toLocaleString();
    }

    const status = statusForEvent(m.eMessageEventTypeID);
    let detailEl = null;

    // Failures get a label next to the icon, the reason on hover, and a tap
    // target that reveals the reason inline for touch devices with no hover.
    const iconEl = document.createElement(isFailed ? 'button' : 'span');
    iconEl.className = 'text-[11px]';
    iconEl.textContent = status.icon;
    iconEl.title = status.label;

    if (isFailed) {
      const detail = failureDetail(m);
      iconEl.type = 'button';
      iconEl.className = 'text-[11px] font-semibold text-red-600 hover:text-red-700 transition-colors';
      iconEl.textContent = status.icon + ' ' + status.label;
      iconEl.title = detail;
      iconEl.setAttribute('aria-label', status.label + ': ' + detail);

      detailEl = document.createElement('div');
      detailEl.className = 'hidden mt-1 px-3 py-2 rounded-xl bg-red-50 border border-red-200 text-[11px] text-red-700';
      detailEl.textContent = detail;

      iconEl.onclick = (ev) => {
        ev.stopPropagation();
        detailEl.classList.toggle('hidden');
      };
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'text-[11px] text-slate-300 hover:text-red-400 transition-colors ml-1';
    delBtn.textContent = 'Delete';
    delBtn.dataset.mid = m.iMessageId;
    delBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (confirm('Delete this message?')) {
        await fetch('/api/messages/' + m.iMessageId, { method: 'DELETE' });
        await openConversation(customer, true);
        await loadConversations();
      }
    };

    if (isInbound) {
      meta.appendChild(timeEl);
      meta.appendChild(iconEl);
      meta.appendChild(delBtn);
    } else {
      meta.appendChild(delBtn);
      meta.appendChild(iconEl);
      meta.appendChild(timeEl);
    }

    wrapper.appendChild(bubble);
    wrapper.appendChild(meta);
    if (detailEl) wrapper.appendChild(detailEl);
    box.appendChild(wrapper);
  }
}

/* ── Attachment handling ── */

function getSendButton() {
  return document.querySelector('#compose button[type="submit"]');
}

function updateSendButtonState() {
  const btn = getSendButton();
  if (!btn) return;
  const hasUploading = pendingDraftMedia.some(m => m.status === 'uploading');
  btn.disabled = hasUploading;
  btn.classList.toggle('opacity-50', hasUploading);
  btn.classList.toggle('cursor-not-allowed', hasUploading);
}

function clearAttachments() {
  for (const m of pendingDraftMedia) {
    if (m.localPreviewUrl) URL.revokeObjectURL(m.localPreviewUrl);
    if (m.status === 'uploading' && m.abortController) {
      try { m.abortController.abort(); } catch (_) {}
    }
  }
  pendingDraftMedia = [];
  renderAttachmentPreviews();
}

function saveDraftMediaIds() {
  if (!currentCustomer) return;
  const key = 'draft-' + currentCustomer;
  const text = document.getElementById('text').value;
  const ids = pendingDraftMedia.filter(m => m.status === 'ready' && m.draftMediaId).map(m => m.draftMediaId);
  if (!text.trim() && ids.length === 0) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify({ text, draftMediaIds: ids }));
}

function readDraft(customer) {
  const raw = localStorage.getItem('draft-' + customer);
  if (!raw) return { text: '', draftMediaIds: [] };
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      return {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        draftMediaIds: Array.isArray(parsed.draftMediaIds) ? parsed.draftMediaIds : []
      };
    } catch (_) { /* fall through to legacy */ }
  }
  return { text: raw, draftMediaIds: [] };
}

async function rehydrateDraftMedia(customer, wantedIds) {
  if (!wantedIds || wantedIds.length === 0) return [];
  try {
    const r = await fetch('/api/drafts/' + customer + '/media');
    if (!r.ok) return [];
    const data = await r.json();
    const byId = new Map((data.items || []).map(it => [it.draftMediaId, it]));
    const restored = [];
    for (const id of wantedIds) {
      const it = byId.get(id);
      if (!it) continue;
      restored.push({
        draftMediaId: it.draftMediaId,
        displayName: it.displayName,
        contentType: it.contentType,
        contentLength: it.contentLength,
        storagePath: it.storagePath,
        thumbnailPath: it.thumbnailPath,
        status: 'ready'
      });
    }
    return restored;
  } catch (err) {
    console.warn('[drafts] rehydrate failed:', err.message);
    return [];
  }
}

function renderAttachmentPreviews() {
  const container = document.getElementById('attachments');
  container.innerHTML = '';

  if (pendingDraftMedia.length === 0) {
    container.classList.add('hidden');
    container.classList.remove('flex');
    updateSendButtonState();
    return;
  }

  container.classList.remove('hidden');
  container.classList.add('flex');

  pendingDraftMedia.forEach((entry, idx) => {
    const card = document.createElement('div');
    const borderClass = entry.status === 'error' ? 'border-red-400' : 'border-slate-200';
    card.className = 'relative flex-shrink-0 w-24 h-24 rounded-xl border overflow-hidden bg-slate-50 group ' + borderClass;

    const ct = (entry.contentType || '').toLowerCase();
    const isImage = ct.startsWith('image/');
    const isVideo = ct.startsWith('video/');

    // Always prefer the local blob preview when available — it's the original,
    // sharp image and doesn't depend on the server serving it back. Only fall
    // back to the server-stored file when we've rehydrated a draft in a new
    // session and the blob URL is gone.
    let imgSrc = null;
    if (entry.localPreviewUrl && (isImage || isVideo)) {
      imgSrc = entry.localPreviewUrl;
    } else if (entry.status === 'ready' && isImage && entry.storagePath) {
      imgSrc = MEDIA_BASE_URL + entry.storagePath;
    }

    if (imgSrc && isImage) {
      const img = document.createElement('img');
      img.src = imgSrc;
      img.className = 'w-full h-full object-cover';
      card.appendChild(img);
    } else if (isVideo && entry.localPreviewUrl) {
      const video = document.createElement('video');
      video.src = entry.localPreviewUrl;
      video.className = 'w-full h-full object-cover';
      video.muted = true;
      video.preload = 'metadata';
      card.appendChild(video);
      const playIcon = document.createElement('div');
      playIcon.className = 'absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none';
      playIcon.innerHTML = '<svg class="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      card.appendChild(playIcon);
    } else {
      const iconWrap = document.createElement('div');
      iconWrap.className = 'flex flex-col items-center justify-center h-full p-2';
      iconWrap.innerHTML = getFileIconSvg(ct) + '<div class="text-[10px] text-slate-500 truncate w-full text-center mt-1">' + escapeHtml(entry.displayName || 'file') + '</div>';
      card.appendChild(iconWrap);
    }

    if (entry.status === 'uploading') {
      const overlay = document.createElement('div');
      overlay.className = 'absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none';
      overlay.innerHTML = '<svg class="animate-spin w-6 h-6 text-white" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path></svg>';
      card.appendChild(overlay);
    } else if (entry.status === 'error') {
      const errBadge = document.createElement('div');
      errBadge.className = 'absolute bottom-0 inset-x-0 bg-red-500/90 text-white text-[10px] text-center px-1 py-0.5 truncate';
      errBadge.textContent = entry.error || 'Upload failed';
      card.appendChild(errBadge);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'absolute top-1 right-1 w-5 h-5 rounded-full bg-black/50 text-white text-xs flex items-center justify-center hover:bg-red-500 transition-colors';
    removeBtn.textContent = '\u00D7';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      removeAttachment(idx);
    };
    card.appendChild(removeBtn);

    container.appendChild(card);
  });

  updateSendButtonState();
}

async function removeAttachment(idx) {
  const entry = pendingDraftMedia[idx];
  if (!entry) return;
  if (entry.status === 'uploading' && entry.abortController) {
    try { entry.abortController.abort(); } catch (_) {}
  }
  if (entry.localPreviewUrl) URL.revokeObjectURL(entry.localPreviewUrl);
  pendingDraftMedia.splice(idx, 1);
  renderAttachmentPreviews();
  saveDraftMediaIds();
  if (entry.status === 'ready' && entry.draftMediaId && currentCustomer) {
    try {
      await fetch('/api/drafts/' + currentCustomer + '/media/' + encodeURIComponent(entry.draftMediaId), { method: 'DELETE' });
    } catch (err) {
      console.warn('[drafts] delete failed:', err.message);
    }
  }
}

async function uploadDraftFile(file, entry) {
  const customer = currentCustomer;
  if (!customer) {
    entry.status = 'error';
    entry.error = 'Pick a conversation first';
    renderAttachmentPreviews();
    return;
  }

  const controller = new AbortController();
  entry.abortController = controller;

  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/drafts/' + customer + '/media', {
      method: 'POST',
      body: fd,
      signal: controller.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();

    if (pendingDraftMedia.indexOf(entry) === -1) return;

    entry.draftMediaId = data.draftMediaId;
    entry.displayName = data.displayName;
    entry.contentType = data.contentType;
    entry.contentLength = data.contentLength;
    entry.storagePath = data.storagePath;
    entry.thumbnailPath = data.thumbnailPath;
    entry.status = 'ready';
    entry.abortController = null;
    // Keep entry.localPreviewUrl — it's the original blob and renders crisper
    // than any server-side file for the composer tile.
    renderAttachmentPreviews();
    saveDraftMediaIds();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (pendingDraftMedia.indexOf(entry) === -1) return;
    entry.status = 'error';
    entry.error = 'Upload failed';
    entry.abortController = null;
    renderAttachmentPreviews();
  }
}

// Attach button click
document.getElementById('btnAttach').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

// File input change
document.getElementById('fileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';

  // When drafting a new conversation, promote the typed customer number to
  // currentCustomer so uploaded drafts are scoped correctly.
  if (!currentCustomer && draftingNew) {
    const typed = normalizeNum(document.getElementById('customerInput').value);
    if (/^\d{10}$/.test(typed || '')) {
      currentCustomer = typed;
    }
  }
  if (!currentCustomer) {
    alert('Enter a 10-digit customer number before attaching files.');
    return;
  }

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      alert('File "' + file.name + '" exceeds 3.5 MB limit.');
      continue;
    }
    if (pendingDraftMedia.length >= MAX_FILES) {
      alert('Maximum ' + MAX_FILES + ' attachments per message.');
      break;
    }
    const ct = file.type || '';
    const localPreviewUrl = (ct.startsWith('image/') || ct.startsWith('video/')) ? URL.createObjectURL(file) : null;
    const entry = {
      displayName: file.name,
      contentType: ct,
      contentLength: file.size,
      status: 'uploading',
      localPreviewUrl
    };
    pendingDraftMedia.push(entry);
    uploadDraftFile(file, entry);
  }
  renderAttachmentPreviews();
});

/* ── Compose / send ── */

document.getElementById('compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const txt = document.getElementById('text');
  let to = currentCustomer;

  if (draftingNew) {
    to = normalizeNum(document.getElementById('customerInput').value);
    if (!/^\d{10}$/.test(to || '')) { alert('Use a 10-digit US number'); return; }
    currentCustomer = to;
    draftingNew = false;
  }
  if (!to) return;

  if (pendingDraftMedia.some(m => m.status === 'uploading')) {
    alert('Waiting for attachment uploads to finish\u2026');
    return;
  }

  const draftMediaIds = pendingDraftMedia.filter(m => m.status === 'ready' && m.draftMediaId).map(m => m.draftMediaId);

  // Hold the background refresh off for the duration of the send, so it cannot
  // redraw the thread from between the POST and the reload below.
  sending = true;
  try {
    const r = await fetch('/api/conversations/' + to + '/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: txt.value, draftMediaIds })
    });

    const data = await r.json();
    if (data && data.ok === false) {
      // Keep the composer as-is so the user can edit and retry — draft media
      // rows on the server are untouched when send fails, and the Bandwidth
      // URLs haven't been committed.
      alert('Carrier failure: ' + (typeof data.details === 'string' ? data.details : JSON.stringify(data.details)));
      return;
    }
    txt.value = '';
    txt.style.height = 'auto';
    clearAttachments();
    localStorage.removeItem('draft-' + to);
    await openConversation(to, true);
    await loadConversations();
  } finally {
    sending = false;
  }
});

/* ── Draft saving ── */

document.getElementById('text').addEventListener('input', function () {
  // Auto-resize
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 128) + 'px';

  // Save draft (text + any ready draftMediaIds)
  saveDraftMediaIds();
});

/* On a soft keyboard the Return key is the only way to type a line break, and
   the send button is right there — so Return must never submit. Hardware
   keyboards keep Enter-to-send with Shift/Ctrl/Cmd+Enter for a newline. */
function hasSoftKeyboard() {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

document.getElementById('text').addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return; // IME candidate selection
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if (hasSoftKeyboard()) return;
  e.preventDefault();
  document.getElementById('compose').requestSubmit();
});

/* Customer number field: reformat on every input so pasted numbers keep all
   ten digits regardless of how they were formatted (issues #2, #6). */
const customerInputEl = document.getElementById('customerInput');
customerInputEl.addEventListener('input', () => formatPhoneField(customerInputEl));

/* ── Business phone identity ── */

async function loadBusinessIdentity() {
  try {
    const r = await fetch('/api/business-phones');
    if (!r.ok) return;
    const data = await r.json();
    const name = data?.item?.displayName;
    if (name) {
      const nameEl = document.getElementById('businessName');
      const titleEl = document.getElementById('pageTitle');
      if (nameEl) nameEl.textContent = name;
      if (titleEl) titleEl.textContent = name + ' Messages';
    }
  } catch (_) { /* non-fatal */ }
}

/* ── Live updates (#3) ──

   Two mechanisms, one refresh path.

   Polling (#15) is the floor: every 30 seconds, ask for the conversation list
   and redraw the open thread. It needs nothing from anyone and works on any
   deployment.

   Pusher (#16) sits on top: when EchoService announces a message the refresh
   runs immediately instead of up to 30 seconds later, and the poll backs off
   to a slow heartbeat. Lose the socket and the poll returns to 30 seconds, so
   the worst case is the behaviour of #15 rather than nothing.

   The rule both obey: a refresh redraws the transcript and the list, and
   touches nothing else. Not the composer, not its caret, not the pending
   attachments, not the scroll position of someone reading history. Someone
   halfway through a sentence should not be able to tell that any of this
   happened. */

const POLL_INTERVAL_MS = 30_000;
// While the socket is up, the poll is only a safety net against a missed
// event — it does not need to run at conversational speed.
const POLL_INTERVAL_PUSH_MS = 5 * 60_000;

let pollTimer = null;
let refreshTimer = null;
let pollInFlight = false;
let liveUpdatesStopped = false;
let sending = false;
let pusherConnected = false;
let pusherClient = null;
// What is currently on screen, so an unchanged thread is left alone rather
// than redrawn — a redraw restarts the bubble animation and would flicker
// every 30 seconds for no reason.
let threadSignature = '';
let threadMessageIds = new Set();

function signatureOf(items) {
  return items
    .map((m) => [m.iMessageId, m.eMessageEventTypeID, (m.media || []).length].join(':'))
    .join('|');
}

/** Refresh the open thread in place. Returns true when it actually redrew. */
async function refreshOpenThread() {
  if (!currentCustomer || draftingNew) return false;

  const box = document.getElementById('messages');
  // On a phone the thread panel is swapped out for the list, and currentCustomer
  // stays set behind it. With no layout there is no answer to "were they
  // scrolled to the bottom", and nobody is reading the thread — so leave it
  // alone and let the list refresh carry the news. Reopening draws it fresh.
  if (box.clientHeight === 0) return false;

  const customer = String(currentCustomer);
  const r = await fetch('/api/conversations/' + customer + '/messages');
  if (!r.ok) return false;
  const data = await r.json();
  const items = data.items || [];

  // The thread may have been switched, or a new draft started, while that
  // request was in flight — drawing these messages now would put them in the
  // wrong conversation.
  if (String(currentCustomer) !== customer || draftingNew) return false;
  if (signatureOf(items) === threadSignature) return false;

  const seenBefore = threadMessageIds;
  // Someone scrolled up is reading; only follow the bottom if they were
  // already there.
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const previousScroll = box.scrollTop;

  renderMessages(customer, items, box);
  box.scrollTop = atBottom ? box.scrollHeight : previousScroll;

  // A message that arrived in the thread the user is looking at, in a tab they
  // are looking at, has been read in every sense that matters — leaving the
  // badge on would mark the conversation on screen as unread. This is the one
  // piece of state a refresh writes, and only under those conditions.
  const newInbound = items.some(
    (m) => Number(m.bInbound) === 1 && !seenBefore.has(m.iMessageId)
  );
  if (newInbound && !document.hidden && seenBefore.size > 0) {
    await fetch('/api/conversations/' + customer + '/read', { method: 'POST' });
  }
  return true;
}

async function pollTick() {
  if (liveUpdatesStopped || document.hidden || pollInFlight || sending) return;
  pollInFlight = true;
  try {
    await refreshOpenThread();
    await loadConversations();
  } catch (error) {
    // A dropped connection or a 5xx is a reason to try again in 30 seconds,
    // not to put an error in front of someone who is typing.
    console.debug('[live] refresh failed, will retry', error);
  } finally {
    pollInFlight = false;
  }
}

function scheduleNextPoll() {
  clearTimeout(pollTimer);
  if (liveUpdatesStopped) return;
  const delay = pusherConnected ? POLL_INTERVAL_PUSH_MS : POLL_INTERVAL_MS;
  pollTimer = setTimeout(() => {
    pollTick().finally(scheduleNextPoll);
  }, delay);
}

/** Refresh at the next opportunity, coalescing a burst of events into one. */
function refreshNow() {
  if (liveUpdatesStopped) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    clearTimeout(pollTimer);
    pollTick().finally(scheduleNextPoll);
  }, 250);
}

function stopLiveUpdates(reason) {
  if (liveUpdatesStopped) return;
  liveUpdatesStopped = true;
  clearTimeout(pollTimer);
  clearTimeout(refreshTimer);
  if (pusherClient) {
    try { pusherClient.disconnect(); } catch (_) { /* already gone */ }
    pusherClient = null;
  }
  console.debug('[live] stopped:', reason);
}

// A background tab has nobody reading it. Stop, and catch up in one go on the
// way back rather than replaying every tick that was missed.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    return;
  }
  refreshNow();
});

/* ── Pusher (#16) ── */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(el);
  });
}

function socketLost() {
  if (!pusherConnected) return;
  pusherConnected = false;
  // Back to the 30-second floor immediately, rather than after the long
  // heartbeat that was scheduled while the socket was healthy.
  scheduleNextPoll();
}

async function startLiveSocket() {
  const key = window.ECHO_CONFIG && window.ECHO_CONFIG.PUSHER_KEY;
  // No Pusher configured is a supported deployment, not a failure: the poll
  // above is already running and is the whole feature on its own.
  if (!key) return;

  try {
    const r = await fetch('/api/me');
    if (!r.ok) return;
    const me = await r.json();
    if (!me.iBusinessNumber) return;

    await loadScript('https://js.pusher.com/8.2.0/pusher.min.js');
    if (typeof Pusher === 'undefined') return;

    pusherClient = new Pusher(key, {
      cluster: (window.ECHO_CONFIG && window.ECHO_CONFIG.PUSHER_CLUSTER) || 'mt1',
      // Signed by EchoService, which checks the session owns this business
      // number before it will authorize the channel. The browser never holds
      // a Pusher secret.
      authEndpoint: '/api/pusher/auth',
    });

    pusherClient.connection.bind('connected', () => {
      pusherConnected = true;
      scheduleNextPoll();
      console.debug('[live] socket connected; poll backed off');
    });
    for (const state of ['disconnected', 'unavailable', 'failed']) {
      pusherClient.connection.bind(state, socketLost);
    }
    pusherClient.connection.bind('error', socketLost);

    const channel = pusherClient.subscribe('private-echo-' + me.iBusinessNumber);
    channel.bind('message:new', refreshNow);
    channel.bind('message:status', refreshNow);
    channel.bind('pusher:subscription_error', (status) => {
      // Until EchoService#3 ships there is nothing to authorize against, so
      // this is the expected path. Polling carries the feature meanwhile.
      console.debug('[live] channel subscription refused, staying on poll', status);
      socketLost();
    });
  } catch (error) {
    console.debug('[live] socket unavailable, staying on poll', error);
    socketLost();
  }
}

/* ── Init ── */

setThreadHeader();
loadConversations();
loadBusinessIdentity();
scheduleNextPoll();
startLiveSocket();
