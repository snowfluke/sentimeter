/**
 * Recommendation Card Component
 */

import type { RecommendationItem } from "@/lib/types";
import { Card } from "./Card";
import { Badge } from "./Badge";
import { ScoreGauge } from "./ScoreGauge";
import { formatCurrency, formatPercent, getStatusColor, getStatusLabel } from "@/lib/format";

interface RecommendationCardProps {
  recommendation: RecommendationItem;
}

export function RecommendationCard({ recommendation: rec }: RecommendationCardProps) {
  return (
    <Card className="hover:shadow-md transition-shadow">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-0 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-bold text-gray-900">{rec.ticker}</h3>
            <Badge variant={rec.action === "buy" ? "success" : "danger"}>
              {rec.action.toUpperCase()}
            </Badge>
            <Badge className={getStatusColor(rec.status)}>{getStatusLabel(rec.status)}</Badge>
          </div>
          <p className="text-sm text-gray-500 mt-1">{rec.companyName}</p>
          {rec.sector && <p className="text-xs text-gray-400">{rec.sector}</p>}
        </div>
        <ScoreGauge score={rec.overallScore} label="Score" size="md" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div className="text-center p-3 bg-gray-50 rounded-lg">
          <p className="text-xs text-gray-500">Entry</p>
          <p className="font-semibold text-gray-900">{formatCurrency(rec.entryPrice)}</p>
        </div>
        <div className="text-center p-3 bg-danger-50 rounded-lg">
          <p className="text-xs text-danger-600">Stop Loss</p>
          <p className="font-semibold text-danger-600">{formatCurrency(rec.stopLoss)}</p>
          <p className="text-xs text-danger-500">{formatPercent(-rec.riskPercent)}</p>
        </div>
        <div className="text-center p-3 bg-success-50 rounded-lg">
          <p className="text-xs text-success-600">Target</p>
          <p className="font-semibold text-success-600">{formatCurrency(rec.targetPrice)}</p>
          <p className="text-xs text-success-500">{formatPercent(rec.rewardPercent)}</p>
        </div>
      </div>

      <div className="flex justify-between items-center mb-4 text-sm">
        <span className="text-gray-500">Risk/Reward Ratio</span>
        <span className="font-medium text-primary-600">1:{rec.riskRewardRatio.toFixed(1)}</span>
      </div>

      <div className="flex justify-between items-center mb-4 text-sm">
        <span className="text-gray-500">Max Hold Days</span>
        <span className="font-medium">{rec.maxHoldDays} days</span>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="text-center">
          <p className="text-xs text-gray-400">Sentiment</p>
          <p className="font-medium text-sm">{rec.sentimentScore.toFixed(0)}</p>
        </div>
        <div className="text-center">
          <p className="text-xs text-gray-400">Fundamental</p>
          <p className="font-medium text-sm">{rec.fundamentalScore.toFixed(0)}</p>
        </div>
        <div className="text-center">
          <p className="text-xs text-gray-400">Technical</p>
          <p className="font-medium text-sm">{rec.technicalScore.toFixed(0)}</p>
        </div>
      </div>

      <div className="border-t pt-4">
        <p className="text-sm text-gray-600 line-clamp-3" title={rec.analysisSummary}>{rec.analysisSummary}</p>
      </div>

      <div className="mt-3 p-2 bg-primary-50 rounded text-sm text-primary-700">
        {rec.statusMessage}
      </div>
    </Card>
  );
}
