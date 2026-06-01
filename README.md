# Copilot Session Cost Tracker

Tracker per analizzare i costi delle sessioni Copilot Chat dal tuo workspace locale. Legge i debug-logs e calcola AIC (Abstract Integration Cost) con conversione a EUR.

## Installazione veloce

### 1. Requisiti

- **Node.js** (versione 14+): [Scarica da nodejs.org](https://nodejs.org/)
  - Durante l'installazione, assicurati di spuntare "Add to PATH"

### 2. Avvio

Fai doppio clic su **`start-dashboard.bat`**

Oppure, da terminale PowerShell/CMD nella cartella del tracker:
```bash
node copilot-cost-dashboard-server.js
```

Poi apri nel browser: **http://127.0.0.1:4781**

## Uso

### Default automatico
Alla prima apertura, il tracker carica automaticamente:
```
%AppData%\Roaming\Code\User\workspaceStorage
```

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
copilot-cost-dashboard.html          # Dashboard (frontend)
copilot-cost-dashboard-server.js     # Server Node.js (backend)
start-dashboard.bat                  # Script di avvio automatico
README.md                             # Questo file
```

## Troubleshooting

### "Node.js non trovato"
- Scarica e installa [Node.js](https://nodejs.org/)
- Durante l'installazione, spunta "Add to PATH"
- Riavvia il terminale dopo l'installazione

### "Port 4781 già in uso"
- La porta è già occupata da un'altra applicazione
- Modifica in `copilot-cost-dashboard-server.js`:
  ```javascript
  const PORT = 4781;  // Cambia numero (es: 4782)
  ```

### "Cartella debug-logs non trovata"
- Verifica che il percorso root esista
- Tipicamente: `C:\Users\<username>\AppData\Roaming\Code\User\workspaceStorage`
- Se non esiste, esegui almeno una sessione Copilot Chat per crearla

### "Sessioni caricate: 0"
- Controlla che in workspaceStorage esistano sessioni di Copilot Chat completate
- Il tracker cerca folder `<workspaceId>/GitHub.copilot-chat/debug-logs`

## Condivisione

Il tool è completamente self-contained. Per condividere con altri:

1. Copia la cartella intera con i 3 file principali
2. Chi riceve deve avere Node.js installato
3. Doppio clic su `start-dashboard.bat` per avviare

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
