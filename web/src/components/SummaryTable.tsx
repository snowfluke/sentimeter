/**
 * Summary Table
 *
 * Compact table combining new recommendations and active positions
 * for easy screenshotting and sharing. Sorted by P&L descending.
 */

import { useState } from "react";
import type { RecommendationItem, ActivePositionItem } from "@/lib/types";

const PAGE_SIZE = 10;

interface SummaryTableProps {
  recommendations: RecommendationItem[];
  activePositions: ActivePositionItem[];
  date: string;
}

type SignalType =
  | "BUY"
  | "HOLD"
  | "NEAR_TP"
  | "NEAR_SL"
  | "CONSIDER_TP"
  | "CONSIDER_SL"
  | "WAITING";

type TableRow = {
  ticker: string;
  signal: SignalType;
  entry: number;
  current: number;
  target: number;
  stopLoss: number;
  pnl: number | null;
  score: number | null;
  days: number;
};

function formatPrice(price: number): string {
  return price.toLocaleString("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPnl(pnl: number | null): string {
  if (pnl === null) return "-";
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}${pnl.toFixed(1)}%`;
}

function getPnlColor(pnl: number | null): string {
  if (pnl === null) return "text-gray-500";
  if (pnl > 0) return "text-green-600 font-semibold";
  if (pnl < 0) return "text-red-600 font-semibold";
  return "text-gray-600";
}

const SIGNAL_STYLES: Record<SignalType, string> = {
  BUY: "bg-blue-100 text-blue-800",
  HOLD: "bg-amber-100 text-amber-800",
  NEAR_TP: "bg-green-100 text-green-800",
  NEAR_SL: "bg-red-100 text-red-800",
  CONSIDER_TP: "bg-emerald-50 text-emerald-700",
  CONSIDER_SL: "bg-orange-50 text-orange-700",
  WAITING: "bg-gray-100 text-gray-600",
};

const SIGNAL_LABELS: Record<SignalType, string> = {
  BUY: "BUY",
  HOLD: "HOLD",
  NEAR_TP: "Near TP",
  NEAR_SL: "Near SL",
  CONSIDER_TP: "Take Profit",
  CONSIDER_SL: "Cut Loss",
  WAITING: "Waiting",
};

function deriveSignal(pos: ActivePositionItem): SignalType {
  const current = pos.currentPrice ?? pos.entryPrice;
  const distToTarget = ((pos.targetPrice - current) / current) * 100;
  const distToSl = ((current - pos.stopLoss) / current) * 100;

  if (pos.status === "pending") return "WAITING";

  // Within 2% of target → near TP
  if (distToTarget <= 2 && distToTarget > 0) return "NEAR_TP";
  // Already past target → consider taking profit
  if (distToTarget <= 0) return "CONSIDER_TP";
  // Within 2% of stop loss → near SL
  if (distToSl <= 2 && distToSl > 0) return "NEAR_SL";
  // Already below stop loss → cut loss
  if (distToSl <= 0) return "CONSIDER_SL";

  return "HOLD";
}

export function SummaryTable({ recommendations, activePositions, date }: SummaryTableProps) {
  const [page, setPage] = useState(0);

  const rows: TableRow[] = [
    ...recommendations.map((rec): TableRow => ({
      ticker: rec.ticker,
      signal: "BUY",
      entry: rec.entryPrice,
      current: rec.currentPrice,
      target: rec.targetPrice,
      stopLoss: rec.stopLoss,
      pnl: null,
      score: rec.overallScore,
      days: 0,
    })),
    ...activePositions.map((pos): TableRow => ({
      ticker: pos.ticker,
      signal: deriveSignal(pos),
      entry: pos.entryPrice,
      current: pos.currentPrice ?? pos.entryPrice,
      target: pos.targetPrice,
      stopLoss: pos.stopLoss,
      pnl: pos.unrealizedPnlPct,
      score: null,
      days: pos.daysHeld,
    })),
  ];

  // Sort: positions with P&L first (descending), then new recs by score
  rows.sort((a, b) => {
    if (a.pnl !== null && b.pnl !== null) return b.pnl - a.pnl;
    if (a.pnl !== null) return -1;
    if (b.pnl !== null) return 1;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  if (rows.length === 0) {
    return null;
  }

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pagedRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const formattedDate = new Date(date).toLocaleDateString("id-ID", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
      <div className="bg-gradient-to-r from-indigo-600 to-indigo-700 px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-bold text-lg">Sentimeter Summary</h3>
          <span className="text-indigo-200 text-sm">{formattedDate}</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-gray-700">Ticker</th>
              <th className="px-3 py-2 text-center font-semibold text-gray-700">Signal</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">Entry</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">Current</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">Target</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">SL</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">P&L</th>
              <th className="px-3 py-2 text-center font-semibold text-gray-700">Days</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pagedRows.map((row, idx) => (
              <tr key={`${row.ticker}-${idx}`} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-bold text-gray-900">{row.ticker}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${SIGNAL_STYLES[row.signal]}`}>
                    {SIGNAL_LABELS[row.signal]}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-gray-700">{formatPrice(row.entry)}</td>
                <td className="px-3 py-2 text-right text-gray-900 font-medium">{formatPrice(row.current)}</td>
                <td className="px-3 py-2 text-right text-green-700">{formatPrice(row.target)}</td>
                <td className="px-3 py-2 text-right text-red-700">{formatPrice(row.stopLoss)}</td>
                <td className={`px-3 py-2 text-right ${getPnlColor(row.pnl)}`}>{formatPnl(row.pnl)}</td>
                <td className="px-3 py-2 text-center text-gray-600">{row.days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-gray-50 px-4 py-2 border-t border-gray-200">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{recommendations.length} new + {activePositions.length} active = {rows.length} total</span>
          {totalPages > 1 ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-0.5 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-100"
              >
                Prev
              </button>
              <span>{page + 1}/{totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-0.5 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-100"
              >
                Next
              </button>
            </div>
          ) : (
            <span>sentimeter.app</span>
          )}
        </div>
      </div>
    </div>
  );
}
