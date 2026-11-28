// shared by the public pages: menu, loading data, render helpers
(function (root) {
  const M = root.MHL = root.MHL || {};
  const esc = M.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NAV = [
    ['/', 'Home'], ['/league', 'League'], ['/players', 'Player Stats'], ['/news', 'News'], ['/rules', 'Rules'],
    ['/season-2-players', 'Season 2 Players'],
  ];
  const here = location.pathname.replace(/\/+$/, '') || '/';
  const current = here.startsWith('/team/') || ['/matches', '/standings', '/teams'].includes(here) ? '/league' : here;
  const draftBoard = '/season-2-players';
  const cur = href => href === current ? ' aria-current="page"' : '';
  let checkingDraftTurn = false;
  let notificationsEnabled = false;
  let notificationAnimationTimer = 0;

  const wordmark = '<span class="wm">M<i>H</i>L</span>';
  let steamLoginButton;
  const showSteamProfileButton = signup => {
    const name = signup && (signup.discord || signup.name) || 'Steam profile';
    steamLoginButton.classList.add('is-profile');
    steamLoginButton.setAttribute('aria-label', `${name} player profile`);
    steamLoginButton.title = `${name} player profile`;
    steamLoginButton.innerHTML = signup && signup.photo
      ? `<img src="${esc(signup.photo)}" alt="">`
      : `<span>${esc(name.trim().charAt(0).toUpperCase() || 'S')}</span>`;
  };
  const addScheduleLink = async () => {
    const [adminResponse, captainResponse] = await Promise.all([
      fetch('/api/me', { cache: 'no-store' }),
      fetch('/api/draft', { cache: 'no-store' }),
    ]);
    const [admin, captain] = await Promise.all([adminResponse.json(), captainResponse.json()]);
    if (!adminResponse.ok) throw new Error(admin.error || 'Could not check admin access.');
    if (!captainResponse.ok) throw new Error(captain.error || 'Could not check team captain status.');
    if (!admin.admin && !captain.captainTeamId) return;
    const nav = document.querySelector('.top-nav');
    if (nav.querySelector('a[href="/schedule"]')) return;
    const link = document.createElement('a');
    link.href = '/schedule';
    link.textContent = 'Schedule';
    if (current === '/schedule') link.setAttribute('aria-current', 'page');
    nav.append(link);
  };
  const stopNotificationAnimation = () => {
    window.clearTimeout(notificationAnimationTimer);
    notificationAnimationTimer = 0;
    const toggle = document.getElementById('notificationToggle');
    if (toggle) toggle.classList.remove('animation-enabled');
  };
  const scheduleNotificationAnimation = () => {
    const toggle = document.getElementById('notificationToggle');
    const menu = document.getElementById('notificationMenu');
    if (!toggle || !menu || !menu.hidden || !toggle.classList.contains('has-unread')
        || toggle.classList.contains('animation-enabled') || notificationAnimationTimer) return;
    notificationAnimationTimer = window.setTimeout(() => {
      notificationAnimationTimer = 0;
      if (menu.hidden && toggle.classList.contains('has-unread'))
        toggle.classList.add('animation-enabled');
    }, 10000);
  };
  M.refreshPlayerButton = async function () {
    const sessionResponse = await fetch('/api/player/me', { cache: 'no-store' });
    if (!sessionResponse.ok) throw new Error('Could not check Steam sign-in.');
    const session = await sessionResponse.json();
    if (!session.authenticated) {
      notificationsEnabled = false;
      stopNotificationAnimation();
      steamLoginButton.classList.remove('is-profile');
      steamLoginButton.innerHTML = '<img class="header-service-logo" src="/steam-logo.png" alt="">';
      steamLoginButton.setAttribute('aria-label', 'Steam login and player profile');
      steamLoginButton.removeAttribute('title');
      document.getElementById('playerNotifications').hidden = true;
      return;
    }
    showSteamProfileButton(null);
    const signupResponse = await fetch('/api/player/signup', { cache: 'no-store' });
    if (signupResponse.status === 404) {
      notificationsEnabled = false;
      stopNotificationAnimation();
      document.getElementById('playerNotifications').hidden = true;
      return;
    }
    if (!signupResponse.ok) throw new Error('Could not load your player profile.');
    const result = await signupResponse.json();
    showSteamProfileButton(result.signup);
    document.querySelector('.top-signup').hidden = true;
    notificationsEnabled = true;
    M.refreshNotifications().catch(error => console.error('Could not load player notifications:', error));
  };
  M.refreshNotifications = async function () {
    if (!notificationsEnabled) return;
    const root = document.getElementById('playerNotifications');
    const toggle = document.getElementById('notificationToggle');
    const menu = document.getElementById('notificationMenu');
    const list = document.getElementById('notificationList');
    const count = document.getElementById('notificationCount');
    const markAll = document.getElementById('markAllNotificationsRead');
    const response = await fetch('/api/player/notifications', { cache: 'no-store' });
    const result = await response.json();
    if (response.status === 401 || response.status === 404) {
      notificationsEnabled = false;
      stopNotificationAnimation();
      root.hidden = true;
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!response.ok) throw new Error(result.error || 'Could not load player notifications.');
    root.hidden = false;
    const unreadCount = Number(result.unreadCount) || 0;
    count.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    count.hidden = unreadCount === 0;
    toggle.classList.toggle('has-unread', unreadCount > 0);
    if (unreadCount && menu.hidden) scheduleNotificationAnimation();
    else stopNotificationAnimation();
    toggle.setAttribute('aria-label', unreadCount
      ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
      : 'Notifications');
    markAll.hidden = unreadCount === 0;
    list.replaceChildren();
    const categories = {
      badges: 'Badge',
      pose: 'Pose',
      helmet: 'Helmet',
      torso: 'Torso',
      stick: 'Stick',
      border: 'Border',
    };
    const notifications = Array.isArray(result.notifications) ? result.notifications : [];
    if (!notifications.length) {
      const empty = document.createElement('li');
      empty.className = 'notification-empty';
      empty.textContent = 'No new component unlocks yet.';
      list.append(empty);
      return;
    }
    notifications.slice().reverse().forEach(notification => {
      const item = document.createElement('li');
      item.className = `notification-item${notification.read ? '' : ' unread'}`;
      const link = document.createElement('a');
      const query = new URLSearchParams();
      if (notification.category === 'pose') {
        query.set('focus', 'pose');
        query.set('pose', notification.componentId);
      } else {
        query.set('category', notification.category);
        query.set('item', notification.componentId);
        if (notification.poseId) query.set('pose', notification.poseId);
      }
      link.href = `/player-banner?${query.toString()}`;
      link.textContent = notification.campaignId
        ? notification.title
        : `${categories[notification.category] || 'Component'} unlocked: ${notification.title}`;
      if (!notification.read) {
        const indicator = document.createElement('span');
        indicator.className = 'notification-unread-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        link.prepend(indicator);
      }
      const time = document.createElement('time');
      time.className = 'notification-time';
      if (notification.createdAt) {
        time.dateTime = notification.createdAt;
        const date = new Date(notification.createdAt);
        time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
      }
      link.append(time);
      link.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const destination = link.href;
        const markRead = fetch('/api/player/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: notification.id }),
        }).then(async readResponse => {
          const readResult = await readResponse.json();
          if (!readResponse.ok) throw new Error(readResult.error || 'Could not mark notification as read.');
        });
        menu.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        stopNotificationAnimation();
        markRead.then(() => location.assign(destination)).catch(error => {
          console.error('Could not mark the player notification as read:', error);
          location.assign(destination);
        });
      });
      item.append(link);
      if (notification.description) {
        const description = document.createElement('p');
        description.className = 'notification-description';
        description.textContent = notification.description;
        item.append(description);
      }
      list.append(item);
    });
  };
  M.checkDraftTurn = async function () {
    if (current === draftBoard || current === '/schedule' || document.hidden || checkingDraftTurn) return;
    checkingDraftTurn = true;
    try {
      const response = await fetch('/api/draft', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not check the draft turn.');
      if (result.active && result.captainTeamId && result.currentTeamId === result.captainTeamId) {
        location.replace(draftBoard);
      }
    } finally {
      checkingDraftTurn = false;
    }
  };
  function shell() {
    const header = document.getElementById('mtop');
    header.innerHTML = `
      <a class="top-brand" href="/" aria-label="MHL home">
        <span class="top-brand-mark">${wordmark}</span>
        <span class="top-brand-title"><span>Miniature</span><span>Hockey League</span></span>
      </a>
      <nav class="top-nav" aria-label="Main">${NAV.map(([h, t]) => `<a href="${h}"${cur(h)}>${t}</a>`).join('')}</nav>
      <div class="top-actions"><a class="btn top-signup" href="/sign-up">Sign Up for season 2</a><span id="discordSlot"></span></div>`;
    const notificationRoot = document.createElement('div');
    notificationRoot.className = 'player-notifications';
    notificationRoot.id = 'playerNotifications';
    notificationRoot.hidden = true;
    notificationRoot.innerHTML = `
        <button class="notification-toggle" id="notificationToggle" type="button" aria-label="Notifications" aria-expanded="false" aria-controls="notificationMenu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
          <span class="notification-count" id="notificationCount" hidden></span>
        </button>
        <section class="notification-menu" id="notificationMenu" aria-label="Player notifications" hidden>
          <div class="notification-menu-heading">
            <strong>Notifications</strong>
            <button type="button" id="markAllNotificationsRead" hidden>Mark all read</button>
          </div>
          <ul class="notification-list" id="notificationList"></ul>
        </section>`;
    header.insertAdjacentElement('afterend', notificationRoot);
    const positionNotifications = () => {
      notificationRoot.style.top = `${Math.ceil(header.getBoundingClientRect().bottom + 8)}px`;
    };
    positionNotifications();
    if ('ResizeObserver' in window) new ResizeObserver(positionNotifications).observe(header);
    else window.addEventListener('resize', positionNotifications);
    steamLoginButton = document.createElement('a');
    steamLoginButton.className = 'header-icon-link steam-login-top';
    steamLoginButton.href = '/player-login';
    steamLoginButton.innerHTML = '<img class="header-service-logo" src="/steam-logo.png" alt="">';
    steamLoginButton.setAttribute('aria-label', 'Steam login and player profile');
    document.querySelector('.top-actions').appendChild(steamLoginButton);
    M.refreshPlayerButton().catch(error => console.error('Could not update the Steam profile button:', error));
    addScheduleLink().catch(error => console.error('Could not check schedule access:', error));
    const notificationToggle = document.getElementById('notificationToggle');
    const notificationMenu = document.getElementById('notificationMenu');
    const closeNotifications = () => {
      notificationMenu.hidden = true;
      notificationToggle.setAttribute('aria-expanded', 'false');
      scheduleNotificationAnimation();
    };
    notificationToggle.addEventListener('click', () => {
      const opening = notificationMenu.hidden;
      notificationMenu.hidden = !opening;
      notificationToggle.setAttribute('aria-expanded', String(opening));
      if (opening) {
        stopNotificationAnimation();
        M.refreshNotifications().catch(error => console.error('Could not refresh player notifications:', error));
      } else {
        scheduleNotificationAnimation();
      }
    });
    document.getElementById('markAllNotificationsRead').addEventListener('click', async () => {
      try {
        const response = await fetch('/api/player/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markAll: true }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not mark notifications as read.');
        await M.refreshNotifications();
      } catch (error) {
        console.error('Could not mark player notifications as read:', error);
      }
    });
    document.addEventListener('click', event => {
      if (!notificationRoot.contains(event.target)) closeNotifications();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeNotifications();
    });
    window.setInterval(() => {
      if (notificationsEnabled && !document.hidden)
        M.refreshNotifications().catch(error => console.error('Could not refresh player notifications:', error));
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (notificationsEnabled && !document.hidden)
        M.refreshNotifications().catch(error => console.error('Could not refresh player notifications:', error));
    });
    if (current !== draftBoard) {
      const checkDraftTurn = () => M.checkDraftTurn().catch(error => console.error('Could not check the draft turn:', error));
      checkDraftTurn();
      window.setInterval(checkDraftTurn, 3000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDraftTurn(); });
    }
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
      document.getElementById('discordSlot').outerHTML = `<a class="header-icon-link" href="${esc(d)}" target="_blank" rel="noopener" aria-label="Join the Discord" title="Join the Discord"><img class="header-service-logo" src="/discord-logo.png" alt=""></a>`;
    }
  }

  M.load = async function () {
    const r = await fetch('/api/data', { cache: 'no-store' });
    if (!r.ok) throw new Error('load failed');
    const D = await r.json();
    D.T = Object.fromEntries(D.teams.map(t => [t.id, t]));
    D.R = Object.fromEntries(D.rounds.map(r => [r.id, r]));
    D.table = M.compute(D);
    D.T2 = Object.fromEntries((D.season2Teams || []).map(team => [team.id, team]));
    D.R2 = Object.fromEntries((D.season2Rounds || []).map(round => [round.id, round]));
    D.season2View = {
      ...D,
      seasonKey: 'season2',
      teams: D.season2Teams || [],
      matches: D.season2Matches || [],
      rounds: D.season2Rounds || [],
      T: D.T2,
      R: D.R2,
    };
    D.season2View.table = M.compute(D.season2View);
    // player totals come from the goal logs
    const tot = M.playerTotals(D);
    D.players.forEach(p => { p.g = tot[p.id].g; p.a = tot[p.id].a; });
    D.P = Object.fromEntries(D.players.map(p => [p.id, p]));
    D.season2View.P = D.P;
    dress(D);
    return D;
  };
  M.fail = (el, what) => { el.innerHTML = M.empty('Could not load ' + what, 'Check your connection and reload the page.'); };

  // helpers
  M.badge = (t, cls = '') => !t ? '' : t.logo
    ? `<span class="badge ${cls}"><img src="${esc(t.logo)}" alt=""></span>`
    : `<span class="badge ${cls}" style="--c:${esc(t.color)}" aria-hidden="true">${esc(M.code(t))}</span>`;
  M.code = t => t.short || t.name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase() || t.name.slice(0, 3).toUpperCase();
  M.teamUrl = (t, season = 'season1') => '/team/' + encodeURIComponent(t.slug || t.id)
    + (season === 'season2' ? '?season=season2' : '');
  M.teamLink = (t, text, season = 'season1') => t
    ? `<a class="tlink" href="${M.teamUrl(t, season)}">${esc(text ?? t.name)}</a>`
    : 'Unknown team';
  M.empty = (title, text) => `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  M.parseDate = s => {
    if (!s) return null;
    const value = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s;
    const d = new Date(value);
    return isNaN(d) ? null : d;
  };
  M.toLocalDateTimeInput = value => {
    const date = M.parseDate(value);
    if (!date) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  M.fromLocalDateTimeInput = value => {
    if (!value) return '';
    const date = new Date(value);
    return isNaN(date) ? '' : date.toISOString();
  };
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
  M.played = (m, D) => M.state(m, M.bestOf(D, m)).decided;

  // box score for one series
  M.scoreboard = (m, D) => {
    const A = D.T[m.a], B = D.T[m.b], bestOf = M.bestOf(D, m);
    const st = M.state(m, bestOf), s = M.status(m, st), pts = M.points(st);
    const round = D.R[m.round];
    const counted = new Set(st.counted);
    const games = M.gamesOf(m, bestOf);
    const cell = (g, side) => {
      if (!g || !counted.has(g)) return '<span class="sb-g">-</span>';
      const mine = side === 'a' ? g.as : g.bs, theirs = side === 'a' ? g.bs : g.as;
      return `<span class="sb-g${mine > theirs ? ' w' : ''}">${mine}</span>`;
    };
    const row = (t, side) => {
      const wins = side === 'a' ? st.wa : st.wb, other = side === 'a' ? st.wb : st.wa;
      const cls = st.decided ? (wins > other ? ' win' : ' lose') : '';
      return `<div class="sb-row${cls}">${M.badge(t)}<span class="sb-name">${M.teamLink(t, undefined, D.seasonKey)}</span>${Array.from({ length: bestOf }, (_, i) => cell(games[i], side)).join('')}<span class="sb-s">${st.started ? wins : '-'}</span></div>`;
    };
    const winner = st.decided ? (st.wa > st.wb ? A : B) : null;
    const playoff = round && round.playoffStage;
    const loser = st.decided ? (st.wa > st.wb ? B : A) : null;
    const foot = pts
      ? playoff
        ? `<span>${esc(M.code(winner))} win ${Math.max(st.wa, st.wb)}-${Math.min(st.wa, st.wb)}</span><span>${round.playoffStage === 'finals'
          ? `Champion: <b>${esc(M.code(winner))}</b> · Finalist: <b>${esc(M.code(loser))}</b>`
          : `Advances: <b>${esc(M.code(winner))}</b> · Eliminated: <b>${esc(M.code(loser))}</b>`}</span>`
        : `<span>${esc(M.code(winner))} win ${Math.max(st.wa, st.wb)}-${Math.min(st.wa, st.wb)}</span><span>Points <b>${esc(M.code(A))} ${pts[0]}</b>, <b>${esc(M.code(B))} ${pts[1]}</b></span>`
      : `<span>${esc(M.fmtDate(m.date))}</span><span>${playoff ? (round.playoffStage === 'finals' ? `Championship series · Best of ${bestOf}` : `Playoff · Best of ${bestOf} · winner advances`) : `Best of ${bestOf}`}</span>`;
    // who scored, one line per team, from the goal log
    const tally = side => {
      const T = new Map(), add = (p, k) => { if (!D.P[p]) return; const r = T.get(p) || { g: 0, a: 0 }; r[k]++; T.set(p, r); };
      M.goalsOf(m, bestOf).filter(x => x.t === side).forEach(x => { add(x.s, 'g'); add(x.a1, 'a'); add(x.a2, 'a'); });
      return [...T].sort((x, y) => y[1].g - x[1].g || y[1].a - x[1].a);
    };
    const line = (t, rows) => !rows.length ? '' : `<p><b>${esc(M.code(t))}</b> ${rows.map(([p, r]) =>
      esc(D.P[p].name) + ' ' + [r.g ? r.g + 'G' : '', r.a ? r.a + 'A' : ''].filter(Boolean).join(' ')).join(', ')}</p>`;
    const la = line(A, tally('a')), lb = line(B, tally('b'));
    const scoring = la || lb ? `<div class="sb-pl">${la}${lb}</div>` : '';
    return `<article class="sb bo${bestOf}${st.started ? '' : ' up'}" aria-label="${esc(A ? A.name : '')} against ${esc(B ? B.name : '')}">
      <div class="sb-head"><span>${esc(round ? round.name : M.fmtDate(m.date))}</span><span class="st ${s.cls}">${esc(s.label)}</span></div>
      <div class="sb-cols" aria-hidden="true"><span></span><span></span>${Array.from({ length: bestOf }, (_, i) => `<span>G${i + 1}</span>`).join('')}<span>Series</span></div>
      ${row(A, 'a')}${row(B, 'b')}
      ${scoring}<div class="sb-foot">${foot}</div></article>`;
  };

  // admin text -> paragraphs, https links clickable
  M.prose = text => String(text || '').split(/\n\s*\n/).filter(p => p.trim()).map(p =>
    '<p>' + esc(p.trim()).replace(/\n/g, '<br>').replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`) + '</p>').join('');

  shell();
})(window);
