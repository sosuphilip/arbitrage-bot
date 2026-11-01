import { loadConfig, envKey } from "./config.js";
import { fetchFeed, findOpportunities } from "./scanner.js";
import { checkOpportunity } from "./risk.js";
import { Executor } from "./executor.js";
import { telegramAlert, telegramDiscoverChatIds, hasTelegramCredentials } from "./notifier.js";
import type { Opportunity } from "./types.js";

const MAX_TICKER_AGE_MS = 30_000;
const COOLDOWN_MS = 60_000; // after a trade, don't immediately re-fire on same symbol

const config = loadConfig();
const executor = new Executor(config);

const cooldown = new Map<string, number>(); // symbol -> timestamp of last trade

const alertCooldowns = new Map<string, number>(); // symbol -> last alert timestamp
async function maybeAlert(opp: Opportunity): Promise<void> {
  if (opp.netSpreadPct < config.alertSpreadPct) return;
  const last = alertCooldowns.get(opp.symbol) ?? 0;
  if (Date.now() - last < config.alertCooldownMs) return;
  alertCooldowns.set(opp.symbol, Date.now());
  await telegramAlert(
    `🔎 ${opp.symbol} opportunity\n` +
      `net ${opp.netSpreadPct.toFixed(3)}% (gross ${opp.grossSpreadPct.toFixed(3)}%)\n` +
      `buy ${opp.buyVwap.toFixed(2)} on ${opp.buyExchange} (depth $${opp.buyDepthUsd.toFixed(0)})\n` +
      `sell ${opp.sellVwap.toFixed(2)} on ${opp.sellExchange} (depth $${opp.sellDepthUsd.toFixed(0)})\n` +
      `sizeable: $${opp.sizeableUsd.toFixed(0)}`,
    false,
  );
}

function logOpp(opp: Opportunity) {
  console.log(
    `[scan] ${opp.symbol}: net ${opp.netSpreadPct.toFixed(3)}% (gross ${opp.grossSpreadPct.toFixed(3)}%) for $${opp.sizeableUsd.toFixed(0)} — buy vwap ${opp.buyVwap.toFixed(2)} on ${opp.buyExchange} (depth $${opp.buyDepthUsd.toFixed(0)}), sell vwap ${opp.sellVwap.toFixed(2)} on ${opp.sellExchange} (depth $${opp.sellDepthUsd.toFixed(0)})`,
  );
}

async function tick(): Promise<void> {
  const feed = await fetchFeed(config.exchanges, config.symbols);
  const opps = findOpportunities(feed, config, MAX_TICKER_AGE_MS);
  if (opps.length === 0) {
    console.log(`[scan] no cross-venue gaps on ${config.symbols.join(", ")}`);
    return;
  }
  for (const opp of opps) {
    const block = checkOpportunity(opp, config);
    if (block) {
      logOpp(opp);
      console.log(`[risk] blocked: ${block}`);
      await maybeAlert(opp);
      continue;
    }
    const last = cooldown.get(opp.symbol) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) {
      logOpp(opp);
      console.log(`[risk] cooling down ${opp.symbol} after recent trade`);
      continue;
    }
    logOpp(opp);
    await maybeAlert(opp);
    const intent = await executor.sizeTrade(opp);
    if (!intent) {
      console.log(`[risk] no quote balance to size a trade on ${opp.buyExchange}`);
      continue;
    }
    const result = await executor.execute(intent);
    if (result.ok) {
      cooldown.set(opp.symbol, Date.now());
      await telegramAlert(
        `✅ ${opp.symbol} trade executed (${intent.dryRun ? "DRY-RUN" : "LIVE"})\n` +
          `BUY ${intent.sizeUsd.toFixed(2)} ${config.quote} @ ~${opp.buyVwap.toFixed(2)} on ${opp.buyExchange}\n` +
          `SELL @ ~${opp.sellVwap.toFixed(2)} on ${opp.sellExchange}\n` +
          `net ${opp.netSpreadPct.toFixed(3)}%`,
        false,
      );
    } else console.error(`[executor] trade failed: ${result.error}`);
    break; // one trade per cycle; re-scan before firing again
  }
}

async function main() {
  const once = process.argv.includes("--once");
  if (process.argv.includes("--telegram-chat-id")) {
    await telegramDiscoverChatIds();
    return;
  }
  const tokenSet = Boolean(process.env[envKey("telegram", "bot_token")]);
  console.log(
    `arbitrage-bot starting: mode=${config.mode} venues=${config.exchanges.join(",")} symbols=${config.symbols.join(",")} minSpread=${config.minSpreadPct}% maxTrade=$${config.maxTradeUsd} telegram=${tokenSet && hasTelegramCredentials() ? "on" : "off"}`,
  );
  if (once) {
    await tick();
    return;
  }
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error(`[tick] ${(err as Error).stack ?? err}`);
    }
    await new Promise((r) => setTimeout(r, config.intervalMs));
  }
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
