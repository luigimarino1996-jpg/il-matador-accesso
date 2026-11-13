# Subscribe Telegram → Meta

Quando qualcuno arriva dalla tua landing ed entra nel canale Telegram, Meta
riceve un evento `Subscribe` (Conversions API). Nient'altro.

- Landing: `public/index.html` (foto in `public/avatar.jpg`)
- Backend: `netlify/functions/tracker.mjs`

## Passi

1. **Bot**: su Telegram apri @BotFather → `/newbot` → copia il token.
2. **Meta**: Gestione eventi → il tuo Pixel → Impostazioni → Conversions API →
   "Genera token di accesso". Copia token e ID del Pixel.
3. **Netlify**: pubblica questa cartella e imposta tre variabili d'ambiente:
   - `TELEGRAM_BOT_TOKEN`
   - `META_PIXEL_ID`
   - `META_ACCESS_TOKEN`

   Poi rifai il deploy, così le variabili vengono lette.
4. **Collega il bot**: apri `https://il-matador-accesso.netlify.app/api/setup`.
5. **Canale**: aggiungi il bot al canale come amministratore con il permesso
   "Invitare utenti tramite link". Fallo dopo il passo 4.
6. **Verifica**: ricarica `/api/setup`. Deve dire `ok: true` e il nome del canale.
7. **Landing**: è già collegata. Pulsante e Meta Pixel funzionano da soli.
8. **Annuncio**: in Meta scegli `Subscribe` come evento di conversione.

## Test

Imposta la variabile `META_TEST_EVENT_CODE` con il codice della scheda "Eventi
di test" di Meta, rifai il deploy, passa dalla landing ed entra nel canale con
un account che non ne fa parte. L'evento deve comparire in pochi secondi.
Toglila quando hai finito.

## Da sapere

- Il link d'invito è con approvazione, dura 7 giorni e vale per una sola persona: il bot approva da solo la richiesta.
- Chi esce e rientra non genera un secondo evento.
- Chi entra con un link non creato dalla landing non viene inviato a Meta.
- Variabili facoltative: `TELEGRAM_CHANNEL_ID` (per forzare un canale preciso),
  `META_API_VERSION` (predefinita `v24.0`).
