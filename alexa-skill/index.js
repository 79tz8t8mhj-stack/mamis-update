// =====================================================================
//  MAMIS UPDATE – Alexa-Skill
//  Holt das fertige Briefing (briefing.json) von GitHub und liest es vor.
//  Quelle: github.com/79tz8t8mhj-stack/mamis-update
// =====================================================================

const Alexa = require('ask-sdk-core');
const https = require('https');
const http = require('http');

const BRIEFING_URL = process.env.BRIEFING_URL
  || 'https://raw.githubusercontent.com/79tz8t8mhj-stack/mamis-update/main/briefing.json';

// ---------- Briefing laden (max. 4 Sekunden, Alexa ist ungeduldig) ----------
function fetchJson(url, timeoutMs = 4000) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(`${url}?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
  });
}

function berlinIsoDate(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now); // JJJJ-MM-TT
}

function spokenDate(isoDate) {
  return new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(`${isoDate}T12:00:00Z`));
}

// Sonderzeichen entschärfen, damit Alexa nicht stolpert
function toSsml(text) {
  return text
    .replace(/&/g, ' und ')
    .replace(/[<>]/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' <break time="800ms"/> ');
}

function buildSpeech(briefing, today = berlinIsoDate()) {
  let speech = toSsml(briefing.text || '');
  if (briefing.date !== today) {
    speech = `Kleiner Hinweis: Das heutige Update ist noch nicht fertig. Hier ist das Update von ${spokenDate(briefing.date)}. <break time="600ms"/> ${speech}`;
  }
  return speech.length > 7500 ? speech.slice(0, 7500) : speech; // Alexa-Grenze: 8000 Zeichen
}

// ---------- Was der Skill bei welchem Satz tut ----------
const UpdateHandler = {
  canHandle(input) {
    const type = Alexa.getRequestType(input.requestEnvelope);
    return type === 'LaunchRequest'
      || (type === 'IntentRequest' && Alexa.getIntentName(input.requestEnvelope) === 'UpdateIntent');
  },
  async handle(input) {
    try {
      const briefing = await fetchJson(BRIEFING_URL);
      return input.responseBuilder.speak(buildSpeech(briefing)).withShouldEndSession(true).getResponse();
    } catch (e) {
      console.error('Briefing konnte nicht geladen werden:', e.message);
      return input.responseBuilder
        .speak('Tut mir leid, das Update konnte gerade nicht geladen werden. Probier es bitte gleich noch einmal.')
        .withShouldEndSession(true).getResponse();
    }
  },
};

const HelpHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(input) {
    return input.responseBuilder
      .speak('Ich lese Dir jeden Morgen die wichtigsten Nachrichten, das Wetter in Krefeld und einen Gesundheitstipp vor. Sag einfach: Alexa, gib mir Mamis Update. Soll ich es jetzt vorlesen?')
      .reprompt('Sag einfach ja oder: lies das Update vor.')
      .getResponse();
  },
};

const StopHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && ['AMAZON.CancelIntent', 'AMAZON.StopIntent', 'AMAZON.NavigateHomeIntent', 'AMAZON.NoIntent']
        .includes(Alexa.getIntentName(input.requestEnvelope));
  },
  handle(input) {
    return input.responseBuilder.speak('Bis später!').withShouldEndSession(true).getResponse();
  },
};

const YesHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.YesIntent';
  },
  handle(input) { return UpdateHandler.handle(input); },
};

const FallbackHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(input) {
    return input.responseBuilder
      .speak('Das habe ich nicht verstanden. Soll ich Dir das Update vorlesen?')
      .reprompt('Sag einfach ja.')
      .getResponse();
  },
};

const SessionEndedHandler = {
  canHandle(input) { return Alexa.getRequestType(input.requestEnvelope) === 'SessionEndedRequest'; },
  handle(input) { return input.responseBuilder.getResponse(); },
};

const ErrorHandler = {
  canHandle() { return true; },
  handle(input, error) {
    console.error('Fehler im Skill:', error.message);
    return input.responseBuilder
      .speak('Da ist leider etwas schiefgelaufen. Probier es bitte gleich noch einmal.')
      .withShouldEndSession(true).getResponse();
  },
};

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(UpdateHandler, YesHandler, HelpHandler, StopHandler, FallbackHandler, SessionEndedHandler)
  .addErrorHandlers(ErrorHandler)
  .lambda();

exports._test = { buildSpeech, toSsml, berlinIsoDate };
