import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { JSONFilePreset } from 'lowdb/node';

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const TP_TOKEN = process.env.TRAVELPAYOUTS_TOKEN;
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Controllo una volta al giorno di default (pensato per il budget SerpApi;
// se usi solo Travelpayouts puoi tranquillamente abbassarlo, es. a 6).
const CHECK_INTERVAL_HOURS = parseInt(process.env.CHECK_INTERVAL_HOURS || '24', 10);

// Quante date campionare nel periodo per ogni monitoraggio con fonte SerpApi
// (con Travelpayouts non serve: quell'endpoint copre già un mese intero in 1 chiamata).
const MAX_DATE_SAMPLES = parseInt(process.env.MAX_DATE_SAMPLES || '3', 10);

if (!SERPAPI_KEY) {
  console.warn('[ATTENZIONE] SERPAPI_KEY non impostato: i monitoraggi con fonte "serpapi" falliranno.');
}
if (!TP_TOKEN) {
  console.warn('[ATTENZIONE] TRAVELPAYOUTS_TOKEN non impostato: i monitoraggi con fonte "travelpayouts" falliranno.');
}

// Costruisce un link di ricerca Google Flights per la rotta/data trovata (usato da entrambe le fonti)
function buildBookingUrl(origin, destination, departureDateISO) {
  const dateStr = departureDateISO.slice(0, 10); // YYYY-MM-DD
  const query = encodeURIComponent(`Flights from ${origin} to ${destination} on ${dateStr}`);
  return `https://www.google.com/travel/flights?q=${query}`;
}

// ---------- DB (file JSON) ----------
// Su Railway, DB_PATH deve puntare dentro il volume persistente (es. /data/monitors.json),
// altrimenti i dati si perdono ad ogni redeploy. In locale va bene il default.
const DB_PATH = process.env.DB_PATH || 'monitors.json';
const db = await JSONFilePreset(DB_PATH, { monitors: [] });
console.log(`Database: ${DB_PATH}`);

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json());

// Elenco dei monitoraggi
app.get('/api/monitors', (req, res) => {
  res.json(db.data.monitors);
});

// Nuovo monitoraggio
app.post('/api/monitors', async (req, res) => {
  const { from, to, start, end, pax, bags, maxPrice, tripType, stayDays, source } = req.body;

  if (!from || !to || !start || !end || !maxPrice) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti (from, to, start, end, maxPrice).' });
  }

  const dataSource = source === 'travelpayouts' ? 'travelpayouts' : 'serpapi'; // default: serpapi
  const isRoundTrip = tripType === 'round_trip';

  if (isRoundTrip && (!stayDays || stayDays < 1)) {
    return res.status(400).json({ error: 'Per andata/ritorno indica i giorni di soggiorno (stayDays >= 1).' });
  }
  if (isRoundTrip && dataSource === 'travelpayouts') {
    return res.status(400).json({ error: 'L\'andata/ritorno è al momento supportata solo con la fonte "serpapi".' });
  }

  const monitor = {
    id: Date.now().toString(36),
    from: from.toUpperCase(),
    to: to.toUpperCase(),
    start,
    end,
    pax: pax || 1,
    bags: bags || 0,
    maxPrice: Number(maxPrice),
    source: dataSource,     // 'travelpayouts' | 'serpapi'
    tripType: isRoundTrip ? 'round_trip' : 'one_way',
    stayDays: isRoundTrip ? Number(stayDays) : null,
    status: 'waiting',      // 'waiting' | 'found'
    lastChecked: null,
    datesSampled: [],
    foundPrice: null,
    foundDate: null,
    foundReturnDate: null,
    airline: null,
    airlineName: null,
    bookingUrl: null,
    createdAt: new Date().toISOString()
  };

  db.data.monitors.push(monitor);
  await db.write();

  res.status(201).json(monitor);

  // Primo controllo subito, non aspettare il prossimo giro schedulato
  checkMonitor(monitor).catch(err => console.error('Errore primo controllo:', err));
});

// Rimuovi un monitoraggio
app.delete('/api/monitors/:id', async (req, res) => {
  const before = db.data.monitors.length;
  db.data.monitors = db.data.monitors.filter(m => m.id !== req.params.id);
  await db.write();
  if (db.data.monitors.length === before) {
    return res.status(404).json({ error: 'Monitoraggio non trovato.' });
  }
  res.status(204).send();
});

// Forza un controllo immediato di tutti i monitoraggi (utile per test manuali dal FE)
app.post('/api/monitors/check-now', async (req, res) => {
  await checkAllMonitors();
  res.json(db.data.monitors);
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- LOGICA DI CONTROLLO PREZZI ----------

// Genera la lista di "YYYY-MM" compresi tra due date (Travelpayouts vuole il mese)
function monthsBetween(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  const months = [];
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

// Fonte 1: Travelpayouts — gratuita, illimitata, ma dati in cache (2-7 giorni),
// quindi può mancare occasioni reali disponibili solo in ricerca live (vedi i test fatti).
async function checkTravelpayouts(monitor) {
  const months = monthsBetween(monitor.start, monitor.end);
  let best = null;

  for (const month of months) {
    const url = new URL('https://api.travelpayouts.com/v1/prices/direct');
    url.searchParams.set('origin', monitor.from);
    url.searchParams.set('destination', monitor.to);
    url.searchParams.set('depart_date', month);
    url.searchParams.set('currency', 'eur'); // senza questo, i prezzi arrivano in rubli (RUB) per default
    url.searchParams.set('token', TP_TOKEN);

    const resp = await fetch(url, { headers: { 'X-Access-Token': TP_TOKEN } });
    if (!resp.ok) throw new Error(`Travelpayouts ha risposto ${resp.status}`);
    const json = await resp.json();
    if (!json.success) continue;

    const entries = json.data?.[monitor.to];
    if (!entries) continue;

    for (const offer of Object.values(entries)) {
      const depDate = offer.departure_at?.slice(0, 10);
      if (!depDate || depDate < monitor.start || depDate > monitor.end) continue;
      if (!best || offer.price < best.price) {
        best = { price: offer.price, airline: offer.airline, departure_at: offer.departure_at, return_at: null };
      }
    }
  }

  return { best, datesSampled: months.map(m => `${m} (intero mese)`) };
}

// Fonte 2: SerpApi / Google Flights — dati live, ma a consumo (vedi budget nel README);
// campiona alcune date nel periodo invece di coprirlo tutto.

// Sceglie fino a maxSamples date distribuite uniformemente nel periodo indicato,
// per non dover interrogare ogni singolo giorno (ogni data = 1 ricerca a pagamento).
function sampleDates(startStr, endStr, maxSamples) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);

  if (totalDays <= maxSamples) {
    const dates = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }

  const dates = [];
  for (let i = 0; i < maxSamples; i++) {
    const offset = Math.round((i * (totalDays - 1)) / (maxSamples - 1 || 1));
    const d = new Date(start);
    d.setDate(d.getDate() + offset);
    dates.push(d.toISOString().slice(0, 10));
  }
  return [...new Set(dates)];
}

// Interroga Google Flights (via SerpApi) per una singola data (e, se andata/ritorno,
// una data di rientro) e restituisce solo le offerte di voli diretti (senza scali).
// Per l'andata/ritorno, richiede voli diretti su ENTRAMBE le tratte.
async function fetchGoogleFlightsDirect(origin, destination, dateStr, passengers, returnDateStr) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_flights');
  url.searchParams.set('departure_id', origin);
  url.searchParams.set('arrival_id', destination);
  url.searchParams.set('outbound_date', dateStr);
  if (returnDateStr) {
    url.searchParams.set('return_date', returnDateStr);
    url.searchParams.set('type', '1'); // andata e ritorno
  } else {
    url.searchParams.set('type', '2'); // sola andata
  }
  url.searchParams.set('currency', 'EUR');
  url.searchParams.set('hl', 'it');
  url.searchParams.set('adults', String(Math.max(1, passengers || 1)));
  url.searchParams.set('api_key', SERPAPI_KEY);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`SerpApi ha risposto ${resp.status}`);
  }
  const json = await resp.json();
  if (json.error) {
    throw new Error(json.error);
  }

  const all = [...(json.best_flights || []), ...(json.other_flights || [])];

  if (!returnDateStr) {
    // Sola andata: un'offerta è diretta se ha una sola tratta.
    const direct = all.filter(offer => (offer.flights || []).length === 1);
    return direct.map(offer => {
      const leg = offer.flights[0];
      return {
        price: offer.price,
        airline: leg.airline,
        departure_at: `${dateStr}T${(leg.departure_airport?.time || '00:00').split(' ').pop()}:00Z`,
        return_at: null
      };
    });
  }

  // Andata e ritorno: per un'offerta round-trip diretta su entrambe le tratte,
  // SerpApi restituisce tipicamente 2 segmenti in "flights" (uno per tratta).
  // NOTA: questo comportamento non è stato verificato con una chiamata reale;
  // se la logica sotto scarta troppe/tutte le offerte, va rivista guardando
  // la risposta JSON effettiva.
  const direct = all.filter(offer => (offer.flights || []).length === 2);
  return direct.map(offer => {
    const outboundLeg = offer.flights[0];
    return {
      price: offer.price,
      airline: outboundLeg.airline,
      departure_at: `${dateStr}T${(outboundLeg.departure_airport?.time || '00:00').split(' ').pop()}:00Z`,
      return_at: returnDateStr
    };
  });
}

async function checkSerpApi(monitor) {
  const dates = sampleDates(monitor.start, monitor.end, MAX_DATE_SAMPLES);
  const isRoundTrip = monitor.tripType === 'round_trip';
  let best = null;

  for (const dateStr of dates) {
    let returnDateStr = null;
    if (isRoundTrip) {
      const ret = new Date(dateStr);
      ret.setDate(ret.getDate() + monitor.stayDays);
      returnDateStr = ret.toISOString().slice(0, 10);
    }
    const offers = await fetchGoogleFlightsDirect(monitor.from, monitor.to, dateStr, monitor.pax, returnDateStr);
    for (const offer of offers) {
      if (!best || offer.price < best.price) best = offer;
    }
  }

  return { best, datesSampled: dates };
}

async function checkMonitor(monitor) {
  try {
    const { best, datesSampled } = monitor.source === 'travelpayouts'
      ? await checkTravelpayouts(monitor)
      : await checkSerpApi(monitor);

    monitor.lastChecked = new Date().toISOString();
    monitor.datesSampled = datesSampled; // utile per capire cosa è stato effettivamente controllato

    if (best && best.price <= monitor.maxPrice) {
      const wasAlreadyFound = monitor.status === 'found';
      monitor.status = 'found';
      monitor.foundPrice = best.price;
      monitor.foundDate = best.departure_at?.slice(0, 10) || null;
      monitor.foundReturnDate = best.return_at || null;
      monitor.airline = best.airline || null;
      monitor.airlineName = best.airline || 'Compagnia sconosciuta';
      monitor.bookingUrl = best.departure_at
        ? buildBookingUrl(monitor.from, monitor.to, best.departure_at)
        : null;

      if (!wasAlreadyFound) {
        const tripLabel = monitor.tripType === 'round_trip'
          ? `andata ${monitor.foundDate} / ritorno ${monitor.foundReturnDate}`
          : `partenza ${monitor.foundDate}, sola andata`;
        const sourceLabel = monitor.source === 'travelpayouts' ? 'Travelpayouts (cache)' : 'Google Flights (live)';
        await notifyTelegram(
          `✈️ Trovato ${monitor.from} → ${monitor.to} a €${best.price} con ${monitor.airlineName} ` +
          `(${tripLabel}). Tetto impostato: €${monitor.maxPrice}. Fonte: ${sourceLabel}. ` +
          `Verifica e prenota qui: ${monitor.bookingUrl}\n` +
          `Ricorda: prezzo del solo biglietto, non include eventuali bagagli in stiva.`
        );
      }
    } else {
      monitor.status = 'waiting';
    }
  } catch (err) {
    console.error(`Errore controllando ${monitor.from}->${monitor.to} (${monitor.source}):`, err.message);
  }

  await db.write();
}

async function checkAllMonitors() {
  console.log(`[${new Date().toISOString()}] Controllo di ${db.data.monitors.length} monitoraggi...`);
  for (const monitor of db.data.monitors) {
    await checkMonitor(monitor);
  }
}

async function notifyTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.warn('[ATTENZIONE] Telegram non configurato, notifica non inviata:', text);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text })
    });
  } catch (err) {
    console.error('Errore invio notifica Telegram:', err.message);
  }
}

// ---------- SCHEDULER ----------
// Esegue il controllo ogni CHECK_INTERVAL_HOURS ore (default 6)
cron.schedule(`0 */${CHECK_INTERVAL_HOURS} * * *`, () => {
  checkAllMonitors().catch(err => console.error('Errore nel controllo schedulato:', err));
});

app.listen(PORT, () => {
  console.log(`Radar Voli backend attivo sulla porta ${PORT}`);
  console.log(`Controllo automatico ogni ${CHECK_INTERVAL_HOURS} ore.`);
});
