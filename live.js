'use strict';
// Live-Timing und News – beides kommt vom F1-Hub-Server auf dem N100

const SERVER = (() => {
  try { const o = localStorage.getItem('f1:server'); if (o) return o.replace(/\/$/, ''); } catch {}
  // Eine https-Seite (GitHub Pages) darf keinen http-Server im Heimnetz abfragen
  if (location.protocol === 'https:') return null;
  if (location.protocol.startsWith('http') && !['localhost', '127.0.0.1'].includes(location.hostname)) return location.origin;
  return 'http://192.168.178.72:8790';
})();

const noServerNote = what => `<div class="note">${what} läuft über deinen F1-Hub-Server auf dem N100 und funktioniert nur im Heimnetz.
  Öffne dafür <a href="http://192.168.178.72:8790/#/${state.route}">http://192.168.178.72:8790</a>.</div>`;
const serverDown = () => `<div class="error">Der F1-Hub-Server (${esc(SERVER)}) ist gerade nicht erreichbar. Ist der N100 an und bist du im Heimnetz?</div>`;

async function api(path) {
  const r = await fetch(SERVER + path, { cache: 'no-store' });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  return `vor ${Math.floor(s / 86400)} Tg.`;
}

// ---------------------------------------------------------------- Live-Status im Menü
let lastStatus = null;
async function statusLoop() {
  try { lastStatus = await api('/api/live/status'); } catch { lastStatus = null; }
  const on = Boolean(lastStatus?.active && lastStatus.connected);
  const nav = $('#nav-live');
  nav.classList.toggle('hidden', !on);
  nav.title = on ? `${lastStatus.meeting} – ${lastStatus.session}` : '';
  banner();
}
function banner() {
  $('#live-banner')?.remove();
  const s = lastStatus;
  if (!s?.active || !s.connected || state.route !== 'overview') return;
  $('#view').insertAdjacentHTML('afterbegin', `<a id="live-banner" class="live-banner" href="#/live">
    <span class="live-dot"></span><b>LIVE:</b> ${esc(s.meeting)} – ${esc(SESSION_DE[s.session] || s.session)} <span class="muted">· Live-Timing öffnen →</span></a>`);
}
// Banner nach jedem Aufbau der Übersicht wieder einsetzen
const overviewAfter = views.overview.after;
views.overview.after = (...a) => { overviewAfter?.(...a); banner(); };

// ---------------------------------------------------------------- Live-Timing
const TRACK = {
  1: ['Grün', '#3ddc84'], 2: ['Gelb', '#ffd12e'], 4: ['Safety Car', '#ffb300'], 5: ['Rote Flagge', '#ff3b3b'],
  6: ['Virtual Safety Car', '#ffb300'], 7: ['VSC endet', '#ffd12e'],
};
const SESSION_STATUS = { Inactive: 'Noch nicht gestartet', Started: 'Läuft', Aborted: 'Unterbrochen', Finished: 'Beendet', Finalised: 'Abgeschlossen', Ends: 'Beendet' };
const SESSION_DE = { Race: 'Rennen', Qualifying: 'Qualifying', 'Sprint Qualifying': 'Sprint-Qualifying', Sprint: 'Sprint', 'Practice 1': '1. Training', 'Practice 2': '2. Training', 'Practice 3': '3. Training' };
const TYRE_LETTER = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

const vals = x => (Array.isArray(x) ? x : x ? Object.values(x) : []);
const timeCls = o => (o?.OverallFastest ? 'purple' : o?.PersonalFastest ? 'green' : '');

let liveData = null;

views.live = async () => {
  if (!SERVER) return `<h1>Live-Timing</h1>${noServerNote('Das Live-Timing')}`;
  return `<div id="live-root">${loading('Verbinde mit dem Live-Timing …')}</div>`;
};
views.live.after = () => {
  if (!SERVER) return;
  let version = null;
  const token = render.token;
  const poll = async () => {
    try {
      const snap = await api(`/api/live${version != null ? `?v=${version}` : ''}`);
      if (stale(token)) return;
      if (snap) { version = snap.version; liveData = snap; drawLive(); }
    } catch {
      if (!stale(token)) $('#live-root').innerHTML = serverDown();
    }
  };
  poll();
  state.timers.push(setInterval(poll, 2000));
  state.timers.push(setInterval(tickClock, 1000));
};

function remaining() {
  const c = liveData?.data.ExtrapolatedClock;
  if (!c?.Remaining) return '';
  const [h, m, s] = c.Remaining.split(':').map(Number);
  let sec = h * 3600 + m * 60 + s;
  if (c.Extrapolating) sec -= (Date.now() - Date.parse(c.Utc)) / 1000;
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function tickClock() { const el = $('#live-clock'); if (el) el.textContent = remaining(); }

function drawLive() {
  const root = $('#live-root');
  if (!root || !liveData) return;
  const { data: d, active, connected, staticBase } = liveData;
  const info = d.SessionInfo || {};
  if (!info.Key) { root.innerHTML = `<h1>Live-Timing</h1><p class="muted">Noch keine Daten vom Live-Timing.</p>`; return; }
  const type = info.Type;
  const isRace = type === 'Race';
  const isQuali = type === 'Qualifying';
  const ts = TRACK[d.TrackStatus?.Status] || [d.TrackStatus?.Message || '–', 'var(--muted)'];
  const st = d.SessionStatus?.Status;
  const w = d.WeatherData || {};
  const drivers = d.DriverList || {};
  const timing = d.TimingData?.Lines || {};
  const app = d.TimingAppData?.Lines || {};
  const part = d.TimingData?.SessionPart;

  const rows = Object.entries(timing)
    .map(([num, t]) => ({ num, t, drv: drivers[num] || {}, app: app[num] || {} }))
    .sort((a, b) => (+a.t.Position || +a.t.Line || 99) - (+b.t.Position || +b.t.Line || 99))
    .map(({ num, t, drv, app: ta }) => {
      const col = '#' + (drv.TeamColour || '888888');
      const stints = vals(ta.Stints);
      const cur = stints.at(-1) || {};
      const tyre = cur.Compound ? `<span class="tyre t-${esc(cur.Compound)}" title="${esc(cur.Compound)}${cur.New === 'false' ? ' (gebraucht)' : ''}">${TYRE_LETTER[cur.Compound] || '?'}</span><span class="muted small">${cur.TotalLaps ?? ''}</span>` : '';
      const flags = t.Retired ? '<span class="badge">AUS</span>' : t.Stopped ? '<span class="badge">STOPP</span>' : t.InPit ? '<span class="badge sprint">BOX</span>' : t.PitOut ? '<span class="badge">OUT</span>' : t.KnockedOut ? '<span class="badge">RAUS</span>' : '';
      let gap, interval;
      if (isQuali) {
        const best = vals(t.BestLapTimes)[(part || 1) - 1]?.Value || t.BestLapTime?.Value || '';
        gap = esc(best);
        interval = esc(vals(t.Stats)[(part || 1) - 1]?.TimeDiffToFastest || t.TimeDiffToFastest || '');
      } else if (isRace) {
        gap = esc(t.GapToLeader || '');
        interval = esc(t.IntervalToPositionAhead?.Value || '');
      } else {
        gap = esc(t.BestLapTime?.Value || '');
        interval = esc(t.TimeDiffToFastest || '');
      }
      const sectors = vals(t.Sectors).map(s => `<td class="sec ${timeCls(s)}">${esc(s.Value || '')}</td>`).join('');
      return `<tr class="${t.Retired || t.KnockedOut ? 'out' : ''}">
        <td class="pos">${esc(t.Position || '')}</td>
        <td><span class="teambar" style="background:${col}"></span><b>${esc(drv.Tla || num)}</b> <span class="muted small hide-sm">${esc(drv.LastName || '')}</span> ${flags}</td>
        <td class="num">${gap}</td><td class="num">${interval}</td>
        <td class="num ${timeCls(t.LastLapTime)}">${esc(t.LastLapTime?.Value || '')}</td>
        ${sectors}
        <td class="nowrap">${tyre}</td>
        ${isRace ? `<td class="num">${t.NumberOfPitStops ?? ''}</td>` : `<td class="num">${t.NumberOfLaps ?? ''}</td>`}
      </tr>`;
    }).join('');

  const rcm = [...(d.RaceControlMessages || [])].reverse().map(m => {
    const fc = { GREEN: '#3ddc84', YELLOW: '#ffd12e', 'DOUBLE YELLOW': '#ffd12e', RED: '#ff3b3b', BLUE: '#2f8cff', CHEQUERED: '#fff', CLEAR: '#3ddc84' }[m.Flag] || 'var(--muted)';
    return `<div><span class="muted small">${m.Lap ? 'R' + m.Lap + ' · ' : ''}${new Date(m.Utc + (m.Utc.endsWith('Z') ? '' : 'Z')).toLocaleTimeString('de-DE')}</span><br>
      <span class="rc-flag" style="color:${fc}">${esc(m.Flag || m.Category || '')}</span> ${esc(m.Message)}</div>`;
  }).join('');

  const radio = staticBase ? [...(d.TeamRadio || [])].reverse().slice(0, 15).map(r => {
    const drv = drivers[r.RacingNumber] || {};
    return `<div class="radio"><span class="teambar" style="background:#${esc(drv.TeamColour || '888')}"></span><b>${esc(drv.Tla || r.RacingNumber)}</b>
      <span class="muted small">${new Date(r.Utc).toLocaleTimeString('de-DE')}</span>
      <audio controls preload="none" src="${esc(staticBase + r.Path)}"></audio></div>`;
  }).join('') : '';

  const lap = d.LapCount ? `Runde <b>${d.LapCount.CurrentLap}</b> / ${d.LapCount.TotalLaps}` : '';
  root.innerHTML = `
    <div class="live-head">
      <div>
        <div class="kicker">${active ? '<span class="live-dot"></span>Live' : 'Letzte Session'} · ${esc(info.Meeting?.Name || '')}</div>
        <h1>${esc(SESSION_DE[info.Name] || info.Name || '')}</h1>
        <div class="muted small">${esc(info.Meeting?.Circuit?.ShortName || '')} · ${esc(SESSION_STATUS[st] || st || '')}${connected ? '' : ' · <span style="color:#ff5a5a">Verbindung zum F1-Server getrennt</span>'}</div>
      </div>
      <div class="live-chips">
        <div class="chip" style="border-color:${ts[1]};color:${ts[1]}">⚑ ${esc(ts[0])}</div>
        ${lap ? `<div class="chip">${lap}</div>` : ''}
        ${d.ExtrapolatedClock ? `<div class="chip">⏱ <b id="live-clock">${remaining()}</b></div>` : ''}
        ${w.AirTemp ? `<div class="chip">🌡 ${esc(w.AirTemp)}° / Strecke ${esc(w.TrackTemp)}°</div>` : ''}
        ${w.Rainfall && w.Rainfall !== '0' ? '<div class="chip">🌧 Regen</div>' : ''}
      </div>
    </div>
    ${active ? '' : `<p class="note">Gerade läuft keine Session. Angezeigt wird der letzte Stand von ${esc(info.Meeting?.Name || '')} – ${esc(SESSION_DE[info.Name] || info.Name || '')}. Sobald die nächste Session startet, erscheint oben im Menü „● Live“.</p>`}
    <div class="grid live-grid">
      <div class="card table-wrap"><table class="tower"><thead><tr>
        <th>Pos</th><th>Fahrer</th>
        <th class="num">${isRace ? 'Abstand' : 'Beste'}</th><th class="num">${isRace ? 'Intervall' : 'Rückstand'}</th>
        <th class="num">Letzte</th><th>S1</th><th>S2</th><th>S3</th><th>Reifen</th><th class="num">${isRace ? 'Stopps' : 'Runden'}</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="small muted" style="margin:8px 0 0"><span class="purple">Lila</span> = schnellste Zeit aller Fahrer, <span class="green">Grün</span> = persönliche Bestzeit. Daten: offizielles F1-Live-Timing.</p></div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Rennleitung</h2><div class="rc-list">${rcm || '<span class="muted">Keine Meldungen.</span>'}</div></div>
        ${radio ? `<div class="card"><h2>Boxenfunk</h2><div class="radio-list">${radio}</div></div>` : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- News
let newsFilter = (() => { try { return localStorage.getItem('f1:newslang') || 'all'; } catch { return 'all'; } })();
views.news = async () => {
  if (!SERVER) return `<h1>News</h1>${noServerNote('Der News-Bereich')}`;
  let n;
  try { n = await api('/api/news'); } catch { return `<h1>News</h1>${serverDown()}`; }
  const items = n.items.filter(x => newsFilter === 'all' || x.lang === newsFilter);
  const cards = items.map(x => `<a class="card news-card click" href="${esc(x.link)}" target="_blank" rel="noopener">
      ${x.image ? `<div class="news-img" style="background-image:url('${esc(x.image).replace(/'/g, '%27')}')"></div>` : ''}
      <div class="small muted">${esc(x.source)} · ${ago(x.date)}</div>
      <h3>${esc(x.title)}</h3>
      ${x.summary ? `<p class="small muted">${esc(x.summary)}</p>` : ''}</a>`).join('');
  const btn = (k, l) => `<button data-lang="${k}" class="${newsFilter === k ? 'active' : ''}">${l}</button>`;
  return `<h1>News</h1><p class="sub">${n.sources.map(s => esc(s.name)).join(' · ')} · aktualisiert ${ago(n.updated)}</p>
    <div class="tabs">${btn('all', 'Alle')}${btn('de', 'Deutsch')}${btn('en', 'Englisch')}</div>
    <div class="grid g3">${cards || '<p class="muted">Keine Artikel.</p>'}</div>`;
};
views.news.after = view => {
  $$('.tabs button', view).forEach(b => (b.onclick = () => {
    newsFilter = b.dataset.lang;
    try { localStorage.setItem('f1:newslang', newsFilter); } catch {}
    render();
  }));
  state.timers.push(setInterval(() => render(), 10 * 60 * 1000));
};

document.addEventListener('DOMContentLoaded', () => {
  if (!SERVER) { $('#nav-news').classList.add('hidden'); return; }
  statusLoop();
  setInterval(statusLoop, 60 * 1000);
});
