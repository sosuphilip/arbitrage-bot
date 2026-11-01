import { Exchange, binance, bybit } from "ccxt";
import type { Config } from "./config.js";
import type { Opportunity } from "./types.js";

const EXCHANGE_CLASSES: Record<string, new (opts?: object) => Exchange> = { binance, bybit };

export interface BookOn {
  exchange: string;
  symbol: string;
  // Each level: [price, baseAmount]
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
}

export type Feed = Record<string, Record<string, BookOn>>; // exchange -> symbol -> book

type Level = [number, number];

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

/** Fetch order books (with real depth) for every symbol on every configured exchange. */
export async function fetchFeed(exchanges: Config["exchanges"], symbols: string[]): Promise<Feed> {
  const results = await Promise.allSettled(
    exchanges.map(async (id) => {
      const Ex = EXCHANGE_CLASSES[id];
      if (!Ex) throw new Error(`no exchange class "${id}"`);
      const ex = new Ex({ enableRateLimit: true, timeout: 10_000 });
      const out: Record<string, BookOn> = {};
      await Promise.allSettled(
        symbols.map(async (symbol) => {
          try {
            const book = await timeout(ex.fetchOrderBook(symbol, 20), 10_000);
            if (
              Array.isArray(book.bids) && Array.isArray(book.asks) &&
              book.bids.length > 0 && book.asks.length > 0
            ) {
              out[symbol] = {
                exchange: id,
                symbol,
                bids: book.bids as Level[],
                asks: book.asks as Level[],
                timestamp: book.timestamp ?? Date.now(),
              };
            }
          } catch (err) {
            console.warn(`[scanner] ${id} ${symbol} failed: ${(err as Error).message}`);
          }
        }),
      );
      return { id, out };
    }),
  );

  const feed: Feed = {};
  for (const r of results) {
    if (r.status === "fulfilled") feed[r.value.id] = r.value.out;
  }
  return feed;
}

/** Walk ask levels to buy `baseQty`; returns VWAP or null if book can't cover the qty. */
export function vwapBuy(asks: Level[], baseQty: number): number | null {
  let remaining = baseQty;
  let cost = 0;
  for (const [price, amount] of asks) {
    const take = Math.min(remaining, amount);
    cost += take * price;
    remaining -= take;
    if (remaining <= 0) return cost / baseQty;
  }
  return null; // insufficient depth
}

/** Walk bid levels to sell `baseQty`; returns VWAP or null if book can't cover the qty. */
export function vwapSell(bids: Level[], baseQty: number): number | null {
  let remaining = baseQty;
  let proceeds = 0;
  for (const [price, amount] of bids) {
    const take = Math.min(remaining, amount);
    proceeds += take * price;
    remaining -= take;
    if (remaining <= 0) return proceeds / baseQty;
  }
  return null; // insufficient depth
}

/** Largest base qty fillable outright from a side's book. */
function bookDepthBase(levels: Level[]): number {
  return levels.reduce((acc, [, amount]) => acc + amount, 0);
}

/**
 * Cross every venue pair, sizing each leg against real liquidity:
 * choose the largest qty within MAX_TRADE_USD that BOTH books can absorb
 * at full fill, compute VWAP prices for that qty on each side, and report
 * the net spread achievable at that trade size.
 */
export function findOpportunities(
  feed: Feed,
  config: Config,
  maxBookAgeMs: number,
): Opportunity[] {
  const opps: Opportunity[] = [];
  const ids = Object.keys(feed);
  const now = Date.now();

  for (const symbol of config.symbols) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        for (const [buyId, sellId] of [
          [ids[i], ids[j]],
          [ids[j], ids[i]],
        ]) {
          const buy = feed[buyId]?.[symbol];
          const sell = feed[sellId]?.[symbol];
          if (!buy || !sell) continue;
          if (now - buy.timestamp > maxBookAgeMs || now - sell.timestamp > maxBookAgeMs) continue;

          const buyFeeFrac = config.takerFees[buyId];
          const sellFeeFrac = config.takerFees[sellId];
          if (buyFeeFrac === undefined || sellFeeFrac === undefined) continue;

          // Cap by notional budget and by what each side can fully absorb.
          const qtyBuySide = Math.min(bookDepthBase(buy.asks), config.maxTradeUsd / buy.asks[0][0]);
          const qtySellSide = Math.min(bookDepthBase(sell.bids), config.maxTradeUsd / sell.bids[0][0]);
          const qty = Math.min(qtyBuySide, qtySellSide);
          if (qty <= 0) continue;

          const buyVwap = vwapBuy(buy.asks, qty);
          const sellVwap = vwapSell(sell.bids, qty);
          if (buyVwap === null || sellVwap === null || sellVwap <= buyVwap) continue;

          const netFracPerUnit = sellVwap * (1 - sellFeeFrac) - buyVwap * (1 + buyFeeFrac);
          const netPct = (netFracPerUnit / buyVwap) * 100;

          opps.push({
            symbol,
            buyExchange: buyId,
            sellExchange: sellId,
            buyVwap,
            sellVwap,
            sizeableUsd: qty * buyVwap,
            buyDepthUsd: bookDepthBase(buy.asks) * buyVwap,
            sellDepthUsd: bookDepthBase(sell.bids) * sellVwap,
            grossSpreadPct: ((sellVwap - buyVwap) / buyVwap) * 100,
            netSpreadPct: netPct,
          });
        }
      }
    }
  }
  return opps.sort((a, b) => b.netSpreadPct - a.netSpreadPct);
}
