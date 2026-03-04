/**
 * Custom Hooks for API Data Fetching
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  RecommendationsResponse,
  HistoryResponse,
  HistoryParams,
  LogEntry,
  SchedulerState,
  AvoidResponse,
  MarketOutlookData,
  TickerAnalysisResponse,
  AppConfig,
} from "./types";
import {
  getRecommendations,
  getHistory,
  triggerRefresh,
  getScheduler,
  startScheduler,
  stopScheduler,
  getAvoidList,
  getMarketOutlook,
  analyzeTicker,
  getConfig,
} from "./api";

interface UseQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useRecommendations(date?: string): UseQueryResult<RecommendationsResponse> {
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getRecommendations(date);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useHistory(params: HistoryParams): UseQueryResult<HistoryResponse> {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getHistory(params);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, [params.page, params.pageSize, params.ticker, params.status, params.startDate, params.endDate]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useRefresh(): {
  trigger: () => Promise<void>;
  loading: boolean;
  result: { triggered: boolean; message: string } | null;
} {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ triggered: boolean; message: string } | null>(null);

  const trigger = useCallback(async () => {
    setLoading(true);
    try {
      const response = await triggerRefresh();
      setResult({ triggered: response.triggered, message: response.message });
    } catch (err) {
      setResult({
        triggered: false,
        message: err instanceof Error ? err.message : "Failed to trigger refresh",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  return { trigger, loading, result };
}

// Global log store — persists across component mounts/navigation
let _globalLogs: LogEntry[] = [];
let _globalConnected = false;
let _globalEventSource: EventSource | null = null;
let _globalListeners = new Set<() => void>();

function _initGlobalLogStream(): void {
  if (_globalEventSource) return; // Already initialized

  const eventSource = new EventSource("/api/logs");
  _globalEventSource = eventSource;

  eventSource.onopen = () => {
    _globalConnected = true;
    _globalListeners.forEach((fn) => fn());
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as { type: string } & Partial<LogEntry>;
      if (data.type === "log" && data.level && data.message) {
        const entry: LogEntry = {
          timestamp: data.timestamp ?? new Date().toISOString(),
          level: data.level,
          message: data.message,
          step: data.step,
          totalSteps: data.totalSteps,
        };
        // Deduplicate by timestamp + message (SSE replays on reconnect)
        const isDupe = _globalLogs.some(
          (l) => l.timestamp === entry.timestamp && l.message === entry.message
        );
        if (!isDupe) {
          _globalLogs = [..._globalLogs, entry];
          _globalListeners.forEach((fn) => fn());
        }
      }
    } catch {
      // Ignore parse errors
    }
  };

  eventSource.onerror = () => {
    _globalConnected = false;
    _globalListeners.forEach((fn) => fn());
  };
}

export function useLogStream(): {
  logs: LogEntry[];
  connected: boolean;
  clear: () => void;
} {
  const [logs, setLogs] = useState<LogEntry[]>(_globalLogs);
  const [connected, setConnected] = useState(_globalConnected);

  useEffect(() => {
    _initGlobalLogStream();

    // Sync initial state
    setLogs(_globalLogs);
    setConnected(_globalConnected);

    // Subscribe to updates
    const listener = () => {
      setLogs(_globalLogs);
      setConnected(_globalConnected);
    };
    _globalListeners.add(listener);

    return () => {
      _globalListeners.delete(listener);
    };
  }, []);

  const clear = useCallback(() => {
    _globalLogs = [];
    _globalListeners.forEach((fn) => fn());
  }, []);

  return { logs, connected, clear };
}

export function useScheduler(): {
  state: SchedulerState | null;
  loading: boolean;
  toggle: () => Promise<void>;
  refetch: () => Promise<void>;
} {
  const [state, setState] = useState<SchedulerState | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const result = await getScheduler();
      setState(result);
    } catch {
      // Ignore fetch errors
    }
  }, []);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  const toggle = useCallback(async () => {
    setLoading(true);
    try {
      if (state?.enabled) {
        const result = await stopScheduler();
        setState(result);
      } else {
        const result = await startScheduler();
        setState(result);
      }
    } catch {
      // Ignore toggle errors
    } finally {
      setLoading(false);
    }
  }, [state?.enabled]);

  return { state, loading, toggle, refetch: fetchState };
}

export function useAvoidList(): UseQueryResult<AvoidResponse> {
  const [data, setData] = useState<AvoidResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAvoidList();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useMarketOutlook(): UseQueryResult<MarketOutlookData | null> {
  const [data, setData] = useState<MarketOutlookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getMarketOutlook();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useTickerAnalysis(): {
  analyze: (ticker: string) => Promise<void>;
  data: TickerAnalysisResponse | null;
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<TickerAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(async (ticker: string) => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await analyzeTicker(ticker);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze ticker");
    } finally {
      setLoading(false);
    }
  }, []);

  return { analyze, data, loading, error };
}

export function useConfig(): {
  data: AppConfig | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
} {
  const [data, setData] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getConfig();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useWebSocket(
  url: string,
  onMessage?: (data: any) => void
): { isConnected: boolean; lastMessage: any } {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let retryTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      // Construct full URL
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const fullUrl = url.startsWith("/") ? `${protocol}//${host}${url}` : url;

      const ws = new WebSocket(fullUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLastMessage(data);
          if (onMessageRef.current) {
            onMessageRef.current(data);
          }
        } catch (e) {
          console.error("Failed to parse WebSocket message", e);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        retryTimeout = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      clearTimeout(retryTimeout);
      wsRef.current?.close();
    };
  }, [url]);

  return { isConnected, lastMessage };
}
