/**
 * Market Outlook Cache
 *
 * File-backed cache for market outlook/global sentiment data.
 * Persists to disk so data survives server restarts.
 * Generated during analysis runs, displayed on dashboard.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";

export interface MarketOutlookData {
  summary: string;
  sentiment: "bullish" | "bearish" | "neutral";
  bullishSignals: string[];
  bearishSignals: string[];
  globalNews: NewsHighlight[];
  localNews: NewsHighlight[];
  generatedAt: string;
}

export interface NewsHighlight {
  title: string;
  sentiment: "positive" | "negative" | "neutral";
  source: string;
}

interface CacheFile {
  updatedAt: string;
  data: MarketOutlookData;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = join(import.meta.dir, "../../data");
const CACHE_PATH = join(CACHE_DIR, "market-outlook-cache.json");

function ensureDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function readFromDisk(): CacheFile | null {
  try {
    const text = readFileSync(CACHE_PATH, "utf-8");
    return JSON.parse(text) as CacheFile;
  } catch {
    return null;
  }
}

function writeToDisk(entry: CacheFile): void {
  ensureDir();
  writeFileSync(CACHE_PATH, JSON.stringify(entry, null, 2));
}

export function setMarketOutlook(data: MarketOutlookData): void {
  writeToDisk({ updatedAt: new Date().toISOString(), data });
}

export function getMarketOutlook(): MarketOutlookData | null {
  const entry = readFromDisk();
  if (!entry) return null;

  const age = Date.now() - new Date(entry.updatedAt).getTime();
  if (age > CACHE_TTL_MS) {
    return null;
  }

  return entry.data;
}

export function clearMarketOutlook(): void {
  ensureDir();
  writeFileSync(CACHE_PATH, JSON.stringify({ updatedAt: new Date(0).toISOString(), data: null }, null, 2));
}
