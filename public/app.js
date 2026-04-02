/* ── Echo Messages – client JS ── */

const MEDIA_BASE_URL = 'https://media.echo.wisp.net';
const MAX_FILE_SIZE = 3.5 * 1024 * 1024; // 3.5 MB
const MAX_FILES = 10;

let currentCustomer = null;
let draftingNew = false;
let pendingFiles = []; // Array of File objects for outbound attachments

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

function formatTime(dt) {
  if (!dt) return '';
  const d = new Date(dt);
  if (isNaN(d)) return dt;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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

function iconForEvent(e) {
  if (Number(e) === 1) return '\u{1F4E9}';
  if (Number(e) === 2) return '\u{1F553}';
  if (Number(e) === 4) return '\u2705';
  if (Number(e) === 8) return '\u274C';
  return '\u{1F4AC}';
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
    return;
  }
  if (!r.ok) { console.error('Failed to load conversations', r.status); return; }
  const data = await r.json();
  const root = document.getElementById('conversations');
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
    preview.className = 'text-sm truncate mt-0.5' + (isUnread ? ' font-semibold text-slate-700' : ' text-slate-500');
    preview.textContent = c.lastText || '';

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

  // Restore draft
  const draftKey = 'draft-' + customer;
  const draft = localStorage.getItem(draftKey);
  const txt = document.getElementById('text');
  if (draft && !skipRead) { txt.value = draft; } else if (!skipRead) { txt.value = ''; }

  const r = await fetch('/api/conversations/' + customer + '/messages');
  const data = await r.json();
  const box = document.getElementById('messages');
  box.innerHTML = '';

  for (const m of data.items) {
    const isInbound = Number(m.bInbound) === 1;
    const wrapper = document.createElement('div');
    wrapper.className = 'flex flex-col max-w-[75%] md:max-w-[65%] msg-anim'
      + (isInbound ? ' items-start self-start' : ' items-end self-end');

    const bubble = document.createElement('div');
    bubble.className = isInbound
      ? 'bg-white border border-slate-100 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm text-slate-800 shadow-sm'
      : 'bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm shadow-sm';

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
    timeEl.textContent = formatTime(m.dtCreated);

    const iconEl = document.createElement('span');
    iconEl.className = 'text-[11px]';
    iconEl.textContent = iconForEvent(m.eMessageEventTypeID);

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
    box.appendChild(wrapper);
  }

  box.scrollTop = box.scrollHeight;
  document.getElementById('compose').style.display = 'flex';

  if (!skipRead) {
    await fetch('/api/conversations/' + customer + '/read', { method: 'POST' });
    await loadConversations();
  }
}

/* ── Attachment handling ── */

function clearAttachments() {
  pendingFiles = [];
  renderAttachmentPreviews();
}

function renderAttachmentPreviews() {
  const container = document.getElementById('attachments');
  container.innerHTML = '';

  if (pendingFiles.length === 0) {
    container.classList.add('hidden');
    container.classList.remove('flex');
    return;
  }

  container.classList.remove('hidden');
  container.classList.add('flex');

  pendingFiles.forEach((file, idx) => {
    const card = document.createElement('div');
    card.className = 'relative flex-shrink-0 w-24 h-24 rounded-xl border border-slate-200 overflow-hidden bg-slate-50 group';

    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.className = 'w-full h-full object-cover';
      card.appendChild(img);
    } else if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.className = 'w-full h-full object-cover';
      video.muted = true;
      video.preload = 'metadata';
      const playIcon = document.createElement('div');
      playIcon.className = 'absolute inset-0 flex items-center justify-center bg-black/20';
      playIcon.innerHTML = '<svg class="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      card.appendChild(video);
      card.appendChild(playIcon);
    } else {
      const iconWrap = document.createElement('div');
      iconWrap.className = 'flex flex-col items-center justify-center h-full p-2';
      iconWrap.innerHTML = getFileIconSvg(file.type) + '<div class="text-[10px] text-slate-500 truncate w-full text-center mt-1">' + escapeHtml(file.name) + '</div>';
      card.appendChild(iconWrap);
    }

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'absolute top-1 right-1 w-5 h-5 rounded-full bg-black/50 text-white text-xs flex items-center justify-center hover:bg-red-500 transition-colors';
    removeBtn.textContent = '\u00D7';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      pendingFiles.splice(idx, 1);
      renderAttachmentPreviews();
    };
    card.appendChild(removeBtn);

    container.appendChild(card);
  });
}

// Attach button click
document.getElementById('btnAttach').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

// File input change
document.getElementById('fileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // Reset so same file can be re-selected

  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      alert('File "' + file.name + '" exceeds 3.5 MB limit.');
      continue;
    }
    if (pendingFiles.length >= MAX_FILES) {
      alert('Maximum ' + MAX_FILES + ' attachments per message.');
      break;
    }
    pendingFiles.push(file);
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

  let r;
  if (pendingFiles.length > 0) {
    // Multipart send with files
    const formData = new FormData();
    formData.append('text', txt.value);
    for (const file of pendingFiles) {
      formData.append('files', file);
    }
    r = await fetch('/api/conversations/' + to + '/send', {
      method: 'POST',
      body: formData
    });
  } else {
    // Text-only JSON send
    r = await fetch('/api/conversations/' + to + '/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: txt.value })
    });
  }

  const data = await r.json();
  txt.value = '';
  txt.style.height = 'auto';
  clearAttachments();
  localStorage.removeItem('draft-' + to);
  await openConversation(to, true);
  await loadConversations();
  if (data && data.ok === false) {
    alert('Carrier failure: ' + (typeof data.details === 'string' ? data.details : JSON.stringify(data.details)));
  }
});

/* ── Draft saving ── */

document.getElementById('text').addEventListener('input', function () {
  // Auto-resize
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 128) + 'px';

  // Save draft
  if (currentCustomer) {
    if (this.value.trim()) {
      localStorage.setItem('draft-' + currentCustomer, this.value);
    } else {
      localStorage.removeItem('draft-' + currentCustomer);
    }
  }
});

/* Send on Enter (Shift+Enter for newline) */
document.getElementById('text').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('compose').requestSubmit();
  }
});

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

/* ── Init ── */

setThreadHeader();
loadConversations();
loadBusinessIdentity();
