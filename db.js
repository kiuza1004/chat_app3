const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'chat-data.json');

const defaultData = {
  users: [],
  rooms: [],
  messages: [],
  roomReads: [],
  nextUserId: 1,
  nextRoomId: 1,
  nextMessageId: 1,
};

let data;
let saveTimer = null;

function load() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      data = { ...structuredClone(defaultData), ...loaded };
      if (!Array.isArray(data.roomReads)) data.roomReads = [];
    } catch {
      data = structuredClone(defaultData);
    }
  } else {
    data = structuredClone(defaultData);
    persistNow();
  }
}

function persistNow() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 50);
}

load();

module.exports = {
  // Users
  findUserByName(username) {
    return data.users.find((u) => u.username === username);
  },
  findUserById(id) {
    return data.users.find((u) => u.id === id);
  },
  createUser(username, passwordHash) {
    const user = { id: data.nextUserId++, username, password_hash: passwordHash, created_at: Date.now() };
    data.users.push(user);
    save();
    return user;
  },

  // Rooms
  listRooms() {
    return data.rooms
      .map((r) => {
        const creator = data.users.find((u) => u.id === r.created_by);
        return { ...r, created_by_name: creator ? creator.username : 'unknown' };
      })
      .sort((a, b) => b.created_at - a.created_at);
  },
  findRoomByName(name) {
    return data.rooms.find((r) => r.name === name);
  },
  findRoomById(id) {
    return data.rooms.find((r) => r.id === id);
  },
  createRoom(name, createdBy) {
    const room = { id: data.nextRoomId++, name, created_by: createdBy, created_at: Date.now() };
    data.rooms.push(room);
    save();
    return room;
  },

  // Messages
  listMessages(roomId, limit = 200) {
    return data.messages
      .filter((m) => m.room_id === roomId)
      .slice(-limit)
      .map((m) => ({
        id: m.id,
        username: m.username,
        content: m.content,
        type: m.type || 'text',
        attachment: m.attachment || null,
        created_at: m.created_at,
      }));
  },
  // Room reads (unread tracking)
  markRoomRead(userId, roomId, ts = Date.now()) {
    const existing = data.roomReads.find((r) => r.user_id === userId && r.room_id === roomId);
    if (existing) existing.last_read_at = ts;
    else data.roomReads.push({ user_id: userId, room_id: roomId, last_read_at: ts });
    save();
  },
  getLastRead(userId, roomId) {
    const r = data.roomReads.find((x) => x.user_id === userId && x.room_id === roomId);
    return r ? r.last_read_at : 0;
  },
  countUnread(userId, roomId) {
    const lastRead = this.getLastRead(userId, roomId);
    let count = 0;
    for (const m of data.messages) {
      if (m.room_id === roomId && m.user_id !== userId && m.created_at > lastRead) count++;
    }
    return count;
  },

  createMessage(roomId, userId, username, content, attachment = null) {
    const msg = {
      id: data.nextMessageId++,
      room_id: roomId,
      user_id: userId,
      username,
      content,
      type: attachment ? attachment.kind : 'text',
      attachment,
      created_at: Date.now(),
    };
    data.messages.push(msg);
    save();
    return msg;
  },
};
