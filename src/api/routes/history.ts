/**
 * History Route
 *
 * GET /api/history - Get historical recommendations with pagination
 */

import type { HistoryResponse, HistoryItem, HistoryStats, HistoryParams } from "../types.ts";
import { successResponse, errorResponse } from "../types.ts";
import { jsonResponse } from "../middleware/cors.ts";
import { db } from "../../lib/database/schema.ts";
import { getStockFundamental } from "../../lib/database/queries.ts";

export async function handleHistory(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);

  try {
    const params: HistoryParams = {
      page: parseInt(url.searchParams.get("page") ?? "1", 10),
      pageSize: parseInt(url.searchParams.get("pageSize") ?? "20", 10),
      ticker: url.searchParams.get("ticker") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      startDate: url.searchParams.get("startDate") ?? undefined,
      endDate: url.searchParams.get("endDate") ?? undefined,
    };

    // Validate pagination
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    // Build dynamic query based on filters
    const { items, total } = getFilteredRecommendations(params, pageSize, offset);

    // Calculate stats
    const stats = calculateStats(params);

    const response: HistoryResponse = {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
      stats,
    };

    return jsonResponse(successResponse(response), 200, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("History error:", message);
    return jsonResponse(errorResponse(message), 500, origin);
  }
}

interface FilteredResult {
  items: HistoryItem[];
  total: number;
}

function getFilteredRecommendations(
  params: HistoryParams,
  limit: number,
  offset: number
): FilteredResult {
  // Build base query - use simple approach without dynamic bindings
  let query = "SELECT * FROM recommendations WHERE 1=1";
  let countQuery = "SELECT COUNT(*) as total FROM recommendations WHERE 1=1";

  if (params.ticker) {
    const ticker = params.ticker.toUpperCase().replace(/'/g, "''");
    query += ` AND ticker = '${ticker}'`;
    countQuery += ` AND ticker = '${ticker}'`;
  }

  if (params.status) {
    const status = params.status.replace(/'/g, "''");
    query += ` AND status = '${status}'`;
    countQuery += ` AND status = '${status}'`;
  }

  if (params.startDate) {
    const startDate = params.startDate.replace(/'/g, "''");
    query += ` AND recommendation_date >= '${startDate}'`;
    countQuery += ` AND recommendation_date >= '${startDate}'`;
  }

  if (params.endDate) {
    const endDate = params.endDate.replace(/'/g, "''");
    query += ` AND recommendation_date <= '${endDate}'`;
    countQuery += ` AND recommendation_date <= '${endDate}'`;
  }

  query += ` ORDER BY recommendation_date DESC, overall_score DESC LIMIT ${limit} OFFSET ${offset}`;

  // Execute count query
  const countStmt = db.prepare(countQuery);
  const countResult = countStmt.get() as { total: number };
  const total = countResult.total;

  // Execute data query
  const dataStmt = db.prepare(query);
  const rows = dataStmt.all() as Array<{
    ticker: string;
    recommendation_date: string;
    action: string;
    entry_price: number;
    stop_loss: number;
    target_price: number;
    status: string;
    exit_date: string | null;
    exit_price: number | null;
    profit_loss_pct: number | null;
    overall_score: number;
  }>;

  // Transform to response format
  const items: HistoryItem[] = rows.map((row) => ({
    ticker: row.ticker,
    companyName: getStockFundamental(row.ticker)?.companyName ?? row.ticker,
    recommendationDate: row.recommendation_date,
    action: row.action,
    entryPrice: row.entry_price,
    stopLoss: row.stop_loss,
    targetPrice: row.target_price,
    status: row.status,
    exitDate: row.exit_date,
    exitPrice: row.exit_price,
    profitLossPct: row.profit_loss_pct,
    overallScore: row.overall_score,
  }));

  return { items, total };
}

function calculateStats(params: HistoryParams): HistoryStats {
  // Only count positions that were actually entered (have P&L data).
  // Expired-from-pending positions have no P&L and should not skew stats.
  let whereClause = "WHERE status IN ('target_hit', 'sl_hit', 'expired') AND profit_loss_pct IS NOT NULL";

  if (params.ticker) {
    const ticker = params.ticker.toUpperCase().replace(/'/g, "''");
    whereClause += ` AND ticker = '${ticker}'`;
  }

  if (params.startDate) {
    const startDate = params.startDate.replace(/'/g, "''");
    whereClause += ` AND recommendation_date >= '${startDate}'`;
  }

  if (params.endDate) {
    const endDate = params.endDate.replace(/'/g, "''");
    whereClause += ` AND recommendation_date <= '${endDate}'`;
  }

  const statsQuery = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'target_hit' THEN 1 ELSE 0 END) as wins,
      AVG(profit_loss_pct) as avg_return
    FROM recommendations
    ${whereClause}
  `);

  const statsResult = statsQuery.get() as {
    total: number;
    wins: number;
    avg_return: number | null;
  };

  const bestQuery = db.prepare(`
    SELECT ticker, profit_loss_pct
    FROM recommendations
    ${whereClause}
    ORDER BY profit_loss_pct DESC
    LIMIT 1
  `);

  const worstQuery = db.prepare(`
    SELECT ticker, profit_loss_pct
    FROM recommendations
    ${whereClause}
    ORDER BY profit_loss_pct ASC
    LIMIT 1
  `);

  const bestResult = bestQuery.get() as { ticker: string; profit_loss_pct: number } | null;
  const worstResult = worstQuery.get() as { ticker: string; profit_loss_pct: number } | null;

  return {
    totalRecommendations: statsResult.total,
    winRate: statsResult.total > 0 ? (statsResult.wins / statsResult.total) * 100 : null,
    avgReturn: statsResult.avg_return,
    bestPick: bestResult
      ? { ticker: bestResult.ticker, returnPct: bestResult.profit_loss_pct }
      : null,
    worstPick: worstResult
      ? { ticker: worstResult.ticker, returnPct: worstResult.profit_loss_pct }
      : null,
  };
}
