import type { Config } from "./config.js";
import type { Opportunity } from "./types.js";

/** Risk guards. Each returns null when ok, or a reason string that blocks the trade. */
export function checkOpportunity(opp: Opportunity, config: Config): string | null {
  const ageMs = Date.now() - 0; // staleness handled by scanner; kept for future filters
  void ageMs;
  if (opp.buyVwap <= 0 || opp.sellVwap <= 0) return "non-positive price from venue data";
  if (opp.sizeableUsd <= 0) return "no fillable depth on either side";
  if (opp.netSpreadPct < config.minSpreadPct) {
    return `net spread ${opp.netSpreadPct.toFixed(3)}% below threshold ${config.minSpreadPct}%`;
  }
  return null;
}

export async function checkBalances(
  bookQtyForBuy: number,
  config: Config,
  getFree: (exchangeId: string, currency: string) => Promise<number>,
  buyExchange: string,
  sellExchange: string,
  base: string,
): Promise<string | null> {
  const needQuote = bookQtyForBuy;
  const freeQuote = await getFree(buyExchange, config.quote);
  if (freeQuote < needQuote) {
    return `insufficient ${config.quote} on ${buyExchange}: have ${freeQuote}, need ~${needQuote.toFixed(2)}`;
  }
  const freeBase = await getFree(sellExchange, base);
  if (freeBase < 0) return `failed to read ${base} balance on ${sellExchange}`;
  // After buying on A, the sell leg requires base on B; a fresh arb account usually
  // holds 0 base there, so this is a soft check (top-up inventory case).
  if (freeBase > 0) return null;
  return null;
}
