const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'chat-data.json');

const defaultData = {
  users: [],
  rooms: [],
  messages: [],
  nextUserId: 1,
  nextRoomId: 1,
  nextMessageId: 1,
};

let data;
let saveTimer = null;

function load() {
  if (fs.existsSync(DB_PATH)) {
    try {
      data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
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
