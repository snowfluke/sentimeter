/**
 * Avoid Cache
 *
 * File-backed cache for AVOID/unrecommended tickers.
 * Persists to disk so data survives server restarts.
 * These are high-risk/high-return stocks that we display
 * temporarily but do NOT save as positions.
 */

import { join } from "path";
import { mkdirSync } from "fs";

export interface AvoidItem {
  ticker: string;
  companyName: string;
  sector: string | null;
  currentPrice: number;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  overallScore: number;
  sentimentScore: number;
  fundamentalScore: number;
  technicalScore: number;
  analysisSummary: string;
  riskPercent: number;
  rewardPercent: number;
  reason: string;
  detectedAt: string;
}

interface CacheFile {
  updatedAt: string;
  items: AvoidItem[];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = join(import.meta.dir, "../../data");
const CACHE_PATH = join(CACHE_DIR, "avoid-cache.json");

function ensureDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function readFromDisk(): CacheFile | null {
  try {
    const { readFileSync } = require("fs") as typeof import("fs");
    const text = readFileSync(CACHE_PATH, "utf-8");
    return JSON.parse(text) as CacheFile;
  } catch {
    return null;
  }
}

function writeToDisk(data: CacheFile): void {
  ensureDir();
  const { writeFileSync } = require("fs") as typeof import("fs");
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

export function setAvoidItems(items: AvoidItem[]): void {
  const data: CacheFile = { updatedAt: new Date().toISOString(), items };
  writeToDisk(data);
}

export function addAvoidItem(item: AvoidItem): void {
  const existing = getAvoidItems();
  const filtered = existing.filter((i) => i.ticker !== item.ticker);
  filtered.push(item);
  setAvoidItems(filtered);
}

export function getAvoidItems(): AvoidItem[] {
  const data = readFromDisk();
  if (!data) return [];

  const age = Date.now() - new Date(data.updatedAt).getTime();
  if (age > CACHE_TTL_MS) {
    return [];
  }

  return data.items;
}

export function clearAvoidItems(): void {
  const data: CacheFile = { updatedAt: new Date(0).toISOString(), items: [] };
  writeToDisk(data);
}
