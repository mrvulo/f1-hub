// Discord-Erinnerungen per Webhook: 30 Minuten vor Qualifying, Sprint und Rennen, nach dem Rennen das Podium
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const API = 'https://api.jolpi.ca/ergast/f1';
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const LEAD_MIN = Number(process.env.REMINDER_MINUTES || 30);
const HUB_URL = process.env.HUB_URL || '';
const STATE_FILE = '/app/data/reminders.json';
const SESSIONS = {
  SprintQualifying: { name: 'Sprint Qualifying', emoji: '⏱️' },
  SprintShootout: { name: 'Sprint Shootout', emoji: '⏱️' },
  Sprint: { name: 'Sprint', emoji: '⚡' },
  Qualifying: { name: 'Qualifying', emoji: '⏱️' },
  Race: { name: 'Race', emoji: '🏁' },
};
const log = (...a) => console.log(new Date().toISOString(), '[reminders]', ...a);

let sent = {};
try { sent = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
const save = () => { try { mkdirSync('/app/data', { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(sent, null, 1)); } catch (e) { log('cannot save state', e.message); } };

let schedule = { at: 0, races: [] };
async function getSchedule() {
  if (Date.now() - schedule.at < 3600e3 && schedule.races.length) return schedule.races;
  const r = await fetch(`${API}/current.json?limit=100`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`schedule HTTP ${r.status}`);
  schedule = { at: Date.now(), races: (await r.json()).MRData.RaceTable.Races };
  return schedule.races;
}

const when = (d, t) => new Date(`${d}T${t || '00:00:00Z'}`);
const unix = d => Math.floor(+d / 1000);

export async function postWebhook(payload) {
  if (!WEBHOOK) throw new Error('DISCORD_WEBHOOK_URL is not set');
  const r = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'F1 Hub', ...payload }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`webhook HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

function sessionEmbed(race, key, start) {
  const s = SESSIONS[key];
  const loc = race.Circuit.Location;
  return {
    embeds: [{
      title: `${s.emoji} ${s.name} starts in ${LEAD_MIN} minutes`,
      description: `**${race.raceName}** · Round ${race.round}\n${race.Circuit.circuitName}, ${loc.locality}, ${loc.country}`,
      color: 0xe10600,
      fields: [{ name: 'Start', value: `<t:${unix(start)}:F> (<t:${unix(start)}:R>)` }],
      ...(HUB_URL ? { url: `${HUB_URL}/#/live` } : {}),
      footer: { text: 'F1 Hub' },
    }],
  };
}

// Ergebnis zuerst aus Jolpica, sonst vorläufig aus OpenF1 (Jolpica ist oft Stunden später dran)
async function jolpicaPodium(race) {
  const r = await fetch(`${API}/${race.season}/${race.round}/results.json`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const res = (await r.json()).MRData.RaceTable.Races[0]?.Results;
  if (!res?.length) return null;
  const fl = res.find(x => x.FastestLap?.rank === '1');
  return {
    top: res.slice(0, 3).map(x => ({ name: `${x.Driver.givenName} ${x.Driver.familyName}`, team: x.Constructor.name, time: x.Time?.time || x.status })),
    fastest: fl ? `${fl.Driver.familyName} – ${fl.FastestLap.Time.time}` : null,
    dnf: res.filter(x => x.status !== 'Finished' && !/^\+\d+ Laps?$/.test(x.status) && x.status !== 'Lapped').length,
    provisional: false,
  };
}
async function openf1Podium(race) {
  const get = async p => { const r = await fetch(`https://api.openf1.org/v1${p}`, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`OpenF1 HTTP ${r.status}`); return r.json(); };
  const sessions = await get(`/sessions?year=${race.season}&session_type=Race`);
  const sess = sessions.find(x => x.session_name === 'Race' && x.date_start?.slice(0, 10) === race.date);
  if (!sess) return null;
  const [res, drivers] = await Promise.all([get(`/session_result?session_key=${sess.session_key}`), get(`/drivers?session_key=${sess.session_key}`)]);
  const top = res.filter(x => x.position >= 1 && x.position <= 3).sort((a, b) => a.position - b.position);
  if (top.length < 3) return null;
  const by = Object.fromEntries(drivers.map(d => [d.driver_number, d]));
  const fmt = sec => { const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60; return `${h}:${String(m).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')}`; };
  return {
    top: top.map(x => {
      const d = by[x.driver_number] || {};
      const gap = Array.isArray(x.gap_to_leader) ? x.gap_to_leader.at(-1) : x.gap_to_leader;
      return { name: `${d.first_name || ''} ${d.last_name || x.driver_number}`.trim(), team: d.team_name || '', time: x.position === 1 && x.duration ? fmt(x.duration) : typeof gap === 'number' ? `+${gap.toFixed(3)}` : '' };
    }),
    fastest: null,
    dnf: res.filter(x => x.dnf || x.dns || x.dsq).length,
    provisional: true,
  };
}
async function podiumEmbed(race) {
  let p = await jolpicaPodium(race).catch(() => null);
  if (!p) p = await openf1Podium(race).catch(e => { log('OpenF1 result failed:', e.message); return null; });
  if (!p) return null;
  const medal = ['🥇', '🥈', '🥉'];
  return {
    embeds: [{
      title: `🏆 ${race.raceName} – Result`,
      description: p.top.map((x, i) => `${medal[i]} **${x.name}** · ${x.team}${x.time ? ` · ${x.time}` : ''}`).join('\n'),
      color: 0xf5c542,
      fields: [
        ...(p.fastest ? [{ name: 'Fastest lap', value: p.fastest, inline: true }] : []),
        { name: 'Retirements', value: String(p.dnf), inline: true },
      ],
      ...(HUB_URL ? { url: `${HUB_URL}/#/results/${race.round}` } : {}),
      footer: { text: p.provisional ? 'F1 Hub · provisional result from official timing' : 'F1 Hub' },
    }],
  };
}

let lastResultCheck = 0;
async function tick() {
  const races = await getSchedule();
  const now = Date.now();
  for (const race of races) {
    const id = `${race.season}-${race.round}`;
    for (const key of Object.keys(SESSIONS)) {
      const s = key === 'Race' ? { date: race.date, time: race.time } : race[key];
      if (!s) continue;
      const start = when(s.date, s.time);
      const tag = `${id}-${key}`;
      // Nur im Fenster vor dem Start senden – nach einem Neustart keine verspäteten Erinnerungen
      if (!sent[tag] && now >= +start - LEAD_MIN * 60e3 && now < +start) {
        await postWebhook(sessionEmbed(race, key, start));
        sent[tag] = new Date().toISOString(); save();
        log('sent reminder', tag);
      }
    }
    // Ergebnis: ab 2 h nach dem Start alle 10 Minuten nachsehen, höchstens 3 Tage lang
    const start = when(race.date, race.time);
    const tag = `${id}-Result`;
    if (!sent[tag] && now > +start + 2 * 3600e3 && now < +start + 3 * 86400e3 && now - lastResultCheck > 10 * 60e3) {
      lastResultCheck = now;
      const embed = await podiumEmbed(race);
      if (embed) {
        await postWebhook(embed);
        sent[tag] = new Date().toISOString(); save();
        log('sent result', tag);
      }
    }
  }
}

export function startReminders() {
  if (!WEBHOOK) { log('DISCORD_WEBHOOK_URL not set - reminders disabled'); return; }
  log(`enabled, ${LEAD_MIN} min before Qualifying, Sprint and Race`);
  const run = () => tick().catch(e => log('error:', e.message));
  run();
  setInterval(run, 60e3);
}

export const remindersStatus = () => ({
  enabled: Boolean(WEBHOOK), leadMinutes: LEAD_MIN,
  sent: Object.entries(sent).slice(-10).map(([k, v]) => ({ key: k, at: v })),
});
