import { Exchange, binance, bybit } from "ccxt";
import type { Config } from "./config.js";
import { envKey } from "./config.js";
import type { Opportunity, TradeIntent, TradeResult } from "./types.js";

const EXCHANGE_CLASSES: Record<string, new (opts?: object) => Exchange> = { binance, bybit };

export interface Auth {
  apiKey: string;
  secret: string;
}

/** Create an authenticated exchange instance (only used in live mode). */
function authedInstance(id: string, config: Config): Exchange {
  const Ex = EXCHANGE_CLASSES[id];
  if (!Ex) throw new Error(`no exchange class "${id}"`);
  return new Ex({
    apiKey: process.env[envKey(id, "API_KEY")],
    secret: process.env[envKey(id, "SECRET")],
    enableRateLimit: true,
    timeout: 15_000,
  });
}

export class Executor {
  private live: Map<string, Exchange> = new Map();
  constructor(private config: Config) {
    if (config.mode === "live") {
      for (const id of config.exchanges) {
        this.live.set(id, authedInstance(id, config));
      }
    }
  }

  async freeBalance(exchangeId: string, currency: string): Promise<number> {
    const ex = this.live.get(exchangeId);
    if (!ex) throw new Error(`no live instance for ${exchangeId}`);
    const bal = await ex.fetchBalance();
    const acc = bal[currency];
    if (acc) return Number(acc["free"] ?? acc["total"] ?? 0);
    // Some venues return only an `info` payload; fall back to lowercase scan.
    const key = Object.keys(bal).find((k) => k.toLowerCase() === currency.toLowerCase());
    const alt = key ? bal[key] : undefined;
    return alt ? Number(alt["free"] ?? alt["total"] ?? 0) : 0;
  }

  /** Size the trade: capped by MAX_TRADE_USD *and* what both books can absorb; never exceed free quote balance in live. */
  async sizeTrade(opp: Opportunity): Promise<TradeIntent | null> {
    const sizeUsd = Math.min(this.config.maxTradeUsd, opp.sizeableUsd);
    if (this.config.mode === "live") {
      const free = await this.freeBalance(opp.buyExchange, this.config.quote);
      if (free <= 0) return null;
      const usable = Math.min(sizeUsd, free * 0.98);
      if (usable <= 0) return null;
      return { ...opp, sizeUsd: usable, dryRun: false };
    }
    return { ...opp, sizeUsd, dryRun: true };
  }

  /** Fire both legs. Dry-run logs the intent; live places market orders sequentially. */
  async execute(intent: TradeIntent): Promise<TradeResult> {
    const { symbol, buyExchange, sellExchange, buyVwap, sellVwap, sizeUsd } = intent;
    if (intent.dryRun) {
      console.log(
        `[dry-run] BUY ${symbol} on ${buyExchange} @ ~${buyVwap.toFixed(2)} (vwap), SELL on ${sellExchange} @ ~${sellVwap.toFixed(2)} (vwap), net ${intent.netSpreadPct.toFixed(3)}%, notional $${sizeUsd.toFixed(2)}`,
      );
      return { ok: true, dryRun: true, intent };
    }

    const buyEx = this.live.get(buyExchange)!;
    const sellEx = this.live.get(sellExchange)!;
    const [base] = symbol.split("/");

    try {
      // Leg 1: market buy using the quote balance.
      const quoteBalance = await this.freeBalance(buyExchange, this.config.quote);
      const notional = Math.min(sizeUsd, quoteBalance * 0.98);
      buyEx.amountToPrecision(symbol, notional / buyVwap); // sanity: throws if below min amount
      const buyOrder = await buyEx.createOrder(symbol, "market", "buy", notional / buyVwap);
      const buyOrderId = String(buyOrder.id);
      console.log(`[live] buy leg filled/placed id=${buyOrderId} on ${buyExchange}`);

      // Fetch the buy order to learn the filled amount (fall back to requested).
      let filledQty = notional / buyVwap;
      try {
        const fetched = await buyEx.fetchOrder(buyOrderId, symbol);
        if (typeof fetched.filled === "number" && fetched.filled > 0) filledQty = fetched.filled;
      } catch {
        // fetchOrder unsupported on some venues; proceed with estimate
      }
      const sellAmount = Number(sellEx.amountToPrecision(symbol, filledQty));

      // Leg 2: market sell on the rich venue.
      const sellOrder = await sellEx.createOrder(symbol, "market", "sell", sellAmount);
      const sellOrderId = String(sellOrder.id);
      console.log(`[live] sell leg filled/placed id=${sellOrderId} on ${sellExchange}`);

      return { ok: true, dryRun: false, intent, buyOrderId, sellOrderId };
    } catch (err) {
      return { ok: false, dryRun: false, intent, error: (err as Error).message };
    }
  }
}
