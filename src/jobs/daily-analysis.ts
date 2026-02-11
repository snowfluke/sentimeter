/**
 * Daily Analysis Job
 *
 * Runs the complete analysis pipeline:
 * 1. Crawl news from all portals
 * 2. Extract tickers using Gemini
 * 3. Aggregate top tickers
 * 4. Fetch market data from Yahoo Finance & generate recommendations
 * 5. Update prediction statuses
 *
 * Supports step-level caching (1-hour TTL) so failed runs
 * can resume from the last completed step.
 */

import { crawlAllPortals } from "../lib/crawler/index.ts";
import type { CrawlSummary } from "../lib/crawler/types.ts";
import { extractTickersFromNews } from "../lib/analyzer/ticker-extractor.ts";
import { analyzeStock } from "../lib/analyzer/stock-analyzer.ts";
import type { NewsArticleInput, StockAnalysisInput, ExtractedTicker, TickerExtractionResult } from "../lib/analyzer/types.ts";
import { fetchCurrentQuote, fetchPriceHistory, calculateTechnicalSummary } from "../lib/market-data/technical.ts";
import { fetchFundamentals } from "../lib/market-data/fundamental.ts";
import { updateAllPredictions, getTrackedPredictions } from "../lib/prediction-tracker/updater.ts";
import {
  insertRecommendation,
  upsertStockFundamental,
  startJobExecution,
  completeJobExecution,
  failJobExecution,
  hasJobRunToday,
  getRecentNewsArticles,
  getActiveTickers,
} from "../lib/database/queries.ts";
import type { JobSchedule } from "../lib/database/types.ts";
import { initDatabase } from "../lib/database/schema.ts";
import { getStepCache, setStepCache, getResumeStep, clearStepCache } from "../lib/step-cache.ts";

const MIN_OVERALL_SCORE = 65;
const MAX_RECOMMENDATIONS_PER_RUN = 5;
const MAX_NEWS_AGE_DAYS = 1;
const MAX_CONTENT_LENGTH = 200;
const TOTAL_STEPS = 5;
const CACHEABLE_STEPS = 3;

interface Step1Cache {
  totalNewArticles: number;
  successfulPortals: number;
}

interface JobResult {
  success: boolean;
  jobId: number;
  articlesProcessed: number;
  tickersFound: number;
  recommendationsGenerated: number;
  predictionsUpdated: number;
  errors: string[];
}

export async function runDailyAnalysis(schedule: JobSchedule, force: boolean = false): Promise<JobResult> {
  const today = new Date().toISOString().slice(0, 10);
  const errors: string[] = [];

  if (!force && hasJobRunToday(schedule)) {
    console.log(`WARNING: ${schedule} analysis already completed for today`);
    console.log(`   Use --force to run anyway`);
    return {
      success: false,
      jobId: 0,
      articlesProcessed: 0,
      tickersFound: 0,
      recommendationsGenerated: 0,
      predictionsUpdated: 0,
      errors: [`${schedule} analysis already completed for today`],
    };
  }

  if (force) {
    console.log(`FORCE MODE: Running ${schedule} analysis despite previous run`);
  }

  const jobId = startJobExecution({ schedule, executionDate: today });
  console.log(`Starting ${schedule} analysis (Job ID: ${jobId})`);

  try {
    // Determine resume point from cached steps
    const resumeFrom = await getResumeStep(today, schedule, CACHEABLE_STEPS);
    if (resumeFrom > 1) {
      console.log(`\n   Resuming from step ${resumeFrom} (steps 1-${resumeFrom - 1} cached)`);
    }

    // Step 1: Crawl news
    let crawlStats: Step1Cache;
    if (resumeFrom <= 1) {
      console.log("\n   Step 1: Crawling news portals...");
      const crawlSummary: CrawlSummary = await crawlAllPortals();
      crawlStats = { totalNewArticles: crawlSummary.totalNewArticles, successfulPortals: crawlSummary.successfulPortals };
      await setStepCache(today, schedule, 1, crawlStats);
      console.log(`   Done: ${crawlStats.totalNewArticles} new articles from ${crawlStats.successfulPortals} portals`);
    } else {
      console.log("\n   Step 1: Using cached crawl results");
      crawlStats = (await getStepCache<Step1Cache>(today, schedule, 1)) ?? { totalNewArticles: 0, successfulPortals: 0 };
      console.log(`   Cached: ${crawlStats.totalNewArticles} articles from ${crawlStats.successfulPortals} portals`);
    }

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

    console.log(`   Filtered to ${articlesForExtraction.length} articles from last ${MAX_NEWS_AGE_DAYS} days`);

    // Step 2: Extract tickers
    let tickerResult: TickerExtractionResult;
    if (resumeFrom <= 2) {
      console.log("\n   Step 2: Extracting tickers with AI...");
      tickerResult = await extractTickersFromNews(articlesForExtraction);
      await setStepCache(today, schedule, 2, tickerResult);
      console.log(`   Done: ${tickerResult.tickers.length} unique ticker mentions`);
    } else {
      console.log("\n   Step 2: Using cached ticker extraction");
      const cached = await getStepCache<TickerExtractionResult>(today, schedule, 2);
      tickerResult = cached ?? { tickers: [], articlesAnalyzed: 0, processingTimeMs: 0 };
      console.log(`   Cached: ${tickerResult.tickers.length} ticker mentions`);
    }

    // Step 3: Aggregate tickers
    let topTickers: ExtractedTicker[];
    if (resumeFrom <= 3) {
      console.log("\n   Step 3: Analyzing top tickers...");
      const activeTickers = new Set(getActiveTickers());
      if (activeTickers.size > 0) {
        console.log(`   Excluding ${activeTickers.size} tickers with active positions: ${[...activeTickers].join(", ")}`);
      }
      topTickers = tickerResult.tickers
        .filter((t) => t.sentiment > 0.2)
        .filter((t) => !activeTickers.has(t.ticker.toUpperCase()))
        .sort((a, b) => b.relevance - a.relevance || b.sentiment - a.sentiment)
        .slice(0, 10);
      await setStepCache(today, schedule, 3, topTickers);
      console.log(`   Top tickers: ${topTickers.map((t) => t.ticker).join(", ")}`);
    } else {
      console.log("\n   Step 3: Using cached top tickers");
      topTickers = (await getStepCache<ExtractedTicker[]>(today, schedule, 3)) ?? [];
      console.log(`   Cached: ${topTickers.map((t) => t.ticker).join(", ") || "none"}`);
    }

    // Step 4: Fetch market data and generate recommendations (always fresh)
    console.log("\n   Step 4: Fetching market data and generating recommendations...");
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
        console.log(`   Processing ${ticker}...`);

        const quoteResult = await fetchCurrentQuote(ticker);
        if (!quoteResult.success || !quoteResult.data) {
          console.log(`   Warning: No quote for ${ticker}: ${quoteResult.error}`);
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
          console.log(`   Warning: No price history for ${ticker}`);
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
          console.log(`   ${ticker}: Score ${analysis.overallScore.toFixed(1)} - RECOMMENDED (${analysis.orderType})`);
        } else if (analysis) {
          console.log(`   ${ticker}: Score ${analysis.overallScore.toFixed(1)} - ${analysis.action}`);
        } else {
          console.log(`   ${ticker}: Analysis failed`);
        }

        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${ticker}: ${msg}`);
        console.log(`   Error ${ticker}: ${msg}`);
      }

      if (recommendations.length >= MAX_RECOMMENDATIONS_PER_RUN) break;
    }

    console.log(`   Generated ${recommendations.length} recommendations`);

    // Step 5: Update prediction statuses (always fresh)
    console.log("\n   Step 5: Updating prediction statuses...");
    const updateResult = await updateAllPredictions();
    const predictionsUpdated = updateResult.updated;
    console.log(`   Updated ${predictionsUpdated} predictions`);

    // Clear step cache after successful completion
    await clearStepCache(today, schedule);

    completeJobExecution(jobId, {
      articlesProcessed: crawlStats.totalNewArticles,
      tickersExtracted: tickerResult.tickers.length,
      recommendationsGenerated: recommendations.length,
    });

    console.log(`\n${schedule} analysis completed successfully!`);
    console.log(`   Articles: ${crawlStats.totalNewArticles}`);
    console.log(`   Tickers: ${tickerResult.tickers.length}`);
    console.log(`   Recommendations: ${recommendations.length}`);
    console.log(`   Predictions updated: ${predictionsUpdated}`);

    return {
      success: true,
      jobId,
      articlesProcessed: crawlStats.totalNewArticles,
      tickersFound: tickerResult.tickers.length,
      recommendationsGenerated: recommendations.length,
      predictionsUpdated,
      errors,
    };
  } catch (err) {
    // Do NOT clear cache on failure — allows resume on next run
    const msg = err instanceof Error ? err.message : String(err);
    failJobExecution(jobId, msg);
    console.error(`\n${schedule} analysis failed: ${msg}`);

    return {
      success: false,
      jobId,
      articlesProcessed: 0,
      tickersFound: 0,
      recommendationsGenerated: 0,
      predictionsUpdated: 0,
      errors: [msg, ...errors],
    };
  }
}

// CLI entry point
if (import.meta.main) {
  initDatabase();

  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");
  const hour = new Date().getHours();
  const schedule: JobSchedule = hour < 12 ? "morning" : "evening";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  SENTIMETER DAILY ANALYSIS - ${schedule.toUpperCase()}`);
  console.log(`  ${new Date().toISOString()}`);
  if (force) console.log(`  MODE: FORCE`);
  console.log(`${"=".repeat(60)}\n`);

  runDailyAnalysis(schedule, force)
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Fatal error:", err);
      process.exit(1);
    });
}
