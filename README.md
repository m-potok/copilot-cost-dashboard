# Copilot Session Cost Tracker

Tracker per analizzare i costi delle sessioni Copilot Chat dal tuo workspace locale. Legge i debug-logs e calcola AIC (Abstract Integration Cost) con conversione a EUR.

## Disclaimer

I valori mostrati dal tool sono **indicativi** e hanno finalita di analisi interna.
Non rispecchiano necessariamente il costo finale effettivo di fatturazione.

## Installazione veloce

### 1. Requisiti

- **Node.js** (versione 18+): [Scarica da nodejs.org](https://nodejs.org/)
  - Durante l'installazione, assicurati di spuntare "Add to PATH"

### 2. Avvio

Fai doppio clic su **`start-dashboard.bat`**

Oppure, da terminale PowerShell/CMD nella cartella del tracker:
```bash
node app/copilot-cost-dashboard-server.js
```

Poi apri nel browser: **http://127.0.0.1:4781**

### Test

Esegui i test caratterizzanti e gli smoke test API con:

```bash
npm ci
npm test
```

I controlli di qualita separati sono disponibili con:

```bash
npm run lint
npm run type-check
```

Per misurare discovery e refresh incrementale sul dataset fixture:

```bash
npm run benchmark
```

Le soglie predefinite sono 1000 ms per la scansione iniziale e 1000 ms per
il refresh. Possono essere sovrascritte con `BENCHMARK_MAX_INITIAL_MS` e
`BENCHMARK_MAX_REFRESH_MS`.

## Uso

### Default automatico
Alla prima apertura, il tracker carica automaticamente i dati da:
```
%USERPROFILE%\AppData\Roaming\Code\User\workspaceStorage
%USERPROFILE%\.copilot\session-state
```

Sono supportate sia le sessioni Copilot Chat di VS Code (`debug-logs`) sia le sessioni create dalla GitHub Copilot App su Windows (`events.jsonl`). Per le sessioni della Copilot App i token e l'AIC vengono letti dalle metriche persistite nella sessione; se la sessione è ancora attiva, i dati disponibili possono essere parziali.

### Cambiare percorso
1. Modifica il campo **"Root logs (modificabile)"** in alto
2. Clicca **"Usa percorso inserito"**

### Filtri
- **Preset temporali**: Giorno corrente, Mese corrente, Ultimi 7/30 giorni
- **Intervallo custom**: Seleziona "Da" e "A" manualmente
- **AIC to EUR**: Modifica il valore (default 0.01 €)
- **Aggregazione**: Per giorno o per mese

## Metriche disponibili

| Metrica | Descrizione |
|---------|-------------|
| **Sessioni** | Numero di sessioni nel periodo |
| **Model Turns** | Richieste verso i modelli LLM |
| **Tool Calls** | Chiamate verso tool/plugin |
| **Input Tokens** | Token di input (inclusi cached) |
| **Cached Input Tokens** | Token riusati dalla cache |
| **Output Tokens** | Token di risposta |
| **Total Tokens** | Input + Output |
| **Errors** | Richieste con status != ok |
| **AIC** | Abstract Integration Cost (formula token_prices) |
| **Costo (€)** | AIC × valore configurato |

### Progetti e modifiche al codice

Le sessioni vengono associate al progetto leggendo `workspace.json` nello stesso
workspace storage: `folder` identifica una cartella, mentre `workspace`
identifica un workspace `.code-workspace`. Se il file manca o non è leggibile,
la sessione viene mostrata come **Non identificato**.

Il dashboard legge inoltre `chatEditingSessions/<sessionId>/state.json` e i
`editedFileEvents` del transcript `chatSessions/<sessionId>.jsonl`. Quando il
transcript non contiene l'evento per-request, usa
`recentSnapshot.entries[].state` insieme a `telemetryInfo.requestId` e alla
risorsa del file: in questo modo anche un undo esplicito resta classificato
come rifiutato senza confondere lo stato finale del file con altre richieste.
Le
operazioni vengono deduplicate usando `requestId`, `epoch`, URI e contenuto
dell'hunk. Gli enum VS Code usati sono `eventKind=1` (accettata), `2`
(rifiutata), `3` (modifica manuale) e `state=0/1/2` (modified/accepted/rejected).
Quando non è possibile collegare un'operazione a un segnale per-request, il
dashboard la marca come **non classificata (fallback)** invece di attribuirla
silenziosamente ad uno stato finale.

Le sessioni senza editing state restano disponibili e riportano metriche di
editing a zero o non disponibili. Le righe sono conteggiate per hunk: le
operazioni streaming duplicate vengono ignorate, mentre due hunk distinti
dello stesso request/epoch restano separati. La stima delle righe rimosse si
basa sul range VS Code; per `delete`, se il contenuto non è presente, il dato
non è ricostruibile e rimane non classificato.

Il filtro **Progetto** consente il drill-down per cartella/workspace. Con
**Tutti i progetti** viene mostrata una tabella aggregata con sessioni, token,
AIC, file e righe per stato. Il dettaglio sessione elenca file, operazioni,
request/epoch e indica i fallback non classificati. L'export Excel include il progetto
nella scheda `Sessioni` e una scheda aggregata `Progetti`.

**Nota**: Il tracker aggrega automaticamente i token dalla sessione principale e da tutti i child session (subagent).
I log dei child session sono referenced nel main.jsonl tramite `child_session_ref` e vengono letti e aggregati nel totale.

## Formula di calcolo

```
AIC = ((inputTokens - cachedTokens) × input_price 
      + cachedTokens × cache_price 
      + outputTokens × output_price) / 1.000.000

Costo EUR = AIC × valore_AIC_configurato
```

I prezzi sono letti da `models.json` dentro ogni sessione debug-logs.

## Struttura cartelle

```
app/
  copilot-cost-dashboard.html        # Dashboard (frontend)
  copilot-cost-dashboard-server.js   # Public entry point and compatibility exports
  bootstrap.js                       # Application composition and server startup
  domain/                             # Session, pricing, and editing metrics
  adapters/                           # VS Code and Copilot App session readers
  infrastructure/                    # Filesystem, SQLite, discovery, and Excel adapters
  http/                               # Request router and HTTP controllers
scripts/
  build-standalone.bat               # Build EXE (wrapper)
  build-standalone.ps1               # Build EXE (PowerShell)
start-dashboard.bat                  # Avvio rapido dashboard (Windows)
package.json                         # Config build standalone
README.md                            # Questo file
```

## Troubleshooting

### "Node.js non trovato"
- Scarica e installa [Node.js](https://nodejs.org/)
- Durante l'installazione, spunta "Add to PATH"
- Riavvia il terminale dopo l'installazione

### "Port 4781 già in uso"
- La porta è già occupata da un'altra applicazione
- Modifica in `app/copilot-cost-dashboard-server.js`:
  ```javascript
  const PORT = 4781;  // Cambia numero (es: 4782)
  ```

### "Cartella debug-logs non trovata"
- Verifica che il percorso root esista
- Tipicamente: `C:\Users\<username>\AppData\Roaming\Code\User\workspaceStorage`
- Se non esiste, esegui almeno una sessione Copilot Chat per crearla
- Per la GitHub Copilot App verifica anche `C:\Users\<username>\.copilot\session-state`

### "Sessioni caricate: 0"
- Controlla che in workspaceStorage esistano sessioni di Copilot Chat completate
- Il tracker cerca folder `<workspaceId>/GitHub.copilot-chat/debug-logs` e `<sessionId>/events.jsonl` sotto `.copilot\session-state`

## Condivisione

Il tool è completamente self-contained. Per condividere con altri:

1. Copia la cartella intera con i 3 file principali
2. Chi riceve deve avere Node.js installato
3. Doppio clic su `start-dashboard.bat` per avviare

## EXE standalone

Si, puoi generare un `.exe` standalone (Windows x64) con uno script automatico.

### Build veloce

Opzione 1 (consigliata): doppio clic su `scripts/build-standalone.bat`

Opzione 2 (PowerShell):

```powershell
.\scripts\build-standalone.ps1
```

Lo script:

1. Installa le dipendenze bloccate dal lockfile (`npm ci`)
2. Compila l'eseguibile
3. Salva il file in `dist\copilot-cost-dashboard.exe`

### Avvio EXE

```powershell
.\dist\copilot-cost-dashboard.exe
```

Poi apri nel browser:

```
http://127.0.0.1:4781
```

### Cosa condividere (modalita standalone)

- `dist\copilot-cost-dashboard.exe`

Per verificare l'integrita dell'artifact, calcola il checksum SHA-256:

```powershell
Get-FileHash .\dist\copilot-cost-dashboard.exe -Algorithm SHA256
```

La CI Windows esegue test, lint, type-check e build EXE e pubblica
l'eseguibile come artifact.

Note:

- L'EXE e standalone: non richiede Node.js sul PC destinatario.
- Al primo avvio potrebbe essere segnalato da SmartScreen (app non firmata): usa "Altre info" -> "Esegui comunque" in ambiente interno.

## Note tecniche

- **Frontend**: HTML puro con Fetch API (no framework)
- **Backend**: Node.js HTTP server (fs + path API)
- **Port**: 127.0.0.1:4781 (locale only, non accessibile da rete)
- **Cache browser**: Disabilitata per sempre fresh data
- **Localizzazione**: Italiano (IT-IT)
- **Locale-specific number formatting**: ✓ (separatore decimale personalizzato)

## Licenza

Tool interno Copilot Chat cost analysis.

---

**Domande?** Controlla il terminale per dettagli degli errori.
