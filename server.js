const express = require('express');
const session = require('express-session');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-prod';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).replace(/[^.\w]/g, '');
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
});

app.set('trust proxy', 1);
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요' },
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '업로드 요청이 너무 많습니다. 잠시 후 다시 시도하세요' },
});

io.engine.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/api/signup', authLimiter, (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '아이디는 2~20자' });
  if (!/^[\w가-힣.\-]+$/.test(username)) return res.status(400).json({ error: '아이디는 영문/숫자/한글/_/-/. 만 가능' });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상' });

  if (db.findUserByName(username)) return res.status(409).json({ error: '이미 존재하는 아이디입니다' });

  const hash = bcrypt.hashSync(password, 10);
  const user = db.createUser(username, hash);

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, username: user.username });
});

app.post('/api/login', authLimiter, (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });

  const user = db.findUserByName(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, username: user.username });
});

const startedAt = Date.now();
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
    online_users: onlineUsers.size,
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: req.session.userId, username: req.session.username });
});

app.get('/api/rooms', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const rooms = db.listRoomsForUser(userId);
  rooms.forEach((r) => { r.unread_count = db.countUnread(userId, r.id); });
  res.json(rooms);
});

app.post('/api/rooms', requireAuth, (req, res) => {
  const { name, visibility } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '방 이름을 입력하세요' });
  const trimmed = name.trim().slice(0, 40);
  const vis = visibility === 'private' ? 'private' : 'public';

  if (db.findRoomByName(trimmed)) return res.status(409).json({ error: '이미 존재하는 방 이름입니다' });

  const room = db.createRoom(trimmed, req.session.userId, vis);
  const payload = {
    id: room.id,
    name: room.name,
    visibility: room.visibility,
    created_by: room.created_by,
    created_by_name: req.session.username,
    created_at: room.created_at,
  };
  if (vis === 'public') {
    io.emit('room_created', payload);
  } else {
    io.to(`user:${req.session.userId}`).emit('room_created', payload);
  }
  res.json({ id: room.id, name: room.name, visibility: room.visibility });
});

function canAccessRoom(room, userId) {
  if (!room) return false;
  if (room.visibility !== 'private') return true;
  return db.isMember(room.id, userId);
}

app.get('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'invalid room id' });
  const room = db.findRoomById(roomId);
  if (!canAccessRoom(room, req.session.userId)) return res.status(404).json({ error: '방을 찾을 수 없습니다' });
  const beforeId = req.query.before ? parseInt(req.query.before, 10) : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const messages = db.listMessages(roomId, { beforeId, limit });
  const hasMore = messages.length > 0 ? db.hasOlderMessages(roomId, messages[0].id) : false;
  res.json({ messages, has_more: hasMore });
});

app.get('/api/rooms/:id/members', requireAuth, (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'invalid room id' });
  const room = db.findRoomById(roomId);
  if (!room || room.visibility !== 'private') return res.status(404).json({ error: '비공개방이 아닙니다' });
  if (!db.isMember(roomId, req.session.userId)) return res.status(403).json({ error: '권한이 없습니다' });
  res.json(db.listMembers(roomId));
});

app.post('/api/rooms/:id/invite', requireAuth, (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'invalid room id' });
  const room = db.findRoomById(roomId);
  if (!room || room.visibility !== 'private') return res.status(404).json({ error: '비공개방이 아닙니다' });
  const me = db.getMember(roomId, req.session.userId);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: '관리자만 초대할 수 있습니다' });

  const username = String((req.body && req.body.username) || '').trim();
  if (!username) return res.status(400).json({ error: '아이디를 입력하세요' });
  const target = db.findUserByName(username);
  if (!target) return res.status(404).json({ error: '존재하지 않는 사용자입니다' });

  const result = db.addMember(roomId, target.id);
  if (result.error) return res.status(409).json({ error: result.error });

  io.to(`user:${target.id}`).emit('room_added', {
    id: room.id,
    name: room.name,
    visibility: room.visibility,
    created_by: room.created_by,
    created_by_name: db.findUserById(room.created_by)?.username || 'unknown',
    created_at: room.created_at,
  });
  io.to(`room:${roomId}`).emit('member_added', {
    room_id: roomId,
    user_id: target.id,
    username: target.username,
    role: 'member',
  });
  res.json({ user_id: target.id, username: target.username, role: 'member' });
});

app.delete('/api/rooms/:id/members/:userId', requireAuth, (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  const targetId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(roomId) || !Number.isInteger(targetId)) return res.status(400).json({ error: 'invalid id' });
  const room = db.findRoomById(roomId);
  if (!room || room.visibility !== 'private') return res.status(404).json({ error: '비공개방이 아닙니다' });

  const me = db.getMember(roomId, req.session.userId);
  if (!me) return res.status(403).json({ error: '멤버가 아닙니다' });
  const isSelf = targetId === req.session.userId;
  if (!isSelf && me.role !== 'admin') return res.status(403).json({ error: '관리자만 강퇴할 수 있습니다' });

  const target = db.getMember(roomId, targetId);
  if (!target) return res.status(404).json({ error: '해당 멤버가 없습니다' });
  if (target.role === 'admin' && !isSelf) return res.status(400).json({ error: '관리자는 강퇴할 수 없습니다' });

  db.removeMember(roomId, targetId);
  io.to(`user:${targetId}`).emit('room_removed', { room_id: roomId, kicked: !isSelf });
  io.in(`user:${targetId}`).socketsLeave(`room:${roomId}`);
  io.to(`room:${roomId}`).emit('member_removed', { room_id: roomId, user_id: targetId });
  res.json({ ok: true });
});

app.post('/api/upload', requireAuth, uploadLimiter, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '파일이 너무 큽니다 (최대 10MB)' });
      return res.status(400).json({ error: err.message || '업로드 실패' });
    }
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' });

    const mime = req.file.mimetype || 'application/octet-stream';
    const isImage = mime.startsWith('image/');
    res.json({
      kind: isImage ? 'image' : 'file',
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      size: req.file.size,
      mime,
    });
  });
});

const onlineUsers = new Map();
const getOnlineList = () => [...onlineUsers.values()].map((u) => ({ id: u.id, username: u.username }));

const typingState = new Map();
const typingKey = (roomId, userId) => `${roomId}:${userId}`;
function removeTyping(roomId, userId) {
  const entry = typingState.get(typingKey(roomId, userId));
  if (!entry) return false;
  clearTimeout(entry.timer);
  typingState.delete(typingKey(roomId, userId));
  return true;
}
function broadcastTyping(roomId) {
  const list = [];
  for (const v of typingState.values()) if (v.roomId === roomId) list.push({ id: v.userId, username: v.username });
  io.to(`room:${roomId}`).emit('typing_update', list);
}

io.on('connection', (socket) => {
  const sess = socket.request.session;
  if (!sess || !sess.userId) {
    socket.disconnect(true);
    return;
  }

  const userId = sess.userId;
  const username = sess.username;
  let currentRoom = null;
  const recentMsgTimes = [];

  socket.join(`user:${userId}`);

  const wasOffline = !onlineUsers.has(userId);
  const entry = onlineUsers.get(userId) || { id: userId, username, count: 0 };
  entry.count++;
  onlineUsers.set(userId, entry);
  socket.emit('presence', getOnlineList());
  if (wasOffline) socket.broadcast.emit('presence', getOnlineList());

  socket.on('join', (roomId) => {
    const id = parseInt(roomId, 10);
    if (!Number.isInteger(id)) return;

    const room = db.findRoomById(id);
    if (!room) return socket.emit('error_msg', '존재하지 않는 방입니다');
    if (room.visibility === 'private' && !db.isMember(id, userId)) {
      return socket.emit('error_msg', '입장 권한이 없습니다');
    }

    if (currentRoom) {
      db.markRoomRead(userId, currentRoom);
      if (removeTyping(currentRoom, userId)) broadcastTyping(currentRoom);
      socket.leave(`room:${currentRoom}`);
    }
    currentRoom = id;
    socket.join(`room:${id}`);
    db.markRoomRead(userId, id);
    socket.emit('joined', { roomId: id, name: room.name });
  });

  socket.on('typing', () => {
    if (!currentRoom) return;
    const key = typingKey(currentRoom, userId);
    const existing = typingState.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      if (removeTyping(currentRoom, userId)) broadcastTyping(currentRoom);
    }, 4000);
    typingState.set(key, { roomId: currentRoom, userId, username, timer });
    broadcastTyping(currentRoom);
  });

  socket.on('stop_typing', () => {
    if (!currentRoom) return;
    if (removeTyping(currentRoom, userId)) broadcastTyping(currentRoom);
  });

  socket.on('message', (payload) => {
    if (!currentRoom) return;

    const now = Date.now();
    while (recentMsgTimes.length && now - recentMsgTimes[0] > 10000) recentMsgTimes.shift();
    if (recentMsgTimes.length >= 20) {
      socket.emit('error_msg', '메시지 전송 속도 제한 (10초당 20개)');
      return;
    }
    recentMsgTimes.push(now);

    if (removeTyping(currentRoom, userId)) broadcastTyping(currentRoom);

    let text = '';
    let attachment = null;

    if (typeof payload === 'string') {
      text = payload.trim().slice(0, 1000);
    } else if (payload && typeof payload === 'object') {
      if (typeof payload.content === 'string') text = payload.content.trim().slice(0, 1000);
      if (payload.attachment && typeof payload.attachment === 'object') {
        const a = payload.attachment;
        if (typeof a.url === 'string' && a.url.startsWith('/uploads/')) {
          attachment = {
            kind: a.kind === 'image' ? 'image' : 'file',
            url: a.url,
            name: String(a.name || 'file').slice(0, 200),
            size: Number.isFinite(a.size) ? a.size : 0,
            mime: String(a.mime || '').slice(0, 100),
          };
        }
      }
    }
    if (!text && !attachment) return;

    const msg = db.createMessage(currentRoom, userId, username, text, attachment);
    io.to(`room:${currentRoom}`).emit('message', {
      id: msg.id,
      user_id: msg.user_id,
      username: msg.username,
      content: msg.content,
      type: msg.type,
      attachment: msg.attachment,
      created_at: msg.created_at,
    });
    io.emit('room_activity', { roomId: currentRoom, fromUserId: userId });
  });

  socket.on('edit_message', ({ id, content } = {}) => {
    if (!currentRoom) return;
    const messageId = parseInt(id, 10);
    if (!Number.isInteger(messageId)) return;
    const text = typeof content === 'string' ? content.trim().slice(0, 1000) : '';
    if (!text) return socket.emit('error_msg', '내용이 비어있습니다');

    const result = db.updateMessage(messageId, userId, text);
    if (result.error) return socket.emit('error_msg', result.error);
    io.to(`room:${currentRoom}`).emit('message_updated', {
      id: result.message.id,
      content: result.message.content,
      edited_at: result.message.edited_at,
    });
  });

  socket.on('delete_message', ({ id } = {}) => {
    if (!currentRoom) return;
    const messageId = parseInt(id, 10);
    if (!Number.isInteger(messageId)) return;

    const result = db.deleteMessage(messageId, userId);
    if (result.error) return socket.emit('error_msg', result.error);
    io.to(`room:${currentRoom}`).emit('message_deleted', { id: result.message.id });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      db.markRoomRead(userId, currentRoom);
      if (removeTyping(currentRoom, userId)) broadcastTyping(currentRoom);
    }
    const e = onlineUsers.get(userId);
    if (!e) return;
    e.count--;
    if (e.count <= 0) {
      onlineUsers.delete(userId);
      io.emit('presence', getOnlineList());
    }
  });
});

// Daily backup of chat-data.json (keeps 7 most recent)
function runBackup() {
  try {
    if (!fs.existsSync(db.DB_PATH)) return;
    if (!fs.existsSync(db.BACKUP_DIR)) fs.mkdirSync(db.BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dest = path.join(db.BACKUP_DIR, `chat-data-${stamp}.json`);
    fs.copyFileSync(db.DB_PATH, dest);

    const files = fs.readdirSync(db.BACKUP_DIR)
      .filter((f) => /^chat-data-\d{8}\.json$/.test(f))
      .sort();
    while (files.length > 7) {
      fs.unlinkSync(path.join(db.BACKUP_DIR, files.shift()));
    }
    console.log(`Backup written: ${dest}`);
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}
setInterval(runBackup, 24 * 60 * 60 * 1000);
setTimeout(runBackup, 30 * 1000);

server.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
});
