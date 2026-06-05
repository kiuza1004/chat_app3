const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'chat-data.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const defaultData = {
  users: [],
  rooms: [],
  messages: [],
  roomReads: [],
  roomMembers: [],
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
      if (!Array.isArray(data.roomMembers)) data.roomMembers = [];
      data.users.forEach((u) => { if (!u.username_lower) u.username_lower = u.username.toLowerCase(); });
      data.rooms.forEach((r) => { if (!r.visibility) r.visibility = 'public'; });
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
  DB_PATH,
  BACKUP_DIR,

  // Users (username is case-insensitive)
  findUserByName(username) {
    const lower = String(username).toLowerCase();
    return data.users.find((u) => u.username_lower === lower);
  },
  findUserById(id) {
    return data.users.find((u) => u.id === id);
  },
  createUser(username, passwordHash) {
    const user = {
      id: data.nextUserId++,
      username,
      username_lower: username.toLowerCase(),
      password_hash: passwordHash,
      created_at: Date.now(),
    };
    data.users.push(user);
    save();
    return user;
  },

  // Rooms
  listRoomsForUser(userId) {
    return data.rooms
      .filter((r) => r.visibility !== 'private' || this.isMember(r.id, userId))
      .map((r) => {
        const creator = data.users.find((u) => u.id === r.created_by);
        return {
          ...r,
          visibility: r.visibility || 'public',
          created_by_name: creator ? creator.username : 'unknown',
        };
      })
      .sort((a, b) => b.created_at - a.created_at);
  },
  findRoomByName(name) {
    const lower = String(name).toLowerCase();
    return data.rooms.find((r) => r.name.toLowerCase() === lower);
  },
  findRoomById(id) {
    return data.rooms.find((r) => r.id === id);
  },
  createRoom(name, createdBy, visibility = 'public') {
    const room = {
      id: data.nextRoomId++,
      name,
      created_by: createdBy,
      visibility: visibility === 'private' ? 'private' : 'public',
      created_at: Date.now(),
    };
    data.rooms.push(room);
    if (room.visibility === 'private') {
      data.roomMembers.push({
        room_id: room.id,
        user_id: createdBy,
        role: 'admin',
        joined_at: Date.now(),
      });
    }
    save();
    return room;
  },

  // Room members (private rooms only)
  isMember(roomId, userId) {
    return data.roomMembers.some((m) => m.room_id === roomId && m.user_id === userId);
  },
  getMember(roomId, userId) {
    return data.roomMembers.find((m) => m.room_id === roomId && m.user_id === userId);
  },
  listMembers(roomId) {
    return data.roomMembers
      .filter((m) => m.room_id === roomId)
      .map((m) => {
        const u = data.users.find((x) => x.id === m.user_id);
        return {
          user_id: m.user_id,
          username: u ? u.username : 'unknown',
          role: m.role,
          joined_at: m.joined_at,
        };
      })
      .sort((a, b) => a.joined_at - b.joined_at);
  },
  addMember(roomId, userId, role = 'member') {
    if (this.isMember(roomId, userId)) return { error: '이미 멤버입니다' };
    const m = { room_id: roomId, user_id: userId, role, joined_at: Date.now() };
    data.roomMembers.push(m);
    save();
    return { member: m };
  },
  removeMember(roomId, userId) {
    const idx = data.roomMembers.findIndex((m) => m.room_id === roomId && m.user_id === userId);
    if (idx < 0) return false;
    data.roomMembers.splice(idx, 1);
    save();
    return true;
  },

  // Messages
  listMessages(roomId, { beforeId = null, limit = 50 } = {}) {
    const all = data.messages.filter((m) => m.room_id === roomId);
    let slice;
    if (beforeId != null) {
      const idx = all.findIndex((m) => m.id === beforeId);
      const end = idx < 0 ? all.length : idx;
      slice = all.slice(Math.max(0, end - limit), end);
    } else {
      slice = all.slice(-limit);
    }
    return slice.map((m) => ({
      id: m.id,
      user_id: m.user_id,
      username: m.username,
      content: m.content,
      type: m.type || 'text',
      attachment: m.attachment || null,
      edited_at: m.edited_at || null,
      deleted: !!m.deleted,
      created_at: m.created_at,
    }));
  },
  hasOlderMessages(roomId, beforeId) {
    const all = data.messages.filter((m) => m.room_id === roomId);
    if (beforeId == null) return all.length > 0;
    const idx = all.findIndex((m) => m.id === beforeId);
    return idx > 0;
  },
  findMessageById(id) {
    return data.messages.find((m) => m.id === id);
  },
  updateMessage(id, userId, newContent) {
    const m = data.messages.find((x) => x.id === id);
    if (!m) return { error: '메시지를 찾을 수 없습니다' };
    if (m.user_id !== userId) return { error: '권한이 없습니다' };
    if (m.deleted) return { error: '삭제된 메시지입니다' };
    m.content = newContent;
    m.edited_at = Date.now();
    save();
    return { message: m };
  },
  deleteMessage(id, userId) {
    const m = data.messages.find((x) => x.id === id);
    if (!m) return { error: '메시지를 찾을 수 없습니다' };
    if (m.user_id !== userId) return { error: '권한이 없습니다' };
    m.deleted = true;
    m.content = '';
    m.attachment = null;
    m.type = 'text';
    save();
    return { message: m };
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
      if (m.room_id === roomId && m.user_id !== userId && !m.deleted && m.created_at > lastRead) count++;
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
