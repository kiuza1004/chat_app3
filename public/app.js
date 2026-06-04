(async function () {
  const meRes = await fetch('/api/me');
  if (!meRes.ok) { location.href = '/'; return; }
  const me = await meRes.json();
  document.getElementById('me-name').textContent = me.username;

  const socket = io({ withCredentials: true });
  let currentRoomId = null;

  const roomListEl = document.getElementById('room-list');
  const messagesEl = document.getElementById('messages');
  const msgInput = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
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

  function appendMessage(m) {
    const li = document.createElement('li');
    li.className = 'msg' + (m.username === me.username ? ' me' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${m.username} · ${fmtTime(m.created_at)}`;
    const body = document.createElement('div');
    body.textContent = m.content;
    li.appendChild(meta);
    li.appendChild(body);
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
    closeSidebar();
  }

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
    if (!text || !currentRoomId) return;
    socket.emit('message', text);
    msgInput.value = '';
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/';
  });

  socket.on('message', appendMessage);
  socket.on('error_msg', (m) => alert(m));

  await loadRooms();
})();
