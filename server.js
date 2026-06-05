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
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '아이디는 2~20자' });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상' });

  if (db.findUserByName(username)) return res.status(409).json({ error: '이미 존재하는 아이디입니다' });

  const hash = bcrypt.hashSync(password, 10);
  const user = db.createUser(username, hash);

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, username: user.username });
});

app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });

  const user = db.findUserByName(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ id: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  res.json({ id: req.session.userId, username: req.session.username });
});

app.get('/api/rooms', requireAuth, (req, res) => {
  const rooms = db.listRooms();
  const userId = req.session.userId;
  rooms.forEach((r) => { r.unread_count = db.countUnread(userId, r.id); });
  res.json(rooms);
});

app.post('/api/rooms', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '방 이름을 입력하세요' });
  const trimmed = name.trim().slice(0, 40);

  if (db.findRoomByName(trimmed)) return res.status(409).json({ error: '이미 존재하는 방 이름입니다' });

  const room = db.createRoom(trimmed, req.session.userId);
  io.emit('room_created', {
    id: room.id,
    name: room.name,
    created_by: room.created_by,
    created_by_name: req.session.username,
    created_at: room.created_at,
  });
  res.json({ id: room.id, name: room.name });
});

app.get('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'invalid room id' });
  res.json(db.listMessages(roomId));
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
      username: msg.username,
      content: msg.content,
      type: msg.type,
      attachment: msg.attachment,
      created_at: msg.created_at,
    });
    io.emit('room_activity', { roomId: currentRoom, fromUserId: userId });
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

server.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
});
