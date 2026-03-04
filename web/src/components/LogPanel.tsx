/**
 * Log Panel Component
 *
 * Displays live analysis logs from SSE stream.
 */

import { useEffect, useRef } from "react";
import type { LogEntry } from "@/lib";

interface LogPanelProps {
  logs: LogEntry[];
  connected: boolean;
  visible?: boolean;
}

const levelStyles: Record<LogEntry["level"], string> = {
  info: "text-gray-600",
  success: "text-green-600",
  warning: "text-yellow-600",
  error: "text-red-600",
  step: "text-blue-600 font-semibold",
};

const levelIcons: Record<LogEntry["level"], string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
  step: "📍",
};

export function LogPanel({ logs, connected, visible = false }: LogPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs]);

  if (!visible && logs.length === 0) {
    return null;
  }

  return (
    <div className="bg-gray-900 rounded-lg overflow-hidden">
      <div className="flex items-center px-4 py-2 bg-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-gray-300 text-sm font-medium">Analysis Logs</span>
          <span
            className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
            title={connected ? "Connected" : "Disconnected"}
          />
        </div>
      </div>
      <div
        ref={containerRef}
        className="p-4 max-h-96 overflow-y-auto font-mono text-sm space-y-1 scroll-smooth"
      >
        {logs.length === 0 ? (
          <div className="text-gray-500 text-center py-4">
            Waiting for logs...
          </div>
        ) : (
          logs.map((log, index) => (
            <div key={index} className={`${levelStyles[log.level]} flex gap-2`}>
              <span className="flex-shrink-0">{levelIcons[log.level]}</span>
              <span className="text-gray-500 flex-shrink-0">
                {new Date(log.timestamp).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}
              </span>
              {log.step && log.totalSteps && (
                <span className="text-blue-400 flex-shrink-0">
                  [{log.step}/{log.totalSteps}]
                </span>
              )}
              <span>{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
