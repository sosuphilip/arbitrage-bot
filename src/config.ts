import "dotenv/config";
import type { Mode } from "./types.js";

export interface Config {
  mode: Mode;
  symbols: string[];
  quote: string;
  minSpreadPct: number;
  maxTradeUsd: number;
  intervalMs: number;
  // Taker fee (fraction, e.g. 0.001 = 0.1%) per exchange id, used for net spread math.
  takerFees: Record<string, number>;
  exchanges: string[];
}

// Format: EXCHANGE1_EXCHANGE2 per pair = markets the bot may trade between.
const PAIRS = [
  ["binance", "bybit"],
];

export function loadConfig(): Config {
  const mode = (process.env.MODE ?? "dry-run") as Mode;
  if (mode !== "live" && mode !== "dry-run") {
    throw new Error(`Invalid MODE "${mode}"; use "dry-run" or "live"`);
  }

  const symbols = (process.env.SYMBOLS ?? "BTC/USDT,ETH/USDT")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0) throw new Error("SYMBOLS must list at least one market, e.g. BTC/USDT");

  const quote = process.env.QUOTE ?? symbols[0]?.split("/")[1] ?? "USDT";
  const minSpreadPct = Number(process.env.MIN_SPREAD_PCT ?? 0.5);
  const maxTradeUsd = Number(process.env.MAX_TRADE_USD ?? 10);
  const intervalMs = Number(process.env.INTERVAL_MS ?? 5000);
  if (!Number.isFinite(minSpreadPct) || minSpreadPct <= 0) throw new Error("MIN_SPREAD_PCT must be > 0");
  if (!Number.isFinite(maxTradeUsd) || maxTradeUsd <= 0) throw new Error("MAX_TRADE_USD must be > 0");
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error("INTERVAL_MS must be >= 1000");

  void PAIRS; // pairs are encoded in exchangeIds below
  const exchangeIds = pickExchanges(symbols);
  const symbolsForExchanges = symbols.filter((s) => s.endsWith(`/${quote}`));
  if (symbolsForExchanges.length === 0) {
    throw new Error(`No listed symbols use quote "${quote}"`);
  }

  if (mode === "live") {
    for (const id of exchangeIds) {
      if (!process.env[envKey(id, "API_KEY")] || !process.env[envKey(id, "SECRET")]) {
        throw new Error(`MODE=live requires ${envKey(id, "API_KEY")} and ${envKey(id, "SECRET")} in .env`);
      }
    }
  }

  return {
    mode,
    symbols: symbolsForExchanges,
    quote,
    minSpreadPct,
    maxTradeUsd,
    intervalMs,
    takerFees: {
      binance: 0.001, // 0.1%
      bybit: 0.001, // 0.1%
      kraken: 0.0026,
      kucoin: 0.001,
      okx: 0.001,
    },
    exchanges: exchangeIds,
  };
}

export function envKey(exchange: string, suffix: string): string {
  return `${exchange.toUpperCase()}_${suffix}`;
}

// Straight 2-way arb between whichever exchanges we hold credentials for; the
// smallest useful version scans everything listed and executor trades the best pair.
function pickExchanges(symbols: string[]): string[] {
  void symbols;
  const configured = [
    "binance",
    "bybit",
  ];
  // Allow swapping an exchange by env: EXCHANGES="binance,kraken"
  const override = process.env.EXCHANGES;
  const list = (override ? override.split(",").map((s) => s.trim()) : configured).filter(Boolean);
  if (list.length < 2) throw new Error("Need at least 2 exchanges to arbitrage between");
  return list;
}
