/* ── Echo Messages – client JS ── */

let currentCustomer = null;
let draftingNew = false;

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

function getInitials(num) {
  const d = String(num).replace(/\D/g, '');
  return d.slice(0, 2);
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

/* ── Panel switching (mobile) ── */

function showPanel(name) {
  const sidebar = document.getElementById('sidebar');
  const thread = document.getElementById('thread');
  if (name === 'list') {
    sidebar.classList.remove('hidden');
    sidebar.classList.add('flex');
    thread.classList.remove('flex');
    thread.classList.add('hidden');
    // On md+, Tailwind md:flex overrides
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
    avatar.classList.remove('hidden');
    avatar.classList.add('flex');
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
  setThreadHeader();
  showPanel('thread');
}

/* ── Conversation list ── */

async function loadConversations() {
  const r = await fetch('/api/conversations');
  if (!r.ok) { location.href = '/'; return; }
  const data = await r.json();
  const root = document.getElementById('conversations');
  root.innerHTML = '';

  for (const c of data.items) {
    const isActive = !draftingNew && String(c.iCustomerNumber) === String(currentCustomer);
    const isUnread = Number(c.unreadCount || 0) > 0;

    const el = document.createElement('div');
    el.className = 'flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 active:bg-slate-100 transition-colors'
      + (isActive ? ' bg-blue-50' : '')
      + (isUnread ? '' : '');
    el.onclick = () => openConversation(c.iCustomerNumber);

    // Avatar
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold flex-shrink-0'
      + (isUnread ? ' bg-blue-600 text-white' : ' bg-blue-100 text-blue-700');
    avatarDiv.textContent = getInitials(c.iCustomerNumber);

    // Content
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

    // Unread badge
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
    document.getElementById('messages').innerHTML = '<div id="emptyState" class="m-auto text-center py-12"><svg class="w-16 h-16 mx-auto text-slate-300 mb-4" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg><p class="text-slate-400 text-sm">Select a conversation to start messaging</p></div>';
    document.getElementById('compose').style.display = 'none';
    setThreadHeader();
    await loadConversations();
  }
}

document.addEventListener('click', () => {
  const dd = document.getElementById('threadMenuDropdown');
  if (dd) dd.classList.add('hidden');
});

/* ── Open conversation ── */

async function openConversation(customer, skipRead) {
  draftingNew = false;
  currentCustomer = String(customer);
  setThreadHeader();
  showPanel('thread');

  const r = await fetch('/api/conversations/' + customer + '/messages');
  const data = await r.json();
  const box = document.getElementById('messages');
  box.innerHTML = '';

  for (const m of data.items) {
    const isInbound = Number(m.bInbound) === 1;
    const wrapper = document.createElement('div');
    wrapper.className = 'flex flex-col max-w-[75%] md:max-w-[65%]'
      + (isInbound ? ' items-start self-start' : ' items-end self-end');

    const bubble = document.createElement('div');
    bubble.className = isInbound
      ? 'bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm text-slate-800 shadow-sm'
      : 'bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm shadow-sm';
    bubble.innerHTML = escapeHtml(m.text);

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

  const r = await fetch('/api/conversations/' + to + '/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: txt.value })
  });
  const data = await r.json();
  txt.value = '';
  txt.style.height = 'auto';
  await openConversation(to, true);
  await loadConversations();
  if (data && data.ok === false) {
    alert('Carrier failure: ' + (typeof data.details === 'string' ? data.details : JSON.stringify(data.details)));
  }
});

/* ── Auto-resize textarea ── */

document.getElementById('text').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 128) + 'px';
});

/* Send on Enter (Shift+Enter for newline) */
document.getElementById('text').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('compose').requestSubmit();
  }
});

/* ── Init ── */

setThreadHeader();
loadConversations();
