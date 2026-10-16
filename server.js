// Blind Test Party — serveur sans dépendance (Node >= 18)
// Lancer : node server.js   puis ouvrir http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MAX_TOURNAMENT = 16;
const maxOf = (room) => (room.mode === 'tournament' ? MAX_TOURNAMENT : MAX_PLAYERS);
const POINTS_OK = 200;
const POINTS_KO = -100;
const ANSWER_TIME = Number(process.env.ANSWER_TIME) || 5; // secondes pour répondre après un buzz
const MANCHES_OPTIONS = [1, 2, 4, 5];
const HINT_AT = Number(process.env.HINT_AT) || 20; // secondes d'écoute avant l'indice automatique
const QUICK_WAIT_MS = Number(process.env.QUICK_WAIT_MS) || 20000; // partie rapide : attente avant le lancement
const QUICK_ROUNDS = 10;
const COUNTDOWN_MS = process.env.COUNTDOWN_MS != null ? Number(process.env.COUNTDOWN_MS) : 3000; // décompte avant chaque générique
const REACTIONS = ['👏', '😂', '🔥', '😮', '❤️', '🎉'];
const TEAMS = [{ name: 'Rouge', icon: '🔴' }, { name: 'Bleu', icon: '🔵' }];
const REVEAL_MS = Number(process.env.REVEAL_MS) || 4500; // tournoi : délai avant le générique suivant d'une salle
const XP_FILE = path.join(__dirname, 'data', 'xp.json');
// Liens YouTube choisis par l'owner : enregistrés pour toujours (un générique -> une vidéo), les autres pistes sont supprimées
const OVR_FILE = path.join(__dirname, 'data', 'liens.json');
let ovr = {};
try { ovr = JSON.parse(fs.readFileSync(OVR_FILE, 'utf8')); } catch (_) {}
function saveOvr() { try { fs.mkdirSync(path.dirname(OVR_FILE), { recursive: true }); fs.writeFileSync(OVR_FILE, JSON.stringify(ovr, null, 2)); } catch (e) { console.error('Liens non sauvegardés :', e.message); } }
function ovrKey(room, item) { const p = packOf(room); return item && p && p.id !== 'custom' ? 'k:' + nzT(item.title) : null; }
let PACKS_BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'packs.json'), 'utf8'));
const PACKS = [];
const MEDIA_DIR = path.join(__dirname, 'media');
// Packs « fichiers locaux » : un pack avec "dir" utilise les mp3 du dossier media/<dir>/ ; chaque générique est associé
// au fichier dont le nom contient ses mots-clés ("match"). Les génériques sans fichier sont écartés du pack.
function refreshPacks() {
  try { PACKS_BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'packs.json'), 'utf8')); } catch (e) { console.error('packs.json illisible :', e.message); } // relu à chaque salon : pas besoin de redémarrer après une modification
  const out = [];
  for (const p of PACKS_BASE) {
    if (!p.dir) { out.push(p); continue; }
    // les mp3 peuvent être dans media/<dir>/ ou directement dans media/
    const cands = [];
    for (const sub of [p.dir, '']) {
      try { for (const f of fs.readdirSync(path.join(MEDIA_DIR, sub))) if (/\.(mp3|ogg|wav|m4a|webm)$/i.test(f)) cands.push({ sub, f }); } catch (_) {}
    }
    const nz = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const items = [];
    for (const it of p.items) {
      const c = cands.find(({ sub, f }) => {
        if (!(it.match || []).every((k) => nz(f).includes(nz(k)))) return false;
        try { return fs.statSync(path.join(MEDIA_DIR, sub, f)).size > 20000; } catch (_) { return false; } // fichier vide / corrompu : ignoré
      });
      if (c) items.push({ title: it.title, accepted: it.accepted, search: it.title, media: '/media/' + [c.sub, c.f].filter(Boolean).map(encodeURIComponent).join('/') });
      else items.push({ title: it.title, accepted: it.accepted, search: it.search || (it.title + ' ' + (p.searchSuffix || 'theme')) }); // pas de mp3 (ex. site en ligne) : recherche YouTube
    }
    if (items.length) out.push({ id: p.id, name: p.name, emoji: p.emoji, items });
  }
  const flat = out.flatMap((p) => p.items);
  if (out.length >= 2 && flat.length >= 10) out.push({ id: 'mix', name: 'Mix aléatoire', emoji: '🎲', items: flat, limit: 20 });
  PACKS.length = 0; PACKS.push(...out);
}
function buildMix() {
  const flat = PACKS.filter((p) => p.id !== 'mix').flatMap((p) => p.items);
  return { id: 'mix', name: 'Mix aléatoire', emoji: '🎲', items: shuffle(flat).slice(0, 20) };
}
refreshPacks();
const ITUNES_URL = process.env.ITUNES_URL || 'https://itunes.apple.com/search';
const ITUNES_GAP_MS = Number(process.env.ITUNES_GAP_MS ?? 3200); // l'API Apple limite à ~20 requêtes/min

// ---------- Recherche automatique d'extraits audio (API iTunes, extraits de 30 s) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trackCache = new Map(); // requête -> { t, list }
let lastCall = 0;
let chain = Promise.resolve();
let pending = 0;
function enqueue(fn) {
  pending += 1;
  const p = chain.then(fn, fn);
  chain = p.catch(() => {}).then(() => { pending -= 1; });
  return p;
}
async function searchItunes(query) {
  const key = query.trim().toLowerCase();
  const hit = trackCache.get(key);
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.list;
  const wait = lastCall + ITUNES_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const u = new URL(ITUNES_URL);
  u.search = new URLSearchParams({ term: query, media: 'music', entity: 'song', limit: '10', country: 'FR' }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('iTunes HTTP ' + r.status);
  const j = await r.json();
  const list = (j.results || []).filter((x) => x.previewUrl)
    .map((x) => ({ title: x.trackName, artist: x.artistName, src: x.previewUrl }));
  trackCache.set(key, { t: Date.now(), list });
  return list;
}
// Source audio : YouTube par défaut (AUDIO_SOURCE=itunes pour revenir aux extraits iTunes de 30 s)
const AUDIO_SOURCE = (process.env.AUDIO_SOURCE || 'youtube').toLowerCase();
const YT_BASE = process.env.YT_BASE || 'https://www.youtube.com';
const YT_GAP_MS = Number(process.env.YT_GAP_MS ?? 900);
const YT_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'fr-FR,fr;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+cb.20210328-17-p0.fr+FX+000' };
const BAD_VIDEO = /\b(cover|reaction|reacts?|karaoke|tutorial|tuto|piano|guitar|remix|slowed|sped|nightcore|8d|bass boosted|parody|parodie|live|concert|interview|review|explained|analyse)\b/i;
const embedCache = new Map();
async function embeddable(id) { // YouTube refuse l'intégration de certaines vidéos : oEmbed répond 401/403 dans ce cas
  if (embedCache.has(id)) return embedCache.get(id);
  let ok = true;
  try { const r = await fetch(YT_BASE + '/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), { headers: YT_HEADERS, signal: AbortSignal.timeout(5000) }); ok = r.status !== 401 && r.status !== 403 && r.status !== 404; } catch (_) {}
  embedCache.set(id, ok);
  return ok;
}
function ytVideos(html) {
  const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch (_) { return []; }
  const out = [];
  (function walk(o) {
    if (!o || typeof o !== 'object' || out.length > 25) return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer, t = v.title && v.title.runs ? v.title.runs.map((r) => r.text).join('') : '';
      const ch = v.ownerText && v.ownerText.runs ? v.ownerText.runs[0].text : '';
      const len = v.lengthText && v.lengthText.simpleText ? v.lengthText.simpleText.split(':').reduce((a, x) => a * 60 + Number(x), 0) : 0;
      out.push({ id: v.videoId, title: t, artist: ch, secs: len });
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(data);
  return out;
}
async function searchYoutube(query) {
  const key = 'yt:' + query.trim().toLowerCase();
  const hit = trackCache.get(key);
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return hit.list;
  const wait = lastCall + YT_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const r = await fetch(YT_BASE + '/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAQ%253D%253D', { headers: YT_HEADERS, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('YouTube HTTP ' + r.status);
  let vids = ytVideos(await r.text()).filter((v) => v.secs >= 45 && v.secs <= 720 && !v.title.toLowerCase().match(/#shorts/));
  const okFlags = await Promise.all(vids.slice(0, 8).map((v) => embeddable(v.id)));
  vids = vids.slice(0, 8).filter((_, i) => okFlags[i]);
  const list = vids.map((v) => ({ title: v.title, artist: v.artist, yt: v.id, secs: v.secs, offset: v.secs >= 150 ? 15 : 0, src: 'https://www.youtube.com/watch?v=' + v.id }));
  trackCache.set(key, { t: Date.now(), list });
  return list;
}
function searchTracks(query) { return AUDIO_SOURCE === 'itunes' ? searchItunes(query) : searchYoutube(query); }


// Vérifie que la piste trouvée est bien la bonne : artiste ET titre doivent correspondre (sinon iTunes renvoie parfois un autre morceau).
const nzT = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
function trackOk(tr, item) {
  const artists = [].concat(item.artist || []).map(nzT).filter(Boolean);
  const song = nzT(item.song);
  const a = nzT(tr.yt ? tr.artist + ' ' + tr.title : tr.artist), t = nzT(tr.title);
  if (tr.yt && BAD_VIDEO.test(tr.title) && !BAD_VIDEO.test(String(item.song || ''))) return false;
  const artistOk = !artists.length || artists.some((x) => (' ' + a + ' ').includes(' ' + x + ' '));
  const songOk = !song || (' ' + t + ' ').includes(' ' + song + ' ');
  return artistOk && songOk;
}
function rankTracks(list, item) {
  if (list.length && list[0].yt) { const clean = list.filter((tr) => !BAD_VIDEO.test(tr.title) || BAD_VIDEO.test(String((item && item.song) || ''))); if (clean.length) list = clean; }
  if (!item || (!item.artist && !item.song)) return list;
  const good = list.filter((tr) => trackOk(tr, item));
  if (item.strict) return good; // pack « strict » : pas de bonne piste = on passe ce générique plutôt que de jouer un autre morceau
  return [...good, ...list.filter((tr) => !good.includes(tr))];
}

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
// éléments de personnage à débloquer avec le niveau du compte
const AV_LOCK = { acc: { 3: 2, 4: 3, 5: 5 }, style: { 4: 4 } };
function cleanAv(a, level) {
  if (!a || typeof a !== 'object') return null;
  const lim = { skin: 4, hair: 5, style: 4, shirt: 9, mouth: 1, acc: 5 }, out = {};
  for (const k of Object.keys(lim)) {
    const v = Number(a[k]);
    out[k] = Number.isInteger(v) && v >= 0 && v <= lim[k] && !((AV_LOCK[k] || {})[v] > (level || 1)) ? v : 0;
  }
  return out;
}
const levelOfAcct = (email) => (email ? levelOf((xpDb['acct:' + email] || {}).xp || 0) : 1);
const statKey = (p) => (p.acct ? 'acct:' + p.acct : keyOf(p.name));

// ---------- Comptes (e-mail + mot de passe) ----------
const ACC_FILE = path.join(__dirname, 'data', 'accounts.json');
let accDb = { users: {}, tokens: {} };
try { accDb = Object.assign(accDb, JSON.parse(fs.readFileSync(ACC_FILE, 'utf8'))); } catch (_) {}
function saveAcc() {
  try { fs.mkdirSync(path.dirname(ACC_FILE), { recursive: true }); fs.writeFileSync(ACC_FILE, JSON.stringify(accDb)); }
  catch (e) { console.error('Comptes non sauvegardés :', e.message); }
}
const crypto = require('crypto');
// Rôle unique « Fondateur » : seul ce compte enregistre les liens YouTube (empreinte du mail, FOUNDER_EMAIL pour le changer)
const FOUNDER_HASH = process.env.FOUNDER_HASH || '4231d7051a8fcda6615a2a878f92ce80cbd161af7f93c03dfd59a761520d3035';
const isFounder = (email) => !!email && (process.env.FOUNDER_EMAIL ? String(email).toLowerCase() === process.env.FOUNDER_EMAIL.toLowerCase() : crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex') === FOUNDER_HASH);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const emailOf = (token) => (token && accDb.tokens[token]) || null;
function newToken(email) {
  const t = crypto.randomBytes(24).toString('hex');
  accDb.tokens[t] = email;
  saveAcc();
  return t;
}
const failures = new Map(); // ip -> {n, t}
const weekNo = () => Math.floor((Date.now() / 86400000 + 3) / 7); // semaine (lundi → dimanche)
const BADGES = [
  { id: 'g1', icon: '🎮', name: 'Premier pas', desc: 'Jouer une partie', test: (e) => e.games >= 1 },
  { id: 'g10', icon: '🎧', name: 'Habitué', desc: 'Jouer 10 parties', test: (e) => e.games >= 10 },
  { id: 'w1', icon: '🥇', name: 'Première victoire', desc: 'Gagner une partie', test: (e) => e.wins >= 1 },
  { id: 'w5', icon: '🏆', name: 'Champion', desc: 'Gagner 5 parties', test: (e) => e.wins >= 5 },
  { id: 'w25', icon: '👑', name: 'Légende', desc: 'Gagner 25 parties', test: (e) => e.wins >= 25 },
  { id: 'a25', icon: '🎯', name: 'Oreille d\'or', desc: '25 bonnes réponses', test: (e) => e.goods >= 25 },
  { id: 'a100', icon: '🧠', name: 'Mélomane', desc: '100 bonnes réponses', test: (e) => e.goods >= 100 },
  { id: 's3', icon: '🔥', name: 'En feu', desc: '3 bonnes réponses d\'affilée', test: (e) => e.bestStreak >= 3 },
  { id: 's5', icon: '⚡', name: 'Inarrêtable', desc: '5 bonnes réponses d\'affilée', test: (e) => e.bestStreak >= 5 },
  { id: 'l5', icon: '⭐', name: 'Niveau 5', desc: 'Atteindre le niveau 5', test: (e) => levelOf(e.xp) >= 5 },
  { id: 'l10', icon: '🌟', name: 'Niveau 10', desc: 'Atteindre le niveau 10', test: (e) => levelOf(e.xp) >= 10 },
];
const entryOf = (k) => Object.assign({ xp: 0, games: 0, wins: 0, goods: 0, bestStreak: 0, packs: {}, week: 0, wWins: 0, wXp: 0 }, xpDb[k] || {});
function authInfo(email) {
  const u = accDb.users[email]; if (!u) return null;
  const e = entryOf('acct:' + email);
  const fav = Object.entries(e.packs || {}).sort((a, b) => b[1] - a[1])[0];
  const favPack = fav ? ((PACKS.find((p) => p.id === fav[0]) || {}).name || null) : null;
  return { email, founder: isFounder(email), pseudo: u.pseudo, avatar: u.avatar || null, xp: e.xp, level: levelOf(e.xp), games: e.games, wins: e.wins || 0, xpPerLevel: XP_PER_LEVEL,
    goods: e.goods, bestStreak: e.bestStreak, winRate: e.games ? Math.round((e.wins / e.games) * 100) : 0, favPack,
    weekWins: e.week === weekNo() ? e.wWins : 0, weekXp: e.week === weekNo() ? e.wXp : 0,
    badges: BADGES.map((b) => ({ id: b.id, icon: b.icon, name: b.name, desc: b.desc, owned: !!b.test(e) })) };
}
function auth(b, ip) {
  const op = b.op;
  if (op === 'me') { const em = emailOf(b.token); return em ? { ok: true, user: authInfo(em) } : { ok: false }; }
  if (op === 'board') {
    if (!emailOf(b.token)) return { error: 'Connecte-toi pour voir le scoreboard' };
    const me = emailOf(b.token);
    const all = Object.entries(accDb.users).map(([em, u]) => {
      const e = entryOf('acct:' + em), wk = e.week === weekNo();
      return { email: em, pseudo: u.pseudo, avatar: u.avatar || null, xp: e.xp, level: levelOf(e.xp), wins: e.wins || 0, games: e.games || 0, wW: wk ? e.wWins : 0, wX: wk ? e.wXp : 0 };
    });
    const rank = (arr, wk) => arr.map((r, i) => ({ rank: i + 1, pseudo: r.pseudo, avatar: r.avatar, xp: r.xp, level: r.level, wins: wk ? r.wW : r.wins, games: r.games, me: r.email === me }));
    const byWins = rank([...all].sort((x, y) => y.wins - x.wins || y.xp - x.xp || x.pseudo.localeCompare(y.pseudo)));
    const byXp = rank([...all].sort((x, y) => y.xp - x.xp || y.wins - x.wins || x.pseudo.localeCompare(y.pseudo)));
    const byWeek = rank([...all].sort((x, y) => y.wW - x.wW || y.wX - x.wX || x.pseudo.localeCompare(y.pseudo)), true);
    return { ok: true, total: all.length, wins: byWins.slice(0, 50), xp: byXp.slice(0, 50), week: byWeek.slice(0, 50), mineWins: byWins.find((r) => r.me), mineXp: byXp.find((r) => r.me), mineWeek: byWeek.find((r) => r.me) };
  }
  if (op === 'avatar') {
    const em = emailOf(b.token); if (!em) return { error: 'Non connecté' };
    accDb.users[em].avatar = cleanAv(b.avatar, levelOfAcct(em)); saveAcc(); return { ok: true };
  }
  if (op === 'logout') { if (b.token && accDb.tokens[b.token]) { delete accDb.tokens[b.token]; saveAcc(); } return { ok: true }; }
  const f = failures.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return { error: 'Trop d\'essais, réessaie dans quelques minutes' };
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  const pw = String(b.password || '').slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Adresse e-mail invalide' };
  if (op === 'register') {
    const pseudo = cleanName(b.pseudo);
    if (!pseudo) return { error: 'Choisis un pseudo valide (sans insulte)' };
    if (pw.length < 6) return { error: 'Mot de passe : 6 caractères minimum' };
    if (accDb.users[email]) return { error: 'Un compte existe déjà avec cet e-mail' };
    if (Object.values(accDb.users).some((u) => keyOf(u.pseudo) === keyOf(pseudo))) return { error: 'Ce pseudo est déjà pris par un autre compte' };
    const salt = crypto.randomBytes(16).toString('hex');
    accDb.users[email] = { pseudo, salt, hash: hashPw(pw, salt), created: Date.now() };
    // reprend l'XP déjà gagnée sous ce pseudo en invité (si le compte n'en a pas encore)
    const old = xpDb[keyOf(pseudo)];
    if (old && !xpDb['acct:' + email]) { xpDb['acct:' + email] = { name: pseudo, xp: old.xp, games: old.games, wins: old.wins || 0 }; saveXp(); }
    return { ok: true, token: newToken(email), user: authInfo(email) };
  }
  if (op === 'login') {
    const u = accDb.users[email];
    const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) { f.n++; failures.set(ip, f); return { error: 'E-mail ou mot de passe incorrect' }; }
    return { ok: true, token: newToken(email), user: authInfo(email) };
  }
  if (op === 'pseudo') {
    const em = emailOf(b.token); if (!em) return { error: 'Non connecté' };
    const pseudo = cleanName(b.pseudo); if (!pseudo) return { error: 'Choisis un pseudo valide (sans insulte)' };
    if (Object.entries(accDb.users).some(([e2, u]) => e2 !== em && keyOf(u.pseudo) === keyOf(pseudo))) return { error: 'Ce pseudo est déjà pris' };
    accDb.users[em].pseudo = pseudo; saveAcc();
    return { ok: true, user: authInfo(em) };
  }
  return { error: 'Requête invalide' };
}

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

// ---------- Modération : filtre de gros mots (pseudos + chat) ----------
const BAD_WORDS = ['con','cons','conne','connard','connards','connasse','salope','salopes','pute','putes','putain','pd','pede','pedes','encule','enculee','enculer','enfoire','enfoires','batard','batards','bite','bites','couille','couilles','nique','niquer','niquez','ntm','fdp','tg','merde','merdes','chienne','nazi','nazis','hitler','tapette','negro','nigger','nigga','negre','bougnoule','bougnoules','youpin','fuck','fucking','fucker','shit','bitch','bitches','cunt','faggot','fag','whore','slut','dick','asshole','rape','rapist','retard','cul','chiasse','sexe','porn','porno','branleur','branler','suce','sucer'];
const BAD_SUBSTR = ['connard','connasse','salope','enculer','enfoire','niquer','niquetamere','nique ta mere','fuck','bitch','nigger','nigga','pute','fdp','ntm','merde','putain','pedophile','hitler','nazi','bougnoul','negro','tarlouze','pétasse','petasse'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
const deAccent = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const deLeet = (t) => deAccent(t).replace(/[01345 7@$!]/g, (c) => (c === ' ' ? ' ' : LEET[c] || c));
function badTokens(text) { // « n!qu3 », « s a l o p e » : on teste mot par mot, collé, et en sous-chaîne pour les mots longs
  const t = deLeet(text), words = t.split(/[^a-z]+/).filter(Boolean);
  const hit = new Set();
  words.forEach((w) => { if (BAD_WORDS.includes(w)) hit.add(w); });
  const glued = t.replace(/[^a-z]/g, '');
  const sub = BAD_SUBSTR.filter((w) => w.length >= 5 && glued.includes(w.replace(/ /g, '')));
  return { words: [...hit], sub };
}
const isBad = (text) => { const r = badTokens(text); return r.words.length > 0 || r.sub.length > 0; };
function maskBad(text) { // chat : on remplace les mots interdits par des étoiles
  let out = String(text).split(/(\s+)/).map((w) => (isBad(w) ? '*'.repeat(Math.min(w.length, 8)) : w)).join('');
  if (isBad(out)) out = out.replace(/[^\s]/g, '*'); // contournement par espaces : tout est masqué
  return out;
}
function cleanName(n) {
  const v = String(n || '').replace(/[<>]/g, '').trim().slice(0, 16);
  return isBad(v) ? '' : v;
}

function packOf(room) {
  if (room.packId === 'mix' && room.mixPack) return room.mixPack;
  return room.packId === 'custom' ? room.customPack : PACKS.find((p) => p.id === room.packId);
}
function packLength(room) {
  if (room.order) return room.order.length; // salle de tournoi : sous-ensemble du pack
  const pack = packOf(room);
  return pack ? Math.min(pack.items.length, pack.limit || Infinity) : 0;
}
function perManche(room) { return Math.max(1, Math.ceil(packLength(room) / room.manches)); }
function manchesTotal(room) { return Math.max(1, Math.ceil(packLength(room) / perManche(room))); }
function fixManches(room) {
  const len = packLength(room);
  if (room.manches > len) room.manches = Math.max(...MANCHES_OPTIONS.filter((m) => m <= len), 1);
}
const clean = (x, n) => String(x == null ? '' : x).replace(/[<>]/g, '').trim().slice(0, n);
function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } room.deadline = null; }
function snapshotManche(room) {
  room.mancheBase = {};
  for (const p of room.players.values()) room.mancheBase[p.id] = p.score;
}
function buildRecap(room) {
  const all = [...room.players.values()].filter((p) => p.id !== room.ownerId).sort((a, b) => b.score - a.score);
  const mancheNo = Math.floor(room.idx / perManche(room));
  const fresh = new Set();
  if (room.mode === 'tournament') { // on garde la moitié la mieux classée (égalités gardées)
    const alive = all.filter((p) => !p.elim);
    if (alive.length > 2) {
      const keep = Math.max(2, Math.ceil(alive.length / 2));
      const cut = alive[keep - 1].score;
      for (const p of alive.slice(keep)) { if (p.score < cut) { p.elim = true; p.elimRound = mancheNo; fresh.add(p.id); } }
    }
  }
  return all.map((p, i) => ({ id: p.id, name: p.name, total: p.score, gain: p.score - (room.mancheBase[p.id] || 0), rank: i + 1, elim: !!p.elim, fresh: fresh.has(p.id) }));
}

// ---------- Détection de la réponse parlée ----------
const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// clé phonétique (français approximatif) : « naruto » ≈ « naruto », « pokémone » ≈ « pokemon », « dragonne bol » ≈ « dragon ball »
function phon(t) {
  return String(t).replace(/\s+/g, '')
    .replace(/ph/g, 'f').replace(/qu|k/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/g(?=[eiy])/g, 'j')
    .replace(/ch|sh/g, 'x').replace(/w/g, 'v').replace(/y/g, 'i').replace(/h/g, '')
    .replace(/eau|au/g, 'o').replace(/ou/g, 'u').replace(/oi/g, 'ua').replace(/ai|ei|er|ez|et/g, 'e')
    .replace(/(a|e)(n|m)(?![aeiou])/g, 'a').replace(/(o)(n|m)(?![aeiou])/g, 'o').replace(/(i|u)(n|m)(?![aeiou])/g, 'e')
    .replace(/(.)\1+/g, '$1').replace(/e+$/, '').replace(/[sxtdz]+$/, '');
}
function matchesAnswer(item, heard) {
  const h = norm(heard); if (!h || !item) return false;
  const words = h.split(' ');
  const list = [...new Set([...(item.accepted || []), item.title].map(norm).filter(Boolean))];
  return list.some((a) => {
    const n = a.split(' ').length, aj = a.replace(/ /g, ''), ap = phon(a);
    for (let m = Math.max(1, n - 1); m <= n + 1; m++) {
      for (let i = 0; i + m <= words.length; i++) {
        const w = words.slice(i, i + m).join(' '), wj = w.replace(/ /g, '');
        if (w === a || wj === aj) return true;
        if (aj.length >= 5) {
          if (lev(wj, aj) <= Math.floor(aj.length / 6)) return true; // petite erreur de reconnaissance
          const wp = phon(w);
          if (ap.length >= 4 && lev(wp, ap) <= Math.floor(ap.length / 5)) return true; // ça sonne pareil
        }
      }
    }
    return false;
  });
}

// ---------- Juge IA (optionnel, gratuit possible) ----------
// Sans clé : le juge local (phonétique + fautes de frappe) décide seul — gratuit et sans limite.
// Avec une clé GRATUITE (Google Gemini ou Groq) : l'IA tranche les cas où le juge local dit « non ».
// Si l'IA est indisponible ou a atteint sa limite gratuite, on retombe automatiquement sur le juge local.
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
function postJson(host, pth, headers, body) {
  return new Promise((resolve) => {
    const https = require('https'); const data = JSON.stringify(body);
    const req = https.request({ hostname: host, path: pth, method: 'POST', timeout: 3500, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(res.statusCode < 300 ? JSON.parse(d) : null); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}
async function aiJudge(item, heard) {
  if (!GEMINI_KEY && !GROQ_KEY) return null;
  const prompt = `Blind test. Bonne réponse attendue : « ${item.title} »` + ((item.accepted || []).length ? ` (aussi acceptés : ${item.accepted.join(', ')})` : '') +
    `.\nLe joueur a dit à voix haute (transcription automatique, souvent déformée) : « ${heard} ».\n` +
    'Le joueur désigne-t-il bien cette œuvre ? Sois tolérant sur l\'orthographe, les accents, les mots mal transcrits et les titres alternatifs, mais refuse une autre œuvre. Réponds uniquement par OUI ou NON.';
  let txt = null;
  if (GEMINI_KEY) {
    const r = await postJson('generativelanguage.googleapis.com', `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`, {},
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 5, temperature: 0 } });
    try { txt = r.candidates[0].content.parts[0].text; } catch (_) {}
  }
  if (txt == null && GROQ_KEY) {
    const r = await postJson('api.groq.com', '/openai/v1/chat/completions', { authorization: 'Bearer ' + GROQ_KEY },
      { model: GROQ_MODEL, max_tokens: 5, temperature: 0, messages: [{ role: 'user', content: prompt }] });
    try { txt = r.choices[0].message.content; } catch (_) {}
  }
  if (txt == null) return null;
  return /^\s*(oui|yes|true)/i.test(txt);
}
const FILLER = /^(euh+|heu+|hum+|hmm+|ah+|oh+|ben|bah|alors|je sais|c est|attends?|attend|donc|le|la|les|un|une)?$/;
const isGold = (room) => (room.idx + 1) % 5 === 0 && packLength(room) >= 5; // 1 générique sur 5 : points doublés
function resetStreaks(room, exceptId) { for (const x of room.players.values()) if (x.id !== exceptId) x.streak = 0; }
function doValidate(room, byVoice) {
  const p = room.players.get(room.buzzer);
  clearTimer(room);
  const mult = isGold(room) ? 2 : 1;
  resetStreaks(room, p.id);
  p.streak = (p.streak || 0) + 1; p.goods = (p.goods || 0) + 1; p.bestStreak = Math.max(p.bestStreak || 0, p.streak);
  const bonus = p.streak >= 3 ? Math.min(150, (p.streak - 2) * 50) : 0; // série de bonnes réponses d'affilée
  const delta = POINTS_OK * mult + bonus;
  p.score += delta;
  if (!p.firstOk) p.firstOk = Date.now();
  room.lastResult = { type: 'ok', playerId: p.id, name: p.name, delta, bonus, streak: p.streak, gold: mult > 1, voice: !!byVoice };
  room.phase = 'reveal';
  room.media = null;
  room.buzzer = null;
}

// Refus d'une réponse (par l'owner, ou automatiquement au bout de ANSWER_TIME s)
function applyRefuse(room, timeout, byVoice) {
  const p = room.players.get(room.buzzer);
  clearTimer(room);
  const delta = POINTS_KO * (isGold(room) ? 2 : 1);
  p.score += delta; p.streak = 0;
  room.lockedOut.add(p.id);
  room.lastResult = { type: 'ko', playerId: p.id, name: p.name, delta, gold: isGold(room), timeout: !!timeout, voice: !!byVoice };
  room.buzzer = null;
  const remaining = [...room.players.values()].filter((x) => x.id !== room.ownerId && !room.lockedOut.has(x.id));
  if (remaining.length === 0) { room.phase = 'reveal'; room.media = null; resetStreaks(room); }
  else { room.phase = 'playing'; room.playStart = Date.now(); }
}

function hintOf(title) { // « Dragon Ball » → « D _ _ _ _ _   B _ _ _ »
  return String(title).split(' ').map((w) => [...w].map((c, i) => (i === 0 || !/[\p{L}\p{N}]/u.test(c) ? c : '_')).join(' ')).join('   ');
}
function elapsedNow(room) {
  return room.elapsed + (room.phase === 'playing' && room.playStart ? (Date.now() - room.playStart) / 1000 : 0);
}

function currentItem(room) {
  const pack = packOf(room);
  if (!pack) return null;
  return pack.items[room.order ? room.order[room.idx] : room.idx] || null;
}

// Applique la piste candidate courante (room.cand[room.candIdx]) comme média du générique
function applyCandidate(room) {
  const c = room.cand[room.candIdx];
  room.media = c ? (c.yt ? { type: 'yt', id: c.yt, offset: c.offset || 0 } : { type: 'file', src: c.src }) : null;
  room.trackInfo = c ? `${c.title} — ${c.artist}` : null;
  if (room.phase === 'playing') { room.elapsed = 0; room.playStart = Date.now(); } // la piste arrive/change pendant l'écoute : on repart du début
}

// Tournoi : le générique démarre tout seul dès que l'extrait est trouvé (l'owner n'a que les validations à gérer)
// Décompte de 3 secondes avant le lancement de chaque générique (tous les modes)
function startCountdown(room) {
  clearTimer(room);
  if (COUNTDOWN_MS <= 0) { room.phase = 'playing'; room.playStart = Date.now(); return; }
  room.phase = 'countdown';
  room.cdEnd = Date.now() + COUNTDOWN_MS;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.phase === 'countdown') { room.phase = 'playing'; room.playStart = Date.now(); broadcast(room); }
  }, COUNTDOWN_MS);
}
function autoPlay(room) {
  if (room.phase !== 'idle' || !room.media) return;
  startCountdown(room);
  broadcast(room);
}
// Tournoi : cherche à l'avance l'extrait du générique suivant pour éviter l'attente entre deux génériques
function prefetchNext(room) {
  const pack = packOf(room);
  const nx = pack && pack.items[room.order ? room.order[room.idx + 1] : room.idx + 1];
  if (nx && !mediaOf(nx.media)) enqueue(() => searchTracks(nx.search || nx.title)).catch(() => {});
}

// Lance la recherche de l'extrait du générique courant (en arrière-plan)
function resolveRound(room) {
  const token = ++room.roundToken;
  const item = currentItem(room);
  room.cand = []; room.candIdx = 0; room.trackInfo = null; room.resolving = false;
  room.media = mediaOf(item && item.media); // média explicite éventuel (lien YouTube ou fichier du dossier media/)
  room.saved = false;
  const sv = !room.media && ovr[ovrKey(room, item)];
  if (sv) { // lien YouTube enregistré par l'owner : plus aucune recherche pour ce générique
    room.media = { type: 'yt', id: sv.id, offset: sv.offset || 0 }; room.saved = true;
    room.cand = [{ title: 'Lien enregistré', artist: 'owner', yt: sv.id, offset: sv.offset || 0, src: 'https://www.youtube.com/watch?v=' + sv.id }];
    room.trackInfo = '💾 Lien enregistré par l\'owner';
    if (room.auto) setTimeout(() => { if (room.roundToken === token) autoPlay(room); }, 700);
    return;
  }
  if (room.media) { room.trackInfo = 'Source fixée dans le pack'; if (room.auto) setTimeout(() => { if (room.roundToken === token) autoPlay(room); }, 700); return; }
  if (!item) return;
  if (room.auto) prefetchNext(room);
  room.resolving = true;
  enqueue(async () => {
    if (room.roundToken !== token) return; // le générique a changé entre-temps
    let list = [];
    try { list = rankTracks(await searchTracks(item.search || item.title), item); } catch (e) { console.error('Recherche audio :', e.message); }
    if (room.roundToken !== token) return;
    room.cand = list; room.candIdx = 0; room.resolving = false;
    applyCandidate(room);
    if (room.auto) autoPlay(room);
    if (room.quick && !room.media) setTimeout(() => { if (room.roundToken === token && room.phase === 'idle') act({ action: 'skip', pid: room.ownerId, code: room.code }); }, 600);
    broadcast(room);
  });
}

function view(room, pid) {
  const isOwner = pid === room.ownerId;
  const pack = packOf(room);
  const item = currentItem(room);
  const revealed = room.phase === 'reveal' || room.phase === 'end';
  const players = [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, score: p.score, connected: p.connected, bot: !!p.bot,
    lockedOut: room.lockedOut.has(p.id), elim: !!p.elim, isOwner: p.id === room.ownerId, avatar: p.avatar || null,
    wins: p.bot ? 0 : ((xpDb[statKey(p)] || {}).wins || 0),
    founder: isFounder(p.acct), ready: !!p.ready, streak: p.streak || 0, team: p.team == null ? null : p.team, level: p.bot || p.house ? 1 : levelOf((xpDb[statKey(p)] || {}).xp || 0),
  })).filter((p) => !room.players.get(p.id).house);
  const teams = room.mode === 'teams' && room.phase !== 'lobby' ? {
    defs: TEAMS, scores: TEAMS.map((_, t) => [...room.players.values()].filter((p) => p.team === t).reduce((a, p) => a + p.score, 0)),
  } : null;
  return {
    code: room.code, me: pid, isOwner, phase: room.phase, maxPlayers: maxOf(room), mode: room.mode,
    packs: [...PACKS, ...(room.customPack ? [room.customPack] : [])]
      .map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, count: Math.min(p.items.length, p.limit || Infinity), custom: p.id === 'custom' })),
    packId: room.packId, packName: pack ? pack.name : null, total: pack ? packLength(room) : 0,
    salleName: room.salleName || null, stageLabel: room.stageLabel || null, paused: !!room.paused, winnerId: room.winnerId || null,
    recapTitle: room.phase === 'recap' ? (room.recapTitle || null) : null,
    round: room.idx + 1, players, buzzer: room.buzzer,
    manches: room.manches, manchesTotal: manchesTotal(room), manchesOptions: MANCHES_OPTIONS.filter((m) => m <= packLength(room)),
    perManche: perManche(room),
    manche: Math.min(Math.floor(room.idx / perManche(room)) + 1, manchesTotal(room)),
    resolving: isOwner ? room.resolving : undefined,
    trackInfo: isOwner ? room.trackInfo : undefined, savedLink: isOwner ? !!room.saved : undefined,
    cands: isOwner ? room.cand.slice(0, 8).map((c, i) => ({ i, title: String(c.title).slice(0, 90), artist: String(c.artist || '').slice(0, 40), yt: c.yt || null })) : undefined,
    candCount: isOwner ? room.cand.length : undefined, candIdx: isOwner ? room.candIdx : undefined,
    roundInManche: (room.idx % perManche(room)) + 1,
    answerTime: ANSWER_TIME, voiceAuto: !!room.voiceAuto,
    heard: room.phase === 'answering' ? (room.heard || '') : '',
    answerMs: room.phase === 'answering' && room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    recap: room.phase === 'recap' ? room.recap : null,
    finishedManche: room.phase === 'recap' ? Math.floor(room.idx / perManche(room)) : null,
    answer: item && (isOwner || revealed) ? item.title : null,
    playing: room.phase === 'playing' && !room.paused && !room.musicPaused, musicPaused: !!room.musicPaused,
    media: room.media, startAt: (room.phase === 'playing' ? Math.floor(room.elapsed) : 0) + ((room.media && room.media.offset) || 0),
    lastResult: room.lastResult,
    results: room.phase === 'end' ? room.results : null,
    pointsOk: POINTS_OK, pointsKo: POINTS_KO,
    gold: ['idle', 'countdown', 'playing', 'answering'].includes(room.phase) && isGold(room),
    cdMs: room.phase === 'countdown' ? Math.max(0, room.cdEnd - Date.now()) : null,
    hint: !isOwner && ['playing', 'answering'].includes(room.phase) && item && elapsedNow(room) >= HINT_AT ? hintOf(item.title) : null,
    reacts: room.reacts || [], chat: room.phase === 'lobby' ? (room.chat || []) : [],
    locked: !!room.pw, quick: !!room.quick, teams, teamResult: room.phase === 'end' ? (room.teamResult || null) : null,
    startIn: room.phase === 'lobby' && room.startAt ? Math.max(0, room.startAt - Date.now()) : null,
    readyCount: [...room.players.values()].filter((p) => p.ready && p.id !== room.ownerId).length,
  };
}

// Vue envoyée à un client : en tournoi pendant les sélections / la finale, l'owner reçoit les salles, chaque joueur reçoit SA salle
function viewFor(room, pid) {
  if (room.children && (room.phase === 'selection' || room.phase === 'final')) {
    if (pid === room.ownerId) return { ...view(room, pid), phase: 'tourney', stage: room.phase, stageLabel: room.stageLabel, salles: room.children.map((c) => view(c, pid)) };
    const ch = room.children.find((c) => c.players.has(pid)) || (room.phase === 'final' ? room.children[0] : null);
    if (ch) return { ...view(ch, pid), code: room.code, spectator: !ch.players.has(pid), stage: room.phase };
  }
  return view(room, pid);
}

function broadcast(room) {
  if (room.quick) quickHook(room);
  if (room.parent) { childHook(room); return broadcast(room.parent); }
  const set = clients.get(room.code);
  if (!set) return;
  for (const [pid, res] of set) {
    res.write(`data: ${JSON.stringify(viewFor(room, pid))}\n\n`);
  }
}

function finishGame(room) {
  if (room.mode === 'teams') { // équipe gagnante = meilleur total ; ses joueurs passent devant au classement
    const guests = guestsOf(room);
    const tot = TEAMS.map((_, t) => guests.filter((p) => p.team === t).reduce((a, p) => a + p.score, 0));
    const win = tot[0] === tot[1] ? -1 : tot[0] > tot[1] ? 0 : 1;
    guests.forEach((p) => { p.teamWin = p.team === win; });
    room.teamResult = { defs: TEAMS, scores: tot, winner: win };
    return finishWith(room, guests.sort((a, b) => (Number(b.teamWin) - Number(a.teamWin)) || (b.score - a.score)));
  }
  const ranked = [...room.players.values()]
    .filter((p) => p.id !== room.ownerId)
    .sort((a, b) => (!!a.elim - !!b.elim) || (a.elim ? (b.elimRound - a.elimRound) : 0) || (b.score - a.score));
  finishWith(room, ranked);
}
function finishWith(room, ranked) {
  const bonus = [50, 30, 15];
  room.results = ranked.map((p, i) => {
    if (p.bot) { // les bots de test ne gagnent pas d'XP
      return { id: p.id, name: p.name, score: p.score, rank: i + 1, gained: 0, xpBefore: 0, xpAfter: 0, levelBefore: 1, levelAfter: 1, xpPerLevel: XP_PER_LEVEL };
    }
    const gained = 20 + Math.max(0, Math.floor(p.score / 10)) + (bonus[i] || 0);
    const k = statKey(p);
    const e = entryOf(k), before = e.xp, won = room.mode === 'teams' ? !!p.teamWin : i === 0, wk = weekNo();
    if (e.week !== wk) { e.week = wk; e.wWins = 0; e.wXp = 0; }
    const pk = room.packId || 'custom'; e.packs[pk] = (e.packs[pk] || 0) + 1;
    xpDb[k] = { ...e, name: p.name, xp: before + gained, games: e.games + 1, wins: e.wins + (won ? 1 : 0), goods: e.goods + (p.goods || 0),
      bestStreak: Math.max(e.bestStreak, p.bestStreak || 0), wWins: e.wWins + (won ? 1 : 0), wXp: e.wXp + gained };
    return {
      id: p.id, name: p.name, score: p.score, rank: i + 1, gained, team: p.team == null ? null : p.team,
      xpBefore: before, xpAfter: before + gained,
      levelBefore: levelOf(before), levelAfter: levelOf(before + gained), xpPerLevel: XP_PER_LEVEL,
    };
  });
  saveXp();
  room.phase = 'end';
  room.media = null;
}

function startRound(room) {
  room.hintIdx = -1;
  room.musicPaused = false;
  room.phase = 'idle';
  room.buzzer = null;
  room.lockedOut = new Set();
  room.elapsed = 0;
  room.playStart = null;
  room.lastResult = null;
  resolveRound(room);
}

// ---------- Tournoi : salles de 4 (quarts), pause des autres salles pendant une réponse, puis finale ----------
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const guestsOf = (room) => [...room.players.values()].filter((p) => p.id !== room.ownerId);

function makeSalle(T, name, stageLabel, players, order) {
  const room = {
    code: T.code + T.all.length, parent: T, mode: 'tournament', ownerId: T.ownerId, players: new Map(), phase: 'idle', reacts: [], chat: [],
    packId: T.packId, customPack: T.customPack, mixPack: T.mixPack, order, idx: 0, buzzer: null, lockedOut: new Set(), media: null, elapsed: 0, playStart: null,
    lastResult: null, results: null, manches: 1, deadline: null, timer: null, mancheBase: {}, recap: null, voiceAuto: T.voiceAuto,
    heard: '', cand: [], candIdx: 0, trackInfo: null, resolving: false, roundToken: 0, auto: true, paused: false,
    salleName: name, stageLabel, winnerId: null,
  };
  room.players.set(T.ownerId, T.players.get(T.ownerId));
  for (const p of players) { p.score = 0; p.firstOk = null; room.players.set(p.id, p); }
  rooms.set(room.code, room);
  T.all.push(room);
  return room;
}

function startTournament(T) {
  const guests = shuffle(guestsOf(T));
  const L = packLength(T), n = guests.length;
  const sh = shuffle([...Array(L).keys()]);
  let cur = 0;
  const take = (k) => Array.from({ length: k }, () => sh[cur++ % L]);
  for (const p of guests) { p.elim = false; p.elimRound = 0; p.score = 0; }
  T.all = []; T.winners = null;
  if (n <= 4) { // pas assez de joueurs pour des sélections : on joue directement la finale
    T.children = [makeSalle(T, 'Finale', 'Finale', guests, take(L))];
    T.phase = 'final';
  } else {
    const S = Math.min(4, Math.ceil(n / 4));
    const fc = Math.max(1, Math.min(4, Math.floor(L / 5)));
    const per = Math.max(1, Math.floor((L - fc) / S));
    const groups = Array.from({ length: S }, () => []);
    guests.forEach((p, i) => groups[i % S].push(p));
    const label = S === 4 ? 'Quart de finale' : S === 2 ? 'Demi-finale' : 'Sélection';
    T.finalOrder = null;
    const orders = groups.map(() => take(per));
    T.finalOrder = take(fc);
    T.children = groups.map((g, i) => makeSalle(T, 'Salle ' + 'ABCD'[i], label, g, orders[i]));
    T.phase = 'selection';
  }
  T.stageLabel = T.children[0].stageLabel;
  T.children.forEach((c) => startRound(c));
}

function startFinal(T) {
  const winners = T.winners || [];
  T.children = [makeSalle(T, 'Finale', 'Finale', winners, T.finalOrder)];
  T.stageLabel = 'Finale';
  T.phase = 'final';
  T.recap = null;
  startRound(T.children[0]);
}

function finishChild(room) {
  clearTimer(room);
  room.phase = 'done';
  room.media = null;
  room.buzzer = null;
  const g = guestsOf(room).sort((a, b) => (b.score - a.score) || ((a.firstOk || Infinity) - (b.firstOk || Infinity)));
  room.winnerId = g[0] ? g[0].id : null;
}

function finishTournament(T) {
  const F = T.children[0];
  const fin = guestsOf(F).sort((a, b) => (b.score - a.score) || ((a.firstOk || Infinity) - (b.firstOk || Infinity)));
  const rest = guestsOf(T).filter((p) => !F.players.has(p.id)).sort((a, b) => b.score - a.score);
  T.children = null;
  finishWith(T, [...fin, ...rest]);
}

// Met en pause les salles qui écoutent tant qu'une salle a un joueur en train de répondre
function syncPause(T) {
  const any = T.children.some((c) => c.phase === 'answering');
  for (const c of T.children) {
    if (c.phase === 'playing') {
      if (any && !c.paused) { c.elapsed = elapsedNow(c); c.playStart = null; c.paused = true; }
      else if (!any && c.paused) { c.paused = false; c.playStart = Date.now(); }
    } else if (c.paused) c.paused = false;
  }
}
function checkProgress(T) {
  if (!T.children) return;
  if (!T.children.every((c) => c.phase === 'done')) return;
  if (T.phase === 'selection') {
    const winners = T.children.map((c) => T.players.get(c.winnerId)).filter(Boolean);
    T.winners = winners;
    T.recap = T.children.flatMap((c) => guestsOf(c).sort((a, b) => b.score - a.score).slice(0, 1).map((p) => ({
      id: p.id, name: p.name, total: p.score, gain: 0, rank: 0, elim: false, fresh: false, sub: c.salleName + ' · vainqueur',
    }))).sort((a, b) => b.total - a.total).map((r, i) => ({ ...r, rank: i + 1 }));
    T.recapTitle = `Fin des sélections : voici les ${winners.length} finalistes`;
    T.children = null; // plus de salles actives : écran récap commun
    T.phase = 'recap';
    T.media = null;
  } else if (T.phase === 'final') finishTournament(T);
}
// Appelé à chaque diffusion d'une salle : enchaînement automatique + pause
function childHook(room) {
  const T = room.parent;
  if (room.phase === 'reveal' && room.revealIdx !== room.idx) {
    room.revealIdx = room.idx;
    setTimeout(() => { if (room.phase === 'reveal' && room.idx === room.revealIdx) act({ action: 'next', pid: room.ownerId, code: room.code }); }, REVEAL_MS);
  }
  if (T.children) { syncPause(T); checkProgress(T); }
}

// ---------- Partie rapide (matchmaking) ----------
function quickCheck(room) {
  if (!room.quick || room.phase !== 'lobby') return;
  const g = guestsOf(room), n = g.length;
  if (n >= MAX_PLAYERS) return startQuick(room);
  if (n < 2) { clearTimeout(room.qTimer); room.qTimer = null; room.startAt = null; return; }
  let at = room.startAt || Date.now() + QUICK_WAIT_MS;
  if (g.every((p) => p.ready)) at = Math.min(at, Date.now() + 3000); // tout le monde est prêt : on accélère
  if (room.startAt !== at) { room.startAt = at; clearTimeout(room.qTimer); room.qTimer = setTimeout(() => startQuick(room), Math.max(0, at - Date.now())); }
}
function startQuick(room) {
  clearTimeout(room.qTimer); room.qTimer = null;
  if (room.phase !== 'lobby') return;
  const g = guestsOf(room);
  if (g.length < 2) { room.startAt = null; return broadcast(room); }
  room.startAt = null;
  if (room.packId === 'mix') room.mixPack = buildMix();
  for (const p of room.players.values()) { p.score = 0; p.goods = 0; p.streak = 0; p.bestStreak = 0; p.ready = false; }
  room.order = shuffle([...Array(packLength(room)).keys()]).slice(0, QUICK_ROUNDS);
  room.idx = 0; snapshotManche(room); startRound(room); broadcast(room);
}
function quickHook(room) {
  if (room.phase === 'reveal' && room.revealIdx !== room.idx && guestsOf(room).some((p) => p.connected)) {
    room.revealIdx = room.idx;
    setTimeout(() => { if (room.phase === 'reveal' && room.idx === room.revealIdx) act({ action: 'next', pid: room.ownerId, code: room.code }); }, REVEAL_MS);
  }
}
// indice automatique : toutes les secondes on regarde si un générique dépasse HINT_AT s d'écoute
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.phase === 'playing' && !r.paused && r.hintIdx !== r.idx && elapsedNow(r) >= HINT_AT) { r.hintIdx = r.idx; broadcast(r); }
  }
}, 1000).unref();

// ---------- Actions ----------
function act(body) {
  const { action } = body;
  const pid = String(body.pid || '');
  if (!pid) return { error: 'Identifiant manquant' };

  if (action === 'create') {
    refreshPacks();
    const acct = emailOf(body.token);
    const name = acct ? accDb.users[acct].pseudo : cleanName(body.name);
    if (!name) return { error: 'Choisis un pseudo valide (sans insulte)' };
    const room = {
      code: code(), mode: ['tournament', 'teams'].includes(body.mode) ? body.mode : 'classic', pw: clean(body.password, 20) || '', chat: [], reacts: [], ownerId: pid, players: new Map(), phase: 'lobby', packId: PACKS[0].id,
      idx: 0, buzzer: null, lockedOut: new Set(), media: null, elapsed: 0, playStart: null,
      lastResult: null, results: null, manches: body.mode === 'tournament' ? 4 : 2, deadline: null, timer: null, mancheBase: {}, recap: null,
      all: [], children: null, customPack: null, voiceAuto: true, heard: '', cand: [], candIdx: 0, trackInfo: null, resolving: false, roundToken: 0,
    };
    room.players.set(pid, { id: pid, name, acct, avatar: cleanAv(body.avatar, levelOfAcct(acct)) || undefined, score: 0, connected: false });
    rooms.set(room.code, room);
    return { ok: true, code: room.code };
  }

  if (action === 'quick') { // matchmaking : rejoint une partie publique en attente, sinon en crée une (sans owner : la partie s'enchaîne toute seule)
    refreshPacks();
    const acct = emailOf(body.token);
    const name = acct ? accDb.users[acct].pseudo : cleanName(body.name);
    if (!name) return { error: 'Choisis un pseudo valide (sans insulte)' };
    for (const r of rooms.values()) { // déjà dans une partie rapide ? on y retourne
      if (r.quick && r.players.has(pid) && r.phase !== 'end') return { ok: true, code: r.code };
    }
    let room = [...rooms.values()].filter((r) => r.quick && r.phase === 'lobby' && guestsOf(r).length < MAX_PLAYERS && !guestsOf(r).some((p) => keyOf(p.name) === keyOf(name)))
      .sort((a, b) => guestsOf(b).length - guestsOf(a).length)[0];
    if (!room) {
      const c = code(), pool = PACKS.filter((p) => p.id !== 'mix');
      room = {
        code: c, mode: 'classic', quick: true, auto: true, pw: '', chat: [], reacts: [], ownerId: 'house' + c, players: new Map(), phase: 'lobby',
        packId: pool[Math.floor(Math.random() * pool.length)].id, idx: 0, buzzer: null, lockedOut: new Set(), media: null, elapsed: 0, playStart: null,
        lastResult: null, results: null, manches: 1, deadline: null, timer: null, mancheBase: {}, recap: null,
        all: [], children: null, customPack: null, voiceAuto: true, heard: '', cand: [], candIdx: 0, trackInfo: null, resolving: false, roundToken: 0,
      };
      room.players.set(room.ownerId, { id: room.ownerId, name: 'Maison', score: 0, connected: true, house: true });
      rooms.set(c, room);
    }
    room.players.set(pid, { id: pid, name, acct, avatar: cleanAv(body.avatar, levelOfAcct(acct)) || undefined, score: 0, connected: false });
    quickCheck(room);
    return { ok: true, code: room.code };
  }

  const room = rooms.get(String(body.code || '').toUpperCase());
  if (!room) return { error: 'Salon introuvable' };

  if (action === 'join') {
    const acct = emailOf(body.token);
    const name = acct ? accDb.users[acct].pseudo : cleanName(body.name);
    if (!name) return { error: 'Choisis un pseudo valide (sans insulte)' };
    const existing = room.players.get(pid);
    if (existing) { existing.name = name; existing.acct = acct; if (body.avatar) existing.avatar = cleanAv(body.avatar, levelOfAcct(acct)); return { ok: true, code: room.code }; }
    if ((room.banned && room.banned.has(pid)) || (room.bannedNames && room.bannedNames.has(keyOf(name)))) return { error: 'Tu as été exclu de ce salon' };
    if (room.phase !== 'lobby') return { error: 'La partie a déjà commencé' };
    if (room.pw && clean(body.password, 20) !== room.pw) return { error: body.password ? 'Mot de passe incorrect' : 'Salon privé : entre le mot de passe', needPw: true };
    const nonOwner = [...room.players.values()].filter((p) => p.id !== room.ownerId).length;
    if (nonOwner >= maxOf(room)) return { error: `Salon complet (${maxOf(room)} joueurs max)` };
    if ([...room.players.values()].some((p) => keyOf(p.name) === keyOf(name))) return { error: 'Ce pseudo est déjà pris dans le salon' };
    room.players.set(pid, { id: pid, name, acct, avatar: cleanAv(body.avatar, levelOfAcct(acct)) || undefined, score: 0, connected: false });
    if (room.quick) quickCheck(room);
    broadcast(room);
    return { ok: true, code: room.code };
  }

  const me = room.players.get(pid);
  if (!me) return { error: 'Tu ne fais pas partie de ce salon' };
  const isOwner = pid === room.ownerId;

  // Tournoi : les actions des joueurs vont dans leur salle ; l'owner désigne la salle avec body.salle
  if (room.mode === 'tournament' && room.children && (room.phase === 'selection' || room.phase === 'final')) {
    if (action === 'buzz' || action === 'heard' || action === 'react') {
      const ch = room.children.find((c) => c.players.has(pid));
      if (!ch) return { error: 'Tu ne joues pas dans cette salle' };
      return act({ ...body, code: ch.code });
    }
    if (isOwner && body.salle != null) {
      const ch = room.children[Number(body.salle)];
      if (!ch) return { error: 'Salle inconnue' };
      return act({ ...body, code: ch.code });
    }
  }

  if (action === 'buzz') {
    if (isOwner) return { error: 'L\'owner ne buzz pas' };
    if (room.phase !== 'playing') return { error: 'Trop tôt ou trop tard' };
    if (room.paused) return { error: 'Une autre salle est en train de répondre, patiente…' };
    if (room.musicPaused) return { error: 'Musique en pause' };
    if ((room.players.get(pid) || {}).elim) return { error: 'Tu es éliminé du tournoi' };
    if (room.lockedOut.has(pid)) return { error: 'Tu as déjà été refusé sur ce générique' };
    room.elapsed = elapsedNow(room);
    room.playStart = null;
    room.buzzer = pid;
    room.heard = ''; room.judging = false;
    room.phase = 'answering';
    room.deadline = Date.now() + ANSWER_TIME * 1000;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.phase === 'answering' && room.buzzer) { applyRefuse(room, true); broadcast(room); }
    }, ANSWER_TIME * 1000);
    broadcast(room);
    return { ok: true };
  }

  if (action === 'heard') {
    if (room.phase !== 'answering' || room.buzzer !== pid) return { error: 'Pas ton tour' };
    room.heard = clean(body.text, 90);
    const item = currentItem(room);
    if (room.voiceAuto && matchesAnswer(item, room.heard)) doValidate(room, true);
    else if (room.voiceAuto && body.final && item && !FILLER.test(norm(room.heard)) && !room.judging) {
      // phrase terminée et ça ne ressemble pas à la bonne réponse : l'IA (ou le juge local) tranche
      room.judging = true;
      const who = room.buzzer, idx = room.idx, heard = room.heard;
      aiJudge(item, heard).then((ok) => {
        room.judging = false;
        if (room.phase !== 'answering' || room.buzzer !== who || room.idx !== idx) return; // l'owner ou le chrono a déjà tranché
        if (ok === true) doValidate(room, true); else applyRefuse(room, false, true);
        broadcast(room);
      });
    }
    broadcast(room);
    return { ok: true };
  }

  if (action === 'chat') {
    if (room.phase !== 'lobby') return { error: 'Le chat est dans le lobby' };
    const t = maskBad(clean(body.text, 140)); if (!t) return { error: 'Message vide' };
    const now = Date.now(); if (me.lastChat && now - me.lastChat < 500) return { error: 'Doucement…' };
    me.lastChat = now;
    room.chat = [...(room.chat || []), { n: me.name, t, s: (room.chatSeq = (room.chatSeq || 0) + 1) }].slice(-40);
    broadcast(room); return { ok: true };
  }
  if (action === 'ready') {
    if (room.phase !== 'lobby' || isOwner) return { error: 'Impossible' };
    me.ready = body.on == null ? !me.ready : !!body.on;
    if (room.quick) quickCheck(room);
    broadcast(room); return { ok: true };
  }
  if (action === 'react') {
    const e = String(body.emoji || ''); if (!REACTIONS.includes(e)) return { error: 'Réaction inconnue' };
    const now = Date.now(); if (me.lastReact && now - me.lastReact < 600) return { ok: true };
    me.lastReact = now;
    room.reacts = [...(room.reacts || []), { s: (room.reactSeq = (room.reactSeq || 0) + 1), n: me.name, e }].slice(-8);
    broadcast(room); return { ok: true };
  }

  if (action === 'setAvatar') {
    if (room.phase !== 'lobby') return { error: 'Personnalisation possible dans le lobby uniquement' };
    const me = room.players.get(pid);
    if (!me) return { error: 'Joueur inconnu' };
    const a = body.avatar || {};
    const lim = { skin: 4, hair: 5, style: 3, shirt: 9, mouth: 1, acc: 2 };
    const out = {};
    for (const k of Object.keys(lim)) {
      const v = Number(a[k]);
      out[k] = Number.isInteger(v) && v >= 0 && v <= lim[k] ? v : 0;
    }
    me.avatar = out;
    broadcast(room);
    return { ok: true };
  }

  if (!isOwner) return { error: 'Action réservée à l\'owner' };

  switch (action) {
    case 'setPack':
      refreshPacks();
      if (room.phase !== 'lobby') return { error: 'Partie en cours' };
      if (body.packId === 'custom' ? !room.customPack : !PACKS.some((p) => p.id === body.packId)) return { error: 'Pack inconnu' };
      room.packId = body.packId;
      fixManches(room);
      break;
    case 'setCustomPack': {
      if (room.phase !== 'lobby') return { error: 'Partie en cours' };
      const raw = body.pack || {};
      const name = clean(raw.name, 30);
      if (!name) return { error: 'Donne un nom à ton pack' };
      const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 60)
        .map((i) => ({ title: clean(i && i.title, 60), search: clean(i && i.search, 200) }))
        .filter((i) => i.title)
        .map((i) => {
          const id = ytId(i.search); // un lien YouTube à la place de la recherche : lu via le lecteur intégré de YouTube
          return id ? { title: i.title, search: i.title, media: `https://youtu.be/${id}` } : { title: i.title, search: (i.search || i.title).slice(0, 100) };
        });
      if (items.length < 1) return { error: 'Ajoute au moins 1 morceau' };
      room.customPack = { id: 'custom', name, emoji: clean(raw.emoji, 4) || '🎵', items };
      room.packId = 'custom';
      fixManches(room);
      break;
    }
    case 'setVoiceAuto':
      if (room.phase !== 'lobby') return { error: 'Partie en cours' };
      room.voiceAuto = !!body.on;
      break;
    case 'setManches':
      if (room.phase !== 'lobby') return { error: 'Partie en cours' };
      if (!MANCHES_OPTIONS.includes(Number(body.manches)) || Number(body.manches) > packLength(room)) return { error: 'Nombre de manches invalide' };
      room.manches = Number(body.manches);
      break;
    case 'addBot': {
      if (room.phase !== 'lobby') return { error: 'Partie en cours' };
      const nonOwner = [...room.players.values()].filter((p) => p.id !== room.ownerId).length;
      if (nonOwner >= maxOf(room)) return { error: `Salon complet (${maxOf(room)} joueurs max)` };
      let n = 1; while (room.players.has('bot' + n)) n += 1;
      room.players.set('bot' + n, { id: 'bot' + n, name: 'Bot ' + n, score: 0, connected: true, bot: true });
      break;
    }
    case 'botBuzz': { // pour tester seul : fait buzzer un bot
      const bot = [...room.players.values()].find((p) => p.bot && !room.lockedOut.has(p.id) && (!body.target || p.id === body.target));
      if (!bot) return { error: 'Aucun bot disponible' };
      return act({ action: 'buzz', pid: bot.id, code: room.code });
    }
    case 'kick': {
      if (body.target === room.ownerId || !room.players.has(body.target)) return { error: 'Impossible' };
      if (room.mode === 'tournament' && room.phase !== 'lobby') return { error: 'En tournoi, exclus les joueurs avant le lancement' };
      if (room.phase === 'end') return { error: 'La partie est terminée' };
      const t = room.players.get(body.target);
      if (room.phase !== 'lobby') { // exclusion en pleine partie : on libère la situation s'il était en train de répondre
        if (room.buzzer === body.target) { clearTimer(room); room.buzzer = null; room.phase = 'playing'; room.playStart = Date.now(); }
        room.lockedOut.delete(body.target);
      }
      (room.banned = room.banned || new Set()).add(body.target); (room.bannedNames = room.bannedNames || new Set()).add(keyOf(t.name));
      room.players.delete(body.target);
      const set = clients.get(room.code);
      if (set && set.get(body.target)) { const r = set.get(body.target); try { r.write(`data: ${JSON.stringify({ kicked: true })}\n\n`); } catch (_) {} r.end(); set.delete(body.target); }
      break;
    }
    case 'start': {
      if (room.phase !== 'lobby') return { error: 'Déjà lancée' };
      const players = [...room.players.values()].filter((p) => p.id !== room.ownerId);
      if (players.length < 1) return { error: 'Il faut au moins 1 joueur (en plus de toi)' };
      if (packLength(room) < 1) return { error: 'Pack vide' };
      if (room.mode === 'teams' && players.length < 2) return { error: 'Il faut au moins 2 joueurs pour jouer en équipes' };
      if (room.packId === 'mix') room.mixPack = buildMix();
      for (const p of room.players.values()) { p.score = 0; p.goods = 0; p.streak = 0; p.bestStreak = 0; p.teamWin = false; p.ready = false; }
      if (room.mode === 'teams') players.forEach((p, i) => { p.team = i % 2; });
      room.idx = 0;
      if (room.mode === 'tournament') { startTournament(room); break; }
      room.order = shuffle([...Array(packLength(room)).keys()]); // ordre des génériques aléatoire à chaque partie
      snapshotManche(room);
      startRound(room);
      break;
    }
    case 'setMedia':
      if (!['idle', 'countdown', 'playing', 'answering'].includes(room.phase)) return { error: 'Impossible maintenant' };
      if (!String(body.url || '').trim()) { // champ vidé : on oublie le lien enregistré et on revient à la recherche automatique
        const k = ovrKey(room, currentItem(room));
        if (k && ovr[k] && isFounder(me.acct || (room.parent && (room.parent.players.get(pid) || {}).acct))) { delete ovr[k]; saveOvr(); resolveRound(room); } else if (k && ovr[k]) return { error: 'Seul le fondateur peut supprimer un lien enregistré' }; else applyCandidate(room);
        break;
      }
      room.media = mediaOf(String(body.url).trim());
      if (!room.media) return { error: 'Lien non reconnu (YouTube ou fichier .mp3)' };
      const founder = isFounder(me.acct || (room.parent && (room.parent.players.get(pid) || {}).acct));
      if (room.media.type === 'yt') { // lien YouTube : on supprime les autres pistes ; seul le fondateur l'enregistre pour ce générique
        room.cand = [{ title: 'Lien collé', artist: 'owner', yt: room.media.id, offset: 0, src: 'https://www.youtube.com/watch?v=' + room.media.id }];
        room.candIdx = 0; room.resolving = false;
        const k = founder ? ovrKey(room, currentItem(room)) : null;
        if (k) { ovr[k] = { id: room.media.id }; saveOvr(); room.saved = true; room.trackInfo = '💾 Lien enregistré : les autres pistes sont supprimées pour ce générique'; }
        else room.trackInfo = founder ? 'Lien collé par l\'owner (pack perso : non enregistré)' : 'Lien collé : joué pour ce générique seulement (seul le fondateur enregistre les liens)';
      } else room.trackInfo = 'Lien collé par l\'owner';
      break;
    case 'pauseMusic':
      if (room.phase !== 'playing' || room.musicPaused) return { error: 'Impossible maintenant' };
      room.elapsed = elapsedNow(room); room.playStart = null; room.musicPaused = true;
      break;
    case 'resumeMusic':
      if (room.phase !== 'playing' || !room.musicPaused) return { error: 'Impossible maintenant' };
      room.musicPaused = false; room.playStart = Date.now();
      break;
    case 'pickTrack': { // l'owner choisit lui-même la piste parmi celles trouvées (avant ou pendant le générique)
      if (!['idle', 'countdown', 'playing'].includes(room.phase)) return { error: 'Impossible maintenant' };
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i >= room.cand.length) return { error: 'Piste inconnue' };
      room.candIdx = i; applyCandidate(room);
      break;
    }
    case 'altTrack':
      if (!['idle', 'countdown', 'playing'].includes(room.phase)) return { error: 'Impossible maintenant' };
      if (room.cand.length < 2) return { error: room.cand.length ? 'Pas d\'autre piste pour ce générique' : 'Aucune piste trouvée pour ce générique' };
      room.candIdx = (room.candIdx + 1) % room.cand.length;
      applyCandidate(room);
      break;
    case 'play':
      if (room.phase !== 'idle') return { error: 'Impossible maintenant' };
      startCountdown(room);
      break;
    case 'validate':
    case 'refuse': {
      if (room.phase !== 'answering' || !room.buzzer) return { error: 'Personne n\'a buzzé' };
      if (action === 'validate') {
        doValidate(room, false);
      } else {
        applyRefuse(room, false);
      }
      break;
    }
    case 'skip':
      if (!['idle', 'countdown', 'playing', 'answering'].includes(room.phase)) return { error: 'Impossible maintenant' };
      clearTimer(room);
      room.lastResult = { type: 'skip' };
      room.buzzer = null;
      room.phase = 'reveal';
      room.media = null;
      break;
    case 'next':
      if (room.phase !== 'reveal') return { error: 'Impossible maintenant' };
      room.idx += 1;
      if (room.idx >= packLength(room)) { if (room.parent) finishChild(room); else finishGame(room); }
      else if (room.idx % perManche(room) === 0) { room.recap = buildRecap(room); room.phase = 'recap'; room.media = null; }
      else startRound(room);
      break;
    case 'nextManche':
      if (room.phase !== 'recap') return { error: 'Impossible maintenant' };
      if (room.mode === 'tournament') { startFinal(room); break; }
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
      room.order = null;
      for (const c of room.all || []) { clearTimer(c); rooms.delete(c.code); }
      room.all = []; room.children = null; room.winners = null;
      for (const p of room.players.values()) { p.score = 0; p.elim = false; p.elimRound = 0; p.ready = false; p.team = null; p.teamWin = false; }
      room.teamResult = null;
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
      if (room.phase === 'lobby' && pid !== room.ownerId) { room.players.delete(pid); if (room.quick) quickCheck(room); }
      if (!set || set.size === 0) {
        setTimeout(() => { const s = clients.get(c); if (!s || s.size === 0) { for (const k of room.all || []) { clearTimer(k); rooms.delete(k.code); } rooms.delete(c); clients.delete(c); } }, 10 * 60 * 1000);
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

  // Test d'une recherche audio (utilisé par l'éditeur de packs) : renvoie les 5 premières pistes trouvées
  if (url.pathname === '/api/search') {
    const q = clean(url.searchParams.get('q'), 100);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!q) return send(400, { error: 'Recherche vide' });
    if (pending > 30) return send(429, { error: 'Trop de recherches en cours, réessaie dans un instant' });
    enqueue(() => searchTracks(q))
      .then((list) => send(200, { tracks: list.slice(0, 5) }))
      .catch((e) => send(502, { error: 'Recherche impossible : ' + e.message }));
    return;
  }

  // Rapport de vérification des packs (texte brut) : pour chaque générique, la piste qui serait jouée. Ex. http://localhost:3000/api/verify?pack=rap-fr
  if (url.pathname === '/api/verify') {
    const only = url.searchParams.get('pack');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    (async () => {
      let good = 0, bad = 0;
      for (const p of PACKS.filter((x) => x.id !== 'mix' && !x.items.every((i) => i.media) && (!only || x.id === only))) {
        res.write('\n=== ' + p.name + ' (' + p.id + ') ===\n');
        for (const it of p.items) {
          if (it.media) continue;
          let line;
          try {
            const list = rankTracks(await enqueue(() => searchTracks(it.search || it.title)), it);
            if (list[0]) { good++; line = 'OK  ' + it.title.padEnd(42) + ' -> ' + list[0].title + ' [' + list[0].artist + '] https://youtu.be/' + list[0].yt; }
            else { bad++; line = 'KO  ' + it.title.padEnd(42) + ' -> aucune bonne vidéo trouvée (sera sauté)'; }
          } catch (e) { bad++; line = 'ERR ' + it.title + ' : ' + e.message; }
          res.write(line + '\n');
        }
      }
      res.end('\n' + good + ' OK, ' + bad + ' KO\n');
    })().catch((e) => res.end('Erreur : ' + e.message));
    return;
  }

  if (url.pathname === '/auth' && req.method === 'POST') {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = auth(JSON.parse(data || '{}'), req.headers['x-forwarded-for'] || req.socket.remoteAddress); } catch (e) { out = { error: 'Requête invalide' }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (url.pathname === '/xp') {
    const name = keyOf(url.searchParams.get('name') || '');
    const e = xpDb[name] || { xp: 0, games: 0, wins: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ xp: e.xp, level: levelOf(e.xp), games: e.games, wins: e.wins || 0, xpPerLevel: XP_PER_LEVEL }));
  }

  // fichiers statiques : seulement la page d'accueil et le dossier media/
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel !== '/index.html' && !rel.startsWith('/media/')) { res.writeHead(404); return res.end('Introuvable'); }
  const file = path.normalize(path.join(__dirname, rel));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, stt) => {
    if (err || !stt.isFile()) { res.writeHead(404); return res.end('Introuvable'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) { // requêtes Range : indispensables pour que le navigateur puisse se placer dans un mp3
      let start = m[1] ? Number(m[1]) : Math.max(0, stt.size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), stt.size - 1) : stt.size - 1;
      if (start > end || start >= stt.size) { res.writeHead(416, { 'Content-Range': `bytes */${stt.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stt.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stt.size });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, () => console.log(`Blind Test Party → http://localhost:${PORT}`));
