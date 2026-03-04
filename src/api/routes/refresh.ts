/**
 * Refresh Route
 *
 * POST /api/refresh - Trigger a manual analysis refresh with live logging
 */

import {
  hasJobRunToday,
  startJobExecution,
  completeJobExecution,
  failJobExecution,
} from "../../lib/database/queries.ts";
import type { JobSchedule } from "../../lib/database/types.ts";
import { jsonResponse } from "../middleware/cors.ts";
import type { RefreshResponse } from "../types.ts";
import { errorResponse, successResponse } from "../types.ts";
import { logEmitter } from "../log-emitter.ts";
import { runAnalysisWithLogging } from "./analysis-runner.ts";
import { getWibDateString } from "../../lib/wib.ts";

export async function handleRefresh(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Check if job is already running
    if (logEmitter.isRunning()) {
      logEmitter.info(`Analysis already in progress (Job ID: ${logEmitter.getJobId()}).`);
      const response: RefreshResponse = {
        triggered: false,
        schedule: "morning",
        jobId: logEmitter.getJobId(),
        message: `Analysis already in progress (Job ID: ${logEmitter.getJobId()}). Check /api/logs for live updates.`,
      };
      return jsonResponse(successResponse(response), 200, origin);
    }

    // Determine schedule based on WIB time (UTC+7)
    const options = { timeZone: "Asia/Jakarta", hour12: false };
    const parts = new Intl.DateTimeFormat('en-US', {
      ...options,
      hour: 'numeric',
    }).formatToParts(new Date());
    
    let hour = parseInt(parts.find(p => p.type === 'hour')?.value || "0");
    if (hour === 24) hour = 0; // Intl format sometimes returns 24 for 00:00

    const schedule: JobSchedule = hour < 12 ? "morning" : "evening";
    const today = getWibDateString();

    // Parse query params for force flag
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";

    // Check if already run today (unless force)
    if (!force && hasJobRunToday(schedule)) {
      logEmitter.info(`${schedule} analysis already completed for today. Use force to re-run.`);
      const response: RefreshResponse = {
        triggered: false,
        schedule,
        jobId: null,
        message: `${schedule} analysis already completed for today. Use ?force=true to run anyway.`,
      };
      return jsonResponse(successResponse(response), 200, origin);
    }

    // Start job execution
    const jobId = startJobExecution({
      schedule,
      executionDate: today,
    });

    // Return immediately, job runs in background
    const response: RefreshResponse = {
      triggered: true,
      schedule,
      jobId,
      message: `${schedule} analysis started (Job ID: ${jobId}). Connect to /api/logs for live updates.`,
    };

    // Run analysis in background (don't await)
    runAnalysisWithLogging(jobId, schedule).catch((err) => {
      console.error("Analysis failed:", err);
    });

    return jsonResponse(successResponse(response), 202, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Refresh error:", message);
    return jsonResponse(errorResponse(message), 500, origin);
  }
}
