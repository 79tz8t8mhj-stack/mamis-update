// =====================================================================
//  MAMIS UPDATE – Briefing-Generator
//  Läuft jeden Morgen automatisch auf GitHub (siehe .github/workflows).
//  1. holt das Wetter für Krefeld (Open-Meteo, kostenlos)
//  2. lässt Claude (Haiku 5.5, Denkaufwand "medium") die Nachrichten
//     recherchieren und ein ca. 4-minütiges Sprech-Briefing schreiben
//  3. speichert das Ergebnis in briefing.json – das liest der Alexa-Skill
// =====================================================================

import { readFile, writeFile } from 'node:fs/promises';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const WEATHER_BASE = process.env.WEATHER_URL || 'https://api.open-meteo.com/v1/forecast';
const FORCE = process.env.FORCE === 'true';
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'briefing.json';

const MODEL = 'claude-haiku-5-5';
const EFFORT = 'medium'; // Denkaufwand: low / medium / high – medium ist der Standard für Haiku 5.5
const KREFELD = { lat: 51.3388, lon: 6.5853 };
const EARLIEST_HOUR = 5; // vor 5 Uhr (deutsche Zeit) wird nichts erstellt

// ---------- Datum & Uhrzeit in deutscher Zeit ----------
function berlinNow(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  return {
    isoDate: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    spoken: new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(now),
  };
}

// ---------- Wetter ----------
const WETTERCODES = {
  0: 'klarer Himmel', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt',
  45: 'Nebel', 48: 'Nebel mit Reif', 51: 'leichter Nieselregen', 53: 'Nieselregen',
  55: 'starker Nieselregen', 56: 'gefrierender Nieselregen', 57: 'starker gefrierender Nieselregen',
  61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen', 66: 'gefrierender Regen',
  67: 'starker gefrierender Regen', 71: 'leichter Schneefall', 73: 'Schneefall',
  75: 'starker Schneefall', 77: 'Schneegriesel', 80: 'leichte Regenschauer',
  81: 'Regenschauer', 82: 'heftige Regenschauer', 85: 'leichte Schneeschauer',
  86: 'starke Schneeschauer', 95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'schwere Gewitter mit Hagel',
};

async function getWeather() {
  const params = new URLSearchParams({
    latitude: KREFELD.lat, longitude: KREFELD.lon, timezone: 'Europe/Berlin', forecast_days: '1',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max',
  });
  try {
    const res = await fetch(`${WEATHER_BASE}?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()).daily;
    const r = (v) => Math.round(v[0]);
    return `${WETTERCODES[d.weather_code[0]] ?? 'wechselhaft'}, Tiefstwert ${r(d.temperature_2m_min)} Grad, `
      + `Höchstwert ${r(d.temperature_2m_max)} Grad, Regenwahrscheinlichkeit ${r(d.precipitation_probability_max)} Prozent, `
      + `Wind bis ${r(d.wind_speed_10m_max)} Kilometer pro Stunde`;
  } catch (e) {
    console.warn(`⚠️  Wetter konnte nicht geladen werden (${e.message}) – Briefing kommt ohne Wetter.`);
    return null;
  }
}

// ---------- Anweisungen an Claude ----------
const SYSTEM_PROMPT = `Du bist Redakteur eines gesprochenen Morgen-Nachrichtenbriefings namens „Mamis Update". Ein Amazon-Echo-Lautsprecher liest es vor. Die Hörerin ist eine allgemein interessierte Frau um die 50 aus Krefeld.

RECHERCHE
- Suche mit dem Websuche-Werkzeug die wichtigsten Nachrichten der letzten 24 Stunden. Du hast höchstens 10 Suchen – plane sie: zuerst 2 bis 3 Suchen, um die wichtigsten Themen des Tages zu finden. Danach pro Hauptthema 1 bis 2 gezielte Suchen nach Hintergrund (Vorgeschichte, Zahlen, Positionen der Beteiligten). 2 Suchen für das Wissenschaftsthema Gesundheit/Ernährung/Bewegung (zuerst eine neue Studie finden, dann gezielt nach Details zur Studie suchen).
- Die Suche ist auf eine feste Quellenliste beschränkt (welche Seiten heute verfügbar sind, steht in der Nachricht des Nutzers). Bevorzuge nüchterne Nachrichtenmeldungen. Kommentare und Meinungsstücke sind keine Nachrichtenquelle – übernimm daraus nur belegte Fakten.
- Für Gesundheit, Ernährung und Bewegung NUR Wissenschaftsquellen: Fachzeitschriften (Nature, BMJ), Wissenschafts-Pressemitteilungen (EurekAlert, ScienceDaily, Medical Xpress) und Wissenschaftsjournalismus (Spektrum, scinexx, New Scientist, Ärzteblatt). Nachrichtenseiten wie Welt oder Focus sind für dieses Thema tabu. Englische Quellen übersetzt Du sinngemäß ins Deutsche. Keine Werbung, keine Wundermittel, keine Crash-Diäten.
- Prüfe das Datum jeder Meldung. Schreibe nur, was Du in den Suchergebnissen tatsächlich gefunden hast. Lieber eine Meldung weglassen als raten.

THEMENAUSWAHL – WENIGE THEMEN, DAFÜR GRÜNDLICH
- Tiefe ist wichtiger als Breite. Die Hörerin soll die Themen wirklich verstehen, nicht nur Schlagzeilen hören.
- 3 bis 4 Hauptthemen aus der Welt und aus Deutschland (Politik, Wirtschaft, Gesellschaft), jeweils etwa 90 bis 120 Wörter.
- Mindestens eines davon mit Alltagsbezug, zum Beispiel Preise, Rente, Verbraucher, Gesundheit oder Verkehr.
- Optional 1 bis 2 Kurzmeldungen mit je 1 bis 2 Sätzen, nur wenn danach noch Platz ist.
- PFLICHT: genau 1 Wissenschaftsthema aus Gesundheit, Ernährung oder Bewegung, etwa 90 bis 120 Wörter. Dieses Thema darf nie fehlen.

WISSENSCHAFTSTHEMA – FÜR EINE KUNDIGE HÖRERIN
- Die Hörerin weiß schon sehr viel über Ernährung und Gesundheit. Allgemeinwissen ist tabu: nichts wie „Vitamin D durch Sonne", „viel Obst und Gemüse", „Bewegung ist gesund", „genug trinken".
- Stelle eine neue Studie oder einen neuen Forschungsbefund vor, möglichst aus den letzten Wochen, der auch für Kundige überraschend oder neu ist.
- Erkläre: Wer hat was untersucht, wie (Art der Studie, Zahl der Teilnehmenden, Dauer), was kam heraus (mit Zahlen), welcher Mechanismus im Körper dahintersteckt, und wo die Grenzen liegen (zum Beispiel: Beobachtungsstudie zeigt Zusammenhang, nicht Ursache; nur an Mäusen getestet; kleine Stichprobe).
- Fachbegriffe darfst Du verwenden, erkläre sie aber in einem Halbsatz.
- Ein praktischer Bezug nur, wenn er sich wirklich aus der Studie ergibt – keine Allerwelts-Tipps.

JEDES HAUPTTHEMA ERKLÄRT
1. Was ist passiert? Der Kern in ein bis zwei Sätzen.
2. Wie kam es dazu? Vorgeschichte und Zusammenhänge, so dass man es auch ohne Vorwissen versteht. Fachbegriffe kurz in einfachen Worten erklären.
3. Wer vertritt welche Position? Die wichtigsten Seiten knapp und fair.
4. Was bedeutet das, wie geht es weiter? Konkrete nächste Schritte, Termine oder Folgen für den Alltag – nur, was in den Quellen steht. Steht dazu nichts in den Quellen, lass diesen Teil einfach weg. Sätze wie „Was als Nächstes passiert, nennen die Berichte nicht“ sind verboten.
- Die Teile gehen als natürlicher Fließtext ineinander über, nicht als hörbare Gliederung.
- Wechsel zwischen den Themen mit einer kurzen Überleitung, damit man beim Zuhören merkt, dass ein neues Thema beginnt.

NEUTRALITÄT – SEHR WICHTIG
- Berichte wie eine Nachrichtenagentur: wer hat was wann getan oder gesagt, mit Zahlen und Fakten.
- Keine Wertungen, keine moralisierenden Formulierungen, keine wertenden Adjektive, keine Vermutungen über Motive.
- Meinungen nur klar zugeordnet („Die Regierung argumentiert …, die Opposition hält dagegen …"). Bei Streitthemen die wichtigsten Positionen beider Seiten knapp und fair nennen.
- Sag der Hörerin nie, was sie davon halten soll. Kein Alarmismus.
- Keine Widersprüche: Wenn Du einen Fakt genannt hast, sag danach nicht, er sei unbekannt. Lies das Briefing vor der Ausgabe einmal auf Widersprüche durch.
- Nenne bei jeder Meldung im Satz die Quelle, zum Beispiel „laut NZZ" oder „wie das Handelsblatt berichtet". Nenne nur Medien, aus denen Du die Meldung in den Suchergebnissen tatsächlich hast.

SPRECHTEXT
- Nur Fließtext zum Vorlesen: keine Überschriften, keine Aufzählungszeichen, keine Sternchen, keine Emojis, keine Links.
- Kurze, klare Sätze. Abkürzungen nur, wenn sie gesprochen geläufig sind (EU, USA).
- Sprich die Hörerin durchgehend mit „Du" an, nie mit „Sie".
- Zwischen den Abschnitten eine Leerzeile.
- Länge: 480 bis 560 Wörter, das sind etwa vier Minuten. Halte diese Länge unbedingt ein – zu kurz ist genauso falsch wie zu lang. Die zusätzliche Länge gehört in Hintergrund und Erklärungen, nicht in zusätzliche Meldungen.

AUFBAU
1. Kurze Begrüßung mit Wochentag und Datum, zum Beispiel: „Guten Morgen! Hier ist Mamis Update für Montag, den 5. Oktober."
2. Das Wetter in Krefeld in ein bis zwei Sätzen (die Daten bekommst Du mitgeliefert, dafür nicht suchen).
3. Die Hauptthemen, das wichtigste zuerst, danach eventuelle Kurzmeldungen.
4. Das Wissenschaftsthema aus Gesundheit, Ernährung oder Bewegung.
5. Ein kurzer, freundlicher Abschluss, zum Beispiel: „Das war Mamis Update. Hab einen schönen Tag!"

AUSGABE
Gib das fertige Briefing zwischen <briefing> und </briefing> aus. Innerhalb der Tags steht nur der Vorlesetext.`;

function userPrompt(today, weather, domains) {
  const wetter = weather
    ? `Wetterdaten für Krefeld heute (vom Wetterdienst, bitte nicht danach suchen): ${weather}.`
    : 'Heute gibt es keine Wetterdaten. Lass das Wetter weg und sag nur kurz, dass die Wetterdaten heute fehlen.';
  return `Heute ist ${today.spoken}.\n${wetter}\nVerfügbare Quellen für die Websuche: ${domains.join(', ')}.\n\nRecherchiere jetzt und erstelle Mamis Update.`;
}

// ---------- Claude-API ----------
const LOCATION = { type: 'approximate', city: 'Krefeld', region: 'Nordrhein-Westfalen', country: 'DE', timezone: 'Europe/Berlin' };
// Erlaubte Quellen (Variante A): Agenturen als Faktenbasis + bürgerliche Medien + Gesundheit
const ALLOWED_DOMAINS = [
  // Nachrichtenagenturen
  'reuters.com', 'apnews.com',
  // bürgerlich / konservativ / wirtschaftsliberal
  'welt.de', 'nzz.ch', 'faz.net', 'focus.de', 'cicero.de', 'handelsblatt.com', 'wiwo.de', 'telegraph.co.uk',
  // Wissenschaft: Gesundheit, Ernährung, Bewegung (nur Fachquellen und Wissenschaftsjournalismus)
  'spektrum.de', 'scinexx.de', 'aerzteblatt.de', 'nature.com', 'bmj.com', 'eurekalert.org', 'sciencedaily.com', 'medicalxpress.com', 'newscientist.com',
];
const MAX_SEARCHES = 10;

// Moderne Websuche: filtert Ergebnisse vor dem Lesen → weniger Token, günstiger
const TOOL_MODERN = { type: 'web_search_20260318', name: 'web_search', max_uses: MAX_SEARCHES, allowed_domains: ALLOWED_DOMAINS, user_location: LOCATION, response_inclusion: 'excluded' };
// Rückfall-Variante, falls die moderne Version mal abgelehnt wird
const TOOL_BASIC = { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES, allowed_domains: ALLOWED_DOMAINS, user_location: LOCATION };

async function callClaude(body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Claude-API-Fehler ${res.status}: ${JSON.stringify(data.error ?? data)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function runClaude(tool, system, prompt) {
  const messages = [{ role: 'user', content: prompt }];
  const usage = { input: 0, output: 0, searches: 0, costUsd: 0 };
  const texts = [];
  const sources = new Map();
  let nudged = false;

  // Lange Recherchen pausiert die API manchmal ("pause_turn") – dann schicken wir einfach weiter.
  for (let round = 0; round < 8; round++) {
    const resp = await callClaude({
      model: MODEL, max_tokens: 16000, output_config: { effort: EFFORT }, system, messages, tools: [tool],
      ...(nudged ? { tool_choice: { type: 'none' } } : {}),
    });
    const u = resp.usage ?? {};
    const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const outTok = u.output_tokens ?? 0;
    const searches = u.server_tool_use?.web_search_requests ?? 0;
    usage.input += inTok;
    usage.output += outTok;
    usage.searches += searches;
    // Haiku 5.5: 0,10 $ / 0,50 $ pro Mio. Token – über 100.000 Token pro Anfrage 0,50 $ / 2,50 $. Suche: 0,01 $ pro Stück.
    const big = inTok > 100000;
    usage.costUsd += inTok * (big ? 0.5 : 0.1) / 1e6 + outTok * (big ? 2.5 : 0.5) / 1e6 + searches * 0.01;

    for (const block of resp.content ?? []) {
      if (block.type !== 'text') continue;
      texts.push(block.text);
      for (const c of block.citations ?? []) if (c.url) sources.set(c.url, c.title ?? c.url);
    }
    if (resp.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: resp.content });
      continue;
    }
    // Sicherheitsnetz: Hat Claude das Briefing nicht in <briefing>-Tags geliefert, einmal nachfordern – ohne neue Suchen.
    if (!/<briefing>[\s\S]*?<\/briefing>/i.test(texts.join('')) && !nudged) {
      console.warn(`⚠️  Kein <briefing> erhalten (stop_reason: ${resp.stop_reason}) – fordere es einmal nach.`);
      nudged = true;
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: 'Du hast das Briefing noch nicht ausgegeben. Schreibe jetzt auf Basis Deiner bisherigen Recherche das vollständige Briefing nach allen Vorgaben, ohne weitere Suchen. Gib nur das Briefing zwischen <briefing> und </briefing> aus.' });
      texts.length = 0;
      continue;
    }
    return { text: texts.join(''), usage, sources: [...sources].map(([url, title]) => ({ title, url })) };
  }
  throw new Error('Claude hat zu viele Pausen gebraucht – Abbruch.');
}

// Manche Seiten sperren den Such-Crawler von Anthropic. Die API lehnt dann die
// ganze Anfrage ab und nennt die gesperrten Domains. Wir werfen sie raus und
// versuchen es erneut – so läuft das Briefing weiter, statt abzustürzen.
function blockedDomains(err) {
  const m = err.message.match(/not accessible to our user agent: \[([^\]]*)\]/);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

async function research(today, weather) {
  let domains = [...ALLOWED_DOMAINS];
  let tool = TOOL_MODERN;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = await runClaude({ ...tool, allowed_domains: domains }, SYSTEM_PROMPT, userPrompt(today, weather, domains));
      return { ...result, domains };
    } catch (e) {
      if (e.status !== 400) throw e;
      const blocked = blockedDomains(e);
      if (blocked.length) {
        domains = domains.filter((d) => !blocked.includes(d));
        console.warn(`⚠️  Gesperrte Quellen entfernt: ${blocked.join(', ')} – neuer Versuch mit ${domains.length} Quellen.`);
        if (domains.length === 0) throw new Error('Keine erlaubte Quelle mehr übrig – bitte ALLOWED_DOMAINS anpassen.');
        continue;
      }
      if (tool === TOOL_MODERN) {
        console.warn(`⚠️  Moderne Websuche abgelehnt (${e.message}) – nutze einfache Websuche.`);
        tool = TOOL_BASIC;
        continue;
      }
      throw e;
    }
  }
  throw new Error('Websuche wurde mehrfach abgelehnt – Abbruch.');
}

// ---------- Text für Alexa säubern ----------
function cleanForSpeech(raw) {
  return raw
    .replace(/https?:\/\/\S+/g, '')          // keine Links vorlesen
    .replace(/[*#_`>|]/g, '')                 // Markdown-Zeichen raus
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBriefing(text) {
  const m = text.match(/<briefing>([\s\S]*?)<\/briefing>/i);
  if (!m) throw new Error('Claude hat kein <briefing> geliefert – altes Briefing bleibt stehen.');
  let briefing = cleanForSpeech(m[1]);
  if (briefing.length > 6000) { // Sicherheitsgrenze für Alexa
    briefing = briefing.slice(0, 6000).replace(/[^.!?]*$/, '').trim();
  }
  return briefing;
}

// ---------- Hauptprogramm ----------
async function main() {
  const today = berlinNow();
  console.log(`🕕 Deutsche Zeit: ${today.spoken}, ${today.hour} Uhr`);

  if (!FORCE) {
    if (today.hour < EARLIEST_HOUR) {
      console.log('😴 Noch zu früh (vor 5 Uhr deutscher Zeit) – nichts zu tun.');
      return;
    }
    const existing = await readFile(OUTPUT_FILE, 'utf8').then(JSON.parse).catch(() => null);
    if (existing?.date === today.isoDate) {
      console.log('✅ Das Briefing für heute existiert schon – nichts zu tun.');
      return;
    }
  }
  if (!API_KEY) throw new Error('Kein API-Schlüssel gefunden (Secret ANTHROPIC_API_KEY fehlt).');

  const weather = await getWeather();
  console.log(`🌦️  Wetter: ${weather ?? 'nicht verfügbar'}`);

  const result = await research(today, weather);
  console.log(`🔎 Genutzte Quellen: ${result.domains.join(', ')}`);

  const text = extractBriefing(result.text);
  const words = text.split(/\s+/).length;
  const { costUsd, ...usage } = result.usage;
  if (words < 400) console.warn(`⚠️  Briefing ist mit ${words} Wörtern kürzer als geplant (Ziel: 480–560).`);

  await writeFile(OUTPUT_FILE, JSON.stringify({
    date: today.isoDate,
    generatedAt: new Date().toISOString(),
    text,
    weather,
    sources: result.sources,
    stats: { words, model: MODEL, effort: EFFORT, ...usage, estimatedCostUsd: Number(costUsd.toFixed(3)) },
  }, null, 2) + '\n');

  console.log(`\n📰 Fertig: ${words} Wörter, ${result.usage.searches} Suchen, ca. ${costUsd.toFixed(2)} $\n`);
  console.log(text);
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1); // GitHub schickt Dir dann eine E-Mail
});
