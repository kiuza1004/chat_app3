(async function () {
  const meRes = await fetch('/api/me');
  if (!meRes.ok) { location.href = '/'; return; }
  const me = await meRes.json();
  document.getElementById('me-name').textContent = me.username;

  const socket = io({ withCredentials: true });
  let currentRoomId = null;
  let pendingAttachment = null;

  const roomListEl = document.getElementById('room-list');
  const messagesEl = document.getElementById('messages');
  const msgInput = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const fileBtn = document.getElementById('file-btn');
  const fileInput = document.getElementById('file-input');
  const attachPreview = document.getElementById('attachment-preview');
  const attachName = document.getElementById('attachment-name');
  const attachCancel = document.getElementById('attachment-cancel');
  const roomNameEl = document.getElementById('room-name');
  const appEl = document.getElementById('app');

  const openSidebar = () => appEl.classList.add('show-sidebar');
  const closeSidebar = () => appEl.classList.remove('show-sidebar');
  document.getElementById('open-sidebar').addEventListener('click', openSidebar);
  document.getElementById('close-sidebar').addEventListener('click', closeSidebar);
  document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function appendMessage(m) {
    const li = document.createElement('li');
    li.className = 'msg' + (m.username === me.username ? ' me' : '');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${m.username} · ${fmtTime(m.created_at)}`;
    li.appendChild(meta);

    if (m.content) {
      const body = document.createElement('div');
      body.textContent = m.content;
      li.appendChild(body);
    }

    if (m.attachment) {
      if (m.attachment.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = m.attachment.url;
        img.alt = m.attachment.name || 'image';
        img.loading = 'lazy';
        img.addEventListener('click', () => window.open(m.attachment.url, '_blank'));
        li.appendChild(img);
      } else {
        const a = document.createElement('a');
        a.className = 'msg-file';
        a.href = m.attachment.url;
        a.download = m.attachment.name || '';
        a.target = '_blank';
        a.rel = 'noopener';

        const icon = document.createElement('span');
        icon.className = 'msg-file-icon';
        icon.textContent = '📄';

        const metaWrap = document.createElement('span');
        metaWrap.className = 'msg-file-meta';
        const nameEl = document.createElement('span');
        nameEl.className = 'msg-file-name';
        nameEl.textContent = m.attachment.name || 'file';
        const sizeEl = document.createElement('span');
        sizeEl.className = 'msg-file-size';
        sizeEl.textContent = fmtSize(m.attachment.size || 0);
        metaWrap.appendChild(nameEl);
        metaWrap.appendChild(sizeEl);

        a.appendChild(icon);
        a.appendChild(metaWrap);
        li.appendChild(a);
      }
    }

    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function loadRooms() {
    const res = await fetch('/api/rooms');
    if (!res.ok) return;
    const rooms = await res.json();
    roomListEl.innerHTML = '';
    rooms.forEach((r) => {
      const li = document.createElement('li');
      li.dataset.roomId = r.id;
      if (r.id === currentRoomId) li.classList.add('active');
      const name = document.createElement('div');
      name.textContent = r.name;
      const sub = document.createElement('small');
      sub.textContent = `by ${r.created_by_name}`;
      li.appendChild(name);
      li.appendChild(sub);
      li.addEventListener('click', () => joinRoom(r.id, r.name));
      roomListEl.appendChild(li);
    });
  }

  async function joinRoom(id, name) {
    currentRoomId = id;
    roomNameEl.textContent = name;
    messagesEl.innerHTML = '';
    clearAttachment();
    document.querySelectorAll('#room-list li').forEach((el) => {
      el.classList.toggle('active', parseInt(el.dataset.roomId, 10) === id);
    });

    const res = await fetch(`/api/rooms/${id}/messages`);
    if (res.ok) {
      const history = await res.json();
      history.forEach(appendMessage);
    }

    socket.emit('join', id);
    msgInput.disabled = false;
    sendBtn.disabled = false;
    fileBtn.disabled = false;
    closeSidebar();
  }

  function clearAttachment() {
    pendingAttachment = null;
    attachPreview.hidden = true;
    attachName.textContent = '';
    fileInput.value = '';
  }

  fileBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      alert('파일이 너무 큽니다 (최대 10MB)');
      fileInput.value = '';
      return;
    }

    fileBtn.disabled = true;
    attachPreview.hidden = false;
    attachName.textContent = `업로드 중… ${file.name}`;

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '업로드 실패');

      pendingAttachment = data;
      attachName.textContent = `📎 ${data.name} (${fmtSize(data.size)})`;
    } catch (err) {
      alert(err.message);
      clearAttachment();
    } finally {
      fileBtn.disabled = false;
    }
  });

  attachCancel.addEventListener('click', clearAttachment);

  document.getElementById('create-room').addEventListener('click', async () => {
    const input = document.getElementById('new-room');
    const name = input.value.trim();
    if (!name) return;
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '방 생성 실패'); return; }
    input.value = '';
    await loadRooms();
    joinRoom(data.id, data.name);
  });

  document.getElementById('new-room').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('create-room').click(); }
  });

  document.getElementById('send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!currentRoomId) return;
    if (!text && !pendingAttachment) return;

    socket.emit('message', { content: text, attachment: pendingAttachment });
    msgInput.value = '';
    clearAttachment();
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/';
  });

  socket.on('message', appendMessage);
  socket.on('error_msg', (m) => alert(m));

  await loadRooms();
})();
