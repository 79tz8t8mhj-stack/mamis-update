# Mamis Update

Ein tägliches, gesprochenes Nachrichten-Briefing für Alexa.

**So funktioniert's:**

1. Jeden Morgen gegen 5:20–6:00 Uhr startet GitHub automatisch `generate.mjs`.
2. Das Programm holt das Wetter für Krefeld und lässt Claude (Sonnet 5.5) die wichtigsten Nachrichten recherchieren und neutral zusammenfassen.
3. Das Ergebnis landet in `briefing.json`.
4. Der Alexa-Skill (Ordner `alexa-skill`) liest diese Datei vor, sobald jemand sagt: „Alexa, gib mir Mamis Update".

**Manuell neu erstellen:** Reiter *Actions* → *Mamis Update erstellen* → *Run workflow*.

**Kosten prüfen:** In `briefing.json` steht unter `stats` die geschätzte Rechnung pro Lauf, die echten Kosten zeigt die Claude Console.
