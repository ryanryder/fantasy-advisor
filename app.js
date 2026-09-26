/* Fantasy Advisor: draft assistant + weekly start/sit + waivers.
 * Data comes from data/*.json (written by scripts/fetch_data.py via GitHub Actions),
 * falling back to Sleeper's public API straight from the browser. */
'use strict';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const SLOT_ELIG = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DST: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'], 'RB/WR': ['RB', 'WR'], 'WR/TE': ['WR', 'TE'], OP: ['QB', 'RB', 'WR', 'TE'],
};
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'RB/WR', 'WR/TE', 'FLEX', 'OP', 'DST', 'K'];
// How flex-type slots are usually filled league-wide, for replacement level.
const FLEX_SHARE = {
  FLEX: { RB: 0.45, WR: 0.45, TE: 0.1 }, 'RB/WR': { RB: 0.5, WR: 0.5 },
  'WR/TE': { WR: 0.8, TE: 0.2 }, OP: { QB: 0.8, RB: 0.1, WR: 0.1 },
};
// Typical week-to-week spread (std dev / mean) when we lack enough games to measure it.
const DEFAULT_CV = { QB: 0.35, RB: 0.5, WR: 0.55, TE: 0.6, K: 0.4, DEF: 0.6 };
// How much a bench player at each position is worth vs. a starter.
const BENCH_MULT = { QB: 0.2, RB: 0.55, WR: 0.55, TE: 0.25, K: 0.02, DEF: 0.02 };
const OUT_STATUSES = ['Out', 'IR', 'PUP', 'Sus', 'Suspended', 'NA', 'DNR'];
const STORE_KEY = 'ffa-draft-v1';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => (n == null || !isFinite(n) ? '–' : Number(n).toFixed(d));

const app = {
  cfg: null, S: null, L: null, M: null,
  draft: { slot: 1, teams: 9, picks: [] },
  ui: { pos: 'ALL', q: '', sort: 'score', wpos: 'ALL', wsort: 'ros', opp: null },
};

/* ---------------- data loading ---------------- */

async function loadJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function sleeperPoints(resp, keepZeroIfPlayed) {
  const out = {};
  const items = Array.isArray(resp)
    ? resp.map((r) => [r.player_id, r.stats || {}])
    : Object.entries(resp || {});
  for (const [pid, s] of items) {
    if (!pid || !s || s.pts_ppr == null) continue;
    const v = Number(s.pts_ppr);
    if (v !== 0 || (keepZeroIfPlayed && (s.gp || 0) > 0)) out[pid] = Math.round(v * 100) / 100;
  }
  return out;
}

// Browser fallback that mirrors scripts/fetch_data.py (minus ESPN, which blocks browsers).
async function loadSleeperLive(season) {
  const LAST = 17;
  const state = await loadJSON('https://api.sleeper.app/v1/state/nfl');
  season = season || Number(state.season);
  let week = Number(state.week) || 1;
  if (state.season_type === 'pre') week = 1;
  else if (state.season_type === 'post' || state.season_type === 'off') week = LAST + 1;
  const statWeeks = [], projWeeks = [];
  for (let w = 1; w <= Math.min(week, LAST); w++) statWeeks.push(w);
  for (let w = Math.max(week, 1); w <= LAST; w++) projWeeks.push(w);
  const [raw, statsArr, projArr, sched, trending] = await Promise.all([
    loadJSON('https://api.sleeper.app/v1/players/nfl'),
    Promise.all(statWeeks.map((w) => loadJSON(`https://api.sleeper.app/v1/stats/nfl/regular/${season}/${w}`).catch(() => ({})))),
    Promise.all(projWeeks.map((w) => loadJSON(`https://api.sleeper.app/v1/projections/nfl/regular/${season}/${w}`).catch(() => ({})))),
    loadJSON(`https://api.sleeper.com/schedule/nfl/regular/${season}`).catch(() => []),
    loadJSON('https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=48&limit=40').catch(() => []),
  ]);
  const stats = {}, proj = {}, schedule = {};
  statWeeks.forEach((w, i) => { stats[w] = sleeperPoints(statsArr[i], true); });
  projWeeks.forEach((w, i) => { proj[w] = sleeperPoints(projArr[i], false); });
  for (const g of sched || []) {
    if (!g.home || !g.away) continue;
    (schedule[g.week] ||= {})[g.home] = g.away;
    schedule[g.week][g.away] = g.home;
  }
  const seen = new Set();
  [...Object.values(stats), ...Object.values(proj)].forEach((t) => Object.keys(t).forEach((k) => seen.add(k)));
  const players = {};
  for (const [pid, p] of Object.entries(raw)) {
    if (!POSITIONS.includes(p.position) || (!seen.has(pid) && !p.team)) continue;
    const n = p.position === 'DEF' ? `${p.last_name || pid} D/ST` : (p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim());
    players[pid] = { n, p: p.position, t: p.team, i: p.injury_status, r: p.search_rank, e: p.espn_id, a: p.age };
  }
  return {
    updated: Math.floor(Date.now() / 1000), season, week, lastWeek: LAST, live: true,
    players, stats, proj, schedule, trending: (trending || []).map((t) => t.player_id),
  };
}

/* ---------------- model ---------------- */

function rosterSlots() {
  return (app.L && Object.keys(app.L.rosterSlots || {}).length) ? app.L.rosterSlots : app.cfg.roster;
}

function buildModel() {
  const S = app.S, L = app.L;
  const week = S.week, last = S.lastWeek || 17;
  const sched = S.schedule || {};
  const haveSched = Object.keys(sched).length > 0;
  const espnRanks = (L && L.espnRanks) || {};
  const trending = new Set(S.trending || []);

  // Points allowed by each defense to each position over completed weeks ("defense vs position").
  const allowed = {}, oppGames = {};
  for (let w = 1; w < week; w++) {
    const st = S.stats[w] || {}, sw = sched[w] || {};
    for (const [pid, pts] of Object.entries(st)) {
      const p = S.players[pid];
      if (!p || !p.t || !sw[p.t] || p.p === 'DEF') continue;
      const opp = sw[p.t];
      ((allowed[opp] ||= {})[p.p] ||= 0);
      allowed[opp][p.p] += pts;
      (oppGames[opp] ||= new Set()).add(w);
    }
  }
  const dvp = {}, posAvg = {};
  for (const pos of POSITIONS) {
    const vals = [];
    for (const team of Object.keys(allowed)) {
      const g = oppGames[team].size;
      if (!g) continue;
      const v = (allowed[team][pos] || 0) / g;
      (dvp[team] ||= {})[pos] = v;
      vals.push(v);
    }
    posAvg[pos] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  const players = {};
  for (const [pid, p] of Object.entries(S.players)) {
    const weekly = [];
    for (let w = 1; w < week; w++) {
      const v = (S.stats[w] || {})[pid];
      if (v != null) weekly.push(v);
    }
    const gp = weekly.length;
    const ppg = gp ? weekly.reduce((a, b) => a + b, 0) / gp : null;
    let sdHist = null;
    if (gp >= 3) sdHist = Math.sqrt(weekly.reduce((a, v) => a + (v - ppg) ** 2, 0) / (gp - 1));

    let ros = 0, remaining = 0;
    for (let w = Math.max(week, 1); w <= last; w++) {
      ros += (S.proj[w] || {})[pid] || 0;
      if (!haveSched || !sched[w] || (p.t && sched[w][p.t])) remaining++;
    }
    if (ros === 0 && ppg) ros = ppg * remaining * 0.85; // no projections: lean on pace, discounted

    const next = (S.proj[week] || {})[pid] || 0;
    let byeWeek = null;
    if (haveSched && p.t) {
      for (let w = 1; w <= 18; w++) if (sched[w] && !sched[w][p.t]) { byeWeek = w; break; }
    }
    const onBye = haveSched && sched[week] ? !sched[week][p.t] : false;
    const opp = sched[week] && p.t ? sched[week][p.t] : null;
    let matchup = null;
    if (opp && dvp[opp] && posAvg[p.p] && week > 2) {
      const ratio = dvp[opp][p.p] / posAvg[p.p];
      matchup = { opp, ratio, label: ratio >= 1.12 ? 'Easy' : ratio <= 0.88 ? 'Tough' : 'Avg' };
    } else if (opp) {
      matchup = { opp, ratio: 1, label: '' };
    }
    const out = OUT_STATUSES.includes(p.i);
    const cvSd = DEFAULT_CV[p.p] * Math.max(next, ppg || 0);
    const sd = sdHist != null ? 0.5 * sdHist + 0.5 * cvSd : cvSd;

    players[pid] = {
      id: pid, name: p.n, pos: p.p, team: p.t || 'FA', inj: p.i, out,
      rank: espnRanks[pid] || null, srank: p.r || null,
      gp, ppg, ros, next, sd, byeWeek, onBye, matchup, trending: trending.has(pid),
    };
  }

  // Replacement level: the Nth best rest-of-season scorer at each position,
  // where N = how many of that position start across the league.
  const slots = rosterSlots();
  const teams = app.draft.teams;
  const starters = Object.fromEntries(POSITIONS.map((p) => [p, 0]));
  for (const [slot, n] of Object.entries(slots)) {
    if (slot === 'BE' || slot === 'IR') continue;
    if (FLEX_SHARE[slot]) for (const [pos, share] of Object.entries(FLEX_SHARE[slot])) starters[pos] += n * teams * share;
    else for (const pos of SLOT_ELIG[slot] || []) starters[pos] += n * teams;
  }
  const repl = {};
  for (const pos of POSITIONS) {
    const sorted = Object.values(players).filter((p) => p.pos === pos).map((p) => p.ros).sort((a, b) => b - a);
    const idx = Math.min(Math.max(Math.round(starters[pos]), 0), sorted.length - 1);
    repl[pos] = sorted.length ? sorted[idx] : 0;
  }
  for (const p of Object.values(players)) p.vorp = p.ros - repl[p.pos];

  // Consensus order (what the rest of the family is likely to pick next): ESPN rank, then Sleeper's.
  const consensus = Object.values(players)
    .filter((p) => p.ros > 1 || (p.srank && p.srank < 400))
    .sort((a, b) => (a.rank || 1e4 + (a.srank || 1e5)) - (b.rank || 1e4 + (b.srank || 1e5)) || b.ros - a.ros);
  consensus.forEach((p, i) => { p.cons = i + 1; });

  return { players, repl, consensus, week, dvpReady: week > 2 };
}

/* ---------------- lineup assignment ---------------- */

// Greedy fill: single-position slots first, then flex-type slots. Returns {filled:[{slot, p}], bench:[p]}.
function assignLineup(list, slots, scoreFn) {
  const pool = [...list].sort((a, b) => scoreFn(b) - scoreFn(a));
  const used = new Set();
  const filled = [];
  const order = Object.keys(slots).filter((s) => s !== 'BE' && s !== 'IR')
    .sort((a, b) => SLOT_ORDER.indexOf(a) - SLOT_ORDER.indexOf(b));
  for (const slot of order) {
    for (let i = 0; i < slots[slot]; i++) {
      const pick = pool.find((p) => !used.has(p.id) && (SLOT_ELIG[slot] || []).includes(p.pos));
      if (pick) used.add(pick.id);
      filled.push({ slot, p: pick || null });
    }
  }
  return { filled, bench: pool.filter((p) => !used.has(p.id)) };
}

/* ---------------- draft ---------------- */

function totalRounds() {
  return Object.entries(rosterSlots()).filter(([s]) => s !== 'IR').reduce((a, [, n]) => a + n, 0);
}
// Team slot (1-based) that owns overall pick number `pick` (1-based) in a snake draft.
function slotForPick(pick, teams) {
  const round = Math.ceil(pick / teams), i = (pick - 1) % teams;
  return round % 2 === 1 ? i + 1 : teams - i;
}
function myPickNumbers() {
  const { teams, slot } = app.draft, out = [];
  for (let p = 1; p <= teams * totalRounds(); p++) if (slotForPick(p, teams) === slot) out.push(p);
  return out;
}

function draftContext() {
  const { picks, teams } = app.draft;
  const current = picks.length + 1;
  const mine = myPickNumbers();
  const future = mine.filter((p) => p >= current);
  const nextMine = future[0] ?? null;
  const afterThat = future[1] ?? null;
  const taken = new Set(picks.map((p) => p.pid));
  const myPlayers = picks.filter((p) => p.mine).map((p) => app.M.players[p.pid]).filter(Boolean);
  return {
    current, round: Math.ceil(current / teams), inRound: ((current - 1) % teams) + 1,
    onClock: nextMine === current, nextMine, afterThat,
    picksUntilMine: nextMine ? nextMine - current : null,
    myPicksLeft: future.length, taken, myPlayers,
    done: current > teams * totalRounds(),
  };
}

function recommend(ctx) {
  const M = app.M, slots = rosterSlots();
  const { filled } = assignLineup(ctx.myPlayers, slots, (p) => p.vorp);
  const openSlots = filled.filter((f) => !f.p).map((f) => f.slot);
  const openCount = openSlots.length;
  const openKD = openSlots.filter((s) => s === 'K' || s === 'DST').length;
  const avail = M.consensus.filter((p) => !ctx.taken.has(p.id));

  // Players the others will probably take before my next turn / the turn after.
  const beforeMine = ctx.onClock ? 0 : (ctx.picksUntilMine ?? 0);
  const horizon = ctx.nextMine && ctx.afterThat ? beforeMine + (ctx.afterThat - ctx.nextMine - 1) : beforeMine;
  const likelyGoneBeforeMine = new Set(avail.slice(0, beforeMine).map((p) => p.id));
  const goneByHorizon = new Set(avail.slice(0, horizon).map((p) => p.id));
  const bestLater = {};
  for (const pos of POSITIONS) {
    const later = avail.filter((p) => p.pos === pos && !goneByHorizon.has(p.id)).sort((a, b) => b.vorp - a.vorp)[0];
    bestLater[pos] = later ? later.vorp : 0;
  }

  const scored = avail.map((p) => {
    const reasons = [], flags = [];
    let mult;
    const direct = openSlots.some((s) => (SLOT_ELIG[s] || []).length === 1 && SLOT_ELIG[s].includes(p.pos));
    const flex = openSlots.some((s) => (SLOT_ELIG[s] || []).length > 1 && SLOT_ELIG[s].includes(p.pos));
    if (direct) { mult = 1; reasons.push(`fills your ${p.pos === 'DEF' ? 'D/ST' : p.pos} starter spot`); }
    else if (flex) { mult = 0.9; reasons.push('fills your FLEX'); }
    else { mult = BENCH_MULT[p.pos]; reasons.push(p.pos === 'K' || p.pos === 'DEF' ? `you already have a ${p.pos === 'DEF' ? 'D/ST' : 'K'}` : 'bench depth'); }

    if ((p.pos === 'K' || p.pos === 'DEF') && (direct)) {
      if (ctx.myPicksLeft > openKD + 1) { mult *= 0.1; reasons.push('wait: take K/D/ST in your last rounds'); }
      else { mult *= 1.5; reasons.push('time to grab one'); }
    }
    if (ctx.myPicksLeft && ctx.myPicksLeft <= openCount) {
      if (direct || flex) mult *= 2; else mult *= 0.05;
      if (direct || flex) reasons.push('you must fill starters now');
    }
    if (p.out) { mult *= 0.4; flags.push(['bad', p.inj]); }
    else if (p.inj) { mult *= 0.9; flags.push(['warn', p.inj]); }

    const drop = Math.max(0, p.vorp - bestLater[p.pos]);
    const base = Math.max(p.vorp + 0.5 * drop, 0);
    const score = mult * base + 0.001 * p.ros * mult;
    if (p.vorp > 0) reasons.unshift(`+${fmt(p.vorp, 0)} pts over a replacement ${p.pos}`);
    if (drop > 15 && mult >= 0.5) reasons.push(`next-best ${p.pos} by your next turn is ~${fmt(drop, 0)} pts worse`);
    if (likelyGoneBeforeMine.has(p.id)) flags.push(['warn', 'may be gone']);
    if (p.trending) flags.push(['good', 'trending']);
    return { p, score, reasons, flags };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ---------------- rendering helpers ---------------- */

function posTag(pos) { return `<span class="pos ${pos}">${pos === 'DEF' ? 'D/ST' : pos}</span>`; }
function badges(flags) { return flags.map(([k, t]) => `<span class="badge ${k}">${esc(t)}</span>`).join(''); }
function matchupBadge(m) {
  if (!m) return '';
  const k = m.label === 'Easy' ? 'good' : m.label === 'Tough' ? 'bad' : '';
  return `<span class="badge ${k}">vs ${esc(m.opp)}${m.label ? ' · ' + m.label : ''}</span>`;
}
function playerMeta(p, extra = '') {
  return `<span>${esc(p.team)}${p.byeWeek ? ` · bye ${p.byeWeek}` : ''}</span>
    <span>ROS <b>${fmt(p.ros, 0)}</b></span>
    <span>PPG <b>${fmt(p.ppg)}</b>${p.gp ? ` (${p.gp}g)` : ''}</span>
    <span>This wk <b>${fmt(p.next)}</b></span>${extra}`;
}

/* ---------------- draft tab ---------------- */

function renderDraft() {
  const M = app.M, ctx = draftContext();
  const { teams } = app.draft;

  const clock = $('#clock');
  clock.classList.toggle('mine', ctx.onClock);
  if (ctx.done) {
    clock.innerHTML = `<div class="big">Draft complete 🎉</div><div class="muted">Head to <b>This week</b> for lineup advice.</div>`;
  } else {
    const who = ctx.onClock ? 'You are on the clock' : `Team in slot ${slotForPick(ctx.current, teams)} is picking`;
    clock.innerHTML = `
      <div><div class="muted small">Pick ${ctx.current} · Round ${ctx.round}.${String(ctx.inRound).padStart(2, '0')}</div>
      <div class="big">${who}</div></div>
      <div class="muted">${ctx.onClock ? '' : ctx.nextMine ? `Your pick is in <b>${ctx.picksUntilMine}</b> (pick ${ctx.nextMine})` : ''}</div>`;
  }

  const recs = recommend(ctx);
  $('#rec-note').textContent = ctx.onClock
    ? 'Ranked for this pick.'
    : `Ranked for your next pick. Players tagged "may be gone" will probably be taken before then.`;
  $('#recs').innerHTML = recs.slice(0, 5).map(({ p, reasons, flags }) => `
    <li class="prow">
      <div class="name">${posTag(p.pos)} ${esc(p.name)} ${badges(flags)}</div>
      <div class="acts"><button class="btn sm" data-mine="${p.id}">Mine</button><button class="btn sm ghost" data-take="${p.id}">Taken</button></div>
      <div class="meta">${playerMeta(p, p.rank ? `<span>ESPN #${p.rank}</span>` : '')}</div>
      <div class="why">${esc(reasons.join(' · '))}</div>
    </li>`).join('') || '<li class="muted">No players left.</li>';

  // My team
  const { filled, bench } = assignLineup(ctx.myPlayers, rosterSlots(), (p) => p.vorp);
  const benchSlots = rosterSlots().BE || 0;
  let html = '<div class="slots">';
  for (const f of filled) html += `<span class="slot">${f.slot === 'DST' ? 'D/ST' : f.slot}</span><span class="${f.p ? '' : 'empty'}">${f.p ? `${esc(f.p.name)} <span class="muted small">${esc(f.p.team)}</span>` : 'empty'}</span>`;
  for (let i = 0; i < Math.max(benchSlots, bench.length); i++) {
    const b = bench[i];
    html += `<span class="slot">BE</span><span class="${b ? '' : 'empty'}">${b ? `${posTag(b.pos)} ${esc(b.name)}` : 'empty'}</span>`;
  }
  $('#myteam').innerHTML = html + '</div>';

  // Board
  const scoreById = Object.fromEntries(recs.map((r) => [r.p.id, r]));
  let rows = recs.map((r) => r.p);
  if (app.ui.sort === 'consensus') rows = M.consensus.filter((p) => !ctx.taken.has(p.id));
  if (app.ui.sort === 'ros') rows = [...rows].sort((a, b) => b.ros - a.ros);
  if (app.ui.pos !== 'ALL') rows = rows.filter((p) => p.pos === app.ui.pos);
  const q = app.ui.q.trim().toLowerCase();
  if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q);
  $('#board').innerHTML = rows.slice(0, 80).map((p) => {
    const r = scoreById[p.id];
    return `<div class="prow">
      <div class="name">${posTag(p.pos)} ${esc(p.name)} ${r ? badges(r.flags) : ''}</div>
      <div class="acts"><button class="btn sm" data-mine="${p.id}">Mine</button><button class="btn sm ghost" data-take="${p.id}">Taken</button></div>
      <div class="meta">${playerMeta(p, `${p.rank ? `<span>ESPN #${p.rank}</span>` : ''}<span>Score <b>${fmt(r ? r.score : 0, 0)}</b></span>`)}</div>
    </div>`;
  }).join('') || '<p class="muted">No matching players.</p>';

  // Pick log
  $('#picklog').innerHTML = app.draft.picks.map((pk, i) => {
    const p = M.players[pk.pid];
    return `<li>${pk.mine ? '<b>You</b>' : `Slot ${slotForPick(i + 1, teams)}`}: ${p ? `${esc(p.name)} (${p.pos === 'DEF' ? 'D/ST' : p.pos})` : esc(pk.pid)}</li>`;
  }).join('');
}

function recordPick(pid, mine) {
  if (app.draft.picks.some((p) => p.pid === pid)) return;
  app.draft.picks.push({ pid, mine });
  saveDraft();
  renderAll();
}

/* ---------------- weekly tab ---------------- */

function normCdf(z) {
  // Abramowitz-Stegun approximation of the standard normal CDF.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
function weekProj(p) { return (p.out || p.onBye) ? 0 : p.next; }

function myRosterAndSource() {
  const L = app.L, M = app.M;
  if (L && L.teams) {
    const me = L.teams.find((t) => t.id === app.cfg.teamId);
    if (me && me.roster.length) {
      return { team: me, players: me.roster.map((r) => M.players[r.sid]).filter(Boolean), espnSlots: Object.fromEntries(me.roster.map((r) => [r.sid, r.slot])), source: 'espn' };
    }
  }
  const players = app.draft.picks.filter((p) => p.mine).map((p) => M.players[p.pid]).filter(Boolean);
  return { team: null, players, espnSlots: null, source: 'draft' };
}

function teamProjection(list, scoreFn) {
  const { filled, bench } = assignLineup(list, rosterSlots(), scoreFn);
  const mean = filled.reduce((a, f) => a + (f.p ? weekProj(f.p) : 0), 0);
  const variance = filled.reduce((a, f) => a + (f.p && weekProj(f.p) ? f.p.sd ** 2 : 0), 0);
  return { filled, bench, mean, sd: Math.sqrt(variance) };
}

function lineupRow(slot, p, espnSlot) {
  if (!p) return `<div class="prow"><div class="name"><span class="slot">${slot}</span> <span class="muted">empty</span></div></div>`;
  const flags = [];
  if (p.onBye) flags.push(['bad', 'BYE']);
  if (p.inj) flags.push([p.out ? 'bad' : 'warn', p.inj]);
  const proj = weekProj(p);
  return `<div class="prow">
    <div class="name"><span class="slot">${slot === 'DST' ? 'D/ST' : slot}</span> ${posTag(p.pos)} ${esc(p.name)} ${badges(flags)}</div>
    <div class="acts"><b>${fmt(proj)}</b></div>
    <div class="meta"><span>${esc(p.team)}</span>${matchupBadge(p.matchup)}
      <span>floor/ceiling <b>${fmt(Math.max(0, proj - p.sd), 0)}–${fmt(proj ? proj + p.sd : 0, 0)}</b></span>
      <span>PPG <b>${fmt(p.ppg)}</b></span>${espnSlot ? `<span>ESPN: ${esc(espnSlot)}</span>` : ''}</div>
  </div>`;
}

function renderWeek() {
  const M = app.M, L = app.L;
  const mine = myRosterAndSource();
  if (!mine.players.length) {
    $('#matchup').innerHTML = `<h2>No roster yet</h2><p class="muted">After the draft this fills in from your ESPN team (once the ESPN cookies are set up, see <b>Setup</b>) or from the players you marked <b>Mine</b> in the draft.</p>`;
    ['#lineup', '#bench', '#opplineup', '#changes', '#lineup-note'].forEach((s) => { $(s).innerHTML = ''; });
    return;
  }

  // Find this week's opponent from ESPN's schedule; allow override.
  let oppTeam = null;
  if (L && L.teams && mine.team) {
    const sel = app.ui.opp;
    if (sel != null) oppTeam = L.teams.find((t) => t.id === sel);
    if (!oppTeam) {
      const m = (L.schedule || []).find((g) => g.period === L.currentPeriod && (g.home === mine.team.id || g.away === mine.team.id));
      const oid = m ? (m.home === mine.team.id ? m.away : m.home) : null;
      oppTeam = L.teams.find((t) => t.id === oid) || null;
    }
  }
  const oppPlayers = oppTeam ? oppTeam.roster.map((r) => M.players[r.sid]).filter(Boolean) : [];

  const baseMine = teamProjection(mine.players, weekProj);
  const opp = oppPlayers.length ? teamProjection(oppPlayers, weekProj) : null;
  let winP = null, tilt = 0, note;
  if (opp) {
    winP = normCdf((baseMine.mean - opp.mean) / Math.sqrt(baseMine.sd ** 2 + opp.sd ** 2 || 1));
    if (winP < 0.4) { tilt = 0.6; note = "You're the underdog, so this lineup leans toward high-ceiling players. You need a big week."; }
    else if (winP > 0.6) { tilt = -0.4; note = "You're the favorite, so this lineup leans toward steady players. Don't gamble a likely win."; }
    else note = "It's a toss-up, so this lineup goes straight by projection.";
  } else {
    note = 'Lineup is straight by projection. Set up the ESPN connection to see your opponent and win odds.';
  }
  const tilted = (p) => (weekProj(p) ? weekProj(p) + tilt * p.sd : -1);
  const rec = teamProjection(mine.players, tilted);

  const teamsOpts = L && L.teams ? L.teams.filter((t) => !mine.team || t.id !== mine.team.id)
    .map((t) => `<option value="${t.id}" ${oppTeam && t.id === oppTeam.id ? 'selected' : ''}>${esc(t.name)}${t.owner ? ` (${esc(t.owner)})` : ''}</option>`).join('') : '';
  $('#matchup').innerHTML = `
    <div class="row between wrap gap"><h2>Week ${M.week} matchup</h2>
      ${teamsOpts ? `<label>Opponent <select id="oppsel">${teamsOpts}</select></label>` : ''}</div>
    <div class="vs mt">
      <div><div class="muted small">${esc(mine.team ? mine.team.name : 'Your team')}</div><div class="score">${fmt(rec.mean)}</div></div>
      <div class="muted">vs</div>
      <div><div class="muted small">${esc(oppTeam ? oppTeam.name : 'Opponent')}</div><div class="score">${opp ? fmt(opp.mean) : '–'}</div></div>
    </div>
    ${winP != null ? `<div class="mt"><div class="row between small"><span>Win chance</span><b>${Math.round(winP * 100)}%</b></div>
      <div class="meter"><div style="width:${Math.round(winP * 100)}%"></div></div></div>` : ''}
    ${mine.source === 'draft' ? '<p class="muted small mt">Using your drafted players. Your ESPN roster isn\'t connected yet.</p>' : ''}`;
  const oppSel = $('#oppsel');
  if (oppSel) oppSel.onchange = (e) => { app.ui.opp = Number(e.target.value); renderWeek(); };

  $('#lineup-note').textContent = note;
  $('#lineup').innerHTML = rec.filled.map((f) => lineupRow(f.slot, f.p, mine.espnSlots && f.p ? mine.espnSlots[f.p.id] : null)).join('');
  $('#bench').innerHTML = rec.bench.map((p) => lineupRow('BE', p, mine.espnSlots ? mine.espnSlots[p.id] : null)).join('') || '<p class="muted">Empty.</p>';
  $('#opplineup').innerHTML = opp ? opp.filled.map((f) => lineupRow(f.slot, f.p)).join('') : '<p class="muted">No opponent data.</p>';

  // Empty starting slots are free points lost: call them out first.
  const empties = rec.filled.filter((f) => !f.p).map((f) => (f.slot === 'DST' ? 'D/ST' : f.slot));
  const emptyNote = empties.length
    ? `<div class="change" style="background:var(--bad-soft)"><b>Nobody to start at ${esc(empties.join(', '))}.</b> Pick someone up on the Waivers tab.</div>`
    : '';

  // Differences vs. what's currently set in ESPN.
  if (mine.espnSlots) {
    const recStarters = new Set(rec.filled.filter((f) => f.p).map((f) => f.p.id));
    const benched = mine.players.filter((p) => !['BE', 'IR'].includes(mine.espnSlots[p.id]) && !recStarters.has(p.id));
    const promote = mine.players.filter((p) => ['BE', 'IR'].includes(mine.espnSlots[p.id]) && recStarters.has(p.id));
    $('#changes').innerHTML = emptyNote + (promote.length || benched.length
      ? `<div class="change"><b>Change in ESPN:</b> start ${promote.map((p) => `<b>${esc(p.name)}</b> (${fmt(weekProj(p))})`).join(', ') || '–'}; bench ${benched.map((p) => `${esc(p.name)} (${fmt(weekProj(p))})`).join(', ') || '–'}.</div>`
      : '<div class="change" style="background:var(--accent-soft)">Your ESPN lineup already matches the recommendation. ✅</div>');
  } else $('#changes').innerHTML = emptyNote;
}

/* ---------------- waivers tab ---------------- */

function renderWaivers() {
  const M = app.M, L = app.L;
  let rostered = new Set(), source;
  if (L && L.teams && L.teams.some((t) => t.roster.length)) {
    L.teams.forEach((t) => t.roster.forEach((r) => r.sid && rostered.add(r.sid)));
    source = 'Excludes everyone rostered in your ESPN league.';
  } else {
    rostered = new Set(app.draft.picks.map((p) => p.pid));
    source = 'Excludes players marked in the draft. Connect ESPN for live rosters.';
  }
  const mine = myRosterAndSource();
  const worstStarter = {}, worstRos = {};
  const { filled, bench } = assignLineup(mine.players, rosterSlots(), weekProj);
  const emptyPos = new Set(filled.filter((f) => !f.p).flatMap((f) => SLOT_ELIG[f.slot] || []));
  for (const pos of POSITIONS) {
    const st = filled.filter((f) => f.p && f.p.pos === pos).map((f) => f.p);
    worstStarter[pos] = st.length ? st.reduce((a, b) => (weekProj(a) < weekProj(b) ? a : b)) : null;
    const all = [...st, ...bench.filter((p) => p.pos === pos)];
    worstRos[pos] = all.length ? all.reduce((a, b) => (a.ros < b.ros ? a : b)) : null;
  }

  let rows = M.consensus.filter((p) => !rostered.has(p.id) && (p.ros > 0 || p.next > 0));
  if (app.ui.wpos !== 'ALL') rows = rows.filter((p) => p.pos === app.ui.wpos);
  rows.sort(app.ui.wsort === 'next' ? (a, b) => weekProj(b) - weekProj(a) : (a, b) => b.vorp - a.vorp);
  $('#waiver-note').textContent = source;
  $('#waivers').innerHTML = rows.slice(0, 50).map((p) => {
    const flags = [];
    if (p.trending) flags.push(['good', 'trending']);
    if (p.inj) flags.push([p.out ? 'bad' : 'warn', p.inj]);
    const ws = worstStarter[p.pos], wr = worstRos[p.pos];
    let why = '';
    if (mine.players.length && emptyPos.has(p.pos)) why = `You have no one to start at ${p.pos === 'DEF' ? 'D/ST' : p.pos}. Grab one.`;
    else if (ws && weekProj(p) > weekProj(ws) + 1) why = `Better this week than your starter ${esc(ws.name)} (${fmt(weekProj(ws))}).`;
    else if (wr && p.ros > wr.ros + 5) why = `Better rest of season than ${esc(wr.name)} (${fmt(wr.ros, 0)}).`;
    return `<div class="prow">
      <div class="name">${posTag(p.pos)} ${esc(p.name)} ${badges(flags)}</div>
      <div class="acts">${matchupBadge(p.matchup)}</div>
      <div class="meta">${playerMeta(p)}</div>
      ${why ? `<div class="why">${why}</div>` : ''}
    </div>`;
  }).join('') || '<p class="muted">Nothing here.</p>';
}

/* ---------------- setup / status ---------------- */

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
function renderStatus() {
  const S = app.S, L = app.L;
  const parts = [`${S.season} week ${S.week}`, `stats ${S.live ? 'loaded live from Sleeper' : 'updated ' + ago(S.updated)}`];
  parts.push(L ? `ESPN league updated ${ago(L.updated)}` : 'ESPN league not connected');
  const el = $('#status');
  el.textContent = parts.join(' · ');
  el.classList.toggle('warn', !L);
  $('#datastatus').innerHTML = `
    <p>Sleeper data: ${S.live ? 'live from your browser (the <code>data/sleeper.json</code> file isn\'t there yet)' : `from <code>data/sleeper.json</code>, updated ${ago(S.updated)}`}.
      ${Object.keys(S.players).length} players.</p>
    <p>ESPN league: ${L ? `connected, updated ${ago(L.updated)}. ${L.teams.length} teams. ${Object.keys(L.espnRanks || {}).length} ESPN draft ranks.` : 'not connected. See README for the two cookie secrets.'}</p>
    <p>Roster slots: ${Object.entries(rosterSlots()).map(([k, v]) => `${k}×${v}`).join(', ')}</p>`;
}

/* ---------------- state + wiring ---------------- */

function saveDraft() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(app.draft)); } catch (e) { /* storage blocked: draft lives for this tab only */ }
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d && Array.isArray(d.picks)) Object.assign(app.draft, d);
  } catch (e) { /* ignore */ }
}

function renderAll() {
  app.M = buildModel();
  renderStatus();
  renderDraft();
  renderWeek();
  renderWaivers();
}

function wire() {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
      try { localStorage.setItem('ffa-tab', b.dataset.tab); } catch (e) { /* ignore */ }
    };
  });
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mine],[data-take]');
    if (!t) return;
    recordPick(t.dataset.mine || t.dataset.take, !!t.dataset.mine);
  });

  const chips = (el, key) => {
    el.innerHTML = ['ALL', ...POSITIONS].map((p) => `<button class="chip" data-p="${p}" aria-pressed="${app.ui[key] === p}">${p === 'DEF' ? 'D/ST' : p === 'ALL' ? 'All' : p}</button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      app.ui[key] = b.dataset.p;
      el.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
      key === 'pos' ? renderDraft() : renderWaivers();
    };
  };
  chips($('#poschips'), 'pos');
  chips($('#wchips'), 'wpos');

  $('#search').oninput = (e) => { app.ui.q = e.target.value; renderDraft(); };
  $('#sort').onchange = (e) => { app.ui.sort = e.target.value; renderDraft(); };
  $('#wsort').onchange = (e) => { app.ui.wsort = e.target.value; renderWaivers(); };

  const slotSel = $('#myslot');
  const fillSlots = () => {
    slotSel.innerHTML = Array.from({ length: app.draft.teams }, (_, i) => `<option value="${i + 1}" ${app.draft.slot === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');
  };
  fillSlots();
  slotSel.onchange = (e) => { app.draft.slot = Number(e.target.value); saveDraft(); renderAll(); };
  $('#teams').value = app.draft.teams;
  $('#teams').onchange = (e) => {
    app.draft.teams = Math.max(4, Math.min(16, Number(e.target.value) || 9));
    app.draft.slot = Math.min(app.draft.slot, app.draft.teams);
    fillSlots(); saveDraft(); renderAll();
  };

  $('#undo').onclick = () => { app.draft.picks.pop(); saveDraft(); renderAll(); };
  $('#reset').onclick = () => {
    if (!confirm('Clear every pick? This cannot be undone (unless you saved a backup).')) return;
    app.draft.picks = []; saveDraft(); renderAll();
  };
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(app.draft, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `draft-backup-${Date.now()}.json` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('#import').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.picks)) throw new Error('not a draft backup');
      Object.assign(app.draft, d); saveDraft(); fillSlots(); $('#teams').value = app.draft.teams; renderAll();
    } catch (err) { alert(`Couldn't load that file: ${err.message}`); }
  };

  try {
    const tab = localStorage.getItem('ffa-tab');
    const b = tab && document.querySelector(`.tabs button[data-tab="${tab}"]`);
    if (b) b.click();
  } catch (e) { /* ignore */ }
}

async function main() {
  try {
    app.cfg = await loadJSON('config.json');
  } catch (e) {
    app.cfg = { leagueId: 884658106, teamId: 9, season: 2026, teams: 9, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1, BE: 7 } };
  }
  app.draft.teams = app.cfg.teams || 9;
  loadDraft();
  try {
    app.S = await loadJSON('data/sleeper.json');
  } catch (e) {
    $('#status').textContent = 'No saved data yet. Loading live from Sleeper (takes ~10s)…';
    try { app.S = await loadSleeperLive(app.cfg.season); } catch (err) {
      $('#status').textContent = `Couldn't load player data: ${err.message}. Check your connection and reload.`;
      $('#status').classList.add('warn');
      return;
    }
  }
  try { app.L = await loadJSON('data/league.json'); } catch (e) { app.L = null; }
  wire();
  renderAll();
}

main();
