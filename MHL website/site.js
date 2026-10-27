// shared by the public pages: menu, loading data, render helpers
(function (root) {
  const M = root.MHL = root.MHL || {};
  const esc = M.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NAV = [
    ['/', 'Home'], ['/matches', 'Matches'], ['/standings', 'Standings'], ['/teams', 'Teams'],
    ['/players', 'Players'], ['/news', 'News'], ['/rules', 'Rules'],
  ];
  // phone tab bar: 4 pages + More
  const TABS = [['/', 'Home'], ['/matches', 'Matches'], ['/standings', 'Table'], ['/teams', 'Teams']];
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const current = here.startsWith('/team/') ? '/teams' : here;
  const cur = href => href === current ? ' aria-current="page"' : '';

  const wordmark = '<span class="wm">M<i>H</i>L</span>';
  function shell() {
    const side = document.getElementById('side');
    side.innerHTML = `
      <a class="brand" href="/" aria-label="MHL home">${wordmark}<small>Miniature Hockey League</small></a>
      <nav aria-label="Main">${NAV.map(([h, t]) => `<a href="${h}"${cur(h)}>${t}</a>`).join('')}</nav>
      <div class="side-foot"><span id="discordSlot"></span><a class="admin" href="/admin">Admin</a></div>`;
    document.getElementById('mtop').innerHTML = `<a href="/" aria-label="MHL home">${wordmark}</a><span>Miniature Hockey League</span>`;
    const inMore = !TABS.some(([h]) => h === current);
    document.getElementById('tabbar').innerHTML = TABS.map(([h, t]) => `<a href="${h}"${cur(h)}>${t}</a>`).join('')
      + `<button type="button" id="moreBtn" aria-expanded="false" aria-controls="more"${inMore ? ' aria-current="page"' : ''}>More</button>`;
    const more = document.getElementById('more');
    more.innerHTML = NAV.filter(([h]) => !TABS.some(([x]) => x === h)).map(([h, t]) => `<a href="${h}"${cur(h)}>${t}</a>`).join('')
      + '<span id="discordSlotM"></span><a href="/admin">Admin</a>';
    const btn = document.getElementById('moreBtn');
    btn.onclick = () => { more.hidden = !more.hidden; btn.setAttribute('aria-expanded', String(!more.hidden)); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !more.hidden) { more.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
    const main = document.getElementById('main');
    const foot = document.createElement('footer');
    foot.className = 'foot';
    foot.textContent = '© ' + new Date().getFullYear() + ' Miniature Hockey League';
    main.appendChild(foot);
  }
  // after load: use the logo if there is one, show discord button if a link is set
  function dress(D) {
    if (D.hasLogo) {
      document.querySelectorAll('.wm').forEach(el => { el.outerHTML = `<img class="logo" src="${esc(D.logoUrl)}" alt="MHL">`; });
      if (!document.querySelector('link[rel=icon]')) document.head.insertAdjacentHTML('beforeend', `<link rel="icon" href="${esc(D.logoUrl)}">`);
    }
    const d = D.site && D.site.discord;
    if (d) {
      document.getElementById('discordSlot').outerHTML = `<a class="btn" href="${esc(d)}" target="_blank" rel="noopener">Join the Discord</a>`;
      document.getElementById('discordSlotM').outerHTML = `<a href="${esc(d)}" target="_blank" rel="noopener">Discord</a>`;
    }
  }

  M.load = async function () {
    const r = await fetch('/api/data', { cache: 'no-store' });
    if (!r.ok) throw new Error('load failed');
    const D = await r.json();
    D.T = Object.fromEntries(D.teams.map(t => [t.id, t]));
    D.R = Object.fromEntries(D.rounds.map(r => [r.id, r]));
    D.table = M.compute(D);
    // player totals come from the goal logs
    const tot = M.playerTotals(D);
    D.players.forEach(p => { p.g = tot[p.id].g; p.a = tot[p.id].a; });
    D.P = Object.fromEntries(D.players.map(p => [p.id, p]));
    dress(D);
    return D;
  };
  M.fail = (el, what) => { el.innerHTML = M.empty('Could not load ' + what, 'Check your connection and reload the page.'); };

  // helpers
  M.badge = (t, cls = '') => !t ? '' : t.logo
    ? `<span class="badge ${cls}"><img src="${esc(t.logo)}" alt=""></span>`
    : `<span class="badge ${cls}" style="--c:${esc(t.color)}" aria-hidden="true">${esc(M.code(t))}</span>`;
  M.code = t => t.short || t.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase() || t.name.slice(0, 3).toUpperCase();
  M.teamUrl = t => '/team/' + encodeURIComponent(t.slug || t.id);
  M.teamLink = (t, text) => t ? `<a class="tlink" href="${M.teamUrl(t)}">${esc(text ?? t.name)}</a>` : 'Unknown team';
  M.empty = (title, text) => `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  M.parseDate = s => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d; };
  M.fmtDate = s => {
    const d = M.parseDate(s); if (!d) return 'Date to be set';
    const time = /T\d/.test(s) ? ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : '';
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${time}`;
  };
  M.month = i => MONTHS[i];
  M.byDate = (x, y) => (M.parseDate(x.date) || new Date(8.64e15)) - (M.parseDate(y.date) || new Date(8.64e15));

  M.status = (m, st) => {
    if (st.decided) return { label: 'Final', cls: '' };
    if (st.started) return { label: 'In progress', cls: 'live' };
    const d = M.parseDate(m.date);
    if (!d) return { label: 'To be scheduled', cls: '' };
    return d > new Date() ? { label: 'Upcoming', cls: '' } : { label: 'Result pending', cls: '' };
  };
  M.played = m => M.state(m).decided;

  // box score for one series
  M.scoreboard = (m, D) => {
    const A = D.T[m.a], B = D.T[m.b], st = M.state(m), s = M.status(m, st), pts = M.points(st);
    const round = D.R[m.round];
    const counted = new Set(st.counted);
    const games = M.gamesOf(m);
    const cell = (g, side) => {
      if (!g || !counted.has(g)) return '<span class="sb-g">-</span>';
      const mine = side === 'a' ? g.as : g.bs, theirs = side === 'a' ? g.bs : g.as;
      return `<span class="sb-g${mine > theirs ? ' w' : ''}">${mine}</span>`;
    };
    const row = (t, side) => {
      const wins = side === 'a' ? st.wa : st.wb, other = side === 'a' ? st.wb : st.wa;
      const cls = st.decided ? (wins > other ? ' win' : ' lose') : '';
      return `<div class="sb-row${cls}">${M.badge(t)}<span class="sb-name">${M.teamLink(t)}</span>${[0, 1, 2].map(i => cell(games[i], side)).join('')}<span class="sb-s">${st.started ? wins : '-'}</span></div>`;
    };
    const winner = st.decided ? (st.wa > st.wb ? A : B) : null;
    const foot = pts
      ? `<span>${esc(M.code(winner))} win ${Math.max(st.wa, st.wb)}-${Math.min(st.wa, st.wb)}</span><span>Points <b>${esc(M.code(A))} ${pts[0]}</b>, <b>${esc(M.code(B))} ${pts[1]}</b></span>`
      : `<span>${esc(M.fmtDate(m.date))}</span><span>Best of 3</span>`;
    // who scored, one line per team, from the goal log
    const tally = side => {
      const T = new Map(), add = (p, k) => { if (!D.P[p]) return; const r = T.get(p) || { g: 0, a: 0 }; r[k]++; T.set(p, r); };
      M.goalsOf(m).filter(x => x.t === side).forEach(x => { add(x.s, 'g'); add(x.a1, 'a'); add(x.a2, 'a'); });
      return [...T].sort((x, y) => y[1].g - x[1].g || y[1].a - x[1].a);
    };
    const line = (t, rows) => !rows.length ? '' : `<p><b>${esc(M.code(t))}</b> ${rows.map(([p, r]) =>
      esc(D.P[p].name) + ' ' + [r.g ? r.g + 'G' : '', r.a ? r.a + 'A' : ''].filter(Boolean).join(' ')).join(', ')}</p>`;
    const la = line(A, tally('a')), lb = line(B, tally('b'));
    const scoring = la || lb ? `<div class="sb-pl">${la}${lb}</div>` : '';
    return `<article class="sb${st.started ? '' : ' up'}" aria-label="${esc(A ? A.name : '')} against ${esc(B ? B.name : '')}">
      <div class="sb-head"><span>${esc(round ? round.name : M.fmtDate(m.date))}</span><span class="st ${s.cls}">${esc(s.label)}</span></div>
      <div class="sb-cols" aria-hidden="true"><span></span><span></span><span>G1</span><span>G2</span><span>G3</span><span>Series</span></div>
      ${row(A, 'a')}${row(B, 'b')}
      ${scoring}<div class="sb-foot">${foot}</div></article>`;
  };

  // admin text -> paragraphs, https links clickable
  M.prose = text => String(text || '').split(/\n\s*\n/).filter(p => p.trim()).map(p =>
    '<p>' + esc(p.trim()).replace(/\n/g, '<br>').replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`) + '</p>').join('');

  shell();
})(window);
