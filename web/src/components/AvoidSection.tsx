/**
 * Avoid Section Component
 *
 * Displays unrecommended/avoid tickers temporarily.
 * High risk, high return - NOT saved as positions.
 */

import type { AvoidItem } from "@/lib/types";
import { Card } from "./Card";
import { formatCurrency, formatPercent } from "@/lib/format";

interface AvoidSectionProps {
  items: AvoidItem[];
}

export function AvoidSection({ items }: AvoidSectionProps) {
  if (items.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          Avoid / High Risk ({items.length})
        </h2>
        <span className="text-xs bg-danger-50 text-danger-600 px-2 py-0.5 rounded-full font-medium">
          Not Saved
        </span>
      </div>

      <Card className="border-danger-200 bg-danger-50/30">
        <p className="text-sm text-danger-700 mb-4">
          These tickers were flagged as high risk / high return during analysis.
          They are displayed for awareness only and are NOT saved as positions.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-danger-200">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Ticker</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-700">Price</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-700">Risk</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-700">Reward</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-700">Score</th>
                <th className="px-3 py-2 text-left font-semibold text-gray-700">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-danger-100">
              {items.map((item) => (
                <tr key={item.ticker} className="hover:bg-danger-50">
                  <td className="px-3 py-2">
                    <p className="font-bold text-gray-900">{item.ticker}</p>
                    <p className="text-xs text-gray-500">{item.companyName}</p>
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {formatCurrency(item.currentPrice)}
                  </td>
                  <td className="px-3 py-2 text-right text-danger-600 font-medium">
                    {formatPercent(-item.riskPercent)}
                  </td>
                  <td className="px-3 py-2 text-right text-success-600 font-medium">
                    {formatPercent(item.rewardPercent)}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {item.overallScore.toFixed(0)}
                  </td>
                  <td className="px-3 py-2 text-gray-600 text-xs max-w-xs truncate" title={item.analysisSummary}>
                    {item.analysisSummary}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
