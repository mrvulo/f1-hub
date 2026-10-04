'use strict';
// F1 Hub – komplett clientseitig, nutzt nur freie APIs (Jolpica-F1 + OpenF1).

const API = 'https://api.jolpi.ca/ergast/f1';
const OF1 = 'https://api.openf1.org/v1';
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const NOW_YEAR = new Date().getFullYear();

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- Cache
const Cache = {
  get(k) {
    try {
      const v = JSON.parse(localStorage.getItem('f1c:' + k));
      if (v && Date.now() < v.e) return v.d;
    } catch {}
    return null;
  },
  set(k, d, ttl) {
    const s = JSON.stringify({ e: Date.now() + ttl, d });
    try { localStorage.setItem('f1c:' + k, s); }
    catch { this.clear(() => true); try { localStorage.setItem('f1c:' + k, s); } catch {} }
  },
  clear(pred) {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith('f1c:') && pred(k.slice(4))) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    } catch {}
  },
};

// Serielle Warteschlange mit Mindestabstand, damit die Rate-Limits der freien APIs halten
function makeQueue(gapMs) {
  let chain = Promise.resolve();
  return fn => {
    const p = chain.then(fn);
    chain = p.catch(() => {}).then(() => sleep(gapMs));
    return p;
  };
}
const ergQ = makeQueue(320);
const of1Q = makeQueue(400);
const inflight = new Map();

async function getJSON(url, ttl, queue) {
  const cached = Cache.get(url);
  if (cached) return cached;
  if (inflight.has(url)) return inflight.get(url);
  const p = queue(async () => {
    for (let attempt = 0; ; attempt++) {
      let r;
      // Drosselungsantworten kommen teils ohne CORS-Header und erscheinen dann als Netzwerkfehler
      try { r = await fetch(url); }
      catch (err) { if (attempt < 2 && !url.startsWith(OF1)) { await sleep(2000 * (attempt + 1)); continue; } throw err; }
      if (r.status === 429 && attempt < 4) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) {
        const err = new Error('HTTP ' + r.status);
        err.status = r.status;
        try { err.detail = (await r.json()).detail; } catch {}
        throw err;
      }
      const d = await r.json();
      Cache.set(url, d, ttl);
      return d;
    }
  }).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

const ttlFor = season => (+season < NOW_YEAR ? 30 * DAY : 10 * MIN);

async function erg(path, ttl = ttlFor(state.season)) {
  return (await getJSON(API + path, ttl, ergQ)).MRData;
}

// Blättert durch alle Seiten (Jolpica liefert max. 100 Zeilen pro Anfrage) und führt Rennen zusammen
async function ergRaces(path, ttl = ttlFor(state.season)) {
  const sep = path.includes('?') ? '&' : '?';
  const pages = [];
  let offset = 0, total = 1;
  while (offset < total) {
    const md = await erg(`${path}${sep}limit=100&offset=${offset}`, ttl);
    total = +md.total;
    pages.push(md.RaceTable.Races);
    offset += 100;
  }
  const map = new Map();
  for (const races of pages) for (const r of races) {
    const ex = map.get(r.round);
    if (!ex) { map.set(r.round, structuredClone(r)); continue; }
    for (const key of ['Results', 'SprintResults', 'QualifyingResults', 'PitStops']) {
      if (r[key]) ex[key] = (ex[key] || []).concat(r[key]);
    }
    if (r.Laps) {
      ex.Laps = ex.Laps || [];
      for (const l of r.Laps) {
        const el = ex.Laps.find(x => x.number === l.number);
        if (el) el.Timings = el.Timings.concat(l.Timings); else ex.Laps.push(l);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.round - b.round);
}

// Während Live-Sessions antwortet OpenF1 mit 401 ohne CORS-Header – im Browser kommt das als Netzwerkfehler an
async function of1(path, ttl = 6 * HOUR) {
  try { return await getJSON(OF1 + path, ttl, of1Q); }
  catch (err) { if (err instanceof TypeError) err.status = 401; throw err; }
}

// ---------------------------------------------------------------- Stammdaten
const TEAM_COLORS = {
  // 2026er Farben aus dem offiziellen Live-Timing (DriverList.TeamColour)
  mercedes: '#00D7B6', ferrari: '#ED1131', red_bull: '#4781D7', mclaren: '#F47600',
  aston_martin: '#229971', alpine: '#00A1E8', williams: '#1868DB', rb: '#6C98FF',
  haas: '#9C9FA2', audi: '#F50537', cadillac: '#909090', sauber: '#52E252',
  alphatauri: '#5E8FAA', toro_rosso: '#469BFF', racing_point: '#F596C8', force_india: '#F596C8',
  renault: '#FFF500', lotus_f1: '#FFB800', alfa: '#B12039', manor: '#ED1C24', marussia: '#ED1C24',
  caterham: '#005030', virgin: '#C00000', hrt: '#B2945E', brawn: '#C6FF00', toyota: '#CC0000',
  bmw_sauber: '#6CD3FF', honda: '#FFFFFF', super_aguri: '#FF0000', spyker: '#FF6600',
  jordan: '#F9D71C', minardi: '#000000', jaguar: '#00573F', bar: '#BBBBBB', benetton: '#00A651',
  stewart: '#FFFFFF', tyrrell: '#0033A0', ligier: '#0055A5', arrows: '#FF8C00', prost: '#003399',
  lotus: '#FFB800', team_lotus: '#FFB800', brabham: '#00A0E0', march: '#FF0000',
};
function teamColor(id, fallbackName = '') {
  if (TEAM_COLORS[id]) return TEAM_COLORS[id];
  let h = 0;
  for (const c of id || fallbackName) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 55%)`;
}

const NAT = {
  British: 'gb', German: 'de', Dutch: 'nl', Spanish: 'es', Mexican: 'mx', Monegasque: 'mc',
  Australian: 'au', French: 'fr', Canadian: 'ca', Finnish: 'fi', Japanese: 'jp', Chinese: 'cn',
  Danish: 'dk', Thai: 'th', American: 'us', Italian: 'it', 'New Zealander': 'nz', Brazilian: 'br',
  Argentine: 'ar', Argentinian: 'ar', Swiss: 'ch', Austrian: 'at', Belgian: 'be', Swedish: 'se',
  Polish: 'pl', Russian: 'ru', Venezuelan: 've', Indian: 'in', Indonesian: 'id', Colombian: 'co',
  Hungarian: 'hu', Portuguese: 'pt', Irish: 'ie', 'South African': 'za', Czech: 'cz', Malaysian: 'my',
  Chilean: 'cl', Uruguayan: 'uy', Liechtensteiner: 'li', Rhodesian: 'zw', 'East German': 'de',
  'American-Italian': 'us', 'Argentine-Italian': 'ar', Estonian: 'ee', Korean: 'kr',
};
const COUNTRY = {
  UK: 'gb', 'United Kingdom': 'gb', Australia: 'au', Bahrain: 'bh', 'Saudi Arabia': 'sa', Japan: 'jp',
  China: 'cn', USA: 'us', 'United States': 'us', Italy: 'it', Monaco: 'mc', Spain: 'es', Canada: 'ca',
  Austria: 'at', Hungary: 'hu', Belgium: 'be', Netherlands: 'nl', Azerbaijan: 'az', Singapore: 'sg',
  Mexico: 'mx', Brazil: 'br', UAE: 'ae', 'United Arab Emirates': 'ae', Qatar: 'qa', France: 'fr',
  Germany: 'de', Portugal: 'pt', Russia: 'ru', Turkey: 'tr', Malaysia: 'my', Korea: 'kr',
  India: 'in', Argentina: 'ar', 'South Africa': 'za', Sweden: 'se', Switzerland: 'ch', Morocco: 'ma',
  Vietnam: 'vn', Thailand: 'th', Rwanda: 'rw',
};
function flag(code) {
  return code ? `<img class="flag" src="https://flagcdn.com/w40/${code}.png" alt="" loading="lazy">` : '';
}
const natFlag = n => flag(NAT[n]);
const countryFlag = c => flag(COUNTRY[c]);

const SESSION_NAMES = {
  FirstPractice: '1. Training', SecondPractice: '2. Training', ThirdPractice: '3. Training',
  SprintQualifying: 'Sprint-Qualifying', SprintShootout: 'Sprint-Shootout', Sprint: 'Sprint',
  Qualifying: 'Qualifying', Race: 'Rennen',
};
const SESSION_LEN = { Race: 2.5 * HOUR, Sprint: HOUR, Qualifying: HOUR + 15 * MIN, SprintQualifying: 45 * MIN, SprintShootout: 45 * MIN };

const fmtDT = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtD = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short' });
const fmtDY = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
const toDate = (d, t) => new Date(`${d}T${t || '12:00:00Z'}`);
const raceDate = r => toDate(r.date, r.time);
const age = dob => { const d = new Date(dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };
const driverName = d => `${esc(d.givenName)} <b>${esc(d.familyName)}</b>`;

function sessionsOf(race) {
  const list = [];
  for (const key of ['FirstPractice', 'SecondPractice', 'ThirdPractice', 'SprintQualifying', 'SprintShootout', 'Sprint', 'Qualifying']) {
    if (race[key]) list.push({ key, name: SESSION_NAMES[key], start: toDate(race[key].date, race[key].time) });
  }
  list.push({ key: 'Race', name: SESSION_NAMES.Race, start: raceDate(race) });
  list.sort((a, b) => a.start - b.start);
  for (const s of list) s.end = new Date(+s.start + (SESSION_LEN[s.key] || HOUR));
  return list;
}

// Porträts und Teamfarben von OpenF1 (dauerhaft lokal gemerkt, weil OpenF1 während Live-Sessions sperrt)
let of1People = {};
try { of1People = JSON.parse(localStorage.getItem('f1:people') || '{}'); } catch {}
function rememberPeople(list) {
  for (const d of list || []) {
    if (!d.name_acronym) continue;
    const prev = of1People[d.name_acronym] || {};
    of1People[d.name_acronym] = {
      headshot: d.headshot_url || prev.headshot || null,
      colour: d.team_colour ? '#' + d.team_colour : prev.colour || null,
    };
  }
  try { localStorage.setItem('f1:people', JSON.stringify(of1People)); } catch {}
}
async function loadPeople() {
  try { rememberPeople(await of1('/drivers?session_key=latest', DAY)); } catch {}
}
function avatar(driver, color) {
  const p = of1People[driver.code];
  const ini = (driver.code || driver.familyName.slice(0, 3)).toUpperCase();
  const img = p?.headshot && +state.season >= NOW_YEAR - 1
    ? `<img src="${esc(p.headshot)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="avatar" style="background:${color}">${img || ini}</div>`;
}

// ---------------------------------------------------------------- Zustand & Routing
const state = {
  season: localStorage.getItem('f1:season') || String(NOW_YEAR),
  route: 'overview',
  params: [],
  timers: [],
};

function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
function loading(text = 'Lade Daten …') { return `<div class="loading">${esc(text)}</div>`; }
function errorBox(err) {
  const live = err?.status === 401;
  const msg = live
    ? 'OpenF1 ist gerade nicht frei abrufbar. Meist läuft eine Session live, dann gibt es die Daten nur für zahlende Nutzer. Nach Session-Ende ist alles wieder kostenlos verfügbar.'
    : `Daten konnten nicht geladen werden (${esc(err?.message || err)}). Internetverbindung prüfen oder später erneut versuchen.`;
  return `<div class="${live ? 'note' : 'error'}">${msg}</div>`;
}

const views = {};
async function render() {
  const [route, ...params] = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
  state.route = views[route] ? route : 'overview';
  state.params = params;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.r === state.route));
  clearTimers();
  const view = $('#view');
  const token = Symbol();
  render.token = token;
  view.innerHTML = loading();
  try {
    const html = await views[state.route](...params);
    if (render.token !== token) return;
    view.innerHTML = html;
    views[state.route].after?.(view, ...params);
  } catch (err) {
    console.error(err);
    if (render.token === token) view.innerHTML = errorBox(err);
  }
}
const stale = token => render.token !== token;

// ---------------------------------------------------------------- Gemeinsame Datenabfragen
const schedule = season => erg(`/${season}.json?limit=100`).then(md => md.RaceTable.Races);
const driverStandings = season => erg(`/${season}/driverstandings.json?limit=100`)
  .then(md => md.StandingsTable.StandingsLists[0]?.DriverStandings || []);
const teamStandings = season => erg(`/${season}/constructorstandings.json?limit=100`)
  .then(md => md.StandingsTable.StandingsLists[0]?.ConstructorStandings || []);
const winners = season => erg(`/${season}/results/1.json?limit=100`).then(md => md.RaceTable.Races);

function nextRace(races) {
  const now = Date.now();
  return races.find(r => +raceDate(r) + SESSION_LEN.Race > now) || null;
}

// ---------------------------------------------------------------- Übersicht
views.overview = async () => {
  const s = state.season;
  const [races, ds, cs] = await Promise.all([schedule(s), driverStandings(s), teamStandings(s)]);
  const next = nextRace(races);
  let last = null;
  try { last = (await erg(`/${s}/last/results.json`)).RaceTable.Races[0]; } catch {}

  let hero;
  if (next) {
    const sess = sessionsOf(next);
    const loc = next.Circuit.Location;
    hero = `<section class="hero">
      <div>
        <div class="kicker">Runde ${next.round} von ${races.length} · ${+raceDate(next) <= Date.now() ? 'Läuft gerade' : 'Nächstes Rennen'}</div>
        <h1>${countryFlag(loc.country)} ${esc(next.raceName)}</h1>
        <div class="muted">${esc(next.Circuit.circuitName)} · ${esc(loc.locality)}, ${esc(loc.country)}</div>
        <div id="cd-label" class="small muted" style="margin-top:14px"></div>
        <div class="countdown" id="countdown"></div>
        <a class="btn" href="#/circuits/${esc(next.Circuit.circuitId)}" style="display:inline-block;margin-top:10px;text-decoration:none">Strecke &amp; Siegerliste</a>
      </div>
      <div>
        <h3>Zeitplan <span class="muted small">(deine Ortszeit)</span></h3>
        <ul class="sessions" id="sessions">${sess.map(x => `<li data-start="${+x.start}" data-end="${+x.end}"><span>${x.name}</span><span>${fmtDT.format(x.start)}</span></li>`).join('')}</ul>
      </div>
    </section>`;
  } else if (ds[0]) {
    const c = ds[0], t = cs[0];
    hero = `<section class="hero"><div>
      <div class="kicker">Saison ${esc(s)} abgeschlossen</div>
      <h1>🏆 ${natFlag(c.Driver.nationality)} ${driverName(c.Driver)}</h1>
      <div class="muted">Weltmeister mit ${esc(c.points)} Punkten und ${esc(c.wins)} Siegen</div>
      ${t ? `<p>Konstrukteurs-Weltmeister: <b>${esc(t.Constructor.name)}</b> (${esc(t.points)} Punkte)</p>` : ''}
    </div></section>`;
  } else {
    hero = `<section class="hero"><div><h1>Saison ${esc(s)}</h1><p class="muted">Noch keine Rennen gefahren.</p></div></section>`;
  }

  const podium = last?.Results ? `<div class="card"><h2>Letztes Rennen: ${esc(last.raceName)}</h2>
    <div class="podium">${[1, 0, 2].map(i => {
      const r = last.Results[i]; if (!r) return '<div></div>';
      return `<div class="step p${i + 1}" style="cursor:pointer" onclick="showDriver('${esc(r.Driver.driverId)}')">
        <div class="pos">P${i + 1}</div>${natFlag(r.Driver.nationality)}
        <div>${driverName(r.Driver)}</div>
        <div class="small muted">${esc(r.Constructor.name)}</div>
        <div class="small">${esc(r.Time?.time || r.status)}</div></div>`;
    }).join('')}</div>
    <p style="margin:12px 0 0"><a href="#/results/${last.round}">Komplettes Ergebnis →</a></p></div>` : '';

  const maxD = +ds[0]?.points || 1, maxC = +cs[0]?.points || 1;
  const miniD = `<div class="card"><h2>Fahrer-WM</h2><table>${ds.slice(0, 10).map(d => {
    const col = teamColor(d.Constructors.at(-1)?.constructorId);
    return `<tr class="click" onclick="showDriver('${esc(d.Driver.driverId)}')"><td class="pos">${esc(d.positionText)}</td>
      <td><span class="teambar" style="background:${col}"></span>${driverName(d.Driver)}</td>
      <td style="width:35%"><div class="bar"><i style="width:${(+d.points / maxD) * 100}%;background:${col}"></i></div></td>
      <td class="num"><b>${esc(d.points)}</b></td></tr>`;
  }).join('')}</table><p style="margin:10px 0 0"><a href="#/standings">Alle Fahrer →</a></p></div>`;
  const miniC = `<div class="card"><h2>Team-WM</h2><table>${cs.slice(0, 10).map(c => {
    const col = teamColor(c.Constructor.constructorId);
    return `<tr class="click" onclick="showTeam('${esc(c.Constructor.constructorId)}')"><td class="pos">${esc(c.positionText)}</td>
      <td><span class="teambar" style="background:${col}"></span>${esc(c.Constructor.name)}</td>
      <td style="width:35%"><div class="bar"><i style="width:${(+c.points / maxC) * 100}%;background:${col}"></i></div></td>
      <td class="num"><b>${esc(c.points)}</b></td></tr>`;
  }).join('')}</table><p style="margin:10px 0 0"><a href="#/teamstandings">Alle Teams →</a></p></div>`;

  return `${hero}<div class="grid g2 section">${podium}${miniD}${miniC}</div>`;
};
views.overview.after = () => {
  const list = $('#sessions');
  if (!list) return;
  const tick = () => {
    const now = Date.now();
    const items = $$('li', list);
    let target = null;
    for (const li of items) {
      const st = +li.dataset.start, en = +li.dataset.end;
      li.className = now > en ? 'done' : now >= st ? 'live' : '';
      if (now >= st && now <= en && !li.querySelector('.live-dot')) li.firstElementChild.insertAdjacentHTML('afterbegin', '<span class="live-dot"></span>');
      if (!target && now < st) { target = li; li.className = 'next'; }
    }
    const live = items.find(li => li.className === 'live');
    const cd = $('#countdown'), label = $('#cd-label');
    if (!cd) return;
    if (live) {
      label.innerHTML = `<span class="live-dot"></span>${esc(live.firstElementChild.textContent)} läuft gerade`;
      cd.innerHTML = '';
      if (!target) return;
    }
    if (!target) { cd.innerHTML = ''; label.textContent = 'Wochenende beendet'; return; }
    let diff = Math.max(0, +target.dataset.start - now) / 1000;
    const d = Math.floor(diff / 86400); diff -= d * 86400;
    const h = Math.floor(diff / 3600); diff -= h * 3600;
    const m = Math.floor(diff / 60), s = Math.floor(diff - m * 60);
    if (!live) label.textContent = `Countdown bis ${target.firstElementChild.textContent}`;
    cd.innerHTML = [[d, 'Tage'], [h, 'Std'], [m, 'Min'], [s, 'Sek']].map(([v, u]) => `<div><b>${String(v).padStart(2, '0')}</b><span>${u}</span></div>`).join('');
  };
  tick();
  state.timers.push(setInterval(tick, 1000));
};

// ---------------------------------------------------------------- Kalender
views.calendar = async () => {
  const s = state.season;
  const [races, wins] = await Promise.all([schedule(s), winners(s).catch(() => [])]);
  const winBy = Object.fromEntries(wins.map(r => [r.round, r.Results[0]]));
  const next = nextRace(races);
  const cards = races.map(r => {
    const sess = sessionsOf(r);
    const w = winBy[r.round];
    const isNext = next && next.round === r.round;
    const sprint = r.Sprint ? '<span class="badge sprint">Sprint</span> ' : '';
    const status = w
      ? `<div class="winner">🏆 ${natFlag(w.Driver.nationality)} ${driverName(w.Driver)} <span class="muted small">· ${esc(w.Constructor.name)}</span></div>`
      : isNext ? `<div class="winner"><span class="badge red">Nächstes Rennen</span></div>` : '';
    const href = w ? `#/results/${r.round}` : `#/circuits/${r.Circuit.circuitId}`;
    return `<a class="card click race-card ${isNext ? 'next' : w ? 'past' : ''}" href="${href}" style="text-decoration:none">
      <div class="round">${r.round}</div>
      <div class="date">${fmtD.format(sess[0].start)} – ${fmtD.format(raceDate(r))}</div>
      <h3 style="margin-top:4px">${countryFlag(r.Circuit.Location.country)} ${esc(r.raceName)}</h3>
      <div class="small muted">${sprint}${esc(r.Circuit.circuitName)}</div>${status}</a>`;
  }).join('');
  return `<h1>Rennkalender ${esc(s)}</h1><p class="sub">${races.length} Rennen · Zeiten in deiner Ortszeit · Klick öffnet Ergebnis bzw. Strecke</p>
    <div class="grid g3">${cards}</div>`;
};

// ---------------------------------------------------------------- WM-Stände + Verlauf
async function pointsProgression(season) {
  const [results, sprints] = await Promise.all([
    ergRaces(`/${season}/results.json`),
    ergRaces(`/${season}/sprint.json`).catch(() => []),
  ]);
  const rounds = results.map(r => r.round);
  const sprintBy = Object.fromEntries(sprints.map(r => [r.round, r.SprintResults || []]));
  const drv = {}, team = {};
  results.forEach((race, i) => {
    const add = (map, id, info, pts) => {
      map[id] ||= { info, pts: new Array(rounds.length).fill(0) };
      map[id].pts[i] += pts;
    };
    for (const res of [...race.Results, ...(sprintBy[race.round] || [])]) {
      add(drv, res.Driver.driverId, res, +res.points);
      add(team, res.Constructor.constructorId, res, +res.points);
    }
  });
  const cum = arr => arr.reduce((a, v, i) => (a.push((a[i - 1] || 0) + v), a), []);
  for (const m of [drv, team]) for (const k in m) m[k].cum = cum(m[k].pts);
  return { rounds, races: results, drv, team };
}

function lineChart({ series, xLabels, yMin, yMax, invert = false, height = 340, yTicks = 5, yFmt = v => v, xEvery = 1 }) {
  const W = 1000, H = height, L = 46, R = 90, T = 12, B = 30;
  const xs = Math.max(1, xLabels.length - 1);
  const X = i => L + (i / xs) * (W - L - R);
  const Y = v => {
    const f = (v - yMin) / (yMax - yMin || 1);
    return invert ? T + f * (H - T - B) : H - B - f * (H - T - B);
  };
  let g = '';
  for (let k = 0; k <= yTicks; k++) {
    const v = yMin + (k / yTicks) * (yMax - yMin);
    g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${yFmt(v)}</text>`;
  }
  xLabels.forEach((l, i) => { if (i % xEvery === 0 || i === xLabels.length - 1) g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`; });
  const lines = series.map(s => {
    const pts = s.points.filter(p => p && p[1] != null && isFinite(p[1]));
    if (!pts.length) return '';
    const d = pts.map(([x, y], j) => `${j ? 'L' : 'M'}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join('');
    const lastP = pts.at(-1);
    const dots = pts.length <= 40 ? pts.map(([x, y]) => `<circle cx="${X(x)}" cy="${Y(y)}" r="3" fill="${s.color}"><title>${esc(s.name)} · ${esc(xLabels[x])}: ${esc(yFmt(y, true))}</title></circle>`).join('') : '';
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" ${s.dash ? 'stroke-dasharray="6 4"' : ''} stroke-linejoin="round"><title>${esc(s.name)}</title></path>${dots}
      <text x="${X(lastP[0]) + 6}" y="${Y(lastP[1]) + 4}" style="fill:${s.color};font-weight:700">${esc(s.label || s.name)}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}${lines}</svg>`;
}

// Teamkollegen bekommen die gleiche Farbe, der zweite Fahrer gestrichelt
function colorize(items, teamOf) {
  const seen = {};
  return items.map(it => {
    const t = teamOf(it);
    seen[t] = (seen[t] || 0) + 1;
    return { ...it, color: teamColor(t), dash: seen[t] > 1 };
  });
}

views.standings = async () => {
  const s = state.season;
  const ds = await driverStandings(s);
  if (!ds.length) return `<h1>Fahrer-WM ${esc(s)}</h1><p class="muted">Noch keine Wertung vorhanden.</p>`;
  const max = +ds[0].points || 1;
  const rows = ds.map((d, i) => {
    const team = d.Constructors.at(-1);
    const col = teamColor(team?.constructorId);
    const gap = i ? `-${+ds[0].points - +d.points}` : '';
    return `<tr class="click" onclick="showDriver('${esc(d.Driver.driverId)}')">
      <td class="pos">${esc(d.positionText)}</td>
      <td><span class="drv"><span class="teambar" style="background:${col}"></span>${natFlag(d.Driver.nationality)} ${driverName(d.Driver)}</span></td>
      <td class="muted">${d.Constructors.map(c => esc(c.name)).join(' / ')}</td>
      <td class="num">${esc(d.wins)}</td>
      <td style="width:22%"><div class="bar"><i style="width:${(+d.points / max) * 100}%;background:${col}"></i></div></td>
      <td class="num"><b>${esc(d.points)}</b></td><td class="num muted">${gap}</td></tr>`;
  }).join('');
  return `<h1>Fahrer-Weltmeisterschaft ${esc(s)}</h1><p class="sub">Klick auf einen Fahrer zeigt Karriere-Statistiken</p>
    <div class="card table-wrap"><table><thead><tr><th>Pos</th><th>Fahrer</th><th>Team</th><th class="num">Siege</th><th></th><th class="num">Punkte</th><th class="num">Rückstand</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="card section"><h2>WM-Verlauf (Top 10)</h2><div id="prog">${loading('Berechne Punkteverlauf …')}</div></div>`;
};
views.standings.after = async () => {
  const token = render.token;
  try {
    const [p, ds] = await Promise.all([pointsProgression(state.season), driverStandings(state.season)]);
    if (stale(token)) return;
    const top = ds.slice(0, 10).map(d => d.Driver.driverId).filter(id => p.drv[id]);
    const series = colorize(top.map(id => {
      const x = p.drv[id];
      return { name: `${x.info.Driver.givenName} ${x.info.Driver.familyName}`, label: x.info.Driver.code || x.info.Driver.familyName, points: x.cum.map((v, i) => [i, v]), team: x.info.Constructor.constructorId };
    }), s => s.team);
    const yMax = Math.max(10, ...series.map(s => s.points.at(-1)?.[1] || 0));
    $('#prog').innerHTML = lineChart({ series, xLabels: p.races.map(r => 'R' + r.round), yMin: 0, yMax: Math.ceil(yMax / 50) * 50, xEvery: p.races.length > 14 ? 2 : 1 });
  } catch (e) { if (!stale(token)) $('#prog').innerHTML = errorBox(e); }
};

views.teamstandings = async () => {
  const s = state.season;
  const [cs, ds] = await Promise.all([teamStandings(s), driverStandings(s)]);
  if (!cs.length) return `<h1>Team-WM ${esc(s)}</h1><p class="muted">Für diese Saison gibt es keine Konstrukteurswertung (erst ab 1958).</p>`;
  const max = +cs[0].points || 1;
  const rows = cs.map((c, i) => {
    const col = teamColor(c.Constructor.constructorId);
    const drivers = ds.filter(d => d.Constructors.some(x => x.constructorId === c.Constructor.constructorId)).map(d => esc(d.Driver.familyName)).join(', ');
    return `<tr class="click" onclick="showTeam('${esc(c.Constructor.constructorId)}')">
      <td class="pos">${esc(c.positionText)}</td>
      <td><span class="teambar" style="background:${col}"></span>${natFlag(c.Constructor.nationality)} <b>${esc(c.Constructor.name)}</b></td>
      <td class="muted">${drivers}</td><td class="num">${esc(c.wins)}</td>
      <td style="width:22%"><div class="bar"><i style="width:${(+c.points / max) * 100}%;background:${col}"></i></div></td>
      <td class="num"><b>${esc(c.points)}</b></td><td class="num muted">${i ? '-' + (+cs[0].points - +c.points) : ''}</td></tr>`;
  }).join('');
  return `<h1>Konstrukteurs-Weltmeisterschaft ${esc(s)}</h1><p class="sub">Klick auf ein Team zeigt die Team-Historie</p>
    <div class="card table-wrap"><table><thead><tr><th>Pos</th><th>Team</th><th>Fahrer</th><th class="num">Siege</th><th></th><th class="num">Punkte</th><th class="num">Rückstand</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="card section"><h2>WM-Verlauf</h2><div id="prog">${loading('Berechne Punkteverlauf …')}</div></div>`;
};
views.teamstandings.after = async () => {
  const token = render.token;
  try {
    const [p, cs] = await Promise.all([pointsProgression(state.season), teamStandings(state.season)]);
    if (stale(token)) return;
    const series = cs.map(c => c.Constructor.constructorId).filter(id => p.team[id]).map(id => {
      const x = p.team[id];
      return { name: x.info.Constructor.name, points: x.cum.map((v, i) => [i, v]), color: teamColor(id) };
    });
    const yMax = Math.max(10, ...series.map(s => s.points.at(-1)?.[1] || 0));
    $('#prog').innerHTML = lineChart({ series, xLabels: p.races.map(r => 'R' + r.round), yMin: 0, yMax: Math.ceil(yMax / 50) * 50, xEvery: p.races.length > 14 ? 2 : 1 });
  } catch (e) { if (!stale(token)) $('#prog').innerHTML = errorBox(e); }
};

// ---------------------------------------------------------------- Ergebnisse
views.results = async (round, tab = 'race') => {
  const s = state.season;
  const [races, wins] = await Promise.all([schedule(s), winners(s).catch(() => [])]);
  const done = new Set(wins.map(r => r.round));
  if (!wins.length) return `<h1>Ergebnisse ${esc(s)}</h1><p class="muted">Noch keine Rennergebnisse vorhanden.</p>`;
  round = round && races.some(r => r.round === round) ? round : wins.at(-1).round;
  const race = races.find(r => r.round === round);
  const opts = races.filter(r => done.has(r.round)).map(r => `<option value="${r.round}" ${r.round === round ? 'selected' : ''}>R${r.round} · ${esc(r.raceName)}</option>`).join('');
  const tabs = [['race', 'Rennen'], ['quali', 'Qualifying'], ...(race.Sprint ? [['sprint', 'Sprint']] : []), ['pits', 'Boxenstopps'], ['laps', 'Positionsverlauf']];
  return `<h1>${countryFlag(race.Circuit.Location.country)} ${esc(race.raceName)} ${esc(s)}</h1>
    <p class="sub">${esc(race.Circuit.circuitName)} · ${fmtDY.format(raceDate(race))}</p>
    <div class="toolbar"><select id="round-sel">${opts}</select>
      <div class="tabs" style="margin:0">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <div class="card" id="res-body">${loading()}</div>`;
};
views.results.after = async (view, round, tab = 'race') => {
  const sel = $('#round-sel');
  if (!sel) return;
  round = sel.value;
  sel.onchange = () => (location.hash = `#/results/${sel.value}/${tab}`);
  $$('.tabs button', view).forEach(b => (b.onclick = () => (location.hash = `#/results/${round}/${b.dataset.tab}`)));
  const token = render.token;
  const body = $('#res-body');
  try {
    const html = await resultTabs[tab]?.(state.season, round) ?? '';
    if (!stale(token)) body.innerHTML = html;
  } catch (e) { if (!stale(token)) body.innerHTML = errorBox(e); }
};

function timeOrStatus(r) {
  if (r.Time?.time) return esc(r.Time.time);
  if (/^\+\d+ Laps?$/.test(r.status) || r.status === 'Lapped') return esc(r.status.replace('Laps', 'Runden').replace('Lap', 'Runde'));
  return `<span class="muted">${esc(r.status)}</span>`;
}
function resultTable(results, sprint = false) {
  const fastest = results.find(r => r.FastestLap?.rank === '1');
  const rows = results.map(r => {
    const grid = +r.grid, pos = +r.position;
    const delta = grid > 0 && r.positionText.match(/^\d+$/) ? grid - pos : 0;
    const dTxt = delta > 0 ? `<span class="gain">▲${delta}</span>` : delta < 0 ? `<span class="loss">▼${-delta}</span>` : '';
    const col = teamColor(r.Constructor.constructorId);
    return `<tr class="click" onclick="showDriver('${esc(r.Driver.driverId)}')">
      <td class="pos">${esc(r.positionText)}</td><td class="muted">${esc(r.number)}</td>
      <td><span class="teambar" style="background:${col}"></span>${natFlag(r.Driver.nationality)} ${driverName(r.Driver)} ${r === fastest ? '<span class="fl" title="Schnellste Runde">⏱ SR</span>' : ''}</td>
      <td class="muted">${esc(r.Constructor.name)}</td>
      <td class="num">${grid || 'Box'} ${dTxt}</td><td class="num">${esc(r.laps)}</td>
      <td>${timeOrStatus(r)}</td>
      <td class="muted small">${r.FastestLap?.Time?.time ? esc(r.FastestLap.Time.time) : ''}</td>
      <td class="num"><b>${+r.points ? esc(r.points) : ''}</b></td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr><th>Pos</th><th>#</th><th>Fahrer</th><th>Team</th><th class="num">Start</th><th class="num">Runden</th><th>Zeit / Status</th><th>Beste Runde</th><th class="num">Punkte</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${fastest ? `<p class="small muted" style="margin:10px 0 0">Schnellste Runde: ${driverName(fastest.Driver)} – ${esc(fastest.FastestLap.Time.time)} (Runde ${esc(fastest.FastestLap.lap)})</p>` : ''}`;
}

const resultTabs = {
  async race(s, round) {
    const race = (await ergRaces(`/${s}/${round}/results.json`))[0];
    return race ? resultTable(race.Results) : '<p class="muted">Keine Daten.</p>';
  },
  async sprint(s, round) {
    const race = (await ergRaces(`/${s}/${round}/sprint.json`))[0];
    return race ? resultTable(race.SprintResults, true) : '<p class="muted">Kein Sprint an diesem Wochenende.</p>';
  },
  async quali(s, round) {
    const race = (await ergRaces(`/${s}/${round}/qualifying.json`))[0];
    if (!race) return '<p class="muted">Keine Qualifying-Daten (vor 1994 nicht in der Datenbank).</p>';
    const rows = race.QualifyingResults.map(q => `<tr class="click" onclick="showDriver('${esc(q.Driver.driverId)}')">
      <td class="pos">${esc(q.position)}</td>
      <td><span class="teambar" style="background:${teamColor(q.Constructor.constructorId)}"></span>${natFlag(q.Driver.nationality)} ${driverName(q.Driver)}</td>
      <td class="muted">${esc(q.Constructor.name)}</td>
      <td>${esc(q.Q1 || '')}</td><td>${esc(q.Q2 || '')}</td><td><b>${esc(q.Q3 || '')}</b></td></tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr><th>Pos</th><th>Fahrer</th><th>Team</th><th>Q1</th><th>Q2</th><th>Q3</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },
  async pits(s, round) {
    const [stops, res] = await Promise.all([ergRaces(`/${s}/${round}/pitstops.json`), ergRaces(`/${s}/${round}/results.json`)]);
    const list = stops[0]?.PitStops || [];
    if (!list.length) return '<p class="muted">Keine Boxenstopp-Daten (erst ab 2011 erfasst).</p>';
    const who = Object.fromEntries((res[0]?.Results || []).map(r => [r.Driver.driverId, r]));
    const best = [...list].sort((a, b) => parseFloat(a.duration) - parseFloat(b.duration))[0];
    const rows = list.map(p => {
      const r = who[p.driverId];
      return `<tr><td>${r ? `<span class="teambar" style="background:${teamColor(r.Constructor.constructorId)}"></span>${driverName(r.Driver)}` : esc(p.driverId)}</td>
        <td class="muted">${r ? esc(r.Constructor.name) : ''}</td><td class="num">${esc(p.stop)}</td><td class="num">${esc(p.lap)}</td>
        <td class="muted">${esc(p.time)}</td><td class="num ${p === best ? 'fl' : ''}">${esc(p.duration)} s</td></tr>`;
    }).join('');
    return `<p class="small muted" style="margin-top:0">Dauer = Zeit in der Boxengasse (Ein- bis Ausfahrt), nicht nur der Stillstand.</p>
      <div class="table-wrap"><table><thead><tr><th>Fahrer</th><th>Team</th><th class="num">Stopp</th><th class="num">Runde</th><th>Uhrzeit</th><th class="num">Dauer</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  },
  async laps(s, round) {
    const [lapsRaces, res] = await Promise.all([ergRaces(`/${s}/${round}/laps.json`), ergRaces(`/${s}/${round}/results.json`)]);
    const laps = (lapsRaces[0]?.Laps || []).sort((a, b) => a.number - b.number);
    if (!laps.length) return '<p class="muted">Keine Rundendaten (erst ab 1996 erfasst).</p>';
    const results = res[0]?.Results || [];
    const pos = {};
    laps.forEach((l, i) => l.Timings.forEach(t => { (pos[t.driverId] ||= [])[i + 1] = +t.position; }));
    const series = colorize(results.filter(r => pos[r.Driver.driverId]).map(r => {
      const p = pos[r.Driver.driverId];
      p[0] = +r.grid || results.length;
      return { name: `${r.Driver.givenName} ${r.Driver.familyName}`, label: r.Driver.code || r.Driver.familyName, team: r.Constructor.constructorId, points: p.map((v, i) => (v ? [i, v] : null)) };
    }), x => x.team);
    const n = Math.max(...series.map(x => x.points.length - 1));
    const xLabels = Array.from({ length: n + 1 }, (_, i) => (i ? String(i) : 'Start'));
    return `<h3>Platzierung pro Runde</h3>
      ${lineChart({ series, xLabels, yMin: 1, yMax: results.length, invert: true, height: 520, yTicks: results.length - 1, yFmt: v => 'P' + Math.round(v), xEvery: Math.ceil(n / 20) })}
      <p class="small muted">Gestrichelt = zweiter Fahrer eines Teams. Linien enden bei Ausfall.</p>`;
  },
};

// ---------------------------------------------------------------- Fahrer & Teams
views.drivers = async () => {
  const s = state.season;
  const ds = await driverStandings(s);
  if (!ds.length) return `<h1>Fahrer ${esc(s)}</h1><p class="muted">Noch keine Daten.</p>`;
  const cards = ds.map(d => {
    const team = d.Constructors.at(-1);
    const col = of1People[d.Driver.code]?.colour && +s >= NOW_YEAR - 1 ? of1People[d.Driver.code].colour : teamColor(team?.constructorId);
    return `<div class="card click person" style="border-top-color:${col}" onclick="showDriver('${esc(d.Driver.driverId)}')">
      ${avatar(d.Driver, col)}
      <div style="flex:1;min-width:0">
        <div class="small muted">${natFlag(d.Driver.nationality)} ${esc(d.Driver.nationality)}${d.Driver.dateOfBirth ? ` · ${age(d.Driver.dateOfBirth)} J.` : ''}</div>
        <div style="font-size:17px">${driverName(d.Driver)}</div>
        <div class="small muted">${esc(team?.name || '')}</div>
        <div class="small">P${esc(d.positionText)} · ${esc(d.points)} Pkt · ${esc(d.wins)} Siege</div>
      </div>
      <div class="bignum" style="color:${col}">${esc(d.Driver.permanentNumber || '')}</div></div>`;
  }).join('');
  return `<h1>Fahrer ${esc(s)}</h1><p class="sub">Klick für Karriere-Statistiken</p><div class="grid g3">${cards}</div>`;
};

views.teams = async () => {
  const s = state.season;
  const [cs, ds] = await Promise.all([teamStandings(s), driverStandings(s)]);
  if (!cs.length) return `<h1>Teams ${esc(s)}</h1><p class="muted">Keine Daten.</p>`;
  const cards = cs.map(c => {
    const id = c.Constructor.constructorId, col = teamColor(id);
    const drivers = ds.filter(d => d.Constructors.some(x => x.constructorId === id));
    return `<div class="card click" style="border-top:4px solid ${col}" onclick="showTeam('${esc(id)}')">
      <div class="small muted">${natFlag(c.Constructor.nationality)} ${esc(c.Constructor.nationality)}</div>
      <h2 style="margin:2px 0 6px">${esc(c.Constructor.name)}</h2>
      <div>P${esc(c.positionText)} · <b>${esc(c.points)}</b> Punkte · ${esc(c.wins)} Siege</div>
      <div class="winner">${drivers.map(d => `${natFlag(d.Driver.nationality)} ${driverName(d.Driver)} <span class="muted small">${esc(d.points)} Pkt</span>`).join('<br>')}</div></div>`;
  }).join('');
  return `<h1>Teams ${esc(s)}</h1><p class="sub">Klick für Team-Historie</p><div class="grid g3">${cards}</div>`;
};

const total = md => +md.total;

// champions.js endet mit 2025 – abgeschlossene spätere Saisons werden einmalig nachgeladen
let champsReady = null;
function ensureChampions() {
  return (champsReady ||= (async () => {
    const last = Math.max(...Object.keys(CHAMPIONS.d).map(Number));
    for (let y = last + 1; y <= NOW_YEAR; y++) {
      try {
        const races = (await erg(`/${y}.json?limit=100`, DAY)).RaceTable.Races;
        if (!races.length || +raceDate(races.at(-1)) + DAY > Date.now()) break;
        const [dm, cm] = await Promise.all([erg(`/${y}/driverstandings/1.json`, 365 * DAY), erg(`/${y}/constructorstandings/1.json`, 365 * DAY)]);
        const d = dm.StandingsTable.StandingsLists[0]?.DriverStandings[0];
        const c = cm.StandingsTable.StandingsLists[0]?.ConstructorStandings[0];
        if (!d) break;
        CHAMPIONS.d[y] = [d.Driver.driverId, `${d.Driver.givenName} ${d.Driver.familyName}`, d.Driver.nationality, d.Constructors.at(-1)?.name || '', d.points, d.wins];
        if (c) CHAMPIONS.c[y] = [c.Constructor.constructorId, c.Constructor.name, c.points, c.wins];
      } catch { break; }
    }
  })());
}

async function careerStats(kind, id) {
  await ensureChampions();
  const base = `/${kind}/${id}`, ttl = DAY;
  const q = p => erg(`${base}${p}?limit=1`, ttl).then(total).catch(() => null);
  const [starts, wins, p2, p3, poles, seasons] = await Promise.all([
    q('/results.json'), q('/results/1.json'), q('/results/2.json'), q('/results/3.json'),
    q('/qualifying/1.json'), q('/seasons.json'),
  ]);
  const titles = titleYears(kind, id).length;
  return { starts, wins, podiums: wins != null && p2 != null && p3 != null ? wins + p2 + p3 : null, poles, titles, seasons };
}
const titleYears = (kind, id) => Object.entries(CHAMPIONS[kind === 'drivers' ? 'd' : 'c']).filter(([, v]) => v[0] === id).map(([y]) => y);

// Jolpica liefert WM-Stände nur pro Saison, daher Saison für Saison nachladen
async function seasonHistory(kind, id, maxSeasons) {
  const seasons = (await erg(`/${kind}/${id}/seasons.json?limit=100`, DAY)).SeasonTable.Seasons.map(s => s.season);
  const pick = seasons.slice(-maxSeasons).reverse();
  const path = kind === 'drivers' ? 'driverstandings' : 'constructorstandings';
  const lists = await Promise.all(pick.map(y =>
    erg(`/${y}/${kind}/${id}/${path}.json`, ttlFor(y)).then(md => md.StandingsTable.StandingsLists[0]).catch(() => null)));
  return { lists: lists.filter(Boolean), more: seasons.length - pick.length };
}
function statsGrid(st, kind) {
  const items = [['Titel', st.titles], ['Siege', st.wins], ['Podien', st.podiums], ['Poles', st.poles], [kind === 'drivers' ? 'Starts' : 'Ergebnisse', st.starts], ['Saisons', st.seasons]];
  return `<div class="stats">${items.map(([l, v]) => `<div class="stat"><b>${v ?? '–'}</b><span>${l}</span></div>`).join('')}</div>`;
}

const modal = $('#modal');
let modalSeq = 0;
function openModal(html) { $('.modal-body', modal).innerHTML = html; modal.classList.remove('hidden'); }
function closeModal() { modal.classList.add('hidden'); }
modal.addEventListener('click', e => { if (e.target === modal || e.target.closest('.modal-close')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

window.showDriver = async id => {
  const my = ++modalSeq;
  openModal(loading('Lade Fahrerprofil …'));
  try {
    const [info, st] = await Promise.all([
      erg(`/drivers/${id}.json`, DAY).then(md => md.DriverTable.Drivers[0]),
      careerStats('drivers', id),
    ]);
    if (my !== modalSeq) return;
    const titles = titleYears('drivers', id);
    openModal(`<div class="person" style="border:0;margin-bottom:6px" id="dhead">${avatar(info, 'var(--panel2)')}<div>
        <div class="small muted">${natFlag(info.nationality)} ${esc(info.nationality)}${info.permanentNumber ? ` · #${esc(info.permanentNumber)}` : ''}</div>
        <h1>${driverName(info)}</h1>
        <div class="small muted">${info.dateOfBirth ? `Geboren ${fmtDY.format(new Date(info.dateOfBirth))} (${age(info.dateOfBirth)} Jahre)` : ''}</div></div></div>
      ${statsGrid(st, 'drivers')}
      ${titles.length ? `<p>🏆 Weltmeister ${titles.join(', ')}</p>` : ''}
      <h3>Saison für Saison</h3><div id="hist">${loading('Lade Saisons …')}</div>
      ${info.url ? `<p><a href="${esc(info.url)}" target="_blank" rel="noopener">Wikipedia-Artikel →</a></p>` : ''}`);
    const { lists, more } = await seasonHistory('drivers', id, 25);
    const box = $('#hist');
    if (!box || my !== modalSeq) return;
    const col = teamColor(lists[0]?.DriverStandings[0]?.Constructors.at(-1)?.constructorId);
    const av = $('#dhead .avatar');
    if (av) av.style.background = col;
    box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Jahr</th><th>Team</th><th class="num">WM</th><th class="num">Siege</th><th class="num">Punkte</th></tr></thead><tbody>${lists.map(l => {
      const d = l.DriverStandings[0];
      return `<tr><td>${esc(l.season)}</td><td>${d.Constructors.map(c => esc(c.name)).join(' / ')}</td><td class="num">P${esc(d.positionText)}</td><td class="num">${esc(d.wins)}</td><td class="num">${esc(d.points)}</td></tr>`;
    }).join('')}</tbody></table></div>${more > 0 ? `<p class="small muted">… und ${more} frühere Saisons</p>` : ''}`;
  } catch (e) { if (my === modalSeq) openModal(errorBox(e)); }
};

window.showTeam = async id => {
  const my = ++modalSeq;
  openModal(loading('Lade Teamprofil …'));
  try {
    const [info, st] = await Promise.all([
      erg(`/constructors/${id}.json`, DAY).then(md => md.ConstructorTable.Constructors[0]),
      careerStats('constructors', id),
    ]);
    if (my !== modalSeq) return;
    const titles = titleYears('constructors', id);
    openModal(`<div style="border-left:5px solid ${teamColor(id)};padding-left:12px">
        <div class="small muted">${natFlag(info.nationality)} ${esc(info.nationality)}</div><h1>${esc(info.name)}</h1></div>
      ${statsGrid(st, 'constructors')}
      ${titles.length ? `<p>🏆 Konstrukteurs-Weltmeister ${titles.join(', ')}</p>` : ''}
      <p class="small muted">Podien und Ergebnisse zählen pro Auto, nicht pro Rennen.</p>
      <h3>Die letzten Saisons</h3><div id="hist">${loading('Lade Saisons …')}</div>
      ${info.url ? `<p><a href="${esc(info.url)}" target="_blank" rel="noopener">Wikipedia-Artikel →</a></p>` : ''}`);
    const { lists, more } = await seasonHistory('constructors', id, 15);
    const box = $('#hist');
    if (!box || my !== modalSeq) return;
    box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Jahr</th><th class="num">WM</th><th class="num">Siege</th><th class="num">Punkte</th></tr></thead><tbody>${lists.map(l => {
      const c = l.ConstructorStandings[0];
      return `<tr><td>${esc(l.season)}</td><td class="num">P${esc(c.positionText)}</td><td class="num">${esc(c.wins)}</td><td class="num">${esc(c.points)}</td></tr>`;
    }).join('')}</tbody></table></div>${more > 0 ? `<p class="small muted">… und ${more} frühere Saisons</p>` : ''}`;
  } catch (e) { if (my === modalSeq) openModal(errorBox(e)); }
};

// ---------------------------------------------------------------- Strecken
views.circuits = async circuitId => {
  const s = state.season;
  const races = await schedule(s);
  const cards = races.map(r => {
    const c = r.Circuit, loc = c.Location;
    return `<div class="card click" onclick="location.hash='#/circuits/${esc(c.circuitId)}'">
      <div class="small muted">Runde ${r.round} · ${fmtD.format(raceDate(r))}</div>
      <h3 style="margin-top:4px">${countryFlag(loc.country)} ${esc(c.circuitName)}</h3>
      <div class="small muted">${esc(loc.locality)}, ${esc(loc.country)}</div></div>`;
  }).join('');
  return `<h1>Strecken ${esc(s)}</h1><p class="sub">Klick zeigt Karte und alle bisherigen Sieger</p><div class="grid g3">${cards}</div>`;
};
views.circuits.after = (view, circuitId) => { if (circuitId) showCircuit(circuitId); };

async function showCircuit(id) {
  const my = ++modalSeq;
  openModal(loading('Lade Streckenhistorie …'));
  try {
    const info = (await erg(`/circuits/${id}.json`, 30 * DAY)).CircuitTable.Circuits[0];
    const n = total(await erg(`/circuits/${id}/results/1.json?limit=1`, DAY));
    const offset = Math.max(0, n - 100);
    const wins = n ? (await erg(`/circuits/${id}/results/1.json?limit=100&offset=${offset}`, DAY)).RaceTable.Races : [];
    const count = {};
    wins.forEach(r => { const d = r.Results[0].Driver; const k = `${d.givenName} ${d.familyName}`; count[k] = (count[k] || 0) + 1; });
    const best = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const { lat, long } = info.Location;
    const rows = [...wins].reverse().map(r => {
      const w = r.Results[0];
      return `<tr><td>${esc(r.season)}</td><td>${natFlag(w.Driver.nationality)} ${driverName(w.Driver)}</td><td class="muted">${esc(w.Constructor.name)}</td><td class="muted small">${esc(w.Time?.time || '')}</td></tr>`;
    }).join('');
    if (my !== modalSeq) return;
    const bb = `${+long - 0.02},${+lat - 0.012},${+long + 0.02},${+lat + 0.012}`;
    openModal(`<h1>${countryFlag(info.Location.country)} ${esc(info.circuitName)}</h1>
      <p class="muted" style="margin-top:0">${esc(info.Location.locality)}, ${esc(info.Location.country)} · ${n} Grand Prix in der Datenbank</p>
      <iframe title="Karte" style="width:100%;height:280px;border:0;border-radius:8px" loading="lazy"
        src="https://www.openstreetmap.org/export/embed.html?bbox=${bb}&layer=mapnik&marker=${lat},${long}"></iframe>
      ${best.length ? `<h3 style="margin-top:14px">Rekordsieger</h3><p>${best.map(([k, v]) => `${esc(k)} <b>${v}×</b>`).join(' · ')}</p>` : ''}
      ${rows ? `<h3>Alle Sieger</h3><div class="table-wrap"><table><thead><tr><th>Jahr</th><th>Sieger</th><th>Team</th><th>Zeit</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      <p><a href="${esc(info.url)}" target="_blank" rel="noopener">Wikipedia-Artikel →</a></p>`);
  } catch (e) { if (my === modalSeq) openModal(errorBox(e)); }
}

// ---------------------------------------------------------------- Analyse (OpenF1)
const TYRE = { SOFT: '#ff3b3b', MEDIUM: '#ffd12e', HARD: '#eeeeee', INTERMEDIATE: '#39b54a', WET: '#2f8cff', UNKNOWN: '#777' };
const fmtLap = sec => { if (sec == null) return ''; const m = Math.floor(sec / 60); return `${m}:${(sec - m * 60).toFixed(3).padStart(6, '0')}`; };

views.analysis = async sessionKey => {
  const s = state.season;
  if (+s < 2023) return `<h1>Analyse</h1><div class="note">Detaillierte Sessiondaten (Reifen, Rundenzeiten, Rennleitung, Wetter) liefert OpenF1 erst ab der Saison 2023. Wähle oben eine neuere Saison.</div>`;
  let sessions;
  try { sessions = await of1(`/sessions?year=${s}`, +s < NOW_YEAR ? 30 * DAY : 30 * MIN); }
  catch (e) { return `<h1>Analyse ${esc(s)}</h1>${errorBox(e)}`; }
  const now = Date.now();
  sessions = sessions.filter(x => new Date(x.date_end || x.date_start) < now).sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
  if (!sessions.length) return `<h1>Analyse ${esc(s)}</h1><p class="muted">Noch keine abgeschlossenen Sessions.</p>`;
  const key = sessionKey && sessions.some(x => String(x.session_key) === sessionKey) ? sessionKey : String((sessions.find(x => x.session_type === 'Race') || sessions[0]).session_key);
  const cur = sessions.find(x => String(x.session_key) === key);
  const opts = sessions.map(x => `<option value="${x.session_key}" ${String(x.session_key) === key ? 'selected' : ''}>${esc(x.country_name)} · ${esc(x.session_name)} · ${fmtD.format(new Date(x.date_start))}</option>`).join('');
  return `<h1>Analyse: ${esc(cur.country_name)} – ${esc(cur.session_name)}</h1>
    <p class="sub">${esc(cur.circuit_short_name)} · Daten von OpenF1 (verfügbar nach Session-Ende)</p>
    <div class="toolbar"><select id="sess-sel">${opts}</select></div>
    <div id="an-body">${loading('Lade Sessiondaten …')}</div>`;
};
views.analysis.after = async (view) => {
  const sel = $('#sess-sel');
  if (!sel) return;
  sel.onchange = () => (location.hash = `#/analysis/${sel.value}`);
  const key = sel.value, token = render.token, body = $('#an-body');
  const ttl = 7 * DAY;
  try {
    const [drivers, result, stints, laps, rc, weather, pits] = await Promise.all([
      of1(`/drivers?session_key=${key}`, ttl),
      of1(`/session_result?session_key=${key}`, ttl).catch(() => []),
      of1(`/stints?session_key=${key}`, ttl).catch(() => []),
      of1(`/laps?session_key=${key}`, ttl).catch(() => []),
      of1(`/race_control?session_key=${key}`, ttl).catch(() => []),
      of1(`/weather?session_key=${key}`, ttl).catch(() => []),
      of1(`/pit?session_key=${key}`, ttl).catch(() => []),
    ]);
    if (stale(token)) return;
    rememberPeople(drivers);
    const byNum = Object.fromEntries(drivers.map(d => [d.driver_number, d]));
    const order = result.length
      ? [...result].sort((a, b) => (a.position ?? 99) - (b.position ?? 99)).map(r => r.driver_number)
      : drivers.map(d => d.driver_number);
    const dcol = n => '#' + (byNum[n]?.team_colour || '888888');
    const dname = n => byNum[n]?.name_acronym || String(n);

    // Ergebnis
    const resHtml = result.length ? `<div class="card"><h2>Ergebnis</h2><div class="table-wrap"><table><thead><tr><th>Pos</th><th>Fahrer</th><th>Team</th><th class="num">Runden</th><th>Abstand</th></tr></thead><tbody>
      ${[...result].sort((a, b) => (a.position ?? 99) - (b.position ?? 99)).map(r => {
        const d = byNum[r.driver_number] || {};
        const gap = r.dnf ? 'DNF' : r.dns ? 'DNS' : r.dsq ? 'DSQ' : r.position === 1 ? 'Sieger' : Array.isArray(r.gap_to_leader) ? r.gap_to_leader.map(g => (g == null ? '' : '+' + g)).filter(Boolean).at(-1) || '' : r.gap_to_leader == null ? '' : typeof r.gap_to_leader === 'number' ? '+' + r.gap_to_leader.toFixed(3) + ' s' : esc(r.gap_to_leader);
        return `<tr><td class="pos">${r.position ?? '–'}</td><td><span class="teambar" style="background:${dcol(r.driver_number)}"></span>${esc(d.full_name || r.driver_number)}</td><td class="muted">${esc(d.team_name || '')}</td><td class="num">${r.number_of_laps ?? ''}</td><td>${gap}</td></tr>`;
      }).join('')}</tbody></table></div></div>` : '';

    // Reifenstrategie
    let tyreHtml = '';
    if (stints.length) {
      const maxLap = Math.max(...stints.map(x => x.lap_end || 0), 1);
      const rowsOrder = order.filter(n => stints.some(x => x.driver_number === n));
      const rowH = 22, L = 50, W = 1000, H = rowsOrder.length * rowH + 24;
      const X = l => L + ((l - 1) / maxLap) * (W - L - 10);
      let svg = '';
      rowsOrder.forEach((n, i) => {
        const y = i * rowH + 4;
        svg += `<text x="${L - 8}" y="${y + 14}" text-anchor="end" style="fill:${dcol(n)};font-weight:700">${esc(dname(n))}</text>`;
        stints.filter(x => x.driver_number === n).forEach(x => {
          const c = TYRE[x.compound] || TYRE.UNKNOWN;
          const x1 = X(x.lap_start || 1), x2 = X((x.lap_end || x.lap_start || 1) + 1);
          svg += `<rect x="${x1}" y="${y}" width="${Math.max(2, x2 - x1 - 2)}" height="${rowH - 6}" rx="4" fill="${c}"><title>${esc(dname(n))}: ${esc(x.compound)} · Runde ${x.lap_start}–${x.lap_end} · Reifenalter beim Start ${x.tyre_age_at_start ?? '?'}</title></rect>`;
        });
      });
      for (let l = 0; l <= maxLap; l += 10) svg += `<text x="${X(l || 1)}" y="${H - 4}" text-anchor="middle">${l || 1}</text>`;
      tyreHtml = `<div class="card"><h2>Reifenstrategie</h2><svg class="chart" viewBox="0 0 ${W} ${H}">${svg}</svg>
        <div class="legend">${Object.entries(TYRE).filter(([k]) => k !== 'UNKNOWN').map(([k, c]) => `<span><i style="background:${c};height:10px"></i>${k}</span>`).join('')}</div></div>`;
    }

    // Wetter
    let wHtml = '';
    if (weather.length) {
      const range = f => { const v = weather.map(w => w[f]).filter(x => x != null); return v.length ? [Math.min(...v), Math.max(...v)] : null; };
      const air = range('air_temperature'), trk = range('track_temperature'), hum = range('humidity'), wind = range('wind_speed');
      const rain = weather.some(w => w.rainfall);
      const fmt = (r, u) => (r ? (r[0] === r[1] ? `${r[0]}${u}` : `${r[0]}–${r[1]}${u}`) : '–');
      wHtml = `<div class="card"><h2>Wetter</h2><div class="stats">
        <div class="stat"><b>${fmt(air, '°')}</b><span>Luft</span></div><div class="stat"><b>${fmt(trk, '°')}</b><span>Strecke</span></div>
        <div class="stat"><b>${fmt(hum, '%')}</b><span>Luftfeuchte</span></div><div class="stat"><b>${fmt(wind, '')}</b><span>Wind m/s</span></div>
        <div class="stat"><b>${rain ? '🌧 Ja' : '☀ Nein'}</b><span>Regen</span></div></div></div>`;
    }

    // Rennleitung
    const rcHtml = rc.length ? `<div class="card"><h2>Rennleitung</h2><div class="rc-list">${rc.map(m => {
      const fc = { GREEN: '#3ddc84', YELLOW: '#ffd12e', 'DOUBLE YELLOW': '#ffd12e', RED: '#ff3b3b', BLUE: '#2f8cff', CHEQUERED: '#fff', CLEAR: '#3ddc84' }[m.flag] || 'var(--muted)';
      return `<div><span class="muted small">${m.lap_number ? 'R' + m.lap_number + ' · ' : ''}${new Date(m.date).toLocaleTimeString('de-DE')}</span><br>
        <span class="rc-flag" style="color:${fc}">${esc(m.flag || m.category || '')}</span> ${esc(m.message)}</div>`;
    }).join('')}</div></div>` : '';

    // Boxenstopps
    const pitHtml = pits.length ? `<div class="card"><h2>Boxenstopps</h2><div class="table-wrap" style="max-height:420px;overflow-y:auto"><table><thead><tr><th>Fahrer</th><th class="num">Runde</th><th class="num">Stillstand</th><th class="num">Boxengasse</th></tr></thead><tbody>
      ${[...pits].sort((a, b) => a.lap_number - b.lap_number).map(p => {
        const lane = p.lane_duration ?? p.pit_duration;
        return `<tr><td><span class="teambar" style="background:${dcol(p.driver_number)}"></span>${esc(dname(p.driver_number))}</td><td class="num">${p.lap_number ?? ''}</td><td class="num">${p.stop_duration != null ? p.stop_duration.toFixed(1) + ' s' : '–'}</td><td class="num">${lane != null ? lane.toFixed(1) + ' s' : '–'}</td></tr>`;
      }).join('')}</tbody></table></div></div>` : '';

    body.innerHTML = `<div class="grid">${wHtml}${laps.length ? `<div class="card"><h2>Rundenzeiten</h2><div class="picker" id="lap-pick"></div><div id="lap-chart"></div><p class="small muted">Boxen-, Safety-Car- und Ausreißerrunden werden ausgeblendet.</p></div>` : ''}${tyreHtml}</div>
      <div class="grid g2 section">${resHtml}${rcHtml}${pitHtml}</div>`;

    if (laps.length) {
      const lapsBy = {};
      laps.forEach(l => { if (l.lap_duration && !l.is_pit_out_lap) (lapsBy[l.driver_number] ||= []).push([l.lap_number, l.lap_duration]); });
      const all = Object.values(lapsBy).flat().map(x => x[1]).sort((a, b) => a - b);
      const median = all[Math.floor(all.length / 2)] || 100;
      const fastest = all[0] || 60;
      const cutoff = median * 1.07;
      const pickable = order.filter(n => lapsBy[n]);
      const picked = new Set(pickable.slice(0, 5));
      const pick = $('#lap-pick');
      pick.innerHTML = pickable.map(n => `<label style="border-color:${dcol(n)}"><input type="checkbox" value="${n}" ${picked.has(n) ? 'checked' : ''}>${esc(dname(n))}</label>`).join('');
      const draw = () => {
        const maxLap = Math.max(...laps.map(l => l.lap_number));
        const xLabels = Array.from({ length: maxLap + 1 }, (_, i) => String(i));
        const series = [...picked].map(n => ({
          name: byNum[n]?.full_name || dname(n), label: dname(n), color: dcol(n),
          points: lapsBy[n].filter(([, t]) => t <= cutoff).sort((a, b) => a[0] - b[0]),
        }));
        series.forEach((s, i) => { s.dash = series.slice(0, i).some(o => o.color === s.color); });
        $('#lap-chart').innerHTML = picked.size
          ? lineChart({ series, xLabels, yMin: Math.floor(fastest), yMax: Math.ceil(cutoff), height: 380, yFmt: (v, exact) => (exact ? fmtLap(v) : fmtLap(Math.round(v)).replace('.000', '')), xEvery: Math.ceil(maxLap / 20) })
          : '<p class="muted">Fahrer auswählen.</p>';
      };
      pick.onchange = e => { const n = +e.target.value; e.target.checked ? picked.add(n) : picked.delete(n); draw(); };
      draw();
    }
  } catch (e) { if (!stale(token)) body.innerHTML = errorBox(e); }
};

// ---------------------------------------------------------------- Weltmeister
views.champions = async () => {
  await ensureChampions();
  const tally = (map, idx) => {
    const t = {};
    for (const v of Object.values(map)) (t[v[0]] ||= { name: v[idx], n: 0, nat: v[2] }).n++;
    return Object.entries(t).sort((a, b) => b[1].n - a[1].n);
  };
  const topD = tally(CHAMPIONS.d, 1).slice(0, 10), topC = tally(CHAMPIONS.c, 1).slice(0, 10);
  const years = Object.keys(CHAMPIONS.d).sort((a, b) => b - a);
  const rows = years.map(y => {
    const d = CHAMPIONS.d[y], c = CHAMPIONS.c[y];
    return `<tr><td><b>${y}</b></td>
      <td class="click" onclick="showDriver('${esc(d[0])}')" style="cursor:pointer">${natFlag(d[2])} ${esc(d[1])}</td>
      <td class="muted">${esc(d[3])}</td><td class="num">${esc(d[4])}</td><td class="num">${esc(d[5])}</td>
      <td style="cursor:${c ? 'pointer' : 'default'}" ${c ? `onclick="showTeam('${esc(c[0])}')"` : ''}>${c ? `<span class="teambar" style="background:${teamColor(c[0])}"></span>${esc(c[1])}` : '<span class="muted">–</span>'}</td></tr>`;
  }).join('');
  const list = (arr, fn) => `<table>${arr.map(([id, v], i) => `<tr class="click" onclick="${fn}('${esc(id)}')"><td class="pos">${i + 1}</td><td>${v.nat && NAT[v.nat] ? natFlag(v.nat) + ' ' : ''}${esc(v.name)}</td><td class="num"><b>${v.n}</b></td></tr>`).join('')}</table>`;
  return `<h1>Weltmeister</h1><p class="sub">Alle Champions seit 1950 (Konstrukteurswertung seit 1958). Eine laufende Saison erscheint, sobald ihr letztes Rennen gefahren ist.</p>
    <div class="grid g2"><div class="card"><h2>Meiste Fahrertitel</h2>${list(topD, 'showDriver')}</div>
    <div class="card"><h2>Meiste Konstrukteurstitel</h2>${list(topC, 'showTeam')}</div></div>
    <div class="card section table-wrap"><table><thead><tr><th>Jahr</th><th>Fahrer-Weltmeister</th><th>Team</th><th class="num">Punkte</th><th class="num">Siege</th><th>Konstrukteurs-Weltmeister</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

// ---------------------------------------------------------------- Start
function initSeasonSelect() {
  const sel = $('#season');
  const years = [];
  for (let y = NOW_YEAR; y >= 1950; y--) years.push(y);
  sel.innerHTML = years.map(y => `<option ${String(y) === state.season ? 'selected' : ''}>${y}</option>`).join('');
  if (!years.includes(+state.season)) { state.season = String(NOW_YEAR); sel.value = state.season; }
  sel.onchange = () => {
    state.season = sel.value;
    localStorage.setItem('f1:season', state.season);
    const keep = ['overview', 'calendar', 'standings', 'teamstandings', 'drivers', 'teams', 'circuits', 'analysis', 'champions', 'duel', 'compare', 'telemetry', 'news', 'live'];
    const target = '#/' + (keep.includes(state.route) ? state.route : 'overview');
    if (location.hash === target) render(); else location.hash = target;
  };
}
$('#refresh').onclick = () => {
  Cache.clear(k => k.includes(`/${NOW_YEAR}`) || k.includes('/current') || k.includes('latest') || k.startsWith(OF1 + '/sessions'));
  render();
};
// Erst starten, wenn alle Skripte geladen sind – live.js und features.js melden eigene Views an
document.addEventListener('DOMContentLoaded', () => {
  window.addEventListener('hashchange', render);
  initSeasonSelect();
  render();
  loadPeople();
});
