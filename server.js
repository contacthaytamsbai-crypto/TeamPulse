'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
// Trust the single reverse proxy used by the hosting platform so req.ip is the visitor IP.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'team-data.json');
const SESSION_COOKIE = 'teampulse_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const VALID_STATUSES = ['pending', 'in_progress', 'review', 'completed', 'blocked'];
const VALID_PRIORITIES = ['low', 'medium', 'high'];
const db = loadDatabase();
const onlineSockets = new Map(); // userId -> Set(socketId)
const loginAttempts = new Map();

function loadDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [], tasks: [], activity: [], sessions: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch (error) {
    console.error('Could not read team database:', error.message);
    throw new Error(`The data file is invalid: ${DB_FILE}`);
  }
}

function saveDatabase() {
  const tempFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, DB_FILE);
}

function makeId() {
  return crypto.randomUUID();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashCredential(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash: derived };
}

// Existing v1 accounts stored this same scrypt hash as a numeric PIN.
// Keeping the stored field names allows old workspaces to continue working.
function verifyCredential(password, user) {
  if (!user.pinSalt || !user.pinHash) return false;
  const candidate = crypto.scryptSync(String(password), user.pinSalt, 64);
  const original = Buffer.from(user.pinHash, 'hex');
  return original.length === candidate.length && crypto.timingSafeEqual(original, candidate);
}

function validCredential(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 72;
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
  }
  return cookies;
}

function getSessionFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = db.sessions.find(item => item.tokenHash === tokenHash && item.expiresAt > Date.now());
  if (!session) return null;
  const user = db.users.find(item => item.id === session.userId && item.active !== false);
  return user ? { session, user } : null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    accountStatus: user.inviteCodeHash ? 'invited' : 'active',
    createdAt: user.createdAt
  };
}

function requireAuth(req, res, next) {
  const auth = getSessionFromCookie(req.headers.cookie);
  if (!auth) return res.status(401).json({ error: 'Please log in again.' });
  req.user = auth.user;
  req.sessionRecord = auth.session;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can do that.' });
  }
  next();
}

function addActivity(user, action, taskTitle = '') {
  db.activity.unshift({
    id: makeId(),
    userId: user.id,
    userName: user.name,
    action,
    taskTitle,
    createdAt: new Date().toISOString()
  });
  db.activity = db.activity.slice(0, 60);
}

function onlineUserIds() {
  return [...onlineSockets.entries()].filter(([, sockets]) => sockets.size > 0).map(([id]) => id);
}

function emitPresence() {
  io.emit('presence:update', onlineUserIds());
}

function emitDataChanged() {
  io.emit('data:changed');
}

function cleanExpiredSessions() {
  const now = Date.now();
  const before = db.sessions.length;
  db.sessions = db.sessions.filter(item => item.expiresAt > now);
  if (before !== db.sessions.length) saveDatabase();
}

app.disable('x-powered-by');
app.get('/api/health', (req, res) => res.status(200).json({ ok: true, service: 'teampulse' }));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function getLocalIPv4Addresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry && entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

app.get('/api/network-info', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ localUrls: getLocalIPv4Addresses().map(address => `http://${address}:${PORT}`) });
});

app.get('/api/bootstrap', (req, res) => {
  cleanExpiredSessions();
  const auth = getSessionFromCookie(req.headers.cookie);
  res.json({ needsSetup: db.users.length === 0, user: auth ? publicUser(auth.user) : null });
});

app.post('/api/setup', (req, res) => {
  if (db.users.length > 0) return res.status(403).json({ error: 'The workspace is already set up.' });
  const { name, username } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 40);
  const cleanUsername = String(username || '').trim().toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : String(req.body?.pin || '');
  if (cleanName.length < 2) return res.status(400).json({ error: 'Enter your name (at least 2 characters).' });
  if (!/^[a-z0-9._-]{3,24}$/.test(cleanUsername)) return res.status(400).json({ error: 'Username must be 3–24 characters: a-z, 0-9, dot, dash or underscore.' });
  if (!validCredential(password)) return res.status(400).json({ error: 'Password must contain 6–72 characters.' });

  const credentials = hashCredential(password);
  const user = {
    id: makeId(), username: cleanUsername, name: cleanName, role: 'admin', active: true,
    pinSalt: credentials.salt, pinHash: credentials.hash, createdAt: new Date().toISOString()
  };
  db.users.push(user);
  addActivity(user, 'created the workspace');
  saveDatabase();
  createSession(user, res);
  res.status(201).json({ user: publicUser(user) });
});

function createSession(user, res) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ tokenHash: hashToken(token), userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  saveDatabase();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

app.post('/api/claim-invite', (req, res) => {
  const cleanUsername = String(req.body?.username || '').trim().toLowerCase();
  const invitationCode = String(req.body?.invitationCode || '').trim().toUpperCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const key = `${req.ip}:invite:${cleanUsername}`;
  const attempt = loginAttempts.get(key) || { count: 0, until: 0 };
  if (attempt.until > Date.now() && attempt.count >= 8) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const user = db.users.find(item => item.username === cleanUsername && item.active !== false);
  if (!user || !user.inviteCodeHash) {
    attempt.count += 1;
    if (attempt.count >= 8) attempt.until = Date.now() + 15 * 60 * 1000;
    loginAttempts.set(key, attempt);
    return res.status(400).json({ error: 'No pending invitation was found for this username. Ask your admin to add you or create a new invite code.' });
  }
  if (user.inviteExpiresAt && user.inviteExpiresAt <= Date.now()) {
    return res.status(410).json({ error: 'This invitation has expired. Ask your admin for a new invitation code.' });
  }
  if (!/^[A-F0-9]{10}$/.test(invitationCode) || hashToken(invitationCode) !== user.inviteCodeHash) {
    attempt.count += 1;
    if (attempt.count >= 8) attempt.until = Date.now() + 15 * 60 * 1000;
    loginAttempts.set(key, attempt);
    return res.status(401).json({ error: 'This invitation code does not match the latest invite for this username. Ask the admin to generate a fresh invite link and open that link directly.' });
  }
  if (!validCredential(password)) {
    return res.status(400).json({ error: 'Choose a password containing 6–72 characters.' });
  }

  const credentials = hashCredential(password);
  user.pinSalt = credentials.salt;
  user.pinHash = credentials.hash;
  delete user.inviteCodeHash;
  delete user.inviteExpiresAt;
  user.activatedAt = new Date().toISOString();
  loginAttempts.delete(key);
  addActivity(user, 'completed account setup');
  saveDatabase();
  createSession(user, res);
  res.status(201).json({ user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username } = req.body || {};
  const password = typeof req.body?.password === 'string' ? req.body.password : String(req.body?.pin || '');
  const cleanUsername = String(username || '').trim().toLowerCase();
  const key = `${req.ip}:${cleanUsername}`;
  const attempt = loginAttempts.get(key) || { count: 0, until: 0 };
  if (attempt.until > Date.now() && attempt.count >= 8) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  const user = db.users.find(item => item.username === cleanUsername && item.active !== false);
  if (user && user.inviteCodeHash) {
    return res.status(403).json({ error: 'Your account invitation is not activated yet. Choose Create account and enter your invitation code.' });
  }
  if (!user || !validCredential(password) || !verifyCredential(password, user)) {
    attempt.count += 1;
    if (attempt.count >= 8) attempt.until = Date.now() + 15 * 60 * 1000;
    loginAttempts.set(key, attempt);
    return res.status(401).json({ error: 'Username or password is incorrect.' });
  }
  loginAttempts.delete(key);
  createSession(user, res);
  addActivity(user, 'signed in');
  saveDatabase();
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  db.sessions = db.sessions.filter(item => item.tokenHash !== req.sessionRecord.tokenHash);
  saveDatabase();
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/state', requireAuth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    members: db.users.filter(item => item.active !== false).map(publicUser),
    tasks: db.tasks,
    activity: db.activity.slice(0, 25),
    onlineIds: onlineUserIds()
  });
});

app.post('/api/members', requireAuth, requireAdmin, (req, res) => {
  const { name, username, role } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 40);
  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanRole = role === 'admin' ? 'admin' : 'member';
  if (cleanName.length < 2) return res.status(400).json({ error: 'Enter a name (at least 2 characters).' });
  if (!/^[a-z0-9._-]{3,24}$/.test(cleanUsername)) return res.status(400).json({ error: 'Username must be 3–24 valid characters.' });
  if (db.users.some(item => item.username === cleanUsername)) return res.status(409).json({ error: 'That username is already taken.' });

  const invitationCode = crypto.randomBytes(5).toString('hex').toUpperCase();
  const user = {
    id: makeId(), username: cleanUsername, name: cleanName, role: cleanRole, active: true,
    inviteCodeHash: hashToken(invitationCode), inviteExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  addActivity(req.user, `invited ${cleanName} to the team`);
  saveDatabase();
  emitDataChanged();
  // The invitation code is returned once only; only its hash is stored.
  res.status(201).json({ member: publicUser(user), invitationCode });
});

app.post('/api/members/:id/invitation-code', requireAuth, requireAdmin, (req, res) => {
  const member = db.users.find(item => item.id === req.params.id && item.active !== false);
  if (!member) return res.status(404).json({ error: 'Team member not found.' });
  const wasPending = Boolean(member.inviteCodeHash);
  const invitationCode = crypto.randomBytes(5).toString('hex').toUpperCase();
  member.inviteCodeHash = hashToken(invitationCode);
  member.inviteExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  // A newly issued code must not inherit rate-limit state from failed attempts
  // against an older code for the same username.
  for (const key of loginAttempts.keys()) {
    if (key.endsWith(`:invite:${member.username}`)) loginAttempts.delete(key);
  }
  // Move an existing account to invite setup so the teammate can choose their own password.
  delete member.pinSalt;
  delete member.pinHash;
  db.sessions = db.sessions.filter(item => item.userId !== member.id);
  for (const activeSocket of io.sockets.sockets.values()) {
    if (activeSocket.data.user?.id === member.id) activeSocket.disconnect(true);
  }
  addActivity(req.user, `${wasPending ? 'renewed invitation for' : 'sent account setup invite to'} ${member.name}`);
  saveDatabase();
  emitDataChanged();
  res.json({ invitationCode });
});

app.patch('/api/members/:id/password', requireAuth, requireAdmin, (req, res) => {
  const member = db.users.find(item => item.id === req.params.id && item.active !== false);
  if (!member) return res.status(404).json({ error: 'Team member not found.' });
  if (member.id === req.user.id) return res.status(400).json({ error: 'Use your own account settings to change your password.' });
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!validCredential(password)) return res.status(400).json({ error: 'Password must contain 6–72 characters.' });
  const credentials = hashCredential(password);
  member.pinSalt = credentials.salt;
  member.pinHash = credentials.hash;
  // Revoke existing sessions so the member must use the newly issued password.
  db.sessions = db.sessions.filter(item => item.userId !== member.id);
  for (const activeSocket of io.sockets.sockets.values()) {
    if (activeSocket.data.user?.id === member.id) activeSocket.disconnect(true);
  }
  addActivity(req.user, `reset password for ${member.name}`);
  saveDatabase();
  emitDataChanged();
  res.json({ ok: true });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const { title, description, assigneeId, priority, deadline } = req.body || {};
  const cleanTitle = String(title || '').trim().slice(0, 100);
  if (cleanTitle.length < 3) return res.status(400).json({ error: 'Task title must be at least 3 characters.' });
  const assignee = db.users.find(item => item.id === assigneeId && item.active !== false);
  if (!assignee) return res.status(400).json({ error: 'Choose a valid team member.' });
  const cleanPriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';
  const cleanDeadline = deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : '';
  const task = {
    id: makeId(), title: cleanTitle,
    description: String(description || '').trim().slice(0, 600),
    assigneeId: assignee.id, assigneeName: assignee.name,
    createdById: req.user.id, createdByName: req.user.name,
    priority: cleanPriority, status: 'pending', deadline: cleanDeadline,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  db.tasks.unshift(task);
  addActivity(req.user, 'created task', task.title);
  saveDatabase();
  emitDataChanged();
  res.status(201).json({ task });
});

app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const task = db.tasks.find(item => item.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const body = req.body || {};
  const changes = [];
  if (body.title !== undefined) {
    const title = String(body.title).trim().slice(0, 100);
    if (title.length < 3) return res.status(400).json({ error: 'Task title must be at least 3 characters.' });
    task.title = title;
  }
  if (body.description !== undefined) task.description = String(body.description || '').trim().slice(0, 600);
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) return res.status(400).json({ error: 'Invalid task status.' });
    if (task.status !== body.status) changes.push(`changed status to ${body.status.replace('_', ' ')}`);
    task.status = body.status;
  }
  if (body.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(body.priority)) return res.status(400).json({ error: 'Invalid priority.' });
    task.priority = body.priority;
  }
  if (body.deadline !== undefined) {
    const deadline = String(body.deadline || '');
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return res.status(400).json({ error: 'Invalid deadline.' });
    task.deadline = deadline;
  }
  if (body.assigneeId !== undefined) {
    const assignee = db.users.find(item => item.id === body.assigneeId && item.active !== false);
    if (!assignee) return res.status(400).json({ error: 'Choose a valid team member.' });
    task.assigneeId = assignee.id;
    task.assigneeName = assignee.name;
    changes.push(`assigned task to ${assignee.name}`);
  }
  task.updatedAt = new Date().toISOString();
  addActivity(req.user, changes.length ? changes.join(' and ') : 'updated task', task.title);
  saveDatabase();
  emitDataChanged();
  res.json({ task });
});

app.delete('/api/tasks/:id', requireAuth, requireAdmin, (req, res) => {
  const index = db.tasks.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Task not found.' });
  const [task] = db.tasks.splice(index, 1);
  addActivity(req.user, 'deleted task', task.title);
  saveDatabase();
  emitDataChanged();
  res.json({ ok: true });
});

io.use((socket, next) => {
  const auth = getSessionFromCookie(socket.handshake.headers.cookie || '');
  if (!auth) return next(new Error('Unauthorized'));
  socket.data.user = publicUser(auth.user);
  next();
});

io.on('connection', socket => {
  const user = socket.data.user;
  if (!onlineSockets.has(user.id)) onlineSockets.set(user.id, new Set());
  onlineSockets.get(user.id).add(socket.id);
  socket.emit('presence:update', onlineUserIds());
  emitPresence();

  socket.on('disconnect', () => {
    const sockets = onlineSockets.get(user.id);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) onlineSockets.delete(user.id);
    }
    emitPresence();
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, HOST, () => {
  console.log(`\nTeamPulse is running at http://localhost:${PORT}`);
  console.log(`For another device on the same Wi-Fi, use this PC's local IP and port ${PORT}.`);
  console.log('Keep this terminal window open while the team uses the app.\n');
});
