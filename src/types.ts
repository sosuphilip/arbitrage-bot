import type { Config } from "./config.js";

export type Mode = "dry-run" | "live";

export interface TickerOn {
  exchange: string;
  symbol: string;
  bid: number; // best price we can SELL at
  ask: number; // best price we can BUY at
  timestamp: number;
}

export interface Opportunity {
  symbol: string;
  buyExchange: string;
  sellExchange: string;
  buyVwap: number; // volume-weighted buy price for `sizeableUsd` on buyExchange
  sellVwap: number; // volume-weighted sell price for the same qty on sellExchange
  sizeableUsd: number; // notional both books can absorb at full fill
  buyDepthUsd: number;
  sellDepthUsd: number;
  grossSpreadPct: number;
  netSpreadPct: number; // after taker fees on both legs
}

export interface TradeIntent extends Opportunity {
  sizeUsd: number;
  dryRun: boolean;
}

export interface TradeResult {
  ok: boolean;
  dryRun: boolean;
  intent: TradeIntent;
  buyOrderId?: string;
  sellOrderId?: string;
  detail?: string;
  error?: string;
}

export interface Ctx {
  config: Config;
}
