Radar Voli — Backend
Piccolo server Node.js che:
salva i tuoi monitoraggi (rotta, periodo, tetto di prezzo, pax, bagagli)
ogni tot ore interroga Travelpayouts per i voli diretti disponibili
ti avvisa su Telegram quando trova un prezzo sotto la soglia impostata
1. Installazione locale
```bash
cd backend
npm install
cp .env.example .env
```
Apri `.env` e inserisci il tuo `TRAVELPAYOUTS_TOKEN` (lo trovi in Travelpayouts, Profilo → API token).
Avvia il server:
```bash
npm start
```
Il server parte su `http://localhost:3000`. Prova subito:
```bash
curl http://localhost:3000/health
```
2. Creare il bot Telegram per le notifiche
Su Telegram cerca @BotFather e avvia una chat.
Manda `/newbot`, scegli un nome e uno username (deve finire in "bot").
BotFather ti restituisce un token: copialo in `TELEGRAM_BOT_TOKEN` nel file `.env`.
Cerca il tuo nuovo bot su Telegram e manda un messaggio qualsiasi (es. "ciao") per avviare la chat.
Apri nel browser:
`https://api.telegram.org/bot<IL_TUO_TOKEN>/getUpdates`
e cerca il campo `"chat":{"id": ... }`. Quel numero è il tuo `TELEGRAM_CHAT_ID`.
3. API disponibili
Metodo	Endpoint	Cosa fa
GET	`/api/monitors`	Elenca tutti i monitoraggi
POST	`/api/monitors`	Crea un monitoraggio (body: `from, to, start, end, pax, bags, maxPrice`)
DELETE	`/api/monitors/:id`	Elimina un monitoraggio
POST	`/api/monitors/check-now`	Forza un controllo immediato di tutti
Esempio creazione:
```bash
curl -X POST http://localhost:3000/api/monitors \
  -H "Content-Type: application/json" \
  -d '{"from":"MXP","to":"JFK","start":"2026-10-01","end":"2026-10-31","pax":2,"bags":1,"maxPrice":350}'
```
4. Deploy online (per farlo girare 24/7 senza il tuo computer acceso)
Il processo deve restare sempre attivo per far scattare i controlli schedulati, quindi non basta un hosting "statico". Le due opzioni più semplici:
Railway (consigliata, ha un piano gratuito con crediti mensili)
Crea un account su railway.app, collega il repository (o carica la cartella `backend`).
Aggiungi le variabili d'ambiente (`TRAVELPAYOUTS_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) nel pannello Railway.
Railway rileva `package.json` e avvia `npm start` automaticamente.
Render
Crea un "Web Service" collegato al repository, cartella `backend`.
Build command: `npm install` — Start command: `npm start`.
Aggiungi le stesse variabili d'ambiente nel pannello Render.
Nota: il piano gratuito di Render "dorme" dopo inattività: se non riceve richieste HTTP per un po' si spegne e i controlli schedulati si fermano finché qualcuno non visita il sito. Per uso personale con pochi controlli al giorno può bastare, ma se vuoi affidabilità piena conviene il piano a pagamento (~7$/mese) o Railway.
5. Collegare il sito (frontend) al backend
Nel file HTML del prototipo, la funzione `checkAll()` genera prezzi finti. Quando il backend è online, la sostituiamo con una vera chiamata a `/api/monitors/check-now` e le funzioni di aggiunta/rimozione puntano a `/api/monitors`. Fammi sapere l'URL del backend una volta deployato (es. `https://radar-voli-production.up.railway.app`) e aggiorno il file HTML per collegarli.
Limiti da tenere presente
I prezzi di Travelpayouts arrivano da una cache di ricerche reali (aggiornata ogni 2-7 giorni), non da una query "live" al secondo.
Il prezzo restituito è quello del solo biglietto: non include eventuali bagagli in stiva a pagamento. Il campo "valigie" nel form resta quindi solo informativo.
Il piano gratuito di Travelpayouts ha dei rate limit (richieste al minuto); con pochi monitoraggi personali non dovresti mai avvicinarti al limite.
