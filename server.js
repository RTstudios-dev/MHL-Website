// MHL site. Install dependencies with npm install, then run node server.js.
//
// env vars (none needed locally):
//   PORT                 default 3000
//   DATA_DIR             where data.json + uploads/ live. point it at the persistent disk when hosted
//   ADMIN_PASSWORD_HASH  from `node hash-password.js` (use this when hosted)
//   ADMIN_PASSWORD       plain text password, works but the hash is better
//   STEAM_API_KEY        optional, resolves existing custom Steam profile links for player editing
//   MHL_MOD_API_KEY      key for protected roster access and game-stat uploads; the public roster needs no key
//   MHL_STATS_SFTP_CONFIG optional SFTP sources for pulling pending game-stat JSON
//   MHL_STATS_SFTP_POLL_SECONDS polling interval for SFTP sources; default 60
//   MHL_STATS_PUSH_KEY   optional key for the server-script stats import endpoint
//   The public mod roster endpoint exposes linked Steam IDs, player values, tracked stats, and the Ice Cap.
//   NODE_ENV=production  won't start without a password
//   TRUST_PROXY=1        set when behind a proxy so the login lockout sees the real ip
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || DIR);
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PW_FILE = path.join(DATA_DIR, '.admin-password');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim();
const MHL_MOD_API_KEY = (process.env.MHL_MOD_API_KEY || '').trim();
const MHL_STATS_PUSH_KEY = (process.env.MHL_STATS_PUSH_KEY || '').trim();
// league logo: logo.png, logo.webp or logo.jpg next to server.js (optional)
const LOGO_TYPES = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' };
const findLogo = () => { for (const ext of Object.keys(LOGO_TYPES)) { const file = path.join(DIR, 'logo.' + ext); if (fs.existsSync(file)) return { file, url: '/logo.' + ext, type: LOGO_TYPES[ext] }; } return null; };
const PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_STATS_IMPORT_LOGS = 500;
const DEFAULT_STATS_POINT_REQUIREMENTS = { goals: 1, assists: 1, saves: 2 };
const EMPTY = { site: { season: 'Season 1', discord: '', iceCap: 0, teamCap: 0, statsPointRequirements: DEFAULT_STATS_POINT_REQUIREMENTS }, teams: [], rounds: [], matches: [], players: [], news: [], rules: [], signups: [], draft: { active: false, manualOrder: false, order: [], nextIndex: 0, picks: [] }, playerStats: {}, modStatEventIds: [], statsImportLogs: [] };

// first run: copy the bundled data.json + uploads into DATA_DIR
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  const seed = path.join(DIR, 'data.json');
  if (DATA_DIR !== DIR && fs.existsSync(seed)) {
    fs.copyFileSync(seed, DATA_FILE);
    const seedUploads = path.join(DIR, 'uploads');
    if (fs.existsSync(seedUploads)) for (const f of fs.readdirSync(seedUploads)) fs.copyFileSync(path.join(seedUploads, f), path.join(UPLOAD_DIR, f));
    console.log('Seeded', DATA_DIR, 'from the bundled data.json and uploads/');
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY, null, 2));
  }
}

const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const UPLOAD_RE = /^\/uploads\/[a-f0-9]{16}\.(png|jpg|webp|gif)$/;
const uploadFile = urlPath => path.join(DATA_DIR, urlPath);
// check the actual bytes, content-type can't be trusted
const sniff = b => {
  if (b.length > 12 && b.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.slice(0, 6).toString())) return 'gif';
  return null;
};

// password
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const scrypt = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? reject(e) : resolve(k)));

const HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim();
let PASSWORD = process.env.ADMIN_PASSWORD;
if (HASH && !/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(HASH)) {
  console.error('ADMIN_PASSWORD_HASH is not valid. Create one with: node hash-password.js');
  process.exit(1);
}
if (!HASH && !PASSWORD) {
  if (PROD) {
    console.error('No admin password set. Set ADMIN_PASSWORD_HASH (recommended) or ADMIN_PASSWORD, then start again.');
    process.exit(1);
  }
  if (!fs.existsSync(PW_FILE)) {
    fs.writeFileSync(PW_FILE, crypto.randomBytes(9).toString('base64url'));
    console.log('Generated a new admin password, see the file .admin-password');
  }
  PASSWORD = fs.readFileSync(PW_FILE, 'utf8').trim();
}
async function checkPassword(pw) {
  if (HASH) {
    const [, salt, hash] = HASH.split('$');
    const got = await scrypt(pw, Buffer.from(salt, 'hex'));
    return crypto.timingSafeEqual(got, Buffer.from(hash, 'hex'));
  }
  return safeEq(pw, PASSWORD);
}

const HTML = 'text/html; charset=utf-8', JS = 'application/javascript; charset=utf-8';
// url -> file
const STATIC = {
  '/': ['index.html', HTML],
  '/matches': ['matches.html', HTML],
  '/standings': ['standings.html', HTML],
  '/teams': ['teams.html', HTML],
  '/players': ['players.html', HTML],
  '/sign-up': ['sign-up.html', HTML],
  '/player-login': ['player-login.html', HTML],
  '/season-2-players': ['season-2-players.html', HTML],
  '/news': ['news.html', HTML],
  '/rules': ['rules.html', HTML],
  '/admin': ['admin.html', HTML],
  '/site.css': ['site.css', 'text/css; charset=utf-8'],
  '/site.js': ['site.js', JS],
  '/standings.js': ['standings.js', JS],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
  '/bg.webp': ['bg.webp', 'image/webp'],
};

const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 3600 * 1000;
const playerSessions = new Map(); // token -> { steamId, expires }
const steamStates = new Map(); // state -> { returnTo, realm, expires }
const steamNonces = new Map(); // nonce -> expiry
const PLAYER_SESSION_MS = 12 * 3600 * 1000;
const STEAM_STATE_MS = 5 * 60 * 1000;
const fails = new Map(); // ip -> {n, until}
const publicLimits = new Map(); // key -> {n, until}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [t, player] of playerSessions) if (player.expires < now) playerSessions.delete(t);
  for (const [state, entry] of steamStates) if (entry.expires < now) steamStates.delete(state);
  for (const [nonce, exp] of steamNonces) if (exp < now) steamNonces.delete(nonce);
  for (const [ip, f] of fails) if (f.until < now && f.n === 0) fails.delete(ip);
  for (const [key, limit] of publicLimits) if (limit.until < now) publicLimits.delete(key);
}, 10 * 60 * 1000).unref();

const clientIp = req => {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // last hop = what the proxy saw
  }
  return req.socket.remoteAddress;
};
const allowPublic = (key, max, windowMs) => {
  const now = Date.now();
  let limit = publicLimits.get(key);
  if (!limit || limit.until <= now) {
    if (publicLimits.size >= 10000) publicLimits.delete(publicLimits.keys().next().value);
    limit = { n: 0, until: now + windowMs };
    publicLimits.set(key, limit);
  }
  if (limit.n >= max) return false;
  limit.n++;
  return true;
};
const getCookie = (req, name) => {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : null;
};
const isAdmin = req => {
  const t = getCookie(req, 'mhl_session');
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
};
const playerSession = req => {
  const token = getCookie(req, 'mhl_player');
  const session = token && playerSessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { playerSessions.delete(token); return null; }
  return session;
};
const requestOrigin = req => {
  const host = String(req.headers.host || '');
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)) return '';
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
  const secure = forwarded ? forwarded === 'https' : !!req.socket.encrypted;
  if (forwarded && forwarded !== 'http' && forwarded !== 'https') return '';
  if (PROD && !secure) return '';
  return `${secure ? 'https' : 'http'}://${host.toLowerCase()}`;
};
const steamFailure = res => send(res, 303, 'Returning to player login', 'text/plain; charset=utf-8', {
  Location: '/player-login?steam=failed',
  'Set-Cookie': 'mhl_steam_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
});

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
const send = (res, code, body, type = 'application/json', extra = {}) => {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': CSP,
    ...extra,
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readRaw = (req, max = 300_000) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readRawLimited = (req, max) => new Promise((resolve, reject) => {
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  req.on('data', chunk => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > max) {
      tooLarge = true;
      chunks.length = 0;
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      reject(error);
    } else {
      chunks.push(chunk);
    }
  });
  req.on('end', () => {
    if (!tooLarge) resolve(Buffer.concat(chunks));
  });
  req.on('error', error => {
    if (!tooLarge) reject(error);
  });
});

// clean up whatever the admin page sends
const readBody = async (req, max = 1_000_000) => (await readRaw(req, max)).toString();
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, max = 9999) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= 0 ? Math.min(x, max) : 0; };
const signupValues = signup => ({
  skaterValue: num(signup.skaterValue ?? signup.value, Number.MAX_SAFE_INTEGER),
  goalieValue: num(signup.goalieValue ?? signup.value, Number.MAX_SAFE_INTEGER),
});
const modRosterSnapshot = data => {
  const seenSteamIds = new Set();
  const players = [];
  for (const signup of data.signups) {
    const steamId = signupSteamId(signup);
    if (!/^\d{17}$/.test(steamId)) continue;
    if (seenSteamIds.has(steamId))
      return { error: 'Duplicate Steam accounts are linked to MHL signups.' };
    seenSteamIds.add(steamId);
    players.push({
      steamId,
      ...signupValues(signup),
      ...trackedStatsFor(data, signup.id),
      statsAvailable: true,
    });
  }
  return { iceCap: num(data.site && data.site.iceCap, Number.MAX_SAFE_INTEGER), players };
};
function syncSignupPlayers(data) {
  const playersBySignupId = new Map(data.players.filter(player => player.signupId).map(player => [player.signupId, player]));
  let changed = false;
  for (const signup of data.signups) {
    let player = playersBySignupId.get(signup.id);
    if (!player) {
      player = { id: crypto.randomUUID(), signupId: signup.id, number: '' };
      data.players.push(player);
      playersBySignupId.set(signup.id, player);
      changed = true;
    }
    const values = {
      signupId: signup.id,
      name: signup.name,
      team: signup.team || '',
      role: signup.position === 'Goalie' ? 'goalie' : 'skater',
      discord: signup.discord,
      steam: signup.steam,
      hours: signup.hours,
      signupPosition: signup.position,
      captain: signup.captain,
      photo: signup.photo,
      ...signupValues(signup),
    };
    if (Object.entries(values).some(([key, value]) => player[key] !== value)) changed = true;
    Object.assign(player, values);
  }
  return changed;
}
const draftPrice = signup => {
  const { skaterValue, goalieValue } = signupValues(signup);
  return Math.max(skaterValue, goalieValue);
};
const normalizeDraft = (raw, teams, signups) => {
  const teamIds = new Set(teams.map(team => team.id));
  const signupIds = new Set(signups.map(signup => signup.id));
  const picked = new Set(), picks = [];
  for (const pick of Array.isArray(raw && raw.picks) ? raw.picks : []) {
    const teamId = str(pick && pick.teamId, 40), signupId = str(pick && pick.signupId, 40);
    if (!teamIds.has(teamId) || !signupIds.has(signupId) || picked.has(signupId)) continue;
    picked.add(signupId);
    picks.push({ teamId, signupId, price: num(pick.price, Number.MAX_SAFE_INTEGER) });
  }
  const manualOrder = !!(raw && raw.manualOrder) || !!(raw && raw.active) || picks.length > 0;
  const order = [], ordered = new Set();
  const rawOrder = Array.isArray(raw && raw.order) ? raw.order : [];
  for (let index = 0; index < teams.length; index++) {
    const id = rawOrder[index];
    if (manualOrder && teamIds.has(id) && !ordered.has(id)) {
      ordered.add(id);
      order.push(id);
    } else order.push('');
  }
  return {
    active: !!(raw && raw.active),
    manualOrder,
    order,
    nextIndex: order.length ? num(raw && raw.nextIndex, Number.MAX_SAFE_INTEGER) % order.length : 0,
    picks,
  };
};
const draftBudget = (data, draft, teamId) => Math.max(0,
  num(data.site && data.site.teamCap, Number.MAX_SAFE_INTEGER) -
  draft.picks.filter(pick => pick.teamId === teamId).reduce((sum, pick) => sum + pick.price, 0));
const currentDraftTurn = (data, draft) => {
  if (!draft.active || !draft.order.length) return null;
  const picked = new Set(draft.picks.map(pick => pick.signupId));
  const captains = new Set(data.teams.map(team => team.captainSignupId).filter(Boolean));
  const available = data.signups.filter(signup => !picked.has(signup.id) && !captains.has(signup.id));
  if (!available.length) return null;
  const cheapest = Math.min(...available.map(draftPrice));
  for (let offset = 0; offset < draft.order.length; offset++) {
    const index = (draft.nextIndex + offset) % draft.order.length;
    const team = data.teams.find(item => item.id === draft.order[index]);
    if (team && team.captainSignupId && draftBudget(data, draft, team.id) >= cheapest) return { team, index };
  }
  return null;
};
const signupForPlayer = (data, player) => {
  const profileKey = steamKey(player.profileUrl);
  const matches = data.signups.filter(signup =>
    (player.steamId && signup.steamId === player.steamId) ||
    (profileKey && steamKey(signup.steam) === profileKey));
  return matches.length === 1 ? matches[0] : null;
};
const score = v => (v === null || v === '' || v === undefined) ? null : num(v, 99);
const okImage = u => UPLOAD_RE.test(u) && fs.existsSync(uploadFile(u));
const steamProfile = v => {
  const u = str(v, 300);
  return /^https:\/\/(?:www\.)?steamcommunity\.com\/(?:id\/[a-z0-9_-]+|profiles\/\d{17})\/?$/i.test(u) ? u : '';
};
const steamIdFromProfileUrl = v => {
  const match = steamProfile(v).match(/^https:\/\/(?:www\.)?steamcommunity\.com\/profiles\/(\d{17})\/?$/i);
  return match ? match[1] : '';
};
const signupSteamId = signup => {
  const profileId = steamIdFromProfileUrl(signup.steam);
  if (profileId) return profileId;
  const storedId = String(signup.steamId || '');
  return /^\d{17}$/.test(storedId) ? storedId : '';
};
const emptyTrackedStats = () => ({ goals: 0, assists: 0, saves: 0 });
const increaseTrackedStat = (value, amount = 1) =>
  Math.min(Number.MAX_SAFE_INTEGER, num(value, Number.MAX_SAFE_INTEGER) + amount);
const trackedStatsFor = (data, signupId) => {
  const raw = data.playerStats && Object.prototype.hasOwnProperty.call(data.playerStats, signupId)
    ? data.playerStats[signupId]
    : null;
  return {
    goals: num(raw && raw.goals, Number.MAX_SAFE_INTEGER),
    assists: num(raw && raw.assists, Number.MAX_SAFE_INTEGER),
    saves: num(raw && raw.saves, Number.MAX_SAFE_INTEGER),
  };
};
const attachTrackedStats = data => {
  data.signups = data.signups.map(signup => ({
    ...signup,
    trackedStats: trackedStatsFor(data, signup.id),
  }));
  const statsBySignupId = new Map(data.signups.map(signup => [signup.id, signup.trackedStats]));
  data.players = data.players.map(player => ({
    ...player,
    trackedStats: statsBySignupId.get(player.signupId) || emptyTrackedStats(),
  }));
  return data;
};
const steamKey = v => steamProfile(v).replace(/^https:\/\/www\./i, 'https://').replace(/\/+$/, '').toLowerCase();
async function steamProfileUrl(steamId) {
  const canonical = `https://steamcommunity.com/profiles/${steamId}`;
  if (!STEAM_API_KEY) return { profileUrl: canonical, lookupFailed: false };
  const endpoint = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
  endpoint.searchParams.set('key', STEAM_API_KEY);
  endpoint.searchParams.set('steamids', steamId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) throw new Error('Steam profile lookup failed');
    const result = await response.json();
    const profile = steamProfile(result.response && result.response.players && result.response.players[0] && result.response.players[0].profileurl);
    return { profileUrl: profile || canonical, lookupFailed: false };
  } catch (error) {
    console.error('Steam profile URL lookup failed:', error.message);
    return { profileUrl: canonical, lookupFailed: true };
  } finally {
    clearTimeout(timeout);
  }
}
const okUrl = u => /^https:\/\/[^\s"<>]+$/.test(String(u || '')) ? String(u).slice(0, 300) : '';
const normalizeStatsPointRequirements = value => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const requirement = (input, fallback) => {
    const number = Number(input);
    return Number.isSafeInteger(number) && number >= 1 && number <= 100_000 ? number : fallback;
  };
  return {
    goals: requirement(raw.goals, DEFAULT_STATS_POINT_REQUIREMENTS.goals),
    assists: requirement(raw.assists, DEFAULT_STATS_POINT_REQUIREMENTS.assists),
    saves: requirement(raw.saves, DEFAULT_STATS_POINT_REQUIREMENTS.saves),
  };
};
function sanitize(d) {
  if (!d || typeof d !== 'object') throw new Error('bad data');
  const s = d.site && typeof d.site === 'object' ? d.site : {};
  const site = {
    season: str(s.season, 40),
    discord: okUrl(s.discord),
    iceCap: num(s.iceCap, Number.MAX_SAFE_INTEGER),
    teamCap: num(s.teamCap, Number.MAX_SAFE_INTEGER),
    statsPointRequirements: normalizeStatsPointRequirements(s.statsPointRequirements),
  };
  const teams = (Array.isArray(d.teams) ? d.teams : []).slice(0, 64).map(t => ({
    id: str(t.id, 40) || crypto.randomUUID(),
    name: str(t.name, 40) || 'Unnamed team',
    short: str(t.short, 4).toUpperCase().replace(/[^A-Z0-9]/g, ''),   // 2-4 letters, shown on scoreboards
    color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#c8102e',
    logo: okImage(t.logo) ? t.logo : '',
    photo: okImage(t.photo) ? t.photo : '',   // optional team photo
    captainSignupId: str(t.captainSignupId, 40),
    slug: str(t.slug, 40),   // /team/<slug>, fixed up below
  }));
  // slug doesn't change on rename so shared links keep working
  const seenSlugs = new Set();
  for (const t of teams) {
    const base = slugify(t.slug) || slugify(t.name) || 'team';
    let sl = base, n = 2;
    while (seenSlugs.has(sl)) { const suffix = '-' + n++; sl = base.slice(0, 40 - suffix.length) + suffix; }
    seenSlugs.add(sl); t.slug = sl;
  }
  const ids = new Set(teams.map(t => t.id));
  const rounds = (Array.isArray(d.rounds) ? d.rounds : []).slice(0, 100).map(r => ({
    id: str(r.id, 40) || crypto.randomUUID(),
    name: str(r.name, 40) || 'Round',
  }));
  const roundIds = new Set(rounds.map(r => r.id));
  const players = (Array.isArray(d.players) ? d.players : []).slice(0, 5000).filter(p => !p.team || ids.has(p.team)).map(p => ({
    id: str(p.id, 40) || crypto.randomUUID(),
    signupId: str(p.signupId, 40),
    name: str(p.name, 40) || 'Player', team: ids.has(p.team) ? p.team : '',
    role: p.role === 'goalie' ? 'goalie' : 'skater',
    number: str(p.number, 3).replace(/[^0-9]/g, ''),
    discord: str(p.discord, 80),
    steam: steamProfile(p.steam),
    hours: num(p.hours, 100000),
    signupPosition: ['Goalie', 'Attacker', 'Defender', 'Flexible'].includes(p.signupPosition) ? p.signupPosition : '',
    captain: ['Yes', 'No', 'Maybe'].includes(p.captain) ? p.captain : '',
    photo: okImage(p.photo) ? p.photo : '',
    ...signupValues(p),
  }));
  const pids = new Set(players.map(p => p.id));
  const pid = v => pids.has(v) ? v : '';
  const matches = (Array.isArray(d.matches) ? d.matches : []).slice(0, 2000).filter(m => ids.has(m.a) && ids.has(m.b) && m.a !== m.b).map(m => {
    // best of 3, one score per game
    const games = (Array.isArray(m.games) ? m.games : []).slice(0, 3).map(g => ({ as: score(g && g.as), bs: score(g && g.bs) }));
    // goal log: g = game index, t = 'a'/'b', n = which goal of that team in that game
    // a goal can't be past the score, and empty slots aren't stored
    const seen = new Set();
    const goals = (Array.isArray(m.goals) ? m.goals : []).slice(0, 300).map(x => ({
      g: num(x && x.g, 2), t: x && x.t === 'b' ? 'b' : 'a', n: num(x && x.n, 98),
      s: pid(x && x.s), a1: pid(x && x.a1), a2: pid(x && x.a2),
    })).filter(x => {
      const game = games[x.g], max = game ? (x.t === 'a' ? game.as : game.bs) || 0 : 0;
      const key = x.g + x.t + x.n;
      if (x.n >= max || seen.has(key) || !(x.s || x.a1 || x.a2)) return false;
      seen.add(key); return true;
    }).map(x => {
      if (x.a1 === x.s) x.a1 = '';
      if (x.a2 === x.s || x.a2 === x.a1) x.a2 = '';
      if (!x.a1 && x.a2) { x.a1 = x.a2; x.a2 = ''; }
      return x;
    });
    return {
      id: str(m.id, 40) || crypto.randomUUID(),
      date: str(m.date, 25), a: m.a, b: m.b,
      round: roundIds.has(m.round) ? m.round : '',
      games, goals,
    };
  });
  const news = (Array.isArray(d.news) ? d.news : []).slice(0, 300).map(n => ({
    id: str(n.id, 40) || crypto.randomUUID(),
    title: str(n.title, 120) || 'Untitled',
    body: String(n.body ?? '').trim().slice(0, 4000),
    date: /^\d{4}-\d{2}-\d{2}$/.test(n.date) ? n.date : new Date().toISOString().slice(0, 10),
    pinned: !!n.pinned,
  }));
  const rules = (Array.isArray(d.rules) ? d.rules : []).slice(0, 100).map(r => ({
    id: str(r.id, 40) || crypto.randomUUID(),
    title: str(r.title, 120) || 'Rule',
    body: String(r.body ?? '').trim().slice(0, 4000),
  }));
  const signups = (Array.isArray(d.signups) ? d.signups : []).slice(0, 5000).map(p => ({
    id: str(p.id, 40) || crypto.randomUUID(),
    discord: str(p.discord, 80),
    steam: steamProfile(p.steam),
    steamId: /^\d{17}$/.test(String(p.steamId || '')) ? String(p.steamId) : '',
    name: str(p.name, 40),
    hours: num(p.hours, 100000),
    position: ['Goalie', 'Attacker', 'Defender', 'Flexible'].includes(p.position) ? p.position : '',
    captain: ['Yes', 'No', 'Maybe'].includes(p.captain) ? p.captain : 'No',
    team: ids.has(p.team) ? p.team : '',
    photo: okImage(p.photo) ? p.photo : '',
    ...signupValues(p),
  })).filter(p => p.discord && p.name);
  const signupIds = new Set(signups.map(signup => signup.id));
  const linkedSignupIds = new Set();
  for (const player of players) {
    if (!signupIds.has(player.signupId) || linkedSignupIds.has(player.signupId)) player.signupId = '';
    else linkedSignupIds.add(player.signupId);
  }
  const captains = new Set();
  for (const team of teams) {
    if (!signupIds.has(team.captainSignupId) || captains.has(team.captainSignupId)) team.captainSignupId = '';
    else captains.add(team.captainSignupId);
  }
  const draft = normalizeDraft(d.draft, teams, signups);
  const signupById = new Map(signups.map(signup => [signup.id, signup]));
  draft.picks.forEach(pick => { signupById.get(pick.signupId).team = pick.teamId; });
  syncSignupPlayers({ players, signups });
  return { site, teams, rounds, matches, players, news, rules, signups, draft };
}

// team pages
const slugify = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// by slug, or by id (old links)
const findTeam = (data, seg) => (data.teams || []).find(t => t.slug === seg) || (data.teams || []).find(t => t.id === seg);

function teamPageHtml(req, team) {
  const html = fs.readFileSync(path.join(DIR, 'team.html'), 'utf8');
  const host = String(req.headers.host || '');
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const origin = /^[a-z0-9.:-]+$/i.test(host) ? `${proto}://${host}` : '';
  if (!team) {   // unknown team -> not found page, noindex
    return html.replace(/<title>[^<]*<\/title>/, '<title>Team not found | MHL</title>')
      .replace('</head>', '<meta name="robots" content="noindex"><script>window.__MHL_404=1</script></head>');
  }
  const url = `${origin}/team/${team.slug}`;
  const title = `${team.name} | MHL`;
  const desc = `${team.name} in the Miniature Hockey League: record, roster, results and upcoming matches.`;
  const logo = findLogo();
  const image = origin && (team.logo || logo) ? origin + (team.logo || logo.url) : '';
  const extra = [
    origin ? `<link rel="canonical" href="${escHtml(url)}">` : '',
    origin ? `<meta property="og:url" content="${escHtml(url)}">` : '',
    image ? `<meta property="og:image" content="${escHtml(image)}">` : '',
    '<meta property="og:site_name" content="Miniature Hockey League">',
    '<meta name="twitter:card" content="summary">',
  ].join('');
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escHtml(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${escHtml(desc)}">`)
    .replace(/<meta property="og:title"[^>]*>/, () => `<meta property="og:title" content="${escHtml(title)}">`)
    .replace(/<meta property="og:description"[^>]*>/, () => `<meta property="og:description" content="${escHtml(desc)}">`)
    .replace('</head>', () => extra + '</head>');
}

const readData = () => ({ ...EMPTY, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) });
const writeData = d => {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
};
const appendStatsImportLog = (data, entry) => {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const safeText = (value, maxLength) => String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, maxLength);
  const status = ['imported', 'duplicate', 'failed'].includes(entry.status) ? entry.status : 'failed';
  const logs = Array.isArray(data.statsImportLogs)
    ? data.statsImportLogs.filter(item => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  logs.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source: entry.source === 'sftp' ? 'sftp' : 'push',
    server: safeText(entry.server, 80),
    fileName: safeText(entry.fileName, 255),
    fileHash: /^[a-f0-9]{64}$/i.test(entry.fileHash || '') ? entry.fileHash.toLowerCase() : '',
    status,
    reportCount: count(entry.reportCount),
    eventCount: count(entry.eventCount),
    accepted: count(entry.accepted),
    credited: count(entry.credited),
    unmatched: count(entry.unmatched),
    duplicates: count(entry.duplicates),
    error: safeText(entry.error, 240),
  });
  data.statsImportLogs = logs.slice(0, MAX_STATS_IMPORT_LOGS);
};
const writeStatsImportLog = entry => {
  const data = readData();
  appendStatsImportLog(data, entry);
  writeData(data);
};
const normalizeStatsReports = rawReports => {
  if (!Array.isArray(rawReports) || rawReports.length > 10_000)
    return { error: 'The stats payload is invalid.' };

  const reports = [];
  let totalEvents = 0;
  for (const rawReport of rawReports) {
    if (!rawReport || typeof rawReport !== 'object' || Array.isArray(rawReport))
      return { error: 'The stats payload is invalid.' };

    const rawGameId = String(rawReport.gameId ?? '').trim();
    const gameId = str(rawGameId, 120);
    if (rawGameId.length > 120 || !/^[a-zA-Z0-9._:-]{1,120}$/.test(gameId) ||
        !Array.isArray(rawReport.events) || rawReport.events.length > 2000) {
      return { error: 'The stats payload is invalid.' };
    }

    totalEvents += rawReport.events.length;
    if (totalEvents > 50_000)
      return { error: 'The stats payload contains too many events.' };

    const events = [];
    for (const raw of rawReport.events) {
      const rawEventId = String((raw && raw.eventId) ?? '').trim();
      const eventId = str(rawEventId, 180);
      const type = raw && raw.type;
      if (!eventId || rawEventId.length > 180 || !eventId.startsWith(gameId + ':'))
        return { error: 'A stats event has an invalid event ID.' };

      if (type === 'goal') {
        const scorerSteamId = str(raw.scorerSteamId, 17);
        const assist1SteamId = str(raw.assist1SteamId, 17);
        const assist2SteamId = str(raw.assist2SteamId, 17);
        if (!/^\d{17}$/.test(scorerSteamId) ||
            (assist1SteamId && !/^\d{17}$/.test(assist1SteamId)) ||
            (assist2SteamId && !/^\d{17}$/.test(assist2SteamId))) {
          return { error: 'A goal event has an invalid Steam ID.' };
        }
        events.push({ eventId, type, scorerSteamId, assist1SteamId, assist2SteamId });
      } else if (type === 'save') {
        const steamId = str(raw.steamId, 17);
        const count = Number(raw.count);
        if (!/^\d{17}$/.test(steamId) || !Number.isSafeInteger(count) || count < 1 || count > 1000)
          return { error: 'A save event is invalid.' };
        events.push({ eventId, type, steamId, count });
      } else {
        return { error: 'A stats event has an unknown type.' };
      }
    }

    reports.push({ gameId, events });
  }

  if (totalEvents === 0)
    return { error: 'The stats payload contains no events.' };
  return { reports };
};
const applyStatsReports = (data, reports) => {
  const signupBySteamId = new Map();
  for (const signup of data.signups) {
    const steamId = signupSteamId(signup);
    if (!/^\d{17}$/.test(steamId)) continue;
    if (signupBySteamId.has(steamId))
      return { error: 'Duplicate Steam accounts are linked to MHL signups.' };
    signupBySteamId.set(steamId, signup);
  }

  const playerStats = data.playerStats && typeof data.playerStats === 'object'
    ? data.playerStats
    : {};
  const trackedIds = Array.isArray(data.modStatEventIds)
    ? data.modStatEventIds.filter(id => typeof id === 'string')
    : [];
  const seen = new Set(trackedIds);
  let accepted = 0;
  let ignored = 0;
  let credited = 0;
  let unmatched = 0;
  const countsFor = signupId => {
    if (!Object.prototype.hasOwnProperty.call(playerStats, signupId) ||
        !playerStats[signupId] || typeof playerStats[signupId] !== 'object')
      playerStats[signupId] = emptyTrackedStats();
    return playerStats[signupId];
  };

  for (const report of reports) {
    for (const event of report.events) {
      if (seen.has(event.eventId)) {
        ignored++;
        continue;
      }
      seen.add(event.eventId);
      accepted++;

      if (event.type === 'goal') {
        let eventCredited = false;
        const scorer = signupBySteamId.get(event.scorerSteamId);
        if (scorer) {
          const stats = countsFor(scorer.id);
          stats.goals = increaseTrackedStat(stats.goals);
          eventCredited = true;
        }
        const creditedAssists = new Set([event.assist1SteamId, event.assist2SteamId]
          .filter(steamId => steamId && steamId !== event.scorerSteamId));
        for (const steamId of creditedAssists) {
          const signup = signupBySteamId.get(steamId);
          if (signup) {
            const stats = countsFor(signup.id);
            stats.assists = increaseTrackedStat(stats.assists);
            eventCredited = true;
          }
        }
        if (eventCredited) credited++;
        else unmatched++;
      } else {
        const signup = signupBySteamId.get(event.steamId);
        if (signup && signup.position === 'Goalie') {
          const stats = countsFor(signup.id);
          stats.saves = increaseTrackedStat(stats.saves, event.count);
          credited++;
        } else unmatched++;
      }
    }
  }

  if (accepted > 0) {
    data.playerStats = playerStats;
    data.modStatEventIds = [...seen];
  }
  return { accepted, ignored, credited, unmatched };
};

const importStatsReports = (rawReports, logContext = null) => {
  const normalized = normalizeStatsReports(rawReports);
  if (normalized.error) {
    if (logContext) writeStatsImportLog({ ...logContext, status: 'failed', error: normalized.error });
    return { error: normalized.error };
  }

  const data = readData();
  const result = applyStatsReports(data, normalized.reports);
  if (result.error) {
    if (logContext) {
      appendStatsImportLog(data, { ...logContext, status: 'failed', error: result.error });
      writeData(data);
    }
    throw new Error(result.error);
  }
  if (logContext) {
    const eventCount = normalized.reports.reduce((count, report) => count + report.events.length, 0);
    appendStatsImportLog(data, {
      ...logContext,
      status: result.accepted === 0 && result.ignored > 0 ? 'duplicate' : 'imported',
      reportCount: normalized.reports.length,
      eventCount,
      accepted: result.accepted,
      credited: result.credited,
      unmatched: result.unmatched,
      duplicates: result.ignored,
    });
    writeData(data);
  } else if (result.accepted > 0) {
    writeData(data);
  }
  return result;
};

const loadStatsSftpConfig = () => {
  const raw = (process.env.MHL_STATS_SFTP_CONFIG || '').trim();
  if (!raw) return null;

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error('MHL_STATS_SFTP_CONFIG must contain valid JSON.');
  }

  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      typeof config.host !== 'string' || !config.host.trim() ||
      typeof config.username !== 'string' || !config.username.trim() ||
      typeof config.hostKeyFingerprint !== 'string' ||
      !Array.isArray(config.sources) || config.sources.length < 1 || config.sources.length > 10) {
    throw new Error('MHL_STATS_SFTP_CONFIG is missing required connection or source settings.');
  }

  const port = config.port === undefined ? 22 : Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('MHL_STATS_SFTP_CONFIG has an invalid port.');

  const fingerprint = config.hostKeyFingerprint.trim().replace(/^SHA256:/, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]{43}$/.test(fingerprint))
    throw new Error('MHL_STATS_SFTP_CONFIG requires a SHA256 host key fingerprint.');

  const authNames = ['privateKeyBase64Env', 'passwordEnv']
    .filter(name => typeof config[name] === 'string' && config[name].trim());
  if (authNames.length !== 1)
    throw new Error('Configure exactly one SFTP authentication environment variable.');
  const authEnvName = config[authNames[0]].trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(authEnvName) || !process.env[authEnvName])
    throw new Error('The configured SFTP authentication environment variable is missing.');

  let passphraseEnvName = '';
  if (config.passphraseEnv !== undefined) {
    if (authNames[0] !== 'privateKeyBase64Env' ||
        typeof config.passphraseEnv !== 'string' ||
        !/^[A-Z_][A-Z0-9_]*$/.test(config.passphraseEnv.trim()) ||
        !process.env[config.passphraseEnv.trim()]) {
      throw new Error('passphraseEnv requires an encrypted private key and a configured secret.');
    }
    passphraseEnvName = config.passphraseEnv.trim();
  }

  const sources = config.sources.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        typeof source.name !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(source.name) ||
        typeof source.remotePath !== 'string' ||
        !source.remotePath.startsWith('/') ||
        !source.remotePath.toLowerCase().endsWith('.json') ||
        source.remotePath.length > 2048) {
      throw new Error('MHL_STATS_SFTP_CONFIG has an invalid source at index ' + index + '.');
    }
    return { name: source.name, remotePath: source.remotePath };
  });

  if (new Set(sources.map(source => source.name)).size !== sources.length)
    throw new Error('MHL_STATS_SFTP_CONFIG source names must be unique.');

  const pollSeconds = process.env.MHL_STATS_SFTP_POLL_SECONDS === undefined
    ? 60
    : Number(process.env.MHL_STATS_SFTP_POLL_SECONDS);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 30 || pollSeconds > 3600)
    throw new Error('MHL_STATS_SFTP_POLL_SECONDS must be between 30 and 3600.');

  return {
    host: config.host.trim(),
    port,
    username: config.username.trim(),
    fingerprint,
    authName: authNames[0],
    authEnvName,
    passphraseEnvName,
    sources,
    pollSeconds,
  };
};

let statsSftpConfig = null;
try {
  statsSftpConfig = loadStatsSftpConfig();
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  console.error('[MHL stats SFTP] Configuration invalid; polling disabled: ' + message);
}
const statsSftpHashes = new Map();
const statsSftpErrors = new Map();
const statsSftpMissing = new Set();
let statsSftpPollRunning = false;

const pollStatsSftpSource = async (config, source) => {
  let sftp = null;
  let connected = false;
  try {
    const SftpClient = require('ssh2-sftp-client');
    sftp = new SftpClient('MHL stats ' + source.name);
    const connectOptions = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: 20000,
      hostVerifier: key => {
        const actual = crypto.createHash('sha256')
          .update(Buffer.isBuffer(key) ? key : Buffer.from(key))
          .digest('base64')
          .replace(/=+$/, '');
        const expectedBuffer = Buffer.from(config.fingerprint);
        const actualBuffer = Buffer.from(actual);
        return actualBuffer.length === expectedBuffer.length
          && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
      },
    };

    if (config.authName === 'privateKeyBase64Env') {
      const encodedKey = process.env[config.authEnvName].replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey))
        throw new Error('The configured SFTP private key is not valid base64.');
      const key = Buffer.from(encodedKey, 'base64');
      if (!key.length)
        throw new Error('The configured SFTP private key is empty.');
      connectOptions.privateKey = key;
      if (config.passphraseEnvName)
        connectOptions.passphrase = process.env[config.passphraseEnvName];
    } else {
      connectOptions.password = process.env[config.authEnvName];
    }

    await sftp.connect(connectOptions);
    connected = true;
    const exists = await sftp.exists(source.remotePath);
    if (!exists) {
      if (!statsSftpMissing.has(source.name)) {
        console.log('[MHL stats SFTP] Waiting for pending JSON from ' + source.name + '.');
        statsSftpMissing.add(source.name);
      }
      statsSftpErrors.delete(source.name);
      return;
    }
    statsSftpMissing.delete(source.name);

    const fileInfo = await sftp.stat(source.remotePath);
    if (!Number.isFinite(fileInfo.size) || fileInfo.size < 1 || fileInfo.size > 20_000_000)
      throw new Error('The pending JSON file has an invalid size.');

    const contents = await sftp.get(source.remotePath);
    const jsonText = Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents);
    const hash = crypto.createHash('sha256').update(jsonText).digest('hex');
    if (statsSftpHashes.get(source.name) === hash) {
      statsSftpErrors.delete(source.name);
      return;
    }

    const logContext = {
      source: 'sftp',
      server: source.name,
      fileName: path.basename(source.remotePath),
      fileHash: hash,
    };
    let payload;
    try {
      payload = JSON.parse(jsonText);
    } catch {
      writeStatsImportLog({ ...logContext, status: 'failed', error: 'The pending JSON file is not valid JSON.' });
      throw new Error('The pending JSON file is not valid JSON.');
    }
    const result = importStatsReports(payload && payload.reports, logContext);
    if (result.error) throw new Error(result.error);

    statsSftpHashes.set(source.name, hash);
    statsSftpErrors.delete(source.name);
    console.log('[MHL stats SFTP] ' + source.name + ': '
      + result.credited + ' credited, ' + result.unmatched + ' unmatched, '
      + result.ignored + ' duplicate event(s).');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (statsSftpErrors.get(source.name) !== message) {
      console.error('[MHL stats SFTP] Could not import from ' + source.name + ': ' + message);
      statsSftpErrors.set(source.name, message);
    }
  } finally {
    if (connected && sftp) {
      try {
        await sftp.end();
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (statsSftpErrors.get(source.name) !== message) {
          console.error('[MHL stats SFTP] Could not close the connection for '
            + source.name + ': ' + message);
          statsSftpErrors.set(source.name, message);
        }
      }
    }
  }
};

const pollStatsSftpSources = async () => {
  if (!statsSftpConfig || statsSftpPollRunning) return;
  statsSftpPollRunning = true;
  try {
    for (const source of statsSftpConfig.sources)
      await pollStatsSftpSource(statsSftpConfig, source);
  } finally {
    statsSftpPollRunning = false;
  }
};

const handleStatsPush = async (req, res) => {
  const rejectBeforeBody = (status, message) => {
    req.resume();
    return send(res, status, { error: message });
  };

  let serverId = 'unknown';
  try {
    if (!MHL_STATS_PUSH_KEY)
      return rejectBeforeBody(503, 'Stats push is not configured.');
    if (!allowPublic('stats-import:' + clientIp(req), 30, 60 * 1000))
      return rejectBeforeBody(429, 'Too many stats imports. Try again shortly.');

    const authorization = req.headers.authorization;
    const suppliedKey = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    const expectedKeyBytes = Buffer.from(MHL_STATS_PUSH_KEY, 'utf8');
    const suppliedKeyBytes = Buffer.from(suppliedKey, 'utf8');
    if (suppliedKeyBytes.length !== expectedKeyBytes.length ||
        !crypto.timingSafeEqual(suppliedKeyBytes, expectedKeyBytes)) {
      return rejectBeforeBody(401, 'A valid stats push key is required.');
    }

    const contentType = String(req.headers['content-type'] || '')
      .split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json')
      return rejectBeforeBody(400, 'Content-Type must be application/json.');

    serverId = req.headers['x-mhl-server'];
    if (typeof serverId !== 'string' || !['server1', 'server2', 'server3'].includes(serverId))
      return rejectBeforeBody(400, 'X-MHL-Server must identify server1, server2, or server3.');

    const fileHashHeader = req.headers['x-mhl-file-hash'];
    if (typeof fileHashHeader !== 'string' || !/^[a-f0-9]{64}$/i.test(fileHashHeader.trim()))
      return rejectBeforeBody(400, 'X-MHL-File-Hash must be a SHA-256 hex digest.');

    let rawBody;
    try {
      rawBody = await readRawLimited(req, 2 * 1024 * 1024);
    } catch (error) {
      if (error && error.statusCode === 413)
        return send(res, 413, { error: 'Stats JSON exceeds the 2 MB limit.' });
      throw error;
    }

    const actualHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    if (actualHash !== fileHashHeader.trim().toLowerCase())
      return send(res, 400, { error: 'X-MHL-File-Hash does not match the request body.' });

    let payload;
    const logContext = {
      source: 'push',
      server: serverId,
      fileHash: actualHash,
    };
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      writeStatsImportLog({ ...logContext, status: 'failed', error: 'The request body is not valid JSON.' });
      return send(res, 400, { error: 'The request body is not valid JSON.' });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      writeStatsImportLog({ ...logContext, status: 'failed', error: 'The stats payload is invalid.' });
      return send(res, 400, { error: 'The stats payload is invalid.' });
    }

    const result = importStatsReports(payload.reports, logContext);
    if (result.error)
      return send(res, 400, { error: result.error });
    if (result.accepted === 0 && result.ignored > 0)
      return send(res, 200, { status: 'duplicate' });
    return send(res, 200, { status: 'imported', ...result });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('[stats-import] Failed to store stats for ' + serverId + ': ' + message);
    if (!res.headersSent)
      return send(res, 500, { error: 'Stats import failed. Please retry.' });
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');   // /matches/ -> /matches
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (p === '/api/stats-import' && req.method === 'POST')
      return handleStatsPush(req, res);
    if (p === '/auth/steam' && req.method === 'GET') {
      const origin = requestOrigin(req);
      if (!origin) return send(res, 503, 'Steam sign-in requires a valid HTTPS site origin.', 'text/plain; charset=utf-8');
      if (!allowPublic('steam-login:' + clientIp(req), 20, 60 * 60 * 1000)) {
        return send(res, 429, 'Too many Steam sign-in attempts. Please try again later.', 'text/plain; charset=utf-8');
      }
      if (steamStates.size >= 10000) steamStates.delete(steamStates.keys().next().value);
      const state = crypto.randomBytes(24).toString('hex');
      const realm = origin + '/';
      const returnTo = `${origin}/auth/steam/callback?state=${state}`;
      const returnPath = url.searchParams.get('return') === '/sign-up' ? '/sign-up' : '/player-login';
      steamStates.set(state, { returnTo, realm, returnPath, expires: Date.now() + STEAM_STATE_MS });
      const login = new URL(STEAM_OPENID);
      login.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
      login.searchParams.set('openid.mode', 'checkid_setup');
      login.searchParams.set('openid.realm', realm);
      login.searchParams.set('openid.return_to', returnTo);
      login.searchParams.set('openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select');
      login.searchParams.set('openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select');
      const secure = origin.startsWith('https://') ? '; Secure' : '';
      return send(res, 302, 'Redirecting to Steam', 'text/plain; charset=utf-8', {
        Location: login.toString(),
        'Set-Cookie': `mhl_steam_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${STEAM_STATE_MS / 1000}${secure}`,
      });
    }
    if (p === '/auth/steam/callback' && req.method === 'GET') {
      const origin = requestOrigin(req);
      const state = url.searchParams.get('state') || '';
      const stateCookie = getCookie(req, 'mhl_steam_state');
      const pending = state && stateCookie === state ? steamStates.get(state) : null;
      if (!origin || !pending || pending.expires < Date.now()) return steamFailure(res);
      steamStates.delete(state);

      const params = url.searchParams;
      const claimed = params.get('openid.claimed_id') || '';
      const identity = params.get('openid.identity') || '';
      const endpoint = params.get('openid.op_endpoint') || '';
      const nonce = params.get('openid.response_nonce') || '';
      const signed = new Set((params.get('openid.signed') || '').split(','));
      const idMatch = claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/i);
      const nonceDate = nonce.slice(0, 20);
      const nonceTime = Date.parse(nonceDate);
      const requiredSigned = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce'];
      if (params.get('openid.ns') !== 'http://specs.openid.net/auth/2.0' ||
          params.get('openid.mode') !== 'id_res' ||
          endpoint !== STEAM_OPENID || !idMatch || identity !== claimed ||
          params.get('openid.return_to') !== pending.returnTo ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(nonceDate) ||
          !Number.isFinite(nonceTime) || Math.abs(Date.now() - nonceTime) > 10 * 60 * 1000 ||
          nonce.length > 256 || requiredSigned.some(field => !signed.has(field)) ||
          steamNonces.has(nonce)) return steamFailure(res);

      if (steamNonces.size >= 10000) steamNonces.delete(steamNonces.keys().next().value);
      steamNonces.set(nonce, Date.now() + 10 * 60 * 1000);
      const verification = new URLSearchParams();
      for (const [key, value] of params) if (key.startsWith('openid.')) verification.append(key, value);
      verification.set('openid.mode', 'check_authentication');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let verified = false;
      try {
        const check = await fetch(STEAM_OPENID, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: verification.toString(),
          signal: controller.signal,
        });
        const result = await check.text();
        verified = check.ok && /^is_valid:true\s*$/m.test(result);
      } catch {
        verified = false;
      } finally {
        clearTimeout(timeout);
      }
      if (!verified) return steamFailure(res);

      const steamId = idMatch[1], token = crypto.randomBytes(32).toString('hex');
      const { profileUrl, lookupFailed } = await steamProfileUrl(steamId);
      playerSessions.set(token, { steamId, profileUrl, lookupFailed, expires: Date.now() + PLAYER_SESSION_MS });
      const secure = origin.startsWith('https://') ? '; Secure' : '';
      return send(res, 303, 'Signed in with Steam', 'text/plain; charset=utf-8', {
        Location: `${pending.returnPath}?steam=connected`,
        'Set-Cookie': [
          `mhl_player=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${PLAYER_SESSION_MS / 1000}${secure}`,
          `mhl_steam_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
        ],
      });
    }
    if (p === '/api/player/me' && req.method === 'GET') {
      const player = playerSession(req);
      return send(res, 200, {
        authenticated: !!player,
        steamId: player ? player.steamId : '',
        profileUrl: player ? player.profileUrl : '',
        profileLookupFailed: !!(player && player.lookupFailed),
      });
    }
    if (p === '/api/draft' && req.method === 'GET') {
      const data = readData();
      const draft = normalizeDraft(data.draft, data.teams, data.signups);
      const player = playerSession(req);
      const signup = player && signupForPlayer(data, player);
      const captainTeam = signup && data.teams.find(team => team.captainSignupId === signup.id);
      const turn = currentDraftTurn(data, draft);
      return send(res, 200, {
        active: draft.active,
        captainTeamId: captainTeam ? captainTeam.id : '',
        currentTeamId: turn ? turn.team.id : '',
        captainSignupIds: captainTeam ? data.teams.map(team => team.captainSignupId).filter(Boolean) : [],
        pickedSignupIds: draft.picks.map(pick => pick.signupId),
        teamBudgets: Object.fromEntries(data.teams.map(team => [team.id, draftBudget(data, draft, team.id)])),
        complete: draft.active && !turn,
      });
    }
    if (p === '/api/draft/pick' && req.method === 'POST') {
      const player = playerSession(req);
      if (!player) return send(res, 401, { error: 'Sign in with the Steam account assigned as captain.' });
      const data = readData();
      const draft = normalizeDraft(data.draft, data.teams, data.signups);
      if (!draft.active) return send(res, 409, { error: 'The draft is not active.' });
      const captainSignup = signupForPlayer(data, player);
      const captainTeam = captainSignup && data.teams.find(team => team.captainSignupId === captainSignup.id);
      if (!captainTeam) return send(res, 403, { error: 'This Steam account is not assigned as a team captain.' });
      const { signupId } = JSON.parse(await readBody(req) || '{}');
      const selectedId = str(signupId, 40);
      if (!selectedId) return send(res, 400, { error: 'Choose a player to draft.' });
      const turn = currentDraftTurn(data, draft);
      if (!turn) return send(res, 409, { error: 'The draft has no affordable players remaining.' });
      if (turn.team.id !== captainTeam.id) return send(res, 409, { error: 'It is not your team’s turn to pick.' });
      const signup = data.signups.find(item => item.id === selectedId);
      if (!signup) return send(res, 404, { error: 'That signup could not be found.' });
      if (data.teams.some(team => team.captainSignupId === signup.id)) return send(res, 409, { error: 'Team captains cannot be drafted.' });
      if (draft.picks.some(pick => pick.signupId === signup.id)) return send(res, 409, { error: 'That player has already been drafted.' });
      const price = draftPrice(signup), budget = draftBudget(data, draft, captainTeam.id);
      if (price > budget) return send(res, 409, { error: 'That player costs more than your team’s remaining budget.' });
      signup.team = captainTeam.id;
      draft.picks.push({ teamId: captainTeam.id, signupId: signup.id, price });
      draft.nextIndex = (turn.index + 1) % draft.order.length;
      data.draft = draft;
      syncSignupPlayers(data);
      writeData(data);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/player/signup' && req.method === 'GET') {
      const player = playerSession(req);
      if (!player) return send(res, 401, { error: 'Sign in with Steam to find your signup.' });
      const profileKey = steamKey(player.profileUrl);
      const matches = readData().signups.filter(signup =>
        (player.steamId && signup.steamId === player.steamId) ||
        (profileKey && steamKey(signup.steam) === profileKey));
      if (!matches.length) {
        if (player.lookupFailed) {
          return send(res, 503, { error: 'Steam could not resolve your profile link right now. Please sign out and try again later; do not create another signup yet.' });
        }
        const help = STEAM_API_KEY
          ? 'No signup was found for this Steam profile. Make a separate signup first, using this Steam profile link.'
          : 'No signup was found for this Steam profile. If your signup uses a custom Steam /id/ link, staff must configure STEAM_API_KEY to match it.';
        return send(res, 404, { error: help });
      }
      if (matches.length > 1) return send(res, 409, { error: 'More than one signup is linked to this Steam profile. Please ask league staff for help.' });
      const signup = matches[0];
      return send(res, 200, {
        profileUrl: player.profileUrl,
        signup: {
          id: signup.id, discord: signup.discord, name: signup.name, steam: signup.steam,
          hours: signup.hours, position: signup.position, captain: signup.captain,
          photo: signup.photo, team: signup.team, ...signupValues(signup),
        },
      });
    }
    if (p === '/api/player/signup' && req.method === 'PUT') {
      const player = playerSession(req);
      if (!player) return send(res, 401, { error: 'Sign in with Steam before editing your signup.' });
      const data = readData();
      const profileKey = steamKey(player.profileUrl);
      const matches = data.signups.filter(signup =>
        (player.steamId && signup.steamId === player.steamId) ||
        (profileKey && steamKey(signup.steam) === profileKey));
      if (matches.length !== 1) return send(res, matches.length ? 409 : 404, { error: 'Could not find one signup linked to this Steam profile.' });
      const signup = matches[0];
      const changes = JSON.parse(await readBody(req) || '{}');
      const discord = str(changes.discord, 80), name = str(changes.name, 40);
      const hours = Number(changes.hours);
      if (!discord || !name || !Number.isSafeInteger(hours) || hours < 0 || hours > 100000 ||
          !['Goalie', 'Attacker', 'Defender', 'Flexible'].includes(changes.position) ||
          !['Yes', 'No', 'Maybe'].includes(changes.captain)) {
        return send(res, 400, { error: 'Complete all fields with valid answers before saving.' });
      }
      const discordKey = discord.toLowerCase();
      if (data.signups.some(other => other !== signup &&
          ((player.steamId && other.steamId === player.steamId) ||
            String(other.discord || '').trim().toLowerCase() === discordKey ||
            (profileKey && steamKey(other.steam) === profileKey)))) {
        return send(res, 409, { error: 'Those details match another signup. Please ask league staff for help.' });
      }
      signup.discord = discord;
      signup.name = name;
      signup.hours = hours;
      signup.position = changes.position;
      signup.captain = changes.captain;
      signup.steam = player.profileUrl;
      signup.steamId = player.steamId;
      if (changes.photo !== undefined) signup.photo = okImage(changes.photo) ? changes.photo : '';
      syncSignupPlayers(data);
      writeData(data);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/player/logout' && req.method === 'POST') {
      const token = getCookie(req, 'mhl_player');
      if (token) playerSessions.delete(token);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, 'application/json', {
        'Set-Cookie': `mhl_player=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
      });
    }
    if (p === '/api/mod/public-roster' && req.method === 'GET') {
      if (!allowPublic('mod-public-roster:' + clientIp(req), 60, 60 * 1000)) {
        return send(res, 429, { error: 'Too many roster requests. Try again shortly.' });
      }

      const roster = modRosterSnapshot(readData());
      if (roster.error) return send(res, 409, { error: roster.error });
      return send(res, 200, roster);
    }
    if (p === '/api/mod/roster' && req.method === 'GET') {
      if (!allowPublic('mod-roster:' + clientIp(req), 30, 60 * 1000)) {
        return send(res, 429, { error: 'Too many roster requests. Try again shortly.' });
      }
      if (MHL_MOD_API_KEY.length < 32) {
        return send(res, 503, { error: 'The mod roster API is not configured.' });
      }

      const authorization = String(req.headers.authorization || '');
      const apiKey = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!apiKey || apiKey.length > 256 || !safeEq(apiKey, MHL_MOD_API_KEY)) {
        return send(res, 401, { error: 'A valid mod API key is required.' });
      }

      const roster = modRosterSnapshot(readData());
      if (roster.error) return send(res, 409, { error: roster.error });
      return send(res, 200, roster);
    }
    if (p === '/api/mod/stats' && req.method === 'POST') {
      if (!allowPublic('mod-stats:' + clientIp(req), 120, 60 * 1000)) {
        return send(res, 429, { error: 'Too many stats requests. Try again shortly.' });
      }
      if (MHL_MOD_API_KEY.length < 32) {
        return send(res, 503, { error: 'The mod stats API is not configured.' });
      }

      const authorization = String(req.headers.authorization || '');
      const apiKey = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!apiKey || apiKey.length > 256 || !safeEq(apiKey, MHL_MOD_API_KEY)) {
        return send(res, 401, { error: 'A valid mod API key is required.' });
      }

      const payload = JSON.parse(await readBody(req, 500_000) || '{}');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return send(res, 400, { error: 'The stats payload is invalid.' });
      const normalized = normalizeStatsReports([{ gameId: payload.gameId, events: payload.events }]);
      if (normalized.error) return send(res, 400, { error: normalized.error });

      const data = readData();
      const result = applyStatsReports(data, normalized.reports);
      if (result.error) return send(res, 409, { error: result.error });
      if (result.accepted > 0) writeData(data);
      return send(res, 200, result);
    }
    if (p === '/api/admin/import-stats' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });

      const payload = JSON.parse(await readBody(req, 20_000_000) || '{}');
      const normalized = normalizeStatsReports(payload && payload.reports);
      if (normalized.error) return send(res, 400, { error: normalized.error });

      const data = readData();
      const result = applyStatsReports(data, normalized.reports);
      if (result.error) return send(res, 409, { error: result.error });
      if (result.accepted > 0) writeData(data);
      return send(res, 200, result);
    }
    if (p === '/api/admin/stats-import-logs' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });
      const logs = readData().statsImportLogs;
      return send(res, 200, {
        logs: Array.isArray(logs) ? logs.slice(0, MAX_STATS_IMPORT_LOGS) : [],
      });
    }
    if (p === '/api/data' && req.method === 'GET') {
      // logoUrl: pages swap the wordmark for the logo when there is one
      const logo = findLogo();
      const data = readData();
      data.site = data.site && typeof data.site === 'object' ? { ...data.site } : { ...EMPTY.site };
      data.site.statsPointRequirements = normalizeStatsPointRequirements(data.site.statsPointRequirements);
      data.draft = normalizeDraft(data.draft, data.teams, data.signups);
      const signupsById = new Map(data.signups.map(signup => [signup.id, signup]));
      data.draft.picks.forEach(pick => { signupsById.get(pick.signupId).team = pick.teamId; });
      if (syncSignupPlayers(data)) writeData(data);
      attachTrackedStats(data);
      if (!isAdmin(req)) {
        data.signups = data.signups.map(({ steam, steamId, ...signup }) => signup);
        data.teams = data.teams.map(({ captainSignupId, ...team }) => team);
        data.players = data.players.map(({ steam, ...player }) => player);
      }
      data.signups = data.signups.map(signup => ({ ...signup, ...signupValues(signup) }));
      const { playerStats, modStatEventIds, statsImportLogs, ...responseData } = data;
      return send(res, 200, { ...responseData, hasLogo: !!logo, logoUrl: logo ? logo.url : '' });
    }
    if (p === '/api/me') return send(res, 200, { admin: isAdmin(req) });

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const { password } = JSON.parse(await readBody(req) || '{}');
      if (!(await checkPassword(password ?? ''))) {
        f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; }
        fails.set(ip, f);
        return send(res, 401, { error: 'Wrong password' });
      }
      fails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `mhl_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = getCookie(req, 'mhl_session'); if (t) sessions.delete(t);
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'mhl_session=; Max-Age=0; Path=/' });
    }
    if (p === '/api/data' && req.method === 'PUT') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });
      const incoming = JSON.parse(await readBody(req, 10_000_000));
      const clearAllAssignments = !!(incoming && incoming.draft && incoming.draft.clearAllAssignments);
      const trackedStatsEdits = incoming && incoming.trackedStatsEdits;
      if (trackedStatsEdits !== undefined &&
          (!trackedStatsEdits || typeof trackedStatsEdits !== 'object' || Array.isArray(trackedStatsEdits) ||
           Object.keys(trackedStatsEdits).length > 5000)) {
        return send(res, 400, { error: 'Tracked stat edits are invalid.' });
      }
      const clean = sanitize(incoming);
      const current = readData();
      clean.playerStats = current.playerStats && typeof current.playerStats === 'object' ? { ...current.playerStats } : {};
      clean.modStatEventIds = Array.isArray(current.modStatEventIds) ? current.modStatEventIds : [];
      clean.statsImportLogs = Array.isArray(current.statsImportLogs)
        ? current.statsImportLogs.slice(0, MAX_STATS_IMPORT_LOGS)
        : [];
      const trackedStatKeys = new Set(['goals', 'assists', 'saves']);
      const currentSignupIds = new Set(current.signups.map(signup => signup.id));
      for (const [signupId, stats] of Object.entries(trackedStatsEdits || {})) {
        if (!currentSignupIds.has(signupId) || !stats || typeof stats !== 'object' || Array.isArray(stats) ||
            Object.keys(stats).some(key => !trackedStatKeys.has(key)) ||
            Object.values(stats).some(value => !Number.isSafeInteger(value) || value < 0)) {
          return send(res, 400, { error: 'Tracked stat edits are invalid.' });
        }
      }
      for (const [signupId, stats] of Object.entries(trackedStatsEdits || {})) {
        clean.playerStats[signupId] = { ...trackedStatsFor(current, signupId), ...stats };
      }
      const byId = new Map(current.signups.map(signup => [signup.id, signup]));
      clean.signups.forEach(signup => byId.set(signup.id, signup));
      clean.signups = [...byId.values()].slice(0, 5000);
      const currentDraft = normalizeDraft(current.draft, current.teams, current.signups);
      if (clearAllAssignments) {
        clean.signups.forEach(signup => { signup.team = ''; });
        clean.draft = normalizeDraft({
          ...clean.draft,
          active: false,
          picks: [],
          nextIndex: 0,
        }, clean.teams, clean.signups);
      } else {
        const keepCurrentOrder = currentDraft.active || currentDraft.picks.length > 0;
        clean.draft = normalizeDraft({
          ...clean.draft,
          manualOrder: keepCurrentOrder ? true : clean.draft.manualOrder,
          order: keepCurrentOrder ? currentDraft.order : clean.draft.order,
          picks: currentDraft.picks,
          nextIndex: currentDraft.nextIndex,
        }, clean.teams, clean.signups);
      }
      const signupsById = new Map(clean.signups.map(signup => [signup.id, signup]));
      clean.draft.picks.forEach(pick => { signupsById.get(pick.signupId).team = pick.teamId; });
      syncSignupPlayers(clean);
      writeData(clean);
      // delete uploads nothing uses anymore
      const used = new Set(clean.teams.flatMap(t => [t.logo, t.photo]).concat(clean.signups.map(s => s.photo)).map(u => path.basename(u || '')));
      for (const f of fs.readdirSync(UPLOAD_DIR)) if (!used.has(f)) fs.unlink(path.join(UPLOAD_DIR, f), () => {});
      const logo = findLogo();
      attachTrackedStats(clean);
      const { playerStats, modStatEventIds, ...responseData } = clean;
      return send(res, 200, { ...responseData, hasLogo: !!logo, logoUrl: logo ? logo.url : '' });
    }
    if (p === '/api/sign-up' && req.method === 'POST') {
      if (!allowPublic('signup:' + clientIp(req), 5, 60 * 60 * 1000)) {
        return send(res, 429, { error: 'You have submitted several signups recently. Please try again later.' });
      }
      const signup = JSON.parse(await readBody(req) || '{}');
      const discord = str(signup.discord, 80), name = str(signup.name, 40);
      const steam = steamProfile(signup.steam);
      const player = playerSession(req);
      const profileSteamId = steamIdFromProfileUrl(steam);
      const manualSteamId = /^\d{17}$/.test(String(signup.steamId || '')) ? String(signup.steamId) : '';
      const submittedSteamId = profileSteamId || manualSteamId;
      const steamId = player
        ? (submittedSteamId === player.steamId ? player.steamId : '')
        : submittedSteamId;
      const hours = Number(signup.hours);
      if (!discord || !name || !steam || !Number.isSafeInteger(hours) || hours < 0 || hours > 100000 ||
          !['Goalie', 'Attacker', 'Defender', 'Flexible'].includes(signup.position) ||
          !['Yes', 'No', 'Maybe'].includes(signup.captain)) {
        return send(res, 400, { error: 'Complete all fields with valid answers before submitting.' });
      }
      if (!submittedSteamId) {
        return send(res, 400, { error: 'This Steam link does not contain a Steam ID. Please enter your 17-digit Steam ID.' });
      }
      if (player && submittedSteamId !== player.steamId) {
        return send(res, 400, { error: 'The Steam ID must match the Steam account you are signed in with.' });
      }
      const data = readData();
      const discordKey = discord.toLowerCase(), profileKey = steamKey(steam);
      if (player && player.lookupFailed && profileKey === steamKey(player.profileUrl)) {
        return send(res, 503, { error: 'Steam could not resolve your profile link right now. Please try Steam sign-in again or enter your profile URL manually.' });
      }
      if (data.signups.some(existing => (steamId && signupSteamId(existing) === steamId) ||
          String(existing.discord || '').trim().toLowerCase() === discordKey ||
          (profileKey && steamKey(existing.steam) === profileKey))) {
        return send(res, 409, { error: 'You have already signed up. Sign in on Player Login using the Steam account on your signup; if it cannot find your signup, ask staff via Discord.' });
      }
      if (data.signups.length >= 5000) return send(res, 409, { error: 'Signups are currently full. Please contact the league administrator.' });
      const entry = {
        id: crypto.randomUUID(),
        discord,
        steam,
        steamId,
        name,
        hours,
        position: signup.position,
        captain: signup.captain,
        team: '',
        photo: okImage(signup.photo) ? signup.photo : '',
        skaterValue: 0,
        goalieValue: 0,
      };
      data.signups.push(entry);
      writeData(data);
      return send(res, 201, { ok: true });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not logged in' });
      let buf;
      try { buf = await readRaw(req, 8_000_000); } catch { return send(res, 413, { error: 'Image too large (max 8 MB)' }); }
      const ext = sniff(buf);
      if (!ext) return send(res, 400, { error: 'Use a PNG, JPG, WEBP or GIF image' });
      const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      return send(res, 200, { url: '/uploads/' + name });
    }
    if (p === '/api/sign-up-upload' && req.method === 'POST') {
      if (!allowPublic('signup-upload:' + clientIp(req), 10, 60 * 60 * 1000)) {
        return send(res, 429, { error: 'Too many profile picture uploads. Please try again later.' });
      }
      let buf;
      try { buf = await readRaw(req, 5_000_000); } catch { return send(res, 413, { error: 'Image too large (max 5 MB)' }); }
      const ext = sniff(buf);
      if (!ext) return send(res, 400, { error: 'Use a PNG, JPG, WEBP or GIF image' });
      const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      return send(res, 200, { url: '/uploads/' + name });
    }
    if (req.method === 'GET' && UPLOAD_RE.test(p)) {
      const f = uploadFile(p);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, fs.readFileSync(f), IMG_TYPES[p.split('.').pop()], { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    // the logo is optional, 404 until it's added
    if (req.method === 'GET' && (/^\/logo\.(png|webp|jpg)$/.test(p) || p === '/favicon.ico')) {
      const logo = findLogo();
      if (!logo || (p !== '/favicon.ico' && p !== logo.url)) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, fs.readFileSync(logo.file), logo.type, { 'Cache-Control': 'no-cache' });
    }
    // same html for every team, just with the right title and preview tags
    const tm = p.match(/^\/team\/([^/]+)$/);
    if (tm && (req.method === 'GET' || req.method === 'HEAD')) {
      let seg = ''; try { seg = decodeURIComponent(tm[1]).toLowerCase(); } catch {}
      const team = /^[a-z0-9-]{1,40}$/.test(seg) ? findTeam(readData(), seg) : null;
      if (!team) return send(res, 404, teamPageHtml(req, null), HTML, { 'Cache-Control': 'no-cache' });
      if (seg !== team.slug) { res.writeHead(301, { Location: '/team/' + team.slug, 'Cache-Control': 'no-cache' }); return res.end(); }
      return send(res, 200, teamPageHtml(req, team), HTML, { 'Cache-Control': 'no-cache' });
    }
    const s = STATIC[p];
    if (s && req.method === 'GET') {
      const extra = { 'Cache-Control': 'no-cache' };
      if (p === '/admin') extra['X-Robots-Tag'] = 'noindex';
      return send(res, 200, fs.readFileSync(path.join(DIR, s[0])), s[1], extra);
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    send(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found | MHL</title><p style="font:18px system-ui;padding:40px">Page not found. <a href="/">Back to the MHL home page</a></p>', HTML);
  } catch (e) {
    send(res, 400, { error: 'Bad request' });
  }
});
server.listen(PORT, () => {
  console.log(`MHL site running on http://localhost:${PORT}  (admin: /admin)  data: ${DATA_DIR}`);
  if (!MHL_STATS_PUSH_KEY)
    console.warn('[stats-import] Disabled: MHL_STATS_PUSH_KEY is unset.');
});

if (statsSftpConfig) {
  console.log('[MHL stats SFTP] Polling ' + statsSftpConfig.sources.length
    + ' source(s) every ' + statsSftpConfig.pollSeconds + ' seconds.');
  const runPoll = () => pollStatsSftpSources().catch(error => {
    console.error('[MHL stats SFTP] Poll failed:', error && error.message ? error.message : error);
  });
  setTimeout(runPoll, 5000).unref();
  setInterval(runPoll, statsSftpConfig.pollSeconds * 1000).unref();
} else {
  console.log('[MHL stats SFTP] Disabled; MHL_STATS_SFTP_CONFIG is not set.');
}

// shut down cleanly on redeploy
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
