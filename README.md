# Radar Voli — Backend

Piccolo server Node.js che:
- salva i tuoi monitoraggi (rotta, periodo, tetto di prezzo, pax, bagagli)
- per ogni monitoraggio, **tu scegli la fonte dati** dal sito:
  - **Travelpayouts** — gratis, illimitato, ma dati in cache (2-7 giorni): può non vedere occasioni reali disponibili solo in ricerca live.
  - **Google Flights via SerpApi** — dati live, ma a consumo (piano gratuito limitato a poche centinaia di ricerche/mese).
- ti avvisa su Telegram quando trova un prezzo sotto la soglia impostata, con link diretto per verificare e prenotare

Puoi configurare entrambe le fonti insieme e usarle in parallelo su monitoraggi diversi, oppure impostarne solo una lasciando l'altra variabile vuota nel `.env`.

## 1. Crea gli account per le fonti dati che vuoi usare

**Travelpayouts** (se vuoi la fonte gratuita/cache): registrati su travelpayouts.com, collegati al programma Aviasales, prendi il token da Profilo → API token.

**SerpApi** (se vuoi la fonte live):
1. Vai su **serpapi.com**, registrati (email + password).
2. Nella dashboard, sezione "Your Account", copia la tua **API Key**.
3. Il piano gratuito include circa 100-250 ricerche al mese (il numero esatto è indicato nel tuo account — verificalo, cambia nel tempo). Ogni data controllata per un monitoraggio conta come 1 ricerca.

## 2. Installazione locale

```bash
cd backend
npm install
cp .env.example .env
```

Apri `.env` e inserisci la tua `SERPAPI_KEY`.

Avvia il server:

```bash
npm start
```

Il server parte su `http://localhost:3000`. Prova subito:

```bash
curl http://localhost:3000/health
```

## 3. Creare il bot Telegram per le notifiche

1. Su Telegram cerca **@BotFather** e avvia una chat.
2. Manda `/newbot`, scegli un nome e uno username (deve finire in "bot").
3. BotFather ti restituisce un **token**: copialo in `TELEGRAM_BOT_TOKEN` nel file `.env`.
4. Cerca il tuo nuovo bot su Telegram e manda un messaggio qualsiasi (es. "ciao") per avviare la chat.
5. Apri nel browser:
   `https://api.telegram.org/bot<IL_TUO_TOKEN>/getUpdates`
   e cerca il campo `"chat":{"id": ... }`. Quel numero è il tuo `TELEGRAM_CHAT_ID`.

## 4. Budget ricerche: quanti monitoraggi puoi permetterti

Ogni controllo consuma `MAX_DATE_SAMPLES` ricerche per monitoraggio (default 3). Con `CHECK_INTERVAL_HOURS=24` (una volta al giorno):

```
ricerche al mese ≈ numero di monitoraggi × MAX_DATE_SAMPLES × 30
```

Esempi con le impostazioni di default (3 date campione, 1 controllo/giorno):
- **1 monitoraggio** → ~90 ricerche/mese → dentro il piano gratuito.
- **2 monitoraggi** → ~180 ricerche/mese → probabilmente supera il piano gratuito più basso, controlla il tuo limite esatto.
- **3+ monitoraggi** → quasi certamente serve un piano a pagamento (da $25/mese per 1.000 ricerche).

Se vuoi tenere più monitoraggi attivi restando gratis, abbassa `MAX_DATE_SAMPLES` a 1-2 (copre meno date nel periodo, ma consuma meno) oppure aumenta `CHECK_INTERVAL_HOURS` (es. 48 = un controllo ogni 2 giorni).

## 5. Api disponibili

| Metodo | Endpoint | Cosa fa |
|---|---|---|
| GET | `/api/monitors` | Elenca tutti i monitoraggi |
| POST | `/api/monitors` | Crea un monitoraggio (body: `from, to, start, end, pax, bags, maxPrice`) |
| DELETE | `/api/monitors/:id` | Elimina un monitoraggio |
| POST | `/api/monitors/check-now` | Forza un controllo immediato di tutti |

Esempio creazione:

```bash
curl -X POST http://localhost:3000/api/monitors \
  -H "Content-Type: application/json" \
  -d '{"from":"MXP","to":"JFK","start":"2026-10-01","end":"2026-10-31","pax":2,"bags":1,"maxPrice":350}'
```

## 6. Deploy online (per farlo girare 24/7 senza il tuo computer acceso)

Il processo deve restare sempre attivo per far scattare i controlli schedulati, quindi non basta un hosting "statico". Le due opzioni più semplici:

**Railway** (consigliata, ha un piano gratuito con crediti mensili)
1. Crea un account su railway.app, collega il repository (o carica la cartella `backend`).
2. Aggiungi le variabili d'ambiente (`SERPAPI_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) nel pannello Railway.
3. Railway rileva `package.json` e avvia `npm start` automaticamente.

**Render**
1. Crea un "Web Service" collegato al repository, cartella `backend`.
2. Build command: `npm install` — Start command: `npm start`.
3. Aggiungi le stesse variabili d'ambiente nel pannello Render.
4. Nota: il piano gratuito di Render "dorme" dopo inattività: se non riceve richieste HTTP per un po' si spegne e i controlli schedulati si fermano finché qualcuno non visita il sito. Per uso personale con pochi controlli al giorno può bastare, ma se vuoi affidabilità piena conviene il piano a pagamento (~7$/mese) o Railway.

## 7. Collegare il sito (frontend) al backend

Nel file HTML del prototipo, la funzione `checkAll()` genera prezzi finti. Quando il backend è online, la sostituiamo con una vera chiamata a `/api/monitors/check-now` e le funzioni di aggiunta/rimozione puntano a `/api/monitors`. Fammi sapere l'URL del backend una volta deployato (es. `https://radar-voli-production.up.railway.app`) e aggiorno il file HTML per collegarli.

## Limiti da tenere presente

- Il controllo campiona solo alcune date nel periodo indicato (vedi sezione Budget ricerche sopra), non ogni singolo giorno — per coprire tutto il periodo servirebbero più ricerche/mese di quelle incluse nel piano gratuito.
- Il prezzo restituito è quello del **solo biglietto**: non include eventuali bagagli in stiva a pagamento. Il campo "valigie" nel form resta quindi solo informativo.
- SerpApi non ha un piano a consumo: superata la quota gratuita, serve passare a un abbonamento mensile (da $25/mese), altrimenti le ricerche in eccesso falliscono fino al rinnovo del mese successivo.
