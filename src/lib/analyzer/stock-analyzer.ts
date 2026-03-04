/**
 * Stock Analyzer
 *
 * Uses Gemini to analyze stocks and generate recommendations.
 */

import { generateContent } from "./llm-client.ts";
import { stockAnalysisSchema } from "./schemas.ts";
import type {
  StockAnalysisInput,
  StockAnalysisResult,
  StockAnalysisResponse,
} from "./types.ts";

const SYSTEM_INSTRUCTION = `You are a professional stock analyst for the Indonesian market (IHSG/IDX).
Your task is to analyze stocks and provide trading recommendations with specific price targets.

Guidelines:
- Be conservative with recommendations - only BUY if there's clear upside
- Entry price should be at a good technical level (support, pullback)
- Stop loss MUST be at least 3% below entry price (minimum). Typically 3-7% below entry, below key support
- Target should have 2:1 or better risk/reward ratio
- Max hold days depends on the setup (swing: 5-14 days, position: 14-30 days)
- Score each factor 0-100 based on strength of signal
- Provide actionable, specific reasoning

For previous predictions, suggest:
- HOLD: Position still valid, continue holding
- EXIT: Cut loss or fundamentals changed
- TAKE_PROFIT: Target reached or momentum fading
- ADD: Opportunity to add to position

Always respond with valid JSON.`;

/**
 * Analyze a stock and generate recommendation
 */
export async function analyzeStock(
  input: StockAnalysisInput
): Promise<StockAnalysisResult | null> {
  const prompt = buildAnalysisPrompt(input);

  const response = await generateContent<StockAnalysisResponse>(
    prompt,
    SYSTEM_INSTRUCTION,
    stockAnalysisSchema
  );

  if (!response.success || !response.data) {
    console.error(`Analysis failed for ${input.ticker}:`, response.error);
    return null;
  }

  return transformResponse(input.ticker, response.data);
}

/**
 * Build the analysis prompt
 */
function buildAnalysisPrompt(input: StockAnalysisInput): string {
  const {
    ticker,
    companyName,
    sector,
    currentPrice,
    priceChange,
    priceChangePct,
    peRatio,
    pbRatio,
    roe,
    debtToEquity,
    dividendYield,
    marketCap,
    trend,
    sma20,
    sma50,
    high3Month,
    low3Month,
    supports,
    resistances,
    volatilityPercent,
    newsMentions,
    activePredictions,
  } = input;

  // Format market cap
  const marketCapStr = marketCap
    ? `Rp ${(marketCap / 1e12).toFixed(1)}T`
    : "N/A";

  // Format news mentions
  const newsSection =
    newsMentions.length > 0
      ? newsMentions
          .map(
            (n) =>
              `- "${n.title}" (sentiment: ${n.sentiment.toFixed(2)}, relevance: ${n.relevance.toFixed(2)})`
          )
          .join("\n")
      : "No recent news mentions";

  // Format active predictions
  const predictionsSection =
    activePredictions.length > 0
      ? activePredictions
          .map((p) => {
            const pnl = ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100;
            return `- ${p.ticker}: Entry ${p.entryPrice}, Current ${p.currentPrice} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%), Status: ${p.status}, Days: ${p.daysActive}`;
          })
          .join("\n")
      : "No active predictions";

  return `Analyze this Indonesian stock and provide a trading recommendation.

## STOCK: ${ticker} - ${companyName}
Sector: ${sector ?? "Unknown"}

## CURRENT PRICE
- Price: Rp ${currentPrice.toLocaleString()}
- Change: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(0)} (${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(2)}%)

## FUNDAMENTALS
- Market Cap: ${marketCapStr}
- P/E Ratio: ${peRatio?.toFixed(1) ?? "N/A"}
- P/B Ratio: ${pbRatio?.toFixed(2) ?? "N/A"}
- ROE: ${roe ? (roe * 100).toFixed(1) + "%" : "N/A"}
- Debt/Equity: ${debtToEquity?.toFixed(2) ?? "N/A"}
- Dividend Yield: ${dividendYield ? (dividendYield * 100).toFixed(2) + "%" : "N/A"}

## TECHNICAL
- Trend: ${trend}
- SMA20: ${sma20?.toFixed(0) ?? "N/A"}
- SMA50: ${sma50?.toFixed(0) ?? "N/A"}
- 3-Month Range: ${low3Month.toFixed(0)} - ${high3Month.toFixed(0)}
- Support Levels: ${supports.length > 0 ? supports.map((s) => s.toFixed(0)).join(", ") : "N/A"}
- Resistance Levels: ${resistances.length > 0 ? resistances.map((r) => r.toFixed(0)).join(", ") : "N/A"}
- Volatility: ${volatilityPercent.toFixed(1)}%

## RECENT NEWS SENTIMENT
${newsSection}

## ACTIVE PREDICTIONS TO UPDATE
${predictionsSection}

Respond with JSON in this exact format:
{
  "action": "BUY" | "HOLD" | "AVOID",
  "confidence": 1-10,
  "entryPrice": number,
  "stopLoss": number,
  "targetPrice": number,
  "maxHoldDays": number,
  "orderType": "LIMIT" | "MARKET",
  "scores": {
    "sentiment": 0-100,
    "fundamental": 0-100,
    "technical": 0-100,
    "overall": 0-100
  },
  "reasoning": {
    "news": "Brief news sentiment analysis",
    "fundamental": "Brief fundamental analysis",
    "technical": "Brief technical analysis",
    "summary": "Overall recommendation summary"
  },
  "previousPredictionUpdates": [
    {
      "ticker": "XXXX",
      "action": "HOLD" | "EXIT" | "TAKE_PROFIT" | "ADD",
      "reason": "Brief reason"
    }
  ]
}

IMPORTANT for orderType:
- Use "LIMIT" (default) when recommending to place a limit order and act after market closing. This is the preferred approach.
- Use "MARKET" ONLY when there is an urgent catalyst requiring immediate entry (e.g., breakout confirmed, major news catalyst). In this case the bot will directly enter the position.
- When in doubt, always default to "LIMIT".`;
}

/**
 * Transform LLM response to our result type
 */
function transformResponse(
  ticker: string,
  response: StockAnalysisResponse
): StockAnalysisResult {
  // Enforce minimum 3% stop loss below entry price for fair balance with take profit
  const minStopLoss = response.entryPrice * 0.97;
  const stopLoss = Math.min(response.stopLoss, minStopLoss);

  return {
    ticker,
    action: response.action,
    confidence: clamp(response.confidence, 1, 10),
    entryPrice: response.entryPrice,
    stopLoss,
    targetPrice: response.targetPrice,
    maxHoldDays: response.maxHoldDays,
    orderType: response.orderType ?? "LIMIT",
    sentimentScore: clamp(response.scores.sentiment, 0, 100),
    fundamentalScore: clamp(response.scores.fundamental, 0, 100),
    technicalScore: clamp(response.scores.technical, 0, 100),
    overallScore: clamp(response.scores.overall, 0, 100),
    newsSummary: response.reasoning.news,
    fundamentalSummary: response.reasoning.fundamental,
    technicalSummary: response.reasoning.technical,
    analysisSummary: response.reasoning.summary,
    predictionUpdates: response.previousPredictionUpdates.map((u) => ({
      ticker: u.ticker,
      action: u.action,
      reason: u.reason,
      newStopLoss: u.newStopLoss,
      newTarget: u.newTarget,
    })),
  };
}

/**
 * Clamp value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
