/**
 * Analyze Ticker Route
 *
 * POST /api/analyze-ticker - Analyze an individual ticker on demand
 *
 * Useful when the job failed to parse some ticker data.
 * Fetches news, technical, and fundamental data then runs LLM analysis.
 * Results are cached for 24 hours per ticker.
 */

import { join } from "path";
import { mkdirSync } from "fs";
import { jsonResponse } from "../middleware/cors.ts";
import { successResponse, errorResponse } from "../types.ts";
import { analyzeStock } from "../../lib/analyzer/stock-analyzer.ts";
import type { StockAnalysisInput } from "../../lib/analyzer/types.ts";
import {
  fetchCurrentQuote,
  fetchPriceHistory,
  calculateTechnicalSummary,
} from "../../lib/market-data/technical.ts";
import { fetchFundamentals } from "../../lib/market-data/fundamental.ts";
import {
  getRecentNewsArticles,
  upsertStockFundamental,
} from "../../lib/database/queries.ts";
import { getTrackedPredictions } from "../../lib/prediction-tracker/updater.ts";

// ============================================================================
// Cache
// ============================================================================

const CACHE_DIR = join(import.meta.dir, "../../../data/ticker-analysis-cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  cachedAt: string;
  data: TickerAnalysisResponse;
}

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function getCachePath(ticker: string): string {
  return join(CACHE_DIR, `${ticker.replace(/\./g, "_")}.json`);
}

async function getCachedAnalysis(ticker: string): Promise<TickerAnalysisResponse | null> {
  try {
    const file = Bun.file(getCachePath(ticker));
    if (!(await file.exists())) return null;

    const entry = (await file.json()) as CacheEntry;
    const age = Date.now() - new Date(entry.cachedAt).getTime();

    if (age > CACHE_TTL_MS) return null;

    return entry.data;
  } catch {
    return null;
  }
}

async function setCachedAnalysis(ticker: string, data: TickerAnalysisResponse): Promise<void> {
  ensureCacheDir();
  const entry: CacheEntry = {
    cachedAt: new Date().toISOString(),
    data,
  };
  await Bun.write(getCachePath(ticker), JSON.stringify(entry, null, 2));
}

// ============================================================================
// Types
// ============================================================================

interface AnalyzeTickerRequest {
  ticker: string;
}

interface TickerAnalysisResponse {
  ticker: string;
  companyName: string;
  sector: string | null;
  currentPrice: number;
  priceChange: number;
  priceChangePct: number;
  fundamentals: {
    peRatio: number | null;
    pbRatio: number | null;
    roe: number | null;
    debtToEquity: number | null;
    dividendYield: number | null;
    marketCap: number | null;
  };
  technical: {
    trend: string;
    sma20: number | null;
    sma50: number | null;
    high3Month: number;
    low3Month: number;
    supports: number[];
    resistances: number[];
    volatilityPercent: number;
  };
  relevantNews: Array<{ title: string; portal: string; publishedAt: string | null }>;
  analysis: {
    action: string;
    confidence: number;
    entryPrice: number;
    stopLoss: number;
    targetPrice: number;
    maxHoldDays: number;
    overallScore: number;
    sentimentScore: number;
    fundamentalScore: number;
    technicalScore: number;
    analysisSummary: string;
    newsSummary: string;
    fundamentalSummary: string;
    technicalSummary: string;
  } | null;
  cached?: boolean;
}

// ============================================================================
// User-Friendly Error Messages
// ============================================================================

function toUserFriendlyError(error: unknown, ticker: string): string {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes("not found") || lower.includes("404") || lower.includes("no results")) {
    return `Ticker "${ticker}" was not found. Please check the ticker symbol and try again.`;
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("econnreset")) {
    return `The request timed out while fetching data for "${ticker}". The market data service may be slow — please try again in a moment.`;
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("enotfound")) {
    return `Could not connect to the market data service. Please check your internet connection and try again.`;
  }
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many")) {
    return `Too many requests — the market data service is rate-limiting us. Please wait a minute and try again.`;
  }
  if (lower.includes("json") || lower.includes("parse") || lower.includes("unexpected token")) {
    return `Received an unexpected response from the market data service for "${ticker}". Please try again later.`;
  }
  if (lower.includes("api key") || lower.includes("unauthorized") || lower.includes("403")) {
    return `Authentication error with the market data service. Please contact the administrator.`;
  }

  // Generic fallback
  return `Something went wrong while analyzing "${ticker}". Please try again later.`;
}

// ============================================================================
// Route Handler
// ============================================================================

export async function handleAnalyzeTicker(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");

  let rawTicker = "";
  try {
    const body = (await request.json()) as AnalyzeTickerRequest;
    rawTicker = body.ticker?.trim()?.toUpperCase() ?? "";
  } catch {
    return jsonResponse(
      errorResponse("Invalid request. Please provide a valid JSON body with a 'ticker' field."),
      400,
      origin
    );
  }

  if (!rawTicker) {
    return jsonResponse(
      errorResponse("Please enter a ticker symbol (e.g. BBCA, TLKM, ASII)."),
      400,
      origin
    );
  }

  // Append .JK suffix for IDX tickers if not already present
  const ticker = rawTicker.includes(".") ? rawTicker : `${rawTicker}.JK`;

  try {
    // Check cache first
    const cached = await getCachedAnalysis(ticker);
    if (cached) {
      console.log(`Ticker analysis cache hit: ${ticker}`);
      return jsonResponse(successResponse({ ...cached, cached: true }), 200, origin);
    }

    // Fetch all data in parallel
    const [quoteResult, fundamentalsResult, historyResult] = await Promise.all([
      fetchCurrentQuote(ticker),
      fetchFundamentals(ticker),
      fetchPriceHistory(ticker, "3mo"),
    ]);

    if (!quoteResult.success || !quoteResult.data) {
      return jsonResponse(
        errorResponse(`Could not find market data for "${rawTicker}". Please verify the ticker symbol is correct and listed on IDX.`),
        404,
        origin
      );
    }

    const quote = quoteResult.data;
    const fundamentals = fundamentalsResult.success ? fundamentalsResult.data : null;

    // Cache fundamentals if available
    if (fundamentals) {
      upsertStockFundamental({
        ticker: fundamentals.ticker,
        companyName: fundamentals.companyName,
        sector: fundamentals.sector,
        marketCap: fundamentals.marketCap,
        peRatio: fundamentals.peRatio,
        pbRatio: fundamentals.pbRatio,
        roe: fundamentals.roe,
        debtToEquity: fundamentals.debtToEquity,
        dividendYield: fundamentals.dividendYield,
      });
    }

    // Calculate technicals
    let technical = null;
    if (historyResult.success && historyResult.data) {
      technical = calculateTechnicalSummary(ticker, historyResult.data, quote.price);
    }

    // Search for relevant news mentioning this ticker
    const recentArticles = getRecentNewsArticles(7);
    const tickerBase = rawTicker.replace(".JK", "");
    const relevantNews = recentArticles
      .filter((a) => {
        const text = `${a.title} ${a.content ?? ""}`.toUpperCase();
        return text.includes(tickerBase);
      })
      .slice(0, 10)
      .map((a) => ({
        title: a.title,
        portal: a.portal,
        publishedAt: a.publishedAt ? String(a.publishedAt) : null,
      }));

    // Run LLM analysis if we have enough data
    let analysisResult = null;
    if (technical) {
      // Get active predictions for context
      const activePredictions = await getTrackedPredictions();
      const activePredictionInputs = activePredictions
        .filter((p) => p.status === "pending" || p.status === "entry_hit")
        .filter((p) => p.ticker === ticker)
        .map((p) => ({
          ticker: p.ticker,
          recommendationDate: p.recommendationDate,
          entryPrice: p.entryPrice,
          stopLoss: p.stopLoss,
          targetPrice: p.targetPrice,
          currentPrice: p.currentPrice ?? p.entryPrice,
          status: p.status as "pending" | "entry_hit",
          daysActive: p.daysActive,
        }));

      const analysisInput: StockAnalysisInput = {
        ticker,
        companyName: fundamentals?.companyName ?? tickerBase,
        sector: fundamentals?.sector ?? null,
        currentPrice: quote.price,
        priceChange: quote.change,
        priceChangePct: quote.changePercent,
        peRatio: fundamentals?.peRatio ?? null,
        pbRatio: fundamentals?.pbRatio ?? null,
        roe: fundamentals?.roe ?? null,
        debtToEquity: fundamentals?.debtToEquity ?? null,
        dividendYield: fundamentals?.dividendYield ?? null,
        marketCap: fundamentals?.marketCap ?? null,
        trend: technical.trend,
        sma20: technical.sma20,
        sma50: technical.sma50,
        high3Month: technical.high3Month,
        low3Month: technical.low3Month,
        supports: technical.supports,
        resistances: technical.resistances,
        volatilityPercent: technical.volatilityPercent,
        newsMentions: relevantNews.map((n) => ({
          title: n.title,
          sentiment: 0,
          relevance: 0.5,
        })),
        activePredictions: activePredictionInputs,
      };

      const llmResult = await analyzeStock(analysisInput);
      if (llmResult) {
        analysisResult = {
          action: llmResult.action,
          confidence: llmResult.confidence,
          entryPrice: llmResult.entryPrice,
          stopLoss: llmResult.stopLoss,
          targetPrice: llmResult.targetPrice,
          maxHoldDays: llmResult.maxHoldDays,
          overallScore: llmResult.overallScore,
          sentimentScore: llmResult.sentimentScore,
          fundamentalScore: llmResult.fundamentalScore,
          technicalScore: llmResult.technicalScore,
          analysisSummary: llmResult.analysisSummary,
          newsSummary: llmResult.newsSummary,
          fundamentalSummary: llmResult.fundamentalSummary,
          technicalSummary: llmResult.technicalSummary,
        };
      }
    }

    const response: TickerAnalysisResponse = {
      ticker,
      companyName: fundamentals?.companyName ?? tickerBase,
      sector: fundamentals?.sector ?? null,
      currentPrice: quote.price,
      priceChange: quote.change,
      priceChangePct: quote.changePercent,
      fundamentals: {
        peRatio: fundamentals?.peRatio ?? null,
        pbRatio: fundamentals?.pbRatio ?? null,
        roe: fundamentals?.roe ?? null,
        debtToEquity: fundamentals?.debtToEquity ?? null,
        dividendYield: fundamentals?.dividendYield ?? null,
        marketCap: fundamentals?.marketCap ?? null,
      },
      technical: technical
        ? {
            trend: technical.trend,
            sma20: technical.sma20,
            sma50: technical.sma50,
            high3Month: technical.high3Month,
            low3Month: technical.low3Month,
            supports: technical.supports,
            resistances: technical.resistances,
            volatilityPercent: technical.volatilityPercent,
          }
        : {
            trend: "UNKNOWN",
            sma20: null,
            sma50: null,
            high3Month: 0,
            low3Month: 0,
            supports: [],
            resistances: [],
            volatilityPercent: 0,
          },
      relevantNews,
      analysis: analysisResult,
      cached: false,
    };

    // Cache the successful result
    await setCachedAnalysis(ticker, response);

    console.log(`Ticker analysis completed: ${ticker}`);
    return jsonResponse(successResponse(response), 200, origin);
  } catch (error) {
    const friendlyMessage = toUserFriendlyError(error, rawTicker);
    console.error("Analyze ticker error:", error instanceof Error ? error.message : error);
    return jsonResponse(errorResponse(friendlyMessage), 500, origin);
  }
}
