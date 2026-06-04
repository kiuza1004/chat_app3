const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-prod';

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

io.engine.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/api/signup', (req, res) => {
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

app.post('/api/login', (req, res) => {
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
  res.json(db.listRooms());
});

app.post('/api/rooms', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '방 이름을 입력하세요' });
  const trimmed = name.trim().slice(0, 40);

  if (db.findRoomByName(trimmed)) return res.status(409).json({ error: '이미 존재하는 방 이름입니다' });

  const room = db.createRoom(trimmed, req.session.userId);
  res.json({ id: room.id, name: room.name });
});

app.get('/api/rooms/:id/messages', requireAuth, (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'invalid room id' });
  res.json(db.listMessages(roomId));
});

io.on('connection', (socket) => {
  const sess = socket.request.session;
  if (!sess || !sess.userId) {
    socket.disconnect(true);
    return;
  }

  const userId = sess.userId;
  const username = sess.username;
  let currentRoom = null;

  socket.on('join', (roomId) => {
    const id = parseInt(roomId, 10);
    if (!Number.isInteger(id)) return;

    const room = db.findRoomById(id);
    if (!room) return socket.emit('error_msg', '존재하지 않는 방입니다');

    if (currentRoom) socket.leave(`room:${currentRoom}`);
    currentRoom = id;
    socket.join(`room:${id}`);
    socket.emit('joined', { roomId: id, name: room.name });
  });

  socket.on('message', (content) => {
    if (!currentRoom) return;
    if (typeof content !== 'string') return;
    const text = content.trim().slice(0, 1000);
    if (!text) return;

    const msg = db.createMessage(currentRoom, userId, username, text);
    io.to(`room:${currentRoom}`).emit('message', {
      id: msg.id,
      username: msg.username,
      content: msg.content,
      created_at: msg.created_at,
    });
  });
});

server.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
});
