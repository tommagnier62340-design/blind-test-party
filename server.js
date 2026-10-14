// Blind Test Party — serveur sans dépendance (Node >= 18)
// Lancer : node server.js   puis ouvrir http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const POINTS_OK = 200;
const POINTS_KO = -100;
const ANSWER_TIME = Number(process.env.ANSWER_TIME) || 15; // secondes pour répondre après un buzz
const MANCHES_OPTIONS = [1, 2, 4, 5];
const XP_FILE = path.join(__dirname, 'data', 'xp.json');
const PACKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'packs.json'), 'utf8'));

// ---------- XP persistant (par pseudo) ----------
let xpDb = {};
try { xpDb = JSON.parse(fs.readFileSync(XP_FILE, 'utf8')); } catch (_) {}
function saveXp() {
  try {
    fs.mkdirSync(path.dirname(XP_FILE), { recursive: true });
    fs.writeFileSync(XP_FILE, JSON.stringify(xpDb, null, 2));
  } catch (e) { console.error('XP non sauvegardé :', e.message); }
}
const XP_PER_LEVEL = 200;
const levelOf = (xp) => Math.floor(xp / XP_PER_LEVEL) + 1;
const keyOf = (name) => name.trim().toLowerCase();

// ---------- Salons ----------
const rooms = new Map();
const clients = new Map(); // roomCode -> Map(playerId -> res)

function code() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function ytId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function mediaOf(src) {
  if (!src) return null;
  const id = ytId(src);
  if (id) return { type: 'yt', id };
  if (/\.(mp3|ogg|wav|m4a|webm)(\?|$)/i.test(src) || src.startsWith('/media/')) return { type: 'file', src };
  return null;
}

function cleanName(n) {
  return String(n || '').replace(/[<>]/g, '').trim().slice(0, 16);
}

function packLength(room) {
  const pack = PACKS.find((p) => p.id === room.packId);
  return pack ? pack.items.length : 0;
}
function perManche(room) { return Math.ceil(packLength(room) / room.manches); }
function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } room.deadline = null; }
function snapshotManche(room) {
  room.mancheBase = {};
  for (const p of room.players.values()) room.mancheBase[p.id] = p.score;
}
function buildRecap(room) {
  return [...room.players.values()].filter((p) => p.id !== room.ownerId)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ id: p.id, name: p.name, total: p.score, gain: p.score - (room.mancheBase[p.id] || 0), rank: i + 1 }));
}

// Refus d'une réponse (par l'owner, ou automatiquement au bout de ANSWER_TIME s)
function applyRefuse(room, timeout) {
  const p = room.players.get(room.buzzer);
  clearTimer(room);
  p.score += POINTS_KO;
  room.lockedOut.add(p.id);
  room.lastResult = { type: 'ko', playerId: p.id, name: p.name, delta: POINTS_KO, timeout: !!timeout };
  room.buzzer = null;
  const remaining = [...room.players.values()].filter((x) => x.id !== room.ownerId && !room.lockedOut.has(x.id));
  if (remaining.length === 0) { room.phase = 'reveal'; room.media = null; }
  else { room.phase = 'playing'; room.playStart = Date.now(); }
}

function elapsedNow(room) {
  return room.elapsed + (room.phase === 'playing' && room.playStart ? (Date.now() - room.playStart) / 1000 : 0);
}

function currentItem(room) {
  const pack = PACKS.find((p) => p.id === room.packId);
  return pack ? pack.items[room.idx] : null;
}

function view(room, pid) {
  const isOwner = pid === room.ownerId;
  const pack = PACKS.find((p) => p.id === room.packId);
  const item = currentItem(room);
  const revealed = room.phase === 'reveal' || room.phase === 'end';
  const players = [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, score: p.score, connected: p.connected,
    lockedOut: room.lockedOut.has(p.id), isOwner: p.id === room.ownerId,
  }));
  return {
    code: room.code, me: pid, isOwner, phase: room.phase, maxPlayers: MAX_PLAYERS,
    packs: PACKS.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, count: p.items.length })),
    packId: room.packId, packName: pack ? pack.name : null, total: pack ? pack.items.length : 0,
    round: room.idx + 1, players, buzzer: room.buzzer,
    manches: room.manches, manchesOptions: MANCHES_OPTIONS, perManche: perManche(room),
    manche: Math.min(Math.floor(room.idx / perManche(room)) + 1, room.manches),
    roundInManche: (room.idx % perManche(room)) + 1,
    answerTime: ANSWER_TIME,
    answerMs: room.phase === 'answering' && room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    recap: room.phase === 'recap' ? room.recap : null,
    finishedManche: room.phase === 'recap' ? Math.floor(room.idx / perManche(room)) : null,
    answer: item && (isOwner || revealed) ? item.title : null,
    playing: room.phase === 'playing',
    media: room.media, startAt: room.phase === 'playing' ? Math.floor(room.elapsed) : 0,
    lastResult: room.lastResult,
    results: room.phase === 'end' ? room.results : null,
    pointsOk: POINTS_OK, pointsKo: POINTS_KO,
  };
}

function broadcast(room) {
  const set = clients.get(room.code);
  if (!set) return;
  for (const [pid, res] of set) {
    res.write(`data: ${JSON.stringify(view(room, pid))}\n\n`);
  }
}

function finishGame(room) {
  const ranked = [...room.players.values()]
    .filter((p) => p.id !== room.ownerId)
    .sort((a, b) => b.score - a.score);
  const bonus = [50, 30, 15];
  room.results = ranked.map((p, i) => {
    const gained = 20 + Math.max(0, Math.floor(p.score / 10)) + (bonus[i] || 0);
    const k = keyOf(p.name);
    const before = (xpDb[k] && xpDb[k].xp) || 0;
    xpDb[k] = { name: p.name, xp: before + gained, games: ((xpDb[k] && xpDb[k].games) || 0) + 1 };
    return {
      id: p.id, name: p.name, score: p.score, rank: i + 1, gained,
      xpBefore: before, xpAfter: before + gained,
      levelBefore: levelOf(before), levelAfter: levelOf(before + gained), xpPerLevel: XP_PER_LEVEL,
    };
  });
  saveXp();
  room.phase = 'end';
  room.media = null;
}

function startRound(room) {
  room.phase = 'idle';
  room.buzzer = null;
  room.lockedOut = new Set();
  room.elapsed = 0;
  room.playStart = null;
  room.lastResult = null;
  const item = currentItem(room);
  room.media = mediaOf(item && item.media);
}

// ---------- Actions ----------
function act(body) {
  const { action } = body;
  const pid = String(body.pid || '');
  if (!pid) return { error: 'Identifiant manquant' };

  if (action === 'create') {
    const name = cleanName(body.name);
    if (!name) return { error: 'Choisis un pseudo' };
    const room = {
      code: code(), ownerId: pid, players: new Map(), phase: 'lobby', packId: PACKS[0].id,
      idx: 0, buzzer: null, lockedOut: new Set(), media: null, elapsed: 0, playStart: null,
      lastResult: null, results: null, manches: 2, deadline: null, timer: null, mancheBase: {}, recap: null,
    };
    room.players.set(pid, { id: pid, name, score: 0, connected: false });
    rooms.set(room.code, room);
    return { ok: true, code: room.code };
  }

  const room = rooms.get(String(body.code || '').toUpperCase());
  if (!room) return { error: 'Salon introuvable' };

  if (action === 'join') {
    const name = cleanName(body.name);
    if (!name) return { error: 'Choisis un pseudo' };
    const existing = room.players.get(pid);
    if (existing) { existing.name = name; return { ok: true, code: room.code }; }
    if (room.phase !== 'lobby') return { error: 'La partie a déjà commencé' };
    const nonOwner = [...room.players.values()].filter((p) => p.id !== room.ownerId).length;
    if (nonOwner >= MAX_PLAYERS) return { error: `Salon complet (${MAX_PLAYERS} joueurs max)` };
    if ([...room.players.values()].some((p) => keyOf(p.name) === keyOf(name))) return { error: 'Ce pseudo est déjà pris dans le salon' };
    room.players.set(pid, { id: pid, name, score: 0, connected: false });
    broadcast(room);
    return { ok: true, code: room.code };
  }

  const me = room.players.get(pid);
  if (!me) return { error: 'Tu ne fais pas partie de ce salon' };
  const isOwner = pid === room.ownerId;

  if (action === 'buzz') {
    if (isOwner) return { error: 'L\'owner ne buzz pas' };
    if (room.phase !== 'playing') return { error: 'Trop tôt ou trop tard' };
    if (room.lockedOut.has(pid)) return { error: 'Tu as déjà été refusé sur ce générique' };
    room.elapsed = elapsedNow(room);
    room.playStart = null;
    room.buzzer = pid;
    room.phase = 'answering';
    room.deadline = Date.now() + ANSWER_TIME * 1000;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.phase === 'answering' && room.buzzer) { applyRefuse(room, true); broadcast(room); }
    }, ANSWER_TIME * 1000);
    broadcast(room);
    return { ok: true };
  }

  if (!isOwner) return { error: 'Action réservée à l\'owner' };

  switch (action) {
    case 'setPack':
      if (room.phase !== 'lobby') return { error: 'Partie en cours' };
      if (!PACKS.some((p) => p.id === body.packId)) return { error: 'Pack inconnu' };
      room.packId = body.packId;
      break;
    case 'setManches':
      if (room.phase !== 'lobby') return { error: 'Partie en cours' };
      if (!MANCHES_OPTIONS.includes(Number(body.manches))) return { error: 'Nombre de manches invalide' };
      room.manches = Number(body.manches);
      break;
    case 'kick': {
      if (room.phase !== 'lobby' || body.target === room.ownerId) return { error: 'Impossible' };
      room.players.delete(body.target);
      const set = clients.get(room.code);
      if (set && set.get(body.target)) { set.get(body.target).end(); set.delete(body.target); }
      break;
    }
    case 'start': {
      if (room.phase !== 'lobby') return { error: 'Déjà lancée' };
      const players = [...room.players.values()].filter((p) => p.id !== room.ownerId);
      if (players.length < 1) return { error: 'Il faut au moins 1 joueur (en plus de toi)' };
      for (const p of room.players.values()) p.score = 0;
      room.idx = 0;
      snapshotManche(room);
      startRound(room);
      break;
    }
    case 'setMedia':
      if (room.phase !== 'idle' && room.phase !== 'playing' && room.phase !== 'answering') return { error: 'Impossible maintenant' };
      room.media = mediaOf(String(body.url || '').trim());
      if (body.url && !room.media) return { error: 'Lien non reconnu (YouTube ou fichier .mp3)' };
      break;
    case 'play':
      if (room.phase !== 'idle') return { error: 'Impossible maintenant' };
      room.phase = 'playing';
      room.playStart = Date.now();
      break;
    case 'validate':
    case 'refuse': {
      if (room.phase !== 'answering' || !room.buzzer) return { error: 'Personne n\'a buzzé' };
      if (action === 'validate') {
        const p = room.players.get(room.buzzer);
        clearTimer(room);
        p.score += POINTS_OK;
        room.lastResult = { type: 'ok', playerId: p.id, name: p.name, delta: POINTS_OK };
        room.phase = 'reveal';
        room.media = null;
        room.buzzer = null;
      } else {
        applyRefuse(room, false);
      }
      break;
    }
    case 'skip':
      if (!['idle', 'playing', 'answering'].includes(room.phase)) return { error: 'Impossible maintenant' };
      clearTimer(room);
      room.lastResult = { type: 'skip' };
      room.buzzer = null;
      room.phase = 'reveal';
      room.media = null;
      break;
    case 'next':
      if (room.phase !== 'reveal') return { error: 'Impossible maintenant' };
      room.idx += 1;
      if (room.idx >= packLength(room)) finishGame(room);
      else if (room.idx % perManche(room) === 0) { room.recap = buildRecap(room); room.phase = 'recap'; room.media = null; }
      else startRound(room);
      break;
    case 'nextManche':
      if (room.phase !== 'recap') return { error: 'Impossible maintenant' };
      snapshotManche(room);
      startRound(room);
      break;
    case 'replay':
      if (room.phase !== 'end') return { error: 'Impossible maintenant' };
      clearTimer(room);
      room.recap = null;
      room.phase = 'lobby';
      room.results = null;
      room.idx = 0;
      for (const p of room.players.values()) p.score = 0;
      break;
    default:
      return { error: 'Action inconnue' };
  }
  broadcast(room);
  return { ok: true };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/events') {
    const c = String(url.searchParams.get('code') || '').toUpperCase();
    const pid = String(url.searchParams.get('pid') || '');
    const room = rooms.get(c);
    if (!room || !room.players.has(pid)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (!clients.has(c)) clients.set(c, new Map());
    clients.get(c).set(pid, res);
    room.players.get(pid).connected = true;
    broadcast(room);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      const set = clients.get(c);
      if (set && set.get(pid) === res) set.delete(pid);
      const p = room.players.get(pid);
      if (p) p.connected = false;
      if (room.phase === 'lobby' && pid !== room.ownerId) room.players.delete(pid);
      if (!set || set.size === 0) {
        setTimeout(() => { const s = clients.get(c); if (!s || s.size === 0) { rooms.delete(c); clients.delete(c); } }, 10 * 60 * 1000);
      } else broadcast(room);
    });
    return;
  }

  if (url.pathname === '/api' && req.method === 'POST') {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = act(JSON.parse(data || '{}')); } catch (e) { out = { error: 'Requête invalide' }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (url.pathname === '/xp') {
    const name = keyOf(url.searchParams.get('name') || '');
    const e = xpDb[name] || { xp: 0, games: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ xp: e.xp, level: levelOf(e.xp), games: e.games, xpPerLevel: XP_PER_LEVEL }));
  }

  // fichiers statiques : seulement la page d'accueil et le dossier media/
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel !== '/index.html' && !rel.startsWith('/media/')) { res.writeHead(404); return res.end('Introuvable'); }
  const file = path.normalize(path.join(__dirname, rel));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Blind Test Party → http://localhost:${PORT}`));
