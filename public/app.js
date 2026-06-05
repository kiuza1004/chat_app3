(async function () {
  const meRes = await fetch('/api/me');
  if (!meRes.ok) { location.href = '/'; return; }
  const me = await meRes.json();
  document.getElementById('me-name').textContent = me.username;

  const socket = io({ withCredentials: true });
  let currentRoomId = null;
  let pendingAttachment = null;
  let oldestMessageId = null;
  let hasMoreOlder = false;
  let loadingOlder = false;
  const unreadCounts = new Map();
  const roomsById = new Map();
  const baseTitle = 'Simple Chat';

  let currentRoomMeta = null; // { id, name, visibility, created_by }
  const roomListEl = document.getElementById('room-list');
  const roomEmptyEl = document.getElementById('room-empty');
  const membersBtn = document.getElementById('members-btn');
  const memberModal = document.getElementById('member-modal');
  const memberListEl = document.getElementById('member-list');
  const memberCloseBtn = document.getElementById('member-close');
  const inviteRow = document.getElementById('invite-row');
  const inviteInput = document.getElementById('invite-username');
  const inviteBtn = document.getElementById('invite-btn');
  const inviteErrEl = document.getElementById('invite-error');
  const leaveBtn = document.getElementById('leave-room-btn');
  const newRoomPrivate = document.getElementById('new-room-private');
  const messagesEl = document.getElementById('messages');
  const chatEmptyEl = document.getElementById('chat-empty');
  const loadMoreBtn = document.getElementById('load-more-btn');
  const scrollDownBtn = document.getElementById('scroll-down-btn');
  const msgInput = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const fileBtn = document.getElementById('file-btn');
  const fileInput = document.getElementById('file-input');
  const attachPreview = document.getElementById('attachment-preview');
  const attachName = document.getElementById('attachment-name');
  const attachCancel = document.getElementById('attachment-cancel');
  const roomNameEl = document.getElementById('room-name');
  const typingIndicatorEl = document.getElementById('typing-indicator');
  const appEl = document.getElementById('app');

  const openSidebar = () => appEl.classList.add('show-sidebar');
  const closeSidebar = () => appEl.classList.remove('show-sidebar');
  document.getElementById('open-sidebar').addEventListener('click', openSidebar);
  document.getElementById('close-sidebar').addEventListener('click', closeSidebar);
  document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);

  // Notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDateLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(d, today)) return '오늘';
    if (sameDay(d, yest)) return '어제';
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function avatarColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 55%, 50%)`;
  }

  function buildAvatar(username) {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = avatarColor(username);
    av.textContent = (username[0] || '?').toUpperCase();
    return av;
  }

  function updateTitleBadge() {
    let total = 0;
    for (const n of unreadCounts.values()) total += n;
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${baseTitle}` : baseTitle;
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  function buildMessageEl(m) {
    const li = document.createElement('li');
    li.className = 'msg with-avatar' + (m.user_id === me.id ? ' me' : '') + (m.deleted ? ' deleted' : '');
    li.dataset.messageId = m.id;
    li.dataset.userId = m.user_id;
    li.dataset.day = dayKey(m.created_at);

    li.appendChild(buildAvatar(m.username || '?'));

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${m.username} · ${fmtTime(m.created_at)}`;
    meta.appendChild(nameSpan);
    if (m.edited_at && !m.deleted) {
      const ed = document.createElement('span');
      ed.className = 'edited-tag';
      ed.textContent = '(수정됨)';
      meta.appendChild(ed);
    }
    bubble.appendChild(meta);

    if (m.deleted) {
      const body = document.createElement('div');
      body.textContent = '삭제된 메시지입니다';
      bubble.appendChild(body);
    } else {
      if (m.content) {
        const body = document.createElement('div');
        body.className = 'body';
        body.textContent = m.content;
        bubble.appendChild(body);
      }
      if (m.attachment) {
        if (m.attachment.kind === 'image') {
          const img = document.createElement('img');
          img.className = 'msg-image';
          img.src = m.attachment.url;
          img.alt = m.attachment.name || 'image';
          img.loading = 'lazy';
          img.addEventListener('click', () => window.open(m.attachment.url, '_blank'));
          bubble.appendChild(img);
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
          bubble.appendChild(a);
        }
      }
    }

    if (m.user_id === me.id && !m.deleted) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      const editBtn = document.createElement('button');
      editBtn.textContent = '수정';
      editBtn.addEventListener('click', () => {
        const cur = m.content || '';
        const next = prompt('메시지 수정', cur);
        if (next == null) return;
        const trimmed = next.trim();
        if (!trimmed || trimmed === cur) return;
        socket.emit('edit_message', { id: m.id, content: trimmed });
      });
      const delBtn = document.createElement('button');
      delBtn.textContent = '삭제';
      delBtn.addEventListener('click', () => {
        if (!confirm('이 메시지를 삭제할까요?')) return;
        socket.emit('delete_message', { id: m.id });
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      bubble.appendChild(actions);
    }

    li.appendChild(bubble);
    return li;
  }

  function buildDateSep(ts) {
    const sep = document.createElement('li');
    sep.className = 'date-sep';
    sep.dataset.day = dayKey(ts);
    sep.textContent = fmtDateLabel(ts);
    return sep;
  }

  function lastDayInList() {
    for (let i = messagesEl.children.length - 1; i >= 0; i--) {
      const el = messagesEl.children[i];
      if (el.dataset.day) return el.dataset.day;
    }
    return null;
  }

  function firstDayInList() {
    for (let i = 0; i < messagesEl.children.length; i++) {
      const el = messagesEl.children[i];
      if (el.dataset.day) return el.dataset.day;
    }
    return null;
  }

  function appendMessage(m) {
    const wasAtBottom = nearBottom();
    const lastDay = lastDayInList();
    const curDay = dayKey(m.created_at);
    if (lastDay !== curDay) messagesEl.appendChild(buildDateSep(m.created_at));
    messagesEl.appendChild(buildMessageEl(m));
    if (oldestMessageId == null || m.id < oldestMessageId) oldestMessageId = m.id;

    if (wasAtBottom || m.user_id === me.id) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      scrollDownBtn.hidden = true;
    } else {
      scrollDownBtn.hidden = false;
    }
  }

  function prependHistory(messages) {
    if (!messages.length) return;
    const prevScrollHeight = messagesEl.scrollHeight;
    const prevScrollTop = messagesEl.scrollTop;
    const existingFirstDay = firstDayInList();

    const frag = document.createDocumentFragment();
    let lastDay = null;
    messages.forEach((m) => {
      const d = dayKey(m.created_at);
      if (d !== lastDay) frag.appendChild(buildDateSep(m.created_at));
      frag.appendChild(buildMessageEl(m));
      lastDay = d;
    });

    if (existingFirstDay && lastDay === existingFirstDay) {
      const firstEl = messagesEl.firstChild;
      if (firstEl && firstEl.classList && firstEl.classList.contains('date-sep')) {
        messagesEl.removeChild(firstEl);
      }
    }
    messagesEl.insertBefore(frag, messagesEl.firstChild);

    if (messages.length) {
      const minId = messages[0].id;
      if (oldestMessageId == null || minId < oldestMessageId) oldestMessageId = minId;
    }
    messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
  }

  function renderBadges() {
    document.querySelectorAll('#room-list li').forEach((el) => {
      const id = parseInt(el.dataset.roomId, 10);
      const count = unreadCounts.get(id) || 0;
      let badge = el.querySelector('.badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'badge';
          el.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : String(count);
      } else if (badge) {
        badge.remove();
      }
    });
    updateTitleBadge();
  }

  function renderRoomEmpty() {
    roomEmptyEl.hidden = roomListEl.children.length > 0;
  }

  async function loadRooms() {
    const res = await fetch('/api/rooms');
    if (!res.ok) return;
    const rooms = await res.json();
    roomListEl.innerHTML = '';
    rooms.forEach((r) => {
      unreadCounts.set(r.id, r.unread_count || 0);
      roomsById.set(r.id, r);
      roomListEl.appendChild(buildRoomLi(r));
    });
    renderBadges();
    renderRoomEmpty();
  }

  function buildRoomLi(r) {
    const li = document.createElement('li');
    li.dataset.roomId = r.id;
    if (r.id === currentRoomId) li.classList.add('active');
    const info = document.createElement('div');
    info.className = 'room-info';
    const name = document.createElement('div');
    name.textContent = r.name;
    if (r.visibility === 'private') {
      const lock = document.createElement('span');
      lock.className = 'room-lock';
      lock.textContent = '🔒';
      lock.title = '비공개방';
      name.appendChild(lock);
    }
    const sub = document.createElement('small');
    sub.textContent = `by ${r.created_by_name}`;
    info.appendChild(name);
    info.appendChild(sub);
    li.appendChild(info);
    li.addEventListener('click', () => joinRoom(r.id, r.name, r));
    return li;
  }

  async function joinRoom(id, name, meta) {
    currentRoomId = id;
    currentRoomMeta = meta || roomsById.get(id) || { id, name, visibility: 'public' };
    roomNameEl.textContent = name;
    membersBtn.hidden = currentRoomMeta.visibility !== 'private';
    messagesEl.innerHTML = '';
    oldestMessageId = null;
    hasMoreOlder = false;
    loadMoreBtn.hidden = true;
    scrollDownBtn.hidden = true;
    chatEmptyEl.hidden = true;
    typingIndicatorEl.textContent = '';
    clearAttachment();
    unreadCounts.set(id, 0);
    document.querySelectorAll('#room-list li').forEach((el) => {
      el.classList.toggle('active', parseInt(el.dataset.roomId, 10) === id);
    });
    renderBadges();

    const res = await fetch(`/api/rooms/${id}/messages`);
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.messages;
      hasMoreOlder = data.has_more === true;
      list.forEach((m) => {
        const last = lastDayInList();
        const cur = dayKey(m.created_at);
        if (last !== cur) messagesEl.appendChild(buildDateSep(m.created_at));
        messagesEl.appendChild(buildMessageEl(m));
        if (oldestMessageId == null || m.id < oldestMessageId) oldestMessageId = m.id;
      });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      loadMoreBtn.hidden = !hasMoreOlder;
    }

    socket.emit('join', id);
    msgInput.disabled = false;
    sendBtn.disabled = false;
    fileBtn.disabled = false;
    closeSidebar();
  }

  function closeMemberModal() {
    memberModal.hidden = true;
    inviteErrEl.textContent = '';
    inviteInput.value = '';
  }

  async function openMemberModal() {
    if (!currentRoomMeta || currentRoomMeta.visibility !== 'private') return;
    memberModal.hidden = false;
    memberListEl.innerHTML = '';
    inviteErrEl.textContent = '';
    inviteRow.hidden = true;
    leaveBtn.hidden = true;
    try {
      const res = await fetch(`/api/rooms/${currentRoomId}/members`);
      if (!res.ok) { inviteErrEl.textContent = '멤버 목록을 불러올 수 없습니다'; return; }
      const members = await res.json();
      const myRole = (members.find((m) => m.user_id === me.id) || {}).role;
      inviteRow.hidden = myRole !== 'admin';
      leaveBtn.hidden = !myRole || myRole === 'admin';
      renderMembers(members, myRole);
    } catch {
      inviteErrEl.textContent = '네트워크 오류';
    }
  }

  function renderMembers(members, myRole) {
    memberListEl.innerHTML = '';
    members.forEach((m) => {
      const li = document.createElement('li');
      const av = document.createElement('div');
      av.className = 'avatar';
      av.style.background = avatarColor(m.username);
      av.textContent = (m.username[0] || '?').toUpperCase();
      li.appendChild(av);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = m.username + (m.user_id === me.id ? ' (나)' : '');
      li.appendChild(name);

      if (m.role === 'admin') {
        const tag = document.createElement('span');
        tag.className = 'role-tag';
        tag.textContent = '관리자';
        li.appendChild(tag);
      }

      if (myRole === 'admin' && m.role !== 'admin' && m.user_id !== me.id) {
        const btn = document.createElement('button');
        btn.className = 'kick';
        btn.textContent = '강퇴';
        btn.addEventListener('click', () => kickMember(m.user_id, m.username));
        li.appendChild(btn);
      }

      memberListEl.appendChild(li);
    });
  }

  async function kickMember(userId, username) {
    if (!confirm(`${username} 님을 강퇴할까요?`)) return;
    const res = await fetch(`/api/rooms/${currentRoomId}/members/${userId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      inviteErrEl.textContent = data.error || '강퇴 실패';
      return;
    }
    openMemberModal();
  }

  async function inviteUser() {
    const username = inviteInput.value.trim();
    if (!username) return;
    inviteErrEl.textContent = '';
    inviteBtn.disabled = true;
    try {
      const res = await fetch(`/api/rooms/${currentRoomId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!res.ok) { inviteErrEl.textContent = data.error || '초대 실패'; return; }
      inviteInput.value = '';
      openMemberModal();
    } finally {
      inviteBtn.disabled = false;
    }
  }

  async function leaveRoom() {
    if (!currentRoomMeta || currentRoomMeta.visibility !== 'private') return;
    if (!confirm('방에서 나갈까요?')) return;
    const res = await fetch(`/api/rooms/${currentRoomId}/members/${me.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || '나가기 실패');
      return;
    }
    closeMemberModal();
  }

  membersBtn.addEventListener('click', openMemberModal);
  memberCloseBtn.addEventListener('click', closeMemberModal);
  memberModal.querySelector('.modal-backdrop').addEventListener('click', closeMemberModal);
  inviteBtn.addEventListener('click', inviteUser);
  inviteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inviteUser(); } });
  leaveBtn.addEventListener('click', leaveRoom);

  loadMoreBtn.addEventListener('click', async () => {
    if (loadingOlder || !currentRoomId || oldestMessageId == null) return;
    loadingOlder = true;
    loadMoreBtn.disabled = true;
    const prevText = loadMoreBtn.textContent;
    loadMoreBtn.textContent = '불러오는 중…';
    try {
      const res = await fetch(`/api/rooms/${currentRoomId}/messages?before=${oldestMessageId}`);
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.messages;
        prependHistory(list);
        hasMoreOlder = data.has_more === true;
        loadMoreBtn.hidden = !hasMoreOlder;
      }
    } finally {
      loadingOlder = false;
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = prevText;
    }
  });

  messagesEl.addEventListener('scroll', () => {
    if (nearBottom()) scrollDownBtn.hidden = true;
  });
  scrollDownBtn.addEventListener('click', () => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    scrollDownBtn.hidden = true;
  });

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
    const visibility = newRoomPrivate.checked ? 'private' : 'public';
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, visibility }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '방 생성 실패'); return; }
    input.value = '';
    newRoomPrivate.checked = false;
    await loadRooms();
    joinRoom(data.id, data.name, roomsById.get(data.id));
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
    socket.emit('stop_typing');
    lastTypingEmit = 0;
    msgInput.value = '';
    clearAttachment();
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/';
  });

  socket.on('message', (m) => {
    appendMessage(m);
    if (m.user_id !== me.id && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(`${m.username} (${roomNameEl.textContent})`, {
          body: m.content || (m.attachment ? '📎 첨부파일' : ''),
          tag: `room-${currentRoomId}`,
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch {}
    }
  });
  socket.on('error_msg', (m) => alert(m));
  socket.on('room_activity', ({ roomId, fromUserId }) => {
    if (fromUserId === me.id) return;
    if (roomId === currentRoomId) return;
    unreadCounts.set(roomId, (unreadCounts.get(roomId) || 0) + 1);
    renderBadges();
  });

  socket.on('message_updated', ({ id, content, edited_at }) => {
    const li = messagesEl.querySelector(`li[data-message-id="${id}"]`);
    if (!li) return;
    const body = li.querySelector('.body');
    if (body) body.textContent = content;
    else {
      const newBody = document.createElement('div');
      newBody.className = 'body';
      newBody.textContent = content;
      li.querySelector('.bubble').appendChild(newBody);
    }
    let tag = li.querySelector('.edited-tag');
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'edited-tag';
      tag.textContent = '(수정됨)';
      li.querySelector('.meta').appendChild(tag);
    }
  });

  socket.on('message_deleted', ({ id }) => {
    const li = messagesEl.querySelector(`li[data-message-id="${id}"]`);
    if (!li) return;
    li.classList.add('deleted');
    const bubble = li.querySelector('.bubble');
    if (bubble) {
      bubble.querySelectorAll('.body, .msg-image, .msg-file, .msg-actions, .edited-tag').forEach((n) => n.remove());
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = '삭제된 메시지입니다';
      bubble.appendChild(body);
    }
  });

  let lastTypingEmit = 0;
  msgInput.addEventListener('input', () => {
    if (!currentRoomId) return;
    const now = Date.now();
    if (now - lastTypingEmit < 2000) return;
    lastTypingEmit = now;
    socket.emit('typing');
  });

  socket.on('typing_update', (users) => {
    const others = users.filter((u) => u.id !== me.id);
    if (others.length === 0) { typingIndicatorEl.textContent = ''; return; }
    const names = others.map((u) => u.username);
    const prefix = names.length === 1
      ? `${names[0]} 님이 입력 중`
      : names.length === 2
        ? `${names[0]}, ${names[1]} 님이 입력 중`
        : `${names[0]} 외 ${names.length - 1}명이 입력 중`;
    typingIndicatorEl.innerHTML = '';
    typingIndicatorEl.appendChild(document.createTextNode(prefix));
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '.';
      typingIndicatorEl.appendChild(dot);
    }
  });

  socket.on('room_created', (room) => {
    roomsById.set(room.id, room);
    if (document.querySelector(`#room-list li[data-room-id="${room.id}"]`)) return;
    if (room.created_by !== me.id) unreadCounts.set(room.id, 0);
    roomListEl.prepend(buildRoomLi(room));
    renderRoomEmpty();
  });

  socket.on('member_added', ({ room_id }) => {
    if (!memberModal.hidden && room_id === currentRoomId) openMemberModal();
  });
  socket.on('member_removed', ({ room_id }) => {
    if (!memberModal.hidden && room_id === currentRoomId) openMemberModal();
  });

  socket.on('room_added', (room) => {
    roomsById.set(room.id, room);
    if (document.querySelector(`#room-list li[data-room-id="${room.id}"]`)) return;
    unreadCounts.set(room.id, 0);
    roomListEl.prepend(buildRoomLi(room));
    renderRoomEmpty();
  });

  socket.on('room_removed', ({ room_id, kicked }) => {
    roomsById.delete(room_id);
    unreadCounts.delete(room_id);
    const li = roomListEl.querySelector(`li[data-room-id="${room_id}"]`);
    if (li) li.remove();
    renderBadges();
    renderRoomEmpty();
    if (currentRoomId === room_id) {
      currentRoomId = null;
      currentRoomMeta = null;
      roomNameEl.textContent = '채팅방을 선택하세요';
      messagesEl.innerHTML = '';
      chatEmptyEl.hidden = false;
      membersBtn.hidden = true;
      msgInput.disabled = true;
      sendBtn.disabled = true;
      fileBtn.disabled = true;
      closeMemberModal();
      if (kicked) alert('방에서 강퇴되었습니다');
    }
  });

  const presenceListEl = document.getElementById('presence-list');
  const presenceCountEl = document.getElementById('presence-count');
  socket.on('presence', (users) => {
    presenceCountEl.textContent = users.length;
    presenceListEl.innerHTML = '';
    users
      .slice()
      .sort((a, b) => {
        if (a.id === me.id) return -1;
        if (b.id === me.id) return 1;
        return a.username.localeCompare(b.username);
      })
      .forEach((u) => {
        const li = document.createElement('li');
        if (u.id === me.id) li.classList.add('me');
        li.textContent = u.username + (u.id === me.id ? ' (나)' : '');
        presenceListEl.appendChild(li);
      });
  });

  window.addEventListener('focus', () => {
    if (currentRoomId) {
      unreadCounts.set(currentRoomId, 0);
      renderBadges();
    }
  });

  await loadRooms();
})();
