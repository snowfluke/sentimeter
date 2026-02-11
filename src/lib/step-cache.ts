/**
 * Step Cache
 *
 * File-based cache for analysis pipeline steps.
 * Allows failed runs to resume from the last completed step
 * within a 1-hour window. Keyed by date + schedule to prevent
 * morning/evening runs from interfering with each other.
 */

import { join } from "path";
import { mkdirSync, readdirSync, unlinkSync } from "fs";

const CACHE_DIR = join(import.meta.dir, "../../data/step-cache");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry<T> {
  cachedAt: string;
  data: T;
}

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function getCachePath(date: string, schedule: string, step: number): string {
  return join(CACHE_DIR, `${date}_${schedule}_step${step}.json`);
}

/**
 * Read cached step output. Returns null if missing or expired (>1 hour).
 */
export async function getStepCache<T>(date: string, schedule: string, step: number): Promise<T | null> {
  const file = Bun.file(getCachePath(date, schedule, step));

  if (!(await file.exists())) {
    return null;
  }

  try {
    const entry = (await file.json()) as CacheEntry<T>;
    const age = Date.now() - new Date(entry.cachedAt).getTime();

    if (age > CACHE_TTL_MS) {
      return null;
    }

    return entry.data;
  } catch {
    return null;
  }
}

/**
 * Persist step output to disk for later resume.
 */
export async function setStepCache<T>(date: string, schedule: string, step: number, data: T): Promise<void> {
  ensureCacheDir();
  const entry: CacheEntry<T> = {
    cachedAt: new Date().toISOString(),
    data,
  };
  await Bun.write(getCachePath(date, schedule, step), JSON.stringify(entry, null, 2));
}

/**
 * Find the first step that is NOT cached (i.e., where to resume from).
 * Returns totalSteps + 1 if all steps are cached.
 */
export async function getResumeStep(date: string, schedule: string, totalSteps: number): Promise<number> {
  for (let step = 1; step <= totalSteps; step++) {
    const cached = await getStepCache(date, schedule, step);
    if (cached === null) {
      return step;
    }
  }
  return totalSteps + 1;
}

/**
 * Remove all cached step files for a given date + schedule.
 */
export async function clearStepCache(date: string, schedule: string): Promise<void> {
  ensureCacheDir();
  const prefix = `${date}_${schedule}_step`;

  try {
    for (const file of readdirSync(CACHE_DIR)) {
      if (file.startsWith(prefix)) {
        unlinkSync(join(CACHE_DIR, file));
      }
    }
  } catch {
    // Cache directory may not exist yet
  }
}
