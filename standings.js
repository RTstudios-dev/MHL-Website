// series + standings maths, used by the site and the admin page
// best of 3: 2-0 = 3/0 points, 2-1 = 2/1
(function (root) {
  const gamesOf = m => (Array.isArray(m.games) ? m.games : []).slice(0, 3);
  const valid = g => g && g.as != null && g.bs != null && g.as !== g.bs;

  // wa/wb = games won by team a/b
  const state = m => {
    let wa = 0, wb = 0; const counted = [];
    for (const [i, g] of gamesOf(m).entries()) {
      if (wa >= 2 || wb >= 2) break;               // already over
      if (i === 2 && !(wa === 1 && wb === 1)) break; // game 3 only if it's 1-1
      if (!valid(g)) continue;
      counted.push(g); g.as > g.bs ? wa++ : wb++;
    }
    return { wa, wb, counted, decided: wa >= 2 || wb >= 2, started: counted.length > 0 };
  };

  // [a, b] points, null if it's not finished
  const points = st => !st.decided ? null
    : st.wa >= 2 ? (st.wb === 0 ? [3, 0] : [2, 1])
    : (st.wa === 0 ? [0, 3] : [1, 2]);

  const playoffStages = ['quarterfinals', 'semifinals', 'finals'];
  const playoffStageNames = {
    quarterfinals: 'Quarter Finals',
    semifinals: 'Semi Finals',
    finals: 'Finals',
  };
  const playoffStageName = stage => playoffStageNames[stage] || '';
  const playoffFinishOrder = {
    Champion: 0,
    Finalist: 1,
    'In Finals': 1,
    'In Semi Finals': 3,
    'Semi-finalist': 4,
    'Advanced to Semi Finals': 5,
    'In Quarter Finals': 6,
    'Quarter-finalist': 7,
  };
  const isPlayoffMatch = (D, match) => {
    const round = (D.rounds || []).find(item => item.id === match.round);
    return !!(round && playoffStages.includes(round.playoffStage));
  };

  function compute(D) {
    const S = Object.fromEntries(D.teams.map(t => [t.id, { t, sp: 0, sw: 0, sl: 0, mp: 0, mw: 0, ml: 0, gf: 0, ga: 0, pts: 0 }]));
    const h2h = {}; // h2h[x][y] = games x won vs y
    let gamesPlayed = 0, goals = 0, seriesPlayed = 0;
    D.matches.forEach(m => {
      const A = S[m.a], B = S[m.b]; if (!A || !B) return;
      const playoff = isPlayoffMatch(D, m);
      const st = state(m);
      st.counted.forEach(g => {
        gamesPlayed++; goals += g.as + g.bs;
        if (playoff) return;
        A.mp++; B.mp++; A.gf += g.as; A.ga += g.bs; B.gf += g.bs; B.ga += g.as;
        const [w, l, wid, lid] = g.as > g.bs ? [A, B, m.a, m.b] : [B, A, m.b, m.a];
        w.mw++; l.ml++;
        h2h[wid] = h2h[wid] || {}; h2h[wid][lid] = (h2h[wid][lid] || 0) + 1;
      });
      if (st.decided) {
        seriesPlayed++;
        if (playoff) return;
        const aWon = st.wa >= 2, w = aWon ? A : B, l = aWon ? B : A, [pa, pb] = points(st);
        w.sw++; l.sl++; w.sp++; l.sp++;
        A.pts += pa; B.pts += pb;
      }
    });
    // tiebreaks: pts, games won, h2h, series won, goal diff, goals for
    const h2hWins = (r, group) => group.reduce((n, o) => o === r ? n : n + ((h2h[r.t.id] || {})[o.t.id] || 0) - ((h2h[o.t.id] || {})[r.t.id] || 0), 0);
    const rows = Object.values(S).sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
    const sorted = [];
    for (let i = 0; i < rows.length;) {
      let j = i; while (j < rows.length && rows[j].pts === rows[i].pts) j++;
      const grp = rows.slice(i, j);
      grp.sort((x, y) => y.mw - x.mw || h2hWins(y, grp) - h2hWins(x, grp) || y.sw - x.sw || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
      sorted.push(...grp); i = j;
    }
    const regularOrder = new Map(sorted.map((r, i) => [r.t.id, i]));
    const playoffOrder = new Map(sorted.map(r => {
      const finish = playoffFinish(D, r.t.id);
      return [r.t.id, { finish, rank: playoffFinishOrder[finish] ?? Number.POSITIVE_INFINITY }];
    }));
    if ([...playoffOrder.values()].some(result => result.finish)) {
      sorted.sort((a, b) => {
        const x = playoffOrder.get(a.t.id), y = playoffOrder.get(b.t.id);
        return x.rank - y.rank || regularOrder.get(a.t.id) - regularOrder.get(b.t.id);
      });
    }
    sorted.forEach((r, i) => { r.place = i + 1; });
    return { S, sorted, gamesPlayed, goals, seriesPlayed };
  }

  function playoffFinish(D, teamId) {
    const rounds = new Map((D.rounds || []).map(round => [round.id, round]));
    for (let index = playoffStages.length - 1; index >= 0; index--) {
      const stage = playoffStages[index];
      const matches = (D.matches || []).filter(match => {
        const round = rounds.get(match.round);
        return (match.a === teamId || match.b === teamId) && round && round.playoffStage === stage;
      });
      if (!matches.length) continue;
      if (matches.some(match => !state(match).decided))
        return 'In ' + playoffStageName(stage);

      const decided = matches
        .filter(match => state(match).decided)
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      const match = decided[decided.length - 1];
      const st = state(match);
      const won = match.a === teamId ? st.wa > st.wb : st.wb > st.wa;
      if (stage === 'finals') return won ? 'Champion' : 'Finalist';
      if (stage === 'semifinals') return won ? 'Finalist' : 'Semi-finalist';
      return won ? 'Advanced to Semi Finals' : 'Quarter-finalist';
    }
    return '';
  }

  // goals from games that count (not a game 3 after 2-0, not ties)
  const goalsOf = m => {
    const st = state(m), games = gamesOf(m);
    const ok = new Set(games.map((g, i) => st.counted.includes(g) ? i : -1));
    return (m.goals || []).filter(x => ok.has(x.g));
  };

  // player id -> {g, a}, counted from every match's goal log
  function playerTotals(D) {
    const T = Object.fromEntries(D.players.map(p => [p.id, { g: 0, a: 0 }]));
    D.matches.forEach(m => goalsOf(m).forEach(x => {
      if (T[x.s]) T[x.s].g++;
      if (T[x.a1]) T[x.a1].a++;
      if (T[x.a2]) T[x.a2].a++;
    }));
    return T;
  }

  root.MHL = Object.assign(root.MHL || {}, {
    gamesOf, valid, state, points, compute, goalsOf, playerTotals,
    isPlayoffMatch, playoffFinish, playoffStageName,
  });
})(window);
