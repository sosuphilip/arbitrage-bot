# arbitrage-bot

CEX→CEX spot arbitrage scanner + executor for crypto markets, built on [ccxt](https://ccxt.trade) in TypeScript.

**⚠️ Education/paper trading first. Real arbitrage is brutally competitive: spreads are usually smaller than fees + latency, and live trading can lose money fast. Never enable `live` mode with money you can't afford to lose.**

## What it does

1. **Scanner** — polls public ticker endpoints on two exchanges (default: Binance + Bybit), cross-compares every tracked symbol, and computes the spread **net of taker fees** on both legs.
2. **Risk guards** — enforces a minimum net spread, per-trade notional cap, trade cooldown, and (in live mode) checks free balances before sizing.
3. **Executor** — in `dry-run` mode logs exactly what it would do. In `live` mode it places a market buy on the cheap venue, reads the filled amount, then a market sell on the rich venue.

## Setup

```bash
cd arbitrage-bot
npm install
cp .env.example .env   # then edit
```

Run a one-shot dry scan (no keys needed, public data only):

```bash
npm run scan
```

Run continuous `dry-run` scanning:

```bash
npm start
```

## Going live

Set in `.env`:
- `MODE=live`
- Your API keys for each venue (`BINANCE_API_KEY`/`BINANCE_SECRET`, `BYBIT_API_KEY`/`BYBIT_SECRET`)
- Spot-only, **no-withdrawal** API keys; enable IP allowlisting on the exchanges
- Start with `MAX_TRADE_USD` at a minimum size and verify each leg manually first

## Hosting 24/7 on Botkeep (free)

The bot is light (one Node process), so it fits Botkeep's free tier (512 MB RAM, 50% CPU, 1 GB disk, no renewals).

1. Log in at [botkeep.cloud](https://botkeep.cloud) and create a new **Node.js** application.
2. Get the code there, either:
   - **GitHub** (recommended): push this `arbitrage-bot/` folder to a repo and connect it, **or**
   - **ZIP**: zip the folder *without* `node_modules/`, `.env`, or `dist/` (keep `.env.example`) and upload it.
3. In the app's environment variables (NOT in any file in the repo), set from `.env.example`:
   - `MODE=dry-run` (keep it in dry-run first!)
   - `SYMBOLS=BTC/USDT,ETH/USDT`, `MIN_SPREAD_PCT=0.5`, `MAX_TRADE_USD=10`, `INTERVAL_MS=5000`
4. Set the start command to `npm start` (Botkeep runs `npm install` from `package.json` — `tsx` is now a normal dependency, so it installs on the server).
5. Deploy and open the live logs. You should see `arbitrage-bot starting: mode=dry-run ...` and periodic `[scan]` lines. If it crashes, the logs at the bottom tell you why (usually a typo in an env var).
6. Only when you are sure you want live trading: add your API keys as env vars too, and switch `MODE=live`. Never put keys in the GitHub repo or the ZIP.

**Good practice:** the bot is non-interactive and writes diagnostics to stdout — exactly what Botkeep expects, so no changes are needed on their side.

## Telegram notifications (optional, free)

The bot can alert your Telegram the moment a real opportunity appears (net spread ≥ `ALERT_SPREAD_PCT`, `0.2%` by default, with a 10-minute anti-spam cooldown per symbol) and whenever a trade is executed.

1. In Telegram, talk to **@BotFather** → `/newbot` → follow the prompts → copy the **bot token**.
2. Create a `.env` (locally) or add env vars (Botkeep dashboard)

```env
TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here
```

3. Find *your new bot* in Telegram and send it any message (e.g. `hello`).
4. Run `npm run telegram-id` locally — it prints `TELEGRAM_ALERT_CHAT_ID=<number>`. Put that number in the environment too (plus `ALERT_SPREAD_PCT` / `ALERT_COOLDOWN_MS` if you want different thresholds).
5. Restart the bot → run `npm start` (or Redeploy on Botkeep).

To test end to end: send `/start` to the bot again, set an easy threshold (`ALERT_SPREAD_PCT=-1` fires on *any* gap, since alert math is net spread ≥ threshold), deploy, and you should get a message within a few scans. Remove it afterwards.

## Key parameters

| Env | Meaning |
|---|---|
| `SYMBOLS` | Markets to scan, e.g. `BTC/USDT,ETH/USDT` |
| `MIN_SPREAD_PCT` | Minimum net spread (after fees) to trade |
| `MAX_TRADE_USD` | Notional cap per trade |
| `INTERVAL_MS` | Polling interval between scans |

## Honest limitations (next steps if you want to go further)

- **Manual funding model**: it buys on venue A and sells on venue B, assuming you have inventory on both. Real arb requires rebalancing loops or pre-funded accounts.
- **No orderbook depth**: uses best bid/ask only; real sizes would slip. Next step is `fetchOrderBook` depth-aware sizing.
- **Synchronous legs**: the sell leg fires after the buy leg; prices can move between legs. Next step is atomic/parallel leg firing and cancel-on-miss.
- **Maker fees & VIP tiers** are hardcoded defaults in `src/config.ts`; wire in your actual fee tier.
