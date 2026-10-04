'use strict';
// Zusatzseiten: Teamkollegen-Duelle, Fahrervergleich, Telemetrie. Nutzt die Globals aus app.js.

// ---------------------------------------------------------------- Hilfsfunktionen
const finishedStatus = st => st === 'Finished' || st === 'Lapped' || /^\+\d+ Laps?/.test(st || '');
const startedStatus = st => !/^(Did not|Withdrew)/i.test(st || '');
const num1 = v => (v == null || !isFinite(v) ? '–' : String(Math.round(v * 10) / 10));
// Hex-Farbe Richtung Weiß aufhellen (für Teamkollegen mit gleicher Teamfarbe)
function lighten(hex, f = 0.5) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgb(${[16, 8, 0].map(s => Math.round(((n >> s) & 255) * (1 - f) + 255 * f)).join(',')})`;
}
// Geteilter Balken: linker Anteil in Teamfarbe, rechter gedimmt
const splitBar = (share, col) => `<div class="split"><i style="width:${(share * 100).toFixed(1)}%;background:${col}"></i><i style="flex:1;background:${col};opacity:.35"></i></div>`;

// ---------------------------------------------------------------- Teamkollegen-Duelle
views.duel = async () => {
  const s = state.season;
  const [results, quali, sprints, cs] = await Promise.all([
    ergRaces(`/${s}/results.json`),
    +s >= 1994 ? ergRaces(`/${s}/qualifying.json`).catch(() => []) : [],
    +s >= 2021 ? ergRaces(`/${s}/sprint.json`).catch(() => []) : [],
    teamStandings(s).catch(() => []),
  ]);
  const head = `<h1>Teamkollegen-Duelle ${esc(s)}</h1>`;
  if (!results.length) return `${head}<p class="muted">Noch keine Rennergebnisse vorhanden.</p>`;

  // Qualifying-Position je Runde und Fahrer/Team
  const qBy = {};
  for (const r of quali) for (const q of r.QualifyingResults || []) (qBy[r.round] ||= {})[`${q.Driver.driverId}|${q.Constructor.constructorId}`] = +q.position;
  const hasQ = Object.keys(qBy).length > 0;

  const teams = {};
  for (const race of results) for (const res of race.Results || []) {
    const cid = res.Constructor.constructorId;
    const t = teams[cid] ||= { c: res.Constructor, drv: {} };
    const d = t.drv[res.Driver.driverId] ||= { d: res.Driver, res: {}, pts: 0 };
    d.pts += +res.points || 0;
    if (startedStatus(res.status)) d.res[race.round] = res;
  }
  for (const race of sprints) for (const res of race.SprintResults || []) {
    const d = teams[res.Constructor.constructorId]?.drv[res.Driver.driverId];
    if (d) d.pts += +res.points || 0;
  }

  // Reihenfolge nach Konstrukteurswertung, Rest (z. B. vor 1958) nach Punkten
  const order = cs.map(c => c.Constructor.constructorId).filter(id => teams[id]);
  const rest = Object.keys(teams).filter(id => !order.includes(id))
    .sort((a, b) => Object.values(teams[b].drv).reduce((x, d) => x + d.pts, 0) - Object.values(teams[a].drv).reduce((x, d) => x + d.pts, 0));

  const cards = [...order, ...rest].map(cid => {
    const t = teams[cid], ids = Object.keys(t.drv);
    let pair = null, shared = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const A = t.drv[ids[i]], B = t.drv[ids[j]];
      const sh = Object.keys(A.res).filter(rd => B.res[rd]);
      if (sh.length > shared.length || (pair && sh.length === shared.length && A.pts + B.pts > pair[0].pts + pair[1].pts)) { pair = [A, B]; shared = sh; }
    }
    if (!pair || !shared.length) return '';
    // Fahrer mit mehr Punkten links
    if (pair[1].pts > pair[0].pts) pair.reverse();
    const [A, B] = pair, key = x => `${x.d.driverId}|${cid}`;
    const q = [0, 0], r = [0, 0], dnf = [0, 0], qs = [[], []], fs = [[], []];
    for (const rd of shared) {
      const a = A.res[rd], b = B.res[rd];
      const qa = qBy[rd]?.[key(A)], qb = qBy[rd]?.[key(B)];
      if (qa) qs[0].push(qa);
      if (qb) qs[1].push(qb);
      if (qa && qb) q[qa < qb ? 0 : 1]++;
      const ca = /^\d+$/.test(a.positionText), cb = /^\d+$/.test(b.positionText);
      if (ca || cb) r[+a.position < +b.position ? 0 : 1]++;
      if (ca) fs[0].push(+a.position);
      if (cb) fs[1].push(+b.position);
      if (!finishedStatus(a.status)) dnf[0]++;
      if (!finishedStatus(b.status)) dnf[1]++;
    }
    const avg = arr => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);
    const metrics = [
      ...(hasQ ? [['Qualifying', q[0], q[1], true]] : []),
      ['Rennen', r[0], r[1], true],
      ['Punkte', A.pts, B.pts, true],
      ...(hasQ ? [['Ø Qualifying', avg(qs[0]), avg(qs[1]), false]] : []),
      ['Ø Zielankunft', avg(fs[0]), avg(fs[1]), false],
      ['Ausfälle', dnf[0], dnf[1], false],
    ];
    const col = teamColor(cid, t.c.name);
    const rows = metrics.map(([label, a, b, hi]) => {
      const ok = a != null && b != null && a + b > 0;
      const share = ok ? (hi ? a : b) / (a + b) : 0.5;
      const aWin = ok && (hi ? a > b : a < b), bWin = ok && (hi ? b > a : b < a);
      return `<div class="duel-row"><b class="${aWin ? '' : 'muted'}">${num1(a)}</b><span>${label}</span><b class="${bWin ? '' : 'muted'}">${num1(b)}</b></div>${splitBar(share, col)}`;
    }).join('');
    const others = ids.filter(id => t.drv[id] !== A && t.drv[id] !== B && Object.keys(t.drv[id].res).length)
      .map(id => `<span class="click-txt" onclick="showDriver('${esc(id)}')">${esc(t.drv[id].d.familyName)}</span> (${Object.keys(t.drv[id].res).length})`);
    const name = (x, right) => `<div class="duel-drv${right ? ' r' : ''}" onclick="showDriver('${esc(x.d.driverId)}')">${natFlag(x.d.nationality)} ${driverName(x.d)}</div>`;
    return `<div class="card duel" style="border-top:4px solid ${col}">
      <div class="duel-team"><h2>${esc(t.c.name)}</h2><span class="small muted">${shared.length} gemeinsame Rennen</span></div>
      <div class="duel-names">${name(A)}<span class="muted small">vs</span>${name(B, true)}</div>
      ${rows}
      ${others.length ? `<p class="small muted" style="margin:10px 0 0">Außerdem gestartet: ${others.join(', ')}</p>` : ''}</div>`;
  }).join('');
  return `${head}<p class="sub">Direkter Vergleich der Teamkollegen – nur Rennen, in denen beide für das Team gestartet sind${hasQ ? '' : ' · Qualifying-Daten erst ab 1994'}. Punkte zählen für das jeweilige Team inkl. Sprint.</p>
    ${cards ? `<div class="grid g2">${cards}</div>` : '<p class="muted">Keine Teamkollegen-Paarungen gefunden.</p>'}`;
};

// ---------------------------------------------------------------- Fahrervergleich
// Fahrer einer Saison, sortiert nach WM-Stand, mit Team (für Farbe)
async function seasonDrivers(y) {
  const ttl = ttlFor(y);
  const [md, ds] = await Promise.all([
    erg(`/${y}/drivers.json?limit=100`, ttl),
    erg(`/${y}/driverstandings.json?limit=100`, ttl).then(m => m.StandingsTable.StandingsLists[0]?.DriverStandings || []).catch(() => []),
  ]);
  let list = md.DriverTable.Drivers;
  if (+md.total > 100) list = list.concat((await erg(`/${y}/drivers.json?limit=100&offset=100`, ttl)).DriverTable.Drivers);
  const out = ds.map(x => ({ id: x.Driver.driverId, d: x.Driver, team: x.Constructors.at(-1) }));
  const seen = new Set(out.map(x => x.id));
  list.filter(d => !seen.has(d.driverId)).sort((a, b) => a.familyName.localeCompare(b.familyName))
    .forEach(d => out.push({ id: d.driverId, d, team: null }));
  return out;
}
const cmpOpts = (list, sel) => list.map(x => `<option value="${esc(x.id)}" data-col="${esc(x.team ? teamColor(x.team.constructorId, x.team.name) : '#888888')}" data-team="${esc(x.team?.name || '')}" ${x.id === sel ? 'selected' : ''}>${esc(x.d.familyName)}, ${esc(x.d.givenName)}${x.team ? ` (${esc(x.team.name)})` : ''}</option>`).join('');

views.compare = async (idA, idB) => {
  const s = state.season;
  const cur = await seasonDrivers(s);
  idA = idA || cur[0]?.id;
  idB = idB || cur.find(x => x.id !== idA)?.id;
  if (!idA || !idB) return `<h1>Fahrervergleich</h1><p class="muted">Für ${esc(s)} sind noch keine Fahrer eingetragen. Wähle oben eine andere Saison.</p>`;
  // Saison je Seite: gewählte Saison, falls der Fahrer dort gefahren ist, sonst seine letzte
  const sideSeason = async id => cur.some(x => x.id === id) ? s
    : (await erg(`/drivers/${id}/seasons.json?limit=100`, DAY).catch(() => null))?.SeasonTable.Seasons.at(-1)?.season || s;
  const ys = await Promise.all([sideSeason(idA), sideSeason(idB)]);
  const lists = await Promise.all(ys.map(y => (y === s ? cur : seasonDrivers(y).catch(() => []))));
  const years = [];
  for (let y = NOW_YEAR; y >= 1950; y--) years.push(y);
  const side = i => {
    const id = [idA, idB][i];
    const list = lists[i].some(x => x.id === id) ? lists[i] : [{ id, d: { familyName: id, givenName: '?' }, team: null }, ...lists[i]];
    return `<div class="cmp-pick"><select class="cmp-y" title="Saison">${years.map(y => `<option ${String(y) === ys[i] ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <select class="cmp-d" title="Fahrer">${cmpOpts(list, id)}</select></div>`;
  };
  return `<h1>Fahrervergleich</h1><p class="sub">Zwei Fahrer, auch aus verschiedenen Epochen – Saison links wählen, dann den Fahrer</p>
    <div class="toolbar cmp-bar">${side(0)}<span class="muted">vs</span>${side(1)}</div>
    <div id="cmp-body">${loading('Lade Karriere-Statistiken …')}</div>`;
};
views.compare.after = async view => {
  const ysel = $$('.cmp-y', view), dsel = $$('.cmp-d', view);
  if (dsel.length < 2) return;
  const token = render.token;
  const go = () => { if (dsel[0].value && dsel[1].value) location.hash = `#/compare/${dsel[0].value}/${dsel[1].value}`; };
  dsel.forEach(d => (d.onchange = go));
  ysel.forEach((y, i) => (y.onchange = async () => {
    dsel[i].disabled = true;
    try {
      const list = await seasonDrivers(y.value);
      if (stale(token)) return;
      dsel[i].innerHTML = `<option value="">– Fahrer wählen –</option>${cmpOpts(list)}`;
    } catch (e) { if (!stale(token)) dsel[i].innerHTML = '<option value="">Laden fehlgeschlagen</option>'; }
    dsel[i].disabled = false;
  }));

  const body = $('#cmp-body');
  const ids = dsel.map(d => d.value);
  const opt = dsel.map(d => d.selectedOptions[0]?.dataset || {});
  const cols = opt.map(o => o.col || '#888888');
  const same = cols[0] === cols[1];
  try {
    const [infos, stats] = await Promise.all([
      Promise.all(ids.map(id => erg(`/drivers/${id}.json`, DAY).then(md => md.DriverTable.Drivers[0]))),
      Promise.all(ids.map(id => careerStats('drivers', id))),
    ]);
    if (stale(token)) return;
    if (!infos[0] || !infos[1]) { body.innerHTML = '<div class="error">Fahrer nicht gefunden.</div>'; return; }
    const pct = (a, b) => (a != null && b ? (a / b) * 100 : null);
    const rows = [
      ['Titel', 'titles'], ['Siege', 'wins'], ['Podien', 'podiums'], ['Poles', 'poles'], ['Starts', 'starts'], ['Saisons', 'seasons'],
    ].map(([l, k]) => [l, stats[0][k], stats[1][k], v => v ?? '–'])
      .concat([
        ['Siegquote', pct(stats[0].wins, stats[0].starts), pct(stats[1].wins, stats[1].starts), v => (v == null ? '–' : v.toFixed(1) + ' %')],
        ['Podiumsquote', pct(stats[0].podiums, stats[0].starts), pct(stats[1].podiums, stats[1].starts), v => (v == null ? '–' : v.toFixed(1) + ' %')],
      ]);
    const bar = (v, max, col, dim) => `<div class="mtrack"><i style="width:${max && v ? (v / max) * 100 : 0}%;background:${col}${dim ? ';opacity:.55' : ''}"></i></div>`;
    const mirror = rows.map(([l, a, b, f]) => {
      const max = Math.max(a || 0, b || 0);
      return `<div class="mrow"><div class="ml"><b class="${a != null && a >= (b ?? -1) && max ? '' : 'muted'}">${f(a)}</b>${bar(a, max, cols[0])}</div>
        <span>${l}</span><div class="mr">${bar(b, max, cols[1], same)}<b class="${b != null && b >= (a ?? -1) && max ? '' : 'muted'}">${f(b)}</b></div></div>`;
    }).join('');
    const head = i => {
      const d = infos[i], t = titleYears('drivers', d.driverId);
      return `<div class="card person cmp-head${i ? ' r' : ''}" style="border-top-color:${cols[i]}">${avatar(d, cols[i])}<div style="min-width:0">
        <div class="small muted">${natFlag(d.nationality)} ${esc(d.nationality)}${d.permanentNumber ? ` · #${esc(d.permanentNumber)}` : ''}</div>
        <div class="click-txt" style="font-size:18px" onclick="showDriver('${esc(d.driverId)}')">${driverName(d)}</div>
        <div class="small muted">${esc(opt[i].team || '')} ${esc(ysel[i].value)}</div>
        ${t.length ? `<div class="small">🏆 ${t.join(', ')}</div>` : ''}</div></div>`;
    };
    const both = ysel.every(y => y.value === state.season);
    body.innerHTML = `<div class="grid g2">${head(0)}${head(1)}</div>
      <div class="card section"><h2>Karriere</h2><div class="mirror">${mirror}</div>
        <p class="small muted" style="margin:10px 0 0">Quoten bezogen auf Starts. Laufende Saison ist bei den Titeln nicht enthalten. Poles erst ab 1994 vollständig (vorher fehlen Qualifying-Daten).</p></div>
      ${both ? `<div class="card section"><h2>Punkteverlauf ${esc(state.season)}</h2><div id="cmp-chart">${loading('Berechne Punkteverlauf …')}</div></div>` : ''}`;
    if (!both) return;
    const p = await pointsProgression(state.season);
    if (stale(token)) return;
    const box = $('#cmp-chart');
    if (!box) return;
    const series = ids.map((id, i) => p.drv[id] && {
      name: `${infos[i].givenName} ${infos[i].familyName}`, label: infos[i].code || infos[i].familyName,
      color: cols[i], dash: i === 1 && same, points: p.drv[id].cum.map((v, j) => [j, v]),
    }).filter(Boolean);
    if (series.length < 2) { box.innerHTML = '<p class="muted">Noch keine Rennergebnisse für beide Fahrer in dieser Saison.</p>'; return; }
    const yMax = Math.max(10, ...series.map(x => x.points.at(-1)?.[1] || 0));
    box.innerHTML = lineChart({ series, xLabels: p.races.map(r => 'R' + r.round), yMin: 0, yMax: Math.ceil(yMax / 25) * 25, height: 300, xEvery: p.races.length > 14 ? 2 : 1 })
      + `<div class="legend">${series.map(x => `<span><i style="background:${x.color}"></i>${esc(x.name)}${x.dash ? ' (gestrichelt)' : ''}</span>`).join('')}</div>`;
  } catch (e) { if (!stale(token)) body.innerHTML = errorBox(e); }
};

// ---------------------------------------------------------------- Telemetrie (OpenF1)
// OpenF1-Zeitstempel haben Mikrosekunden, Date.parse verträgt nur Millisekunden sicher
const ts = s => Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
// Lineare Interpolation in einem nach xk sortierten Array von Objekten
function interp(arr, xk, yk, x) {
  if (!arr.length) return NaN;
  if (x <= arr[0][xk]) return arr[0][yk];
  if (x >= arr.at(-1)[xk]) return arr.at(-1)[yk];
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m][xk] <= x) lo = m; else hi = m; }
  const a = arr[lo], b = arr[hi], f = (x - a[xk]) / (b[xk] - a[xk] || 1);
  return a[yk] + f * (b[yk] - a[yk]);
}
// Car-Data einer Runde: Zeit ab Rundenstart (s) und Distanz (m, über die Geschwindigkeit integriert)
function telLap(car, startMs, dur) {
  const rows = (car || []).filter(c => c.speed != null && c.date).map(c => ({
    t: (ts(c.date) - startMs) / 1000, v: +c.speed, thr: +c.throttle || 0, brk: +c.brake || 0, gear: +c.n_gear || 0,
  })).filter(c => isFinite(c.t)).sort((a, b) => a.t - b.t);
  let d = 0;
  rows.forEach((r, i) => { if (i) d += ((r.v + rows[i - 1].v) / 2 / 3.6) * (r.t - rows[i - 1].t); r.d = d; });
  if (rows.length < 2) return null;
  const d0 = interp(rows, 't', 'd', 0), len = interp(rows, 't', 'd', dur) - d0;
  rows.forEach(r => (r.d -= d0));
  // Bremse kommt je nach Saison als 0/1 oder 0/100
  if (Math.max(...rows.map(r => r.brk)) <= 1) rows.forEach(r => (r.brk *= 100));
  return { rows, len, dur };
}

// Kompaktes Liniendiagramm mit Distanz-x-Achse; gleiche Ränder, damit gestapelte Diagramme fluchten
function distChart(series, { xMax, yMin, yMax, height = 200, yLabel = '', yTicks = 4, yFmt = v => Math.round(v), zero = false, marks = [] }) {
  const W = 1000, H = height, L = 50, R = 12, T = 18, B = 22;
  const X = d => L + (d / (xMax || 1)) * (W - L - R);
  const Y = v => H - B - ((v - yMin) / (yMax - yMin || 1)) * (H - T - B);
  let g = '';
  for (let k = 0; k <= yTicks; k++) {
    const v = yMin + (k / yTicks) * (yMax - yMin);
    g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${yFmt(v)}</text>`;
  }
  const step = xMax > 4000 ? 1000 : 500;
  for (let d = 0; d <= xMax; d += step) g += `<line class="grid-line" x1="${X(d)}" x2="${X(d)}" y1="${T}" y2="${H - B}" opacity=".45"/><text x="${X(d)}" y="${H - 6}" text-anchor="middle">${(d / 1000).toFixed(step < 1000 ? 1 : 0)} km</text>`;
  for (const m of marks) g += `<line x1="${X(m)}" x2="${X(m)}" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 4" opacity=".6"/>`;
  if (zero && yMin < 0 && yMax > 0) g += `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--muted)"/>`;
  if (yLabel) g += `<text x="${L}" y="${T - 6}" style="font-weight:700">${esc(yLabel)}</text>`;
  const lines = series.map(s => {
    const pts = s.points.filter(p => isFinite(p[0]) && isFinite(p[1]));
    if (pts.length < 2) return '';
    const d = pts.map(([x, y], j) => `${j ? 'L' : 'M'}${X(x).toFixed(1)},${Y(Math.max(yMin, Math.min(yMax, y))).toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.8" ${s.dash ? 'stroke-dasharray="6 4"' : ''} stroke-linejoin="round"><title>${esc(s.name)}</title></path>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}${lines}</svg>`;
}

// Streckenkarte aus den Positionsdaten von Fahrer A, Mini-Sektoren nach schnellerem Fahrer eingefärbt
function trackMap(pts, segOf, segCol) {
  const xs = pts.map(p => p.x), ys = pts.map(p => -p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1), pad = span * 0.06;
  const P = p => `${p.x},${-p.y}`;
  let segs = '', cur = [], seg = -1;
  const flush = () => { if (cur.length > 1) segs += `<polyline points="${cur.map(P).join(' ')}" fill="none" stroke="${segCol[seg]}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"><title>Mini-Sektor ${seg + 1}</title></polyline>`; };
  pts.forEach(p => {
    const k = segOf(p);
    if (k !== seg) { const last = cur.at(-1); flush(); cur = last ? [last] : []; seg = k; }
    cur.push(p);
  });
  flush();
  // Beschriftung zur Streckenmitte hin, damit sie nicht aus dem Bild ragt
  const s0 = pts[0], fs = span / 34, right = s0.x > (minX + maxX) / 2, below = -s0.y < (minY + maxY) / 2;
  const lx = s0.x + (right ? -1 : 1) * span / 45, ly = -s0.y + (below ? 1 : -1) * span / 45 + (below ? fs * 0.8 : 0);
  return `<svg class="trackmap" viewBox="${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" preserveAspectRatio="xMidYMid meet">
    <polyline points="${pts.map(P).join(' ')}" fill="none" stroke="var(--line)" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    ${segs}
    <circle cx="${s0.x}" cy="${-s0.y}" r="${span / 70}" fill="#fff" stroke="#000" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <text x="${lx}" y="${ly}" text-anchor="${right ? 'end' : 'start'}" style="font-size:${fs}px;fill:var(--text);font-weight:700">Start/Ziel</text></svg>`;
}

views.telemetry = async sessionKey => {
  const s = state.season;
  if (+s < 2023) return `<h1>Telemetrie</h1><div class="note">Telemetrie- und Positionsdaten liefert OpenF1 erst ab der Saison 2023. Wähle oben eine neuere Saison.</div>`;
  let sessions;
  try { sessions = await of1(`/sessions?year=${s}`, +s < NOW_YEAR ? 30 * DAY : 30 * MIN); }
  catch (e) { return `<h1>Telemetrie ${esc(s)}</h1>${errorBox(e)}`; }
  const now = Date.now();
  sessions = sessions.filter(x => new Date(x.date_end || x.date_start) < now).sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
  if (!sessions.length) return `<h1>Telemetrie ${esc(s)}</h1><p class="muted">Noch keine abgeschlossenen Sessions.</p>`;
  const key = sessionKey && sessions.some(x => String(x.session_key) === sessionKey) ? sessionKey
    : String((sessions.find(x => x.session_type === 'Race' || x.session_type === 'Qualifying') || sessions[0]).session_key);
  const cur = sessions.find(x => String(x.session_key) === key);
  const opts = sessions.map(x => `<option value="${esc(x.session_key)}" ${String(x.session_key) === key ? 'selected' : ''}>${esc(x.country_name)} · ${esc(x.session_name)} · ${fmtD.format(new Date(x.date_start))}</option>`).join('');
  return `<h1>Telemetrie: ${esc(cur.country_name)} – ${esc(cur.session_name)}</h1>
    <p class="sub">${esc(cur.circuit_short_name)} · schnellste Runde zweier Fahrer im Vergleich · Daten von OpenF1</p>
    <div class="toolbar"><select id="tel-sess">${opts}</select><select id="tel-a" disabled></select><span class="muted">vs</span><select id="tel-b" disabled></select></div>
    <div id="tel-body">${loading('Lade Fahrer …')}</div>`;
};
views.telemetry.after = async (view, sessionKey, drvA, drvB) => {
  const sel = $('#tel-sess');
  if (!sel) return;
  const key = sel.value, token = render.token, body = $('#tel-body'), ttl = 7 * DAY;
  sel.onchange = () => (location.hash = `#/telemetry/${sel.value}`);
  try {
    const [drivers, result] = await Promise.all([
      of1(`/drivers?session_key=${key}`, ttl),
      of1(`/session_result?session_key=${key}`, ttl).catch(() => []),
    ]);
    if (stale(token)) return;
    rememberPeople(drivers);
    const byNum = Object.fromEntries(drivers.map(d => [d.driver_number, d]));
    const order = [...result].sort((a, b) => (a.position ?? 99) - (b.position ?? 99)).map(r => r.driver_number).filter(n => byNum[n]);
    drivers.forEach(d => { if (!order.includes(d.driver_number)) order.push(d.driver_number); });
    let nA = byNum[+drvA] ? +drvA : order[0];
    let nB = byNum[+drvB] && +drvB !== nA ? +drvB : order.find(n => n !== nA);
    const sa = $('#tel-a'), sb = $('#tel-b');
    const fill = (s, v) => { s.innerHTML = order.map(n => `<option value="${n}" ${n === v ? 'selected' : ''}>${esc(byNum[n].name_acronym || n)} · ${esc(byNum[n].full_name || '')}</option>`).join(''); s.disabled = false; };
    fill(sa, nA); fill(sb, nB);
    sa.onchange = sb.onchange = () => (location.hash = `#/telemetry/${key}/${sa.value}/${sb.value}`);
    if (nA == null || nB == null) { body.innerHTML = '<p class="muted">Zu wenige Fahrer in dieser Session.</p>'; return; }
    const nums = [nA, nB], dn = n => esc(byNum[n]?.name_acronym || n);
    let cols = nums.map(n => (byNum[n]?.team_colour ? '#' + byNum[n].team_colour : '#888888'));
    if (cols[0].toLowerCase() === cols[1].toLowerCase()) cols = [cols[0], lighten(cols[1], 0.55)];

    body.innerHTML = loading('Lade schnellste Runden …');
    const laps = await Promise.all(nums.map(n => of1(`/laps?session_key=${key}&driver_number=${n}`, ttl)));
    if (stale(token)) return;
    const best = laps.map(l => (l || []).filter(x => x.lap_duration && !x.is_pit_out_lap && x.date_start).sort((x, y) => x.lap_duration - y.lap_duration)[0]);
    const miss = nums.filter((n, i) => !best[i]);
    if (miss.length) { body.innerHTML = `<div class="note">Keine gezeitete Runde für ${miss.map(dn).join(' und ')} in dieser Session.</div>`; return; }

    body.innerHTML = loading('Lade Telemetrie …');
    // Fenster = Runde ± 1 s, damit Start und Ende sauber interpoliert werden können
    const win = l => { const st = ts(l.date_start); return [new Date(st - 1000).toISOString(), new Date(st + l.lap_duration * 1000 + 1000).toISOString()]; };
    const q = (ep, n, l) => { const [f, t] = win(l); return of1(`/${ep}?session_key=${key}&driver_number=${n}&date>=${encodeURIComponent(f)}&date<${encodeURIComponent(t)}`, ttl); };
    const [carA, carB, locA] = await Promise.all([q('car_data', nA, best[0]), q('car_data', nB, best[1]), q('location', nA, best[0]).catch(() => [])]);
    if (stale(token)) return;
    const T = [telLap(carA, ts(best[0].date_start), best[0].lap_duration), telLap(carB, ts(best[1].date_start), best[1].lap_duration)];
    if (!T[0] || !T[1] || T[0].rows.length < 20 || T[1].rows.length < 20) {
      body.innerHTML = `<div class="note">OpenF1 liefert für diese Runden keine (vollständige) Telemetrie. Andere Session oder andere Fahrer wählen.</div>`;
      return;
    }
    body.innerHTML = telemetryHtml({ T, best, nums, cols, dn, loc: locA || [] });
  } catch (e) { if (!stale(token)) body.innerHTML = errorBox(e); }
};

function telemetryHtml({ T, best, nums, cols, dn, loc }) {
  // Beide Runden auf eine gemeinsame Länge normieren (Integrationsfehler ~1 %)
  const Lc = (T[0].len + T[1].len) / 2;
  T.forEach(x => { const k = Lc / (x.len || Lc); x.rows.forEach(r => (r.d *= k)); });
  const tAt = (x, d) => interp(x.rows, 'd', 't', d);
  const inLap = x => x.rows.filter(r => r.t >= 0 && r.t <= x.dur);
  const NS = 25, segLen = Lc / NS;
  const segT = T.map(x => Array.from({ length: NS }, (_, k) => tAt(x, (k + 1) * segLen) - tAt(x, k * segLen)));
  const segWin = segT[0].map((a, k) => (a <= segT[1][k] ? 0 : 1));
  const wins = [segWin.filter(w => w === 0).length, segWin.filter(w => w === 1).length];
  const lineSeries = f => T.map((x, i) => ({ name: dn(nums[i]), color: cols[i], points: inLap(x).map(r => [r.d, f(r)]) }));
  const legend = `<div class="legend">${nums.map((n, i) => `<span><i style="background:${cols[i]}"></i>${dn(n)} · Runde ${best[i].lap_number}</span>`).join('')}</div>`;

  // Streckenkarte
  const pts = loc.filter(p => p.date && (p.x || p.y)).map(p => ({ t: (ts(p.date) - ts(best[0].date_start)) / 1000, x: +p.x, y: +p.y }))
    .filter(p => p.t >= 0 && p.t <= T[0].dur).sort((a, b) => a.t - b.t);
  const segOf = p => Math.max(0, Math.min(NS - 1, Math.floor(interp(T[0].rows, 't', 'd', p.t) / segLen)));
  const map = pts.length > 20
    ? trackMap(pts, segOf, segWin.map(w => cols[w]))
    : '<p class="muted">Keine Positionsdaten für die Streckenkarte.</p>';

  // Zeitdifferenz über die Distanz
  const delta = Array.from({ length: 301 }, (_, i) => { const d = (i / 300) * Lc; return [d, tAt(T[0], d) - tAt(T[1], d)]; });
  const dMax = Math.max(0.1, ...delta.map(p => Math.abs(p[1])));
  const dLim = Math.ceil(dMax * 10) / 10;
  const vMax = Math.max(...T.flatMap(x => inLap(x).map(r => r.v)));
  const vMin = Math.min(...T.flatMap(x => inLap(x).map(r => r.v)));
  const top = T.map(x => Math.max(...inLap(x).map(r => r.v)));
  const gap = best[0].lap_duration - best[1].lap_duration;
  const sec = v => (v == null ? '–' : v.toFixed(3));
  const marks = Array.from({ length: NS - 1 }, (_, k) => (k + 1) * segLen);

  const summary = `<div class="stats">
      <div class="stat"><b style="color:${cols[0]}">${fmtLap(best[0].lap_duration)}</b><span>${dn(nums[0])} · Runde ${best[0].lap_number}</span></div>
      <div class="stat"><b style="color:${cols[1]}">${fmtLap(best[1].lap_duration)}</b><span>${dn(nums[1])} · Runde ${best[1].lap_number}</span></div>
      <div class="stat"><b>${gap > 0 ? '+' : gap < 0 ? '−' : '±'}${Math.abs(gap).toFixed(3)} s</b><span>Abstand ${dn(nums[0])} zu ${dn(nums[1])}</span></div>
      <div class="stat"><b>${Math.round(top[0])} / ${Math.round(top[1])}</b><span>Top-Speed km/h</span></div>
      <div class="stat"><b>${wins[0]} : ${wins[1]}</b><span>Mini-Sektoren</span></div></div>
    <div class="table-wrap"><table><thead><tr><th>Fahrer</th><th class="num">Runde</th><th class="num">Zeit</th><th class="num">S1</th><th class="num">S2</th><th class="num">S3</th><th class="num">Speedtrap</th><th class="num">Top-Speed</th></tr></thead><tbody>
      ${best.map((l, i) => `<tr><td><span class="teambar" style="background:${cols[i]}"></span>${dn(nums[i])}</td><td class="num">${l.lap_number ?? ''}</td><td class="num"><b>${fmtLap(l.lap_duration)}</b></td>
        <td class="num">${sec(l.duration_sector_1)}</td><td class="num">${sec(l.duration_sector_2)}</td><td class="num">${sec(l.duration_sector_3)}</td>
        <td class="num">${l.st_speed ?? '–'}</td><td class="num">${Math.round(top[i])}</td></tr>`).join('')}</tbody></table></div>`;

  return `<div class="grid g2 tel-grid">
      <div class="card"><h2>Zusammenfassung</h2>${summary}</div>
      <div class="card"><h2>Streckenkarte · Mini-Sektoren</h2>${map}
        <div class="legend">${nums.map((n, i) => `<span><i style="background:${cols[i]};height:6px"></i>${dn(n)} schneller</span>`).join('')}</div>
        <p class="small muted" style="margin:6px 0 0">Runde in ${NS} gleich lange Abschnitte geteilt; Farbe = wer dort weniger Zeit gebraucht hat.</p></div></div>
    <div class="card section"><h2>Telemetrie über die Runde</h2>${legend}
      ${distChart(lineSeries(r => r.v), { xMax: Lc, yMin: Math.max(0, Math.floor(vMin / 50) * 50), yMax: Math.ceil(vMax / 50) * 50, yTicks: Math.max(1, Math.ceil(vMax / 50) - Math.floor(vMin / 50)), height: 280, yLabel: 'Geschwindigkeit km/h' })}
      ${distChart([{ name: `${dn(nums[0])} − ${dn(nums[1])}`, color: cols[0], points: delta }], { xMax: Lc, yMin: -dLim, yMax: dLim, height: 170, yTicks: 2, yFmt: v => (v > 0 ? '+' : '') + v.toFixed(2), zero: true, marks, yLabel: `Zeitdifferenz s (+ = ${dn(nums[0])} langsamer)` })}
      ${distChart(lineSeries(r => r.thr), { xMax: Lc, yMin: 0, yMax: 100, height: 140, yTicks: 2, yLabel: 'Gas %' })}
      ${distChart(lineSeries(r => r.brk), { xMax: Lc, yMin: 0, yMax: 100, height: 100, yTicks: 1, yLabel: 'Bremse' })}
      ${distChart(lineSeries(r => r.gear), { xMax: Lc, yMin: 0, yMax: 8, height: 140, yTicks: 4, yLabel: 'Gang' })}
      <p class="small muted">Distanz aus der Geschwindigkeit integriert und auf eine gemeinsame Rundenlänge (${(Lc / 1000).toFixed(2)} km) normiert – Abweichungen von ~1 % sind normal. Abtastrate ca. 3,7 Hz.</p></div>`;
}
