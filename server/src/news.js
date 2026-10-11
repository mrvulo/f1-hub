// Sammelt F1-News aus freien RSS-Feeds (Browser können die wegen CORS nicht direkt lesen)
const FEEDS = [
  { name: 'Formula1.com', lang: 'en', url: 'https://www.formula1.com/en/latest/all.xml' },
  { name: 'Motorsport.com', lang: 'en', url: 'https://www.motorsport.com/rss/f1/news/' },
  { name: 'Autosport', lang: 'en', url: 'https://www.autosport.com/rss/f1/news/' },
  { name: 'RaceFans', lang: 'en', url: 'https://www.racefans.net/feed/' },
  { name: 'Motorsport.com DE', lang: 'de', url: 'https://de.motorsport.com/rss/f1/news/' },
  { name: 'Formel1.de', lang: 'de', url: 'https://www.formel1.de/rss/news/feed.xml' },
];
const REFRESH = 15 * 60 * 1000;
const log = (...a) => console.log(new Date().toISOString(), '[news]', ...a);

let items = [];
let lastFetch = 0;
let removed = 0;
const firstSeen = new Map();

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ENT[e.toLowerCase()] ?? m;
    });
}
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
};
const attr = (xml, name, a) => {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${a}=["']([^"']+)["']`, 'i'));
  return m ? decode(m[1]) : '';
};
const strip = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function parse(xml, feed) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.map((b, i) => {
    const link = tag(b, 'link') || attr(b, 'link', 'href');
    const rawDesc = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded');
    const image = attr(b, 'enclosure', 'url') || attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url')
      || (rawDesc.match(/<img[^>]+src=["']([^"']+)/i) || [])[1] || '';
    const dateStr = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    let date = Date.parse(dateStr);
    // Feeds ohne Datum (formula1.com): Zeitpunkt des ersten Auftauchens, Reihenfolge bleibt erhalten
    if (!date) {
      if (!firstSeen.has(link)) firstSeen.set(link, Date.now() - i * 60000);
      date = firstSeen.get(link);
    }
    let summary = strip(rawDesc).replace(/\s*(Weiterlesen|Read more|Keep reading)\s*$/i, '');
    if (summary.length > 260) summary = summary.slice(0, 257).replace(/\s\S*$/, '') + ' …';
    return { title: strip(tag(b, 'title')), link, summary, image, date, source: feed.name, lang: feed.lang };
  }).filter(x => x.title && x.link);
}

// Mehrere Quellen syndizieren denselben Text; Motorsport.com DE und Formel1.de
// liefern regelmaessig wortgleiche Artikel. Gleiche Links und gleiche Titel fliegen
// raus. Fast gleiche Titel nur dann, wenn sich die Wortmengen nicht in einem
// unterscheidenden Begriff trennen: "Samstag-Zeitplan" und "Sonntag-Zeitplan" sind
// zu 83 % wortgleich und trotzdem zwei verschiedene Artikel.
const DISCRIM = new Set(`monday tuesday wednesday thursday friday saturday sunday
  montag dienstag mittwoch donnerstag freitag samstag sonntag
  sprint qualifying quali race rennen grid startaufstellung results ergebnisse
  preview review vorschau rueckblick fp1 fp2 fp3 practice training
  1 2 3 one two three erste zweite dritte`.split(/\s+/).filter(Boolean));

const titleKey = t => (t || '').toLowerCase()
  .replace(/[‘’“”'"`]/g, '')
  .replace(/[^a-z0-9äöüß]+/g, ' ')
  .trim();

function dedupe(list) {
  const kept = [];
  const byLink = new Set();
  const byKey = new Set();
  for (const it of list) {
    if (it.link && byLink.has(it.link)) continue;
    const key = titleKey(it.title);
    if (key && byKey.has(key)) continue;
    const words = new Set(key.split(' ').filter(Boolean));
    let twin = false;
    if (words.size) {
      for (const k of kept) {
        if (k.it.lang !== it.lang) continue;
        let both = 0;
        for (const w of words) if (k.words.has(w)) both++;
        if (both / (words.size + k.words.size - both) < 0.8) continue;
        let split = false;
        for (const w of words) if (!k.words.has(w) && DISCRIM.has(w)) split = true;
        for (const w of k.words) if (!words.has(w) && DISCRIM.has(w)) split = true;
        if (!split) { twin = true; break; }
      }
    }
    if (twin) continue;
    kept.push({ it, words });
    if (it.link) byLink.add(it.link);
    if (key) byKey.add(key);
  }
  return kept.map(k => k.it);
}

async function refresh() {
  const results = await Promise.allSettled(FEEDS.map(async f => {
    const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 (F1 Hub news reader)' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${f.name}: HTTP ${r.status}`);
    return parse(await r.text(), f);
  }));
  const fresh = [];
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') fresh.push(...res.value);
    else log('feed failed', FEEDS[i].name, res.reason?.message);
  });
  if (fresh.length) {
    // Bei gleichem Datum gewinnt die inhaltsreichere Fassung, damit die Auswahl
    // nicht von der zufaelligen Reihenfolge der Feeds abhaengt
    const sorted = fresh.sort((a, b) => b.date - a.date || (b.summary || '').length - (a.summary || '').length);
    const unique = dedupe(sorted);
    removed = sorted.length - unique.length;
    items = unique.slice(0, 150);
    lastFetch = Date.now();
    log('loaded', items.length, 'articles,', removed, 'duplicates dropped');
  }
}

export function startNews() {
  refresh().catch(e => log(e.message));
  setInterval(() => refresh().catch(e => log(e.message)), REFRESH);
}
export const newsSnapshot = () => ({ updated: lastFetch, removed, sources: FEEDS.map(f => ({ name: f.name, lang: f.lang })), items });
