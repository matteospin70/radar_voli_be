import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { JSONFilePreset } from 'lowdb/node';

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const TP_TOKEN = process.env.TRAVELPAYOUTS_TOKEN;
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL_HOURS = parseInt(process.env.CHECK_INTERVAL_HOURS || '6', 10);

if (!TP_TOKEN) {
  console.warn('[ATTENZIONE] TRAVELPAYOUTS_TOKEN non impostato: le chiamate falliranno.');
}

// Marker affiliato Travelpayouts (opzionale): se lo imposti, i link di acquisto
// vengono tracciati sul tuo account. Senza, i link funzionano comunque lo stesso.
const AVIASALES_MARKER = process.env.AVIASALES_MARKER || '';

// ---------- MAPPA COMPAGNIE AEREE (nome per esteso a partire dal codice IATA) ----------
let airlineMap = {};
async function loadAirlines() {
  try {
    const resp = await fetch('https://api.travelpayouts.com/data/en/airlines.json');
    const list = await resp.json();
    for (const a of list) {
      if (a.iata) airlineMap[a.iata] = a.name;
    }
    console.log(`Caricate ${Object.keys(airlineMap).length} compagnie aeree.`);
  } catch (err) {
    console.warn('Impossibile caricare la lista compagnie aeree:', err.message);
  }
}
loadAirlines();

// Costruisce un link di ricerca Aviasales per la rotta/data trovata
function buildBookingUrl(origin, destination, departureDateISO, passengers) {
  const d = new Date(departureDateISO);
  const ddmm = String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0');
  const pax = Math.max(1, passengers || 1);
  let url = `https://www.aviasales.com/search/${origin}${ddmm}${destination}${pax}`;
  if (AVIASALES_MARKER) url += `?marker=${AVIASALES_MARKER}`;
  return url;
}

// ---------- DB (file JSON locale, va bene per uso personale) ----------
const db = await JSONFilePreset('monitors.json', { monitors: [] });

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
  const { from, to, start, end, pax, bags, maxPrice } = req.body;

  if (!from || !to || !start || !end || !maxPrice) {
    return res.status(400).json({ error: 'Campi obbligatori mancanti (from, to, start, end, maxPrice).' });
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
    status: 'waiting',      // 'waiting' | 'found'
    lastChecked: null,
    foundPrice: null,
    foundDate: null,
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

async function fetchDirectPrices(origin, destination, departMonth) {
  const url = new URL('https://api.travelpayouts.com/v1/prices/direct');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  url.searchParams.set('depart_date', departMonth);
  url.searchParams.set('currency', 'eur'); // senza questo, i prezzi arrivano in rubli (RUB) per default
  url.searchParams.set('token', TP_TOKEN);

  const resp = await fetch(url, {
    headers: { 'X-Access-Token': TP_TOKEN }
  });

  if (!resp.ok) {
    throw new Error(`Travelpayouts ha risposto ${resp.status}`);
  }
  const json = await resp.json();
  if (!json.success) return [];

  // La risposta è tipicamente { data: { <destination>: { "0": {price, departure_at, ...}, ... } } }
  const entries = json.data?.[destination];
  if (!entries) return [];
  return Object.values(entries);
}

async function checkMonitor(monitor) {
  try {
    const months = monthsBetween(monitor.start, monitor.end);
    let best = null;

    for (const month of months) {
      const offers = await fetchDirectPrices(monitor.from, monitor.to, month);
      for (const offer of offers) {
        const depDate = offer.departure_at?.slice(0, 10);
        if (!depDate || depDate < monitor.start || depDate > monitor.end) continue;
        if (!best || offer.price < best.price) best = offer;
      }
    }

    monitor.lastChecked = new Date().toISOString();

    if (best && best.price <= monitor.maxPrice) {
      const wasAlreadyFound = monitor.status === 'found';
      monitor.status = 'found';
      monitor.foundPrice = best.price;
      monitor.foundDate = best.departure_at?.slice(0, 10) || null;
      monitor.airline = best.airline || null;
      monitor.airlineName = airlineMap[best.airline] || best.airline || 'Compagnia sconosciuta';
      monitor.bookingUrl = best.departure_at
        ? buildBookingUrl(monitor.from, monitor.to, best.departure_at, monitor.pax)
        : null;

      if (!wasAlreadyFound) {
        await notifyTelegram(
          `✈️ Trovato ${monitor.from} → ${monitor.to} a €${best.price} con ${monitor.airlineName} ` +
          `(partenza ${monitor.foundDate}). Tetto impostato: €${monitor.maxPrice}. ` +
          `Prenota qui: ${monitor.bookingUrl}\n` +
          `Ricorda: prezzo del solo biglietto, non include eventuali bagagli in stiva.`
        );
      }
    } else {
      monitor.status = 'waiting';
    }
  } catch (err) {
    console.error(`Errore controllando ${monitor.from}->${monitor.to}:`, err.message);
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
