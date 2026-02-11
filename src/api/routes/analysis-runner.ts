/**
 * Analysis Runner
 *
 * Runs the daily analysis with live logging to SSE clients.
 * Supports step-level caching (1-hour TTL) so failed runs
 * can resume from the last completed step.
 */

import { logEmitter } from "../log-emitter.ts";
import { crawlAllPortals } from "../../lib/crawler/index.ts";
import { extractTickersFromNews } from "../../lib/analyzer/ticker-extractor.ts";
import { analyzeStock } from "../../lib/analyzer/stock-analyzer.ts";
import type { NewsArticleInput, StockAnalysisInput, ExtractedTicker, TickerExtractionResult } from "../../lib/analyzer/types.ts";
import { fetchCurrentQuote, fetchPriceHistory, calculateTechnicalSummary } from "../../lib/market-data/technical.ts";
import { fetchFundamentals } from "../../lib/market-data/fundamental.ts";
import { updateAllPredictions, getTrackedPredictions } from "../../lib/prediction-tracker/updater.ts";
import {
  insertRecommendation,
  upsertStockFundamental,
  completeJobExecution,
  failJobExecution,
  getRecentNewsArticles,
  getActiveTickers,
} from "../../lib/database/queries.ts";
import type { JobSchedule } from "../../lib/database/types.ts";
import { addAvoidItem, clearAvoidItems } from "../../lib/avoid-cache.ts";
import { setMarketOutlook } from "../../lib/market-outlook-cache.ts";
import { getStepCache, setStepCache, getResumeStep, clearStepCache } from "../../lib/step-cache.ts";

const MIN_OVERALL_SCORE = 65;
const MAX_RECOMMENDATIONS_PER_RUN = 5;
const MAX_NEWS_AGE_DAYS = 1;
const MAX_CONTENT_LENGTH = 200;
const TOTAL_STEPS = 6;
const CACHEABLE_STEPS = 3; // Only steps 1-3 are cached

interface Step1Cache {
  totalNewArticles: number;
  successfulPortals: number;
}

export async function runAnalysisWithLogging(jobId: number, schedule: JobSchedule): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  logEmitter.startJob(jobId);
  clearAvoidItems();

  try {
    // Determine resume point from cached steps
    const resumeFrom = await getResumeStep(today, schedule, CACHEABLE_STEPS);
    if (resumeFrom > 1) {
      logEmitter.info(`Resuming from step ${resumeFrom} (steps 1-${resumeFrom - 1} cached)`);
    }

    // Step 1: Crawl news
    let crawlStats: Step1Cache;
    if (resumeFrom <= 1) {
      logEmitter.step(1, TOTAL_STEPS, "Crawling news portals...");
      const crawlSummary = await crawlAllPortals();
      crawlStats = { totalNewArticles: crawlSummary.totalNewArticles, successfulPortals: crawlSummary.successfulPortals };
      await setStepCache(today, schedule, 1, crawlStats);
      logEmitter.success(`Processed ${crawlStats.totalNewArticles} new articles from ${crawlStats.successfulPortals} portals`);
    } else {
      logEmitter.step(1, TOTAL_STEPS, "Using cached crawl results");
      crawlStats = (await getStepCache<Step1Cache>(today, schedule, 1)) ?? { totalNewArticles: 0, successfulPortals: 0 };
      logEmitter.success(`Cached: ${crawlStats.totalNewArticles} articles from ${crawlStats.successfulPortals} portals`);
    }

    // Articles are persisted in DB by the crawl — always query fresh
    const recentArticles = getRecentNewsArticles(MAX_NEWS_AGE_DAYS);
    const cutoffDate = new Date(Date.now() - MAX_NEWS_AGE_DAYS * 24 * 60 * 60 * 1000);

    const articlesForExtraction: NewsArticleInput[] = recentArticles
      .filter((article) => {
        if (!article.publishedAt) return true;
        return new Date(article.publishedAt) >= cutoffDate;
      })
      .map((article) => ({
        title: article.title,
        content: article.content?.slice(0, MAX_CONTENT_LENGTH) ?? null,
        portal: article.portal,
        publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
      }));

    logEmitter.info(`Filtered to ${articlesForExtraction.length} articles from last ${MAX_NEWS_AGE_DAYS} day(s)`);

    // Step 2: Extract tickers (expensive Gemini call)
    let tickerResult: TickerExtractionResult;
    if (resumeFrom <= 2) {
      logEmitter.step(2, TOTAL_STEPS, "Extracting tickers with AI...");
      tickerResult = await extractTickersFromNews(articlesForExtraction);
      await setStepCache(today, schedule, 2, tickerResult);
      logEmitter.success(`Found ${tickerResult.tickers.length} unique ticker mentions`);
    } else {
      logEmitter.step(2, TOTAL_STEPS, "Using cached ticker extraction");
      const cached = await getStepCache<TickerExtractionResult>(today, schedule, 2);
      tickerResult = cached ?? { tickers: [], articlesAnalyzed: 0, processingTimeMs: 0 };
      logEmitter.success(`Cached: ${tickerResult.tickers.length} ticker mentions`);
    }

    // Step 3: Aggregate tickers
    let topTickers: ExtractedTicker[];
    if (resumeFrom <= 3) {
      logEmitter.step(3, TOTAL_STEPS, "Analyzing top tickers...");
      const activeTickers = new Set(getActiveTickers());
      if (activeTickers.size > 0) {
        logEmitter.info(`Excluding ${activeTickers.size} tickers with active positions: ${[...activeTickers].join(", ")}`);
      }
      topTickers = tickerResult.tickers
        .filter((t) => t.sentiment > 0.2)
        .filter((t) => !activeTickers.has(t.ticker.toUpperCase()))
        .sort((a, b) => b.relevance - a.relevance || b.sentiment - a.sentiment)
        .slice(0, 10);
      await setStepCache(today, schedule, 3, topTickers);
      logEmitter.info(`Top tickers: ${topTickers.map((t) => t.ticker).join(", ") || "none"}`);
    } else {
      logEmitter.step(3, TOTAL_STEPS, "Using cached top tickers");
      topTickers = (await getStepCache<ExtractedTicker[]>(today, schedule, 3)) ?? [];
      logEmitter.success(`Cached: ${topTickers.map((t) => t.ticker).join(", ") || "none"}`);
    }

    // Step 4: Fetch market data and generate recommendations (always fresh)
    logEmitter.step(4, TOTAL_STEPS, "Fetching market data and generating recommendations...");
    const recommendations: Array<{ ticker: string; score: number }> = [];

    const activePredictions = await getTrackedPredictions();
    const activePredictionInputs = activePredictions
      .filter((p) => p.status === "pending" || p.status === "entry_hit")
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

    for (const tickerInfo of topTickers) {
      const ticker = tickerInfo.ticker;

      try {
        logEmitter.info(`Processing ${ticker}...`);

        const quoteResult = await fetchCurrentQuote(ticker);
        if (!quoteResult.success || !quoteResult.data) {
          logEmitter.warn(`No quote for ${ticker}: ${quoteResult.error}`);
          continue;
        }
        const quote = quoteResult.data;

        const fundamentalsResult = await fetchFundamentals(ticker);
        const fundamentals = fundamentalsResult.success ? fundamentalsResult.data : null;

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

        const historyResult = await fetchPriceHistory(ticker, "3mo");
        if (!historyResult.success || !historyResult.data) {
          logEmitter.warn(`No price history for ${ticker}`);
          continue;
        }

        const technical = calculateTechnicalSummary(ticker, historyResult.data, quote.price);

        const analysisInput: StockAnalysisInput = {
          ticker,
          companyName: fundamentals?.companyName ?? ticker,
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
          newsMentions: [{
            title: tickerInfo.reason,
            sentiment: tickerInfo.sentiment,
            relevance: tickerInfo.relevance,
          }],
          activePredictions: activePredictionInputs.filter((p) => p.ticker === ticker),
        };

        const analysis = await analyzeStock(analysisInput);

        if (analysis && analysis.overallScore >= MIN_OVERALL_SCORE && analysis.action === "BUY") {
          insertRecommendation({
            ticker,
            recommendationDate: today,
            action: "BUY",
            entryPrice: analysis.entryPrice,
            stopLoss: analysis.stopLoss,
            targetPrice: analysis.targetPrice,
            maxHoldDays: analysis.maxHoldDays,
            orderType: analysis.orderType,
            sentimentScore: analysis.sentimentScore,
            fundamentalScore: analysis.fundamentalScore,
            technicalScore: analysis.technicalScore,
            overallScore: analysis.overallScore,
            newsSummary: analysis.newsSummary,
            fundamentalSummary: analysis.fundamentalSummary,
            technicalSummary: analysis.technicalSummary,
            analysisSummary: analysis.analysisSummary,
          });
          recommendations.push({ ticker, score: analysis.overallScore });
          logEmitter.success(`${ticker}: Score ${analysis.overallScore.toFixed(1)} - RECOMMENDED (${analysis.orderType})`);
        } else if (analysis && analysis.action === "AVOID") {
          const riskPct = analysis.entryPrice > 0
            ? ((analysis.entryPrice - analysis.stopLoss) / analysis.entryPrice) * 100
            : 0;
          const rewardPct = analysis.entryPrice > 0
            ? ((analysis.targetPrice - analysis.entryPrice) / analysis.entryPrice) * 100
            : 0;
          addAvoidItem({
            ticker,
            companyName: fundamentals?.companyName ?? ticker,
            sector: fundamentals?.sector ?? null,
            currentPrice: quote.price,
            entryPrice: analysis.entryPrice,
            stopLoss: analysis.stopLoss,
            targetPrice: analysis.targetPrice,
            overallScore: analysis.overallScore,
            sentimentScore: analysis.sentimentScore,
            fundamentalScore: analysis.fundamentalScore,
            technicalScore: analysis.technicalScore,
            analysisSummary: analysis.analysisSummary,
            riskPercent: riskPct,
            rewardPercent: rewardPct,
            reason: analysis.analysisSummary,
            detectedAt: new Date().toISOString(),
          });
          logEmitter.info(`${ticker}: Score ${analysis.overallScore.toFixed(1)} - AVOID (high risk)`);
        } else if (analysis) {
          logEmitter.info(`${ticker}: Score ${analysis.overallScore.toFixed(1)} - ${analysis.action}`);
        } else {
          logEmitter.warn(`${ticker}: Analysis failed`);
        }

        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logEmitter.error(`${ticker}: ${msg}`);
      }

      if (recommendations.length >= MAX_RECOMMENDATIONS_PER_RUN) break;
    }

    logEmitter.success(`Generated ${recommendations.length} recommendations`);

    // Step 5: Update prediction statuses (always fresh)
    logEmitter.step(5, TOTAL_STEPS, "Updating prediction statuses...");
    const updateResult = await updateAllPredictions();
    logEmitter.success(`Updated ${updateResult.updated} predictions`);

    // Step 6: Generate market outlook (always fresh)
    logEmitter.step(6, TOTAL_STEPS, "Generating market outlook...");
    try {
      const bullishSignals: string[] = [];
      const bearishSignals: string[] = [];
      const globalNews: Array<{ title: string; sentiment: "positive" | "negative" | "neutral"; source: string }> = [];
      const localNews: Array<{ title: string; sentiment: "positive" | "negative" | "neutral"; source: string }> = [];

      for (const article of recentArticles.slice(0, 30)) {
        const isGlobal = article.portal.toLowerCase().includes("cnbc") ||
          article.portal.toLowerCase().includes("reuters") ||
          article.portal.toLowerCase().includes("bloomberg");

        const sentimentLabel: "positive" | "negative" | "neutral" = "neutral";
        const entry = { title: article.title, sentiment: sentimentLabel, source: article.portal };

        if (isGlobal) {
          globalNews.push(entry);
        } else {
          localNews.push(entry);
        }
      }

      const avgSentiment = tickerResult.tickers.length > 0
        ? tickerResult.tickers.reduce((sum, t) => sum + t.sentiment, 0) / tickerResult.tickers.length
        : 0;

      const positiveTickers = tickerResult.tickers.filter((t) => t.sentiment > 0.3);
      const negativeTickers = tickerResult.tickers.filter((t) => t.sentiment < -0.3);

      if (positiveTickers.length > 0) {
        bullishSignals.push(`${positiveTickers.length} tickers with positive sentiment`);
      }
      if (negativeTickers.length > 0) {
        bearishSignals.push(`${negativeTickers.length} tickers with negative sentiment`);
      }
      if (recommendations.length > 0) {
        bullishSignals.push(`${recommendations.length} new BUY recommendations generated`);
      }

      const overallSentiment: "bullish" | "bearish" | "neutral" =
        avgSentiment > 0.2 ? "bullish" : avgSentiment < -0.2 ? "bearish" : "neutral";

      setMarketOutlook({
        summary: `Market analysis based on ${recentArticles.length} articles. Average sentiment: ${avgSentiment.toFixed(2)}. ${recommendations.length} recommendations generated.`,
        sentiment: overallSentiment,
        bullishSignals,
        bearishSignals,
        globalNews: globalNews.slice(0, 5),
        localNews: localNews.slice(0, 10),
        generatedAt: new Date().toISOString(),
      });
      logEmitter.success("Market outlook generated");
    } catch (outlookErr) {
      const outlookMsg = outlookErr instanceof Error ? outlookErr.message : String(outlookErr);
      logEmitter.warn(`Market outlook generation failed: ${outlookMsg}`);
    }

    // Clear step cache after successful completion (next run starts fresh)
    await clearStepCache(today, schedule);

    completeJobExecution(jobId, {
      articlesProcessed: crawlStats.totalNewArticles,
      tickersExtracted: tickerResult.tickers.length,
      recommendationsGenerated: recommendations.length,
    });

    logEmitter.endJob(true);
  } catch (err) {
    // Do NOT clear cache on failure — allows resume on next run
    const msg = err instanceof Error ? err.message : String(err);
    failJobExecution(jobId, msg);
    logEmitter.error(msg);
    logEmitter.endJob(false);
  }
}
