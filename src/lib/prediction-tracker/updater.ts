/**
 * Prediction Updater
 *
 * Updates prediction status in database based on current prices.
 */

import type { TrackedPrediction, TrackingResult, StatusUpdate, PredictionSummary } from "./types.ts";
import {
  checkStatusChange,
  calculatePnlPct,
  calculateDistancePct,
  calculateRiskReward,
  calculateDaysActive,
} from "./status-checker.ts";
import {
  getActiveRecommendations,
  updateRecommendationStatus,
  getRecommendationsByDate,
} from "../database/queries.ts";
import type { Recommendation } from "../database/types.ts";
import { fetchCurrentQuote } from "../market-data/index.ts";

/**
 * Update all active predictions with current prices
 */
export async function updateAllPredictions(): Promise<TrackingResult> {
  const result: TrackingResult = {
    checked: 0,
    updated: 0,
    statusUpdates: [],
    errors: [],
  };

  // Get all active recommendations
  const activeRecs = getActiveRecommendations();
  result.checked = activeRecs.length;

  if (activeRecs.length === 0) {
    return result;
  }

  // Get unique tickers
  const tickers = [...new Set(activeRecs.map((r) => r.ticker))];

  // Fetch current prices
  const priceMap = new Map<string, number>();
  for (const ticker of tickers) {
    try {
      const quoteResult = await fetchCurrentQuote(ticker);
      if (quoteResult.success && quoteResult.data) {
        priceMap.set(ticker, quoteResult.data.price);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to fetch price for ${ticker}: ${msg}`);
    }
  }

  // Check each prediction
  for (const rec of activeRecs) {
    const currentPrice = priceMap.get(rec.ticker);
    if (!currentPrice) {
      continue;
    }

    const tracked = transformToTracked(rec, currentPrice);
    const statusUpdate = checkStatusChange(tracked, currentPrice);

    if (statusUpdate) {
      // Only calculate P&L for positions that were actually entered.
      // pending → expired means entry was never hit, so P&L is meaningless.
      const wasEntered = statusUpdate.previousStatus === "entry_hit";
      const isTerminal = statusUpdate.newStatus === "target_hit" ||
        statusUpdate.newStatus === "sl_hit" ||
        statusUpdate.newStatus === "expired";
      const pnl = wasEntered && isTerminal
        ? calculatePnlPct(rec.entryPrice, currentPrice)
        : undefined;

      updateRecommendationStatus(rec.id, statusUpdate.newStatus, currentPrice, pnl);

      result.statusUpdates.push(statusUpdate);
      result.updated++;

      console.log(
        `📊 ${statusUpdate.ticker}: ${statusUpdate.previousStatus} → ${statusUpdate.newStatus}`
      );
    }
  }

  return result;
}

/**
 * Get all tracked predictions with computed fields
 */
export async function getTrackedPredictions(): Promise<TrackedPrediction[]> {
  const activeRecs = getActiveRecommendations();

  if (activeRecs.length === 0) {
    return [];
  }

  // Get unique tickers and fetch prices
  const tickers = [...new Set(activeRecs.map((r) => r.ticker))];
  const priceMap = new Map<string, number>();

  for (const ticker of tickers) {
    try {
      const quoteResult = await fetchCurrentQuote(ticker);
      if (quoteResult.success && quoteResult.data) {
        priceMap.set(ticker, quoteResult.data.price);
      }
    } catch {
      // Use entry price as fallback
    }
  }

  return activeRecs.map((rec) => {
    const currentPrice = priceMap.get(rec.ticker) ?? rec.entryPrice;
    return transformToTracked(rec, currentPrice);
  });
}

/**
 * Transform database recommendation to tracked prediction
 */
function transformToTracked(rec: Recommendation, currentPrice: number): TrackedPrediction {
  const daysActive = calculateDaysActive(rec.recommendationDate);
  const riskReward = calculateRiskReward(rec.entryPrice, rec.stopLoss, rec.targetPrice);

  let unrealizedPnlPct: number | null = null;
  if (rec.status === "entry_hit") {
    unrealizedPnlPct = calculatePnlPct(rec.entryPrice, currentPrice);
  }

  return {
    id: rec.id,
    ticker: rec.ticker,
    recommendationDate: rec.recommendationDate,
    entryPrice: rec.entryPrice,
    stopLoss: rec.stopLoss,
    targetPrice: rec.targetPrice,
    maxHoldDays: rec.maxHoldDays,
    orderType: rec.orderType ?? "LIMIT",
    status: rec.status,
    currentPrice,
    daysActive,
    entryHitDate: rec.entryHitDate,
    entryHitPrice: rec.status !== "pending" ? rec.entryPrice : null,
    exitDate: rec.exitDate,
    exitPrice: rec.exitPrice,
    profitLossPct: rec.profitLossPct,
    unrealizedPnlPct,
    distanceToEntryPct: calculateDistancePct(currentPrice, rec.entryPrice),
    distanceToTargetPct: calculateDistancePct(currentPrice, rec.targetPrice),
    distanceToSlPct: calculateDistancePct(currentPrice, rec.stopLoss),
    riskRewardRatio: riskReward,
  };
}

/**
 * Get prediction summary for a date
 */
export function getPredictionSummary(date?: string): PredictionSummary {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const recs = getRecommendationsByDate(targetDate);
  const activeRecs = getActiveRecommendations();

  // Count by status
  const pending = activeRecs.filter((r) => r.status === "pending").length;
  const entryHit = activeRecs.filter((r) => r.status === "entry_hit").length;

  // Count closed today
  const today = new Date().toISOString().slice(0, 10);
  const closedToday = recs.filter(
    (r) =>
      r.exitDate === today &&
      (r.status === "target_hit" || r.status === "sl_hit" || r.status === "expired")
  ).length;

  // Calculate win rate and avg return from closed positions
  const closedRecs = recs.filter(
    (r) => r.status === "target_hit" || r.status === "sl_hit" || r.status === "expired"
  );

  let winRate: number | null = null;
  let avgReturn: number | null = null;

  if (closedRecs.length > 0) {
    const wins = closedRecs.filter((r) => r.status === "target_hit").length;
    winRate = (wins / closedRecs.length) * 100;

    const returns = closedRecs
      .filter((r) => r.profitLossPct !== null)
      .map((r) => r.profitLossPct as number);

    if (returns.length > 0) {
      avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    }
  }

  return {
    totalActive: activeRecs.length,
    pending,
    entryHit,
    closedToday,
    winRate,
    avgReturn,
  };
}
