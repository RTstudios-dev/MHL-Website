// MHL site. no npm packages needed, just: node server.js
//
// env vars (none needed locally):
//   PORT                 default 3000
//   DATA_DIR             where data.json + uploads/ live. point it at the persistent disk when hosted
//   ADMIN_PASSWORD_HASH  from `node hash-password.js` (use this when hosted)
//   ADMIN_PASSWORD       plain text password, works but the hash is better
//   NODE_ENV=production  won't start without a password
//   TRUST_PROXY=1        set when behind a proxy so the login lockout sees the real ip
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || DIR);
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PW_FILE = path.join(DATA_DIR, '.admin-password');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
// league logo: logo.png, logo.webp or logo.jpg next to server.js (optional)
const LOGO_TYPES = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg' };
const findLogo = () => { for (const ext of Object.keys(LOGO_TYPES)) { const file = path.join(DIR, 'logo.' + ext); if (fs.existsSync(file)) return { file, url: '/logo.' + ext, type: LOGO_TYPES[ext] }; } return null; };
const PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const EMPTY = { site: { season: 'Season 1', discord: '' }, teams: [], rounds: [], matches: [], players: [], news: [], rules: [] };

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
const fails = new Map(); // ip -> {n, until}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, f] of fails) if (f.until < now && f.n === 0) fails.delete(ip);
}, 10 * 60 * 1000).unref();

const clientIp = req => {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // last hop = what the proxy saw
  }
  return req.socket.remoteAddress;
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

// clean up whatever the admin page sends
const readBody = async req => (await readRaw(req, 1_000_000)).toString();
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, max = 9999) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= 0 ? Math.min(x, max) : 0; };
const score = v => (v === null || v === '' || v === undefined) ? null : num(v, 99);
const okImage = u => UPLOAD_RE.test(u) && fs.existsSync(uploadFile(u));
const okUrl = u => /^https:\/\/[^\s"<>]+$/.test(String(u || '')) ? String(u).slice(0, 300) : '';
function sanitize(d) {
  if (!d || typeof d !== 'object') throw new Error('bad data');
  const s = d.site && typeof d.site === 'object' ? d.site : {};
  const site = { season: str(s.season, 40), discord: okUrl(s.discord) };
  const teams = (Array.isArray(d.teams) ? d.teams : []).slice(0, 64).map(t => ({
    id: str(t.id, 40) || crypto.randomUUID(),
    name: str(t.name, 40) || 'Unnamed team',
    short: str(t.short, 4).toUpperCase().replace(/[^A-Z0-9]/g, ''),   // 2-4 letters, shown on scoreboards
    color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#c8102e',
    logo: okImage(t.logo) ? t.logo : '',
    photo: okImage(t.photo) ? t.photo : '',   // optional team photo
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
  const players = (Array.isArray(d.players) ? d.players : []).slice(0, 1000).filter(p => ids.has(p.team)).map(p => ({
    id: str(p.id, 40) || crypto.randomUUID(),
    name: str(p.name, 40) || 'Player', team: p.team,
    role: p.role === 'goalie' ? 'goalie' : 'skater',
    number: str(p.number, 3).replace(/[^0-9]/g, ''),
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
  return { site, teams, rounds, matches, players, news, rules };
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');   // /matches/ -> /matches
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (p === '/api/data' && req.method === 'GET') {
      // logoUrl: pages swap the wordmark for the logo when there is one
      const logo = findLogo();
      return send(res, 200, { ...readData(), hasLogo: !!logo, logoUrl: logo ? logo.url : '' });
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
      const clean = sanitize(JSON.parse(await readBody(req)));
      writeData(clean);
      // delete uploads nothing uses anymore
      const used = new Set(clean.teams.flatMap(t => [t.logo, t.photo]).map(u => path.basename(u || '')));
      for (const f of fs.readdirSync(UPLOAD_DIR)) if (!used.has(f)) fs.unlink(path.join(UPLOAD_DIR, f), () => {});
      const logo = findLogo();
      return send(res, 200, { ...clean, hasLogo: !!logo, logoUrl: logo ? logo.url : '' });
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
server.listen(PORT, () => console.log(`MHL site running on http://localhost:${PORT}  (admin: /admin)  data: ${DATA_DIR}`));

// shut down cleanly on redeploy
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
