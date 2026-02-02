# Sentimeter

A sentiment-based stock trading bot for the Indonesian Stock Exchange (IHSG/IDX). Sentimeter crawls financial news from Indonesian portals, extracts stock tickers using AI, fetches market data, and generates daily buy recommendations with entry prices, stop losses, and target prices.

![Sentimeter 1](/assets/sentimeter-1.png)
![Sentimeter 2](/assets/sentimeter-2.png)

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Development](#development)

## Features

- News Crawling: Scrapes 14 Indonesian financial news portals (Kontan, Bisnis, CNBC Indonesia, etc.)
- AI-Powered Analysis: Uses Google Gemini to extract stock tickers and analyze sentiment
- Market Data: Fetches real-time quotes and historical prices from Yahoo Finance
- Technical Analysis: Calculates SMA, ATR, support/resistance levels, and trend detection
- Recommendation Engine: Generates buy signals with entry price, stop loss, target price, and max hold days
- Prediction Tracking: Monitors active positions and updates status (pending, entry_hit, target_hit, sl_hit, expired)
- Scheduled Jobs: Runs automatically twice daily (morning before market open, evening after close)
- REST API: Exposes recommendations and history via HTTP endpoints
- React Dashboard: Professional UI for viewing recommendations and tracking performance
- Live Log Streaming: Real-time analysis progress via Server-Sent Events (SSE)
- Scheduler Control: Toggle auto-scheduler on/off from the dashboard
- Docker Support: Multi-stage Dockerfile for production deployment

## Architecture

```
                                    +------------------+
                                    |   React Frontend |
                                    |   (port 3000)    |
                                    +--------+---------+
                                             |
                                             v
+------------------+              +----------+---------+
|  News Portals    |              |    REST API        |
|  (14 sources)    +------------->|    (port 3001)     |
+------------------+              +----------+---------+
                                             |
        +------------------------------------+------------------------------------+
        |                    |                    |                    |          |
        v                    v                    v                    v          v
+-------+------+    +--------+-------+    +------+-------+    +-------+------+   |
|   Crawler    |    |    Analyzer    |    |  Market Data |    |   Prediction |   |
|              |    |    (Gemini)    |    | (Yahoo Fin)  |    |    Tracker   |   |
+--------------+    +----------------+    +--------------+    +--------------+   |
                                                                                 |
                                          +--------------------------------------+
                                          |
                                          v
                                  +-------+--------+
                                  |    SQLite      |
                                  |   Database     |
                                  +----------------+
```

## Analysis Strategy

The analysis pipeline runs in 5 sequential steps:

```
+==============================================================================+
|                          STEP 1: NEWS CRAWLING                               |
+==============================================================================+
|                                                                              |
|  +-------------+  +-------------+  +-------------+       +-------------+     |
|  |    CNBC     |  |   Bisnis    |  |   Kontan    |  ...  |  IDX Channel|     |
|  |  Indonesia  |  |   Market    |  |             |       |             |     |
|  +------+------+  +------+------+  +------+------+       +------+------+     |
|         |                |                |                     |            |
|         v                v                v                     v            |
|  +------+------+  +------+------+  +------+------+       +------+------+     |
|  | Fetch HTML  |  | Fetch HTML  |  | Fetch HTML  |       | Fetch HTML  |     |
|  | Parse Links |  | Parse Links |  | Parse Links |       | Parse Links |     |
|  +------+------+  +------+------+  +------+------+       +------+------+     |
|         |                |                |                     |            |
|         +----------------+----------------+---------------------+            |
|                                    |                                         |
|                                    v                                         |
|                          +---------+---------+                               |
|                          | Deduplicate by    |                               |
|                          | Content Hash      |                               |
|                          +---------+---------+                               |
|                                    |                                         |
|                                    v                                         |
|                          +---------+---------+                               |
|                          | Save to SQLite    |                               |
|                          | (news_articles)   |                               |
|                          +-------------------+                               |
|                                                                              |
+==============================================================================+
                                     |
                                     v
+==============================================================================+
|                       STEP 2: TICKER EXTRACTION                              |
+==============================================================================+
|                                                                              |
|  +-----------------+                                                         |
|  | Load Recent     |     Filter: Last 24 hours                               |
|  | News Articles   |     Limit: 200 chars content                            |
|  +--------+--------+                                                         |
|           |                                                                  |
|           v                                                                  |
|  +--------+--------+                                                         |
|  | Batch Articles  |     10 articles per batch                               |
|  | for LLM         |     (avoid quota limits)                                |
|  +--------+--------+                                                         |
|           |                                                                  |
|           v                                                                  |
|  +--------+-------------------+                                              |
|  |     Gemini LLM Prompt      |                                              |
|  |-----------------------------|                                             |
|  | "Extract Indonesian stock   |                                             |
|  |  tickers (4-letter codes)   |                                             |
|  |  with sentiment & relevance"|                                             |
|  +--------+-------------------+                                              |
|           |                                                                  |
|           v                                                                  |
|  +--------+--------+                                                         |
|  | JSON Response   |     { ticker, sentiment, relevance, reason }            |
|  | Parse & Merge   |                                                         |
|  +--------+--------+                                                         |
|           |                                                                  |
|           v                                                                  |
|  +--------+--------+                                                         |
|  | Aggregate by    |     Combine duplicates, avg sentiment                   |
|  | Ticker Symbol   |                                                         |
|  +-----------------+                                                         |
|                                                                              |
+==============================================================================+
                                     |
                                     v
+==============================================================================+
|                       STEP 3: FILTER TOP TICKERS                             |
+==============================================================================+
|                                                                              |
|  +-------------------+                                                       |
|  | All Extracted     |     Example: 50+ tickers                              |
|  | Tickers           |                                                       |
|  +--------+----------+                                                       |
|           |                                                                  |
|           v                                                                  |
|  +--------+----------+                                                       |
|  | Filter:           |     sentiment > 0.2 (positive bias)                   |
|  | Positive Sentiment|                                                       |
|  +--------+----------+                                                       |
|           |                                                                  |
|           v                                                                  |
|  +--------+----------+                                                       |
|  | Sort by:          |     1. Relevance (desc)                               |
|  | Relevance + Sent  |     2. Sentiment (desc)                               |
|  +--------+----------+                                                       |
|           |                                                                  |
|           v                                                                  |
|  +--------+----------+                                                       |
|  | Take Top 10       |     Example: BBCA, TLKM, BMRI...                      |
|  | Tickers           |                                                       |
|  +-------------------+                                                       |
|                                                                              |
+==============================================================================+
                                     |
                                     v
+==============================================================================+
|                    STEP 4: MARKET DATA & ANALYSIS                            |
+==============================================================================+
|                                                                              |
|  For each ticker (max 10):                                                   |
|                                                                              |
|  +-------------------+     +-------------------+     +-------------------+    |
|  | Yahoo Finance     |     | Yahoo Finance     |     | Yahoo Finance     |   |
|  | Quote API         |     | Fundamentals      |     | Historical Prices |   |
|  | (.JK suffix)      |     | (P/E, P/B, ROE)   |     | (3 months OHLCV)  |   |
|  +--------+----------+     +--------+----------+     +--------+----------+   |
|           |                         |                         |              |
|           +-------------------------+-------------------------+              |
|                                     |                                        |
|                                     v                                        |
|                    +----------------+----------------+                       |
|                    |     Technical Analysis          |                       |
|                    |----------------------------------|                      |
|                    | - SMA 20, 50, 200               |                       |
|                    | - ATR 14 (volatility)           |                       |
|                    | - Support/Resistance levels     |                       |
|                    | - Trend direction               |                       |
|                    +----------------+----------------+                       |
|                                     |                                        |
|                                     v                                        |
|                    +----------------+----------------+                       |
|                    |     Gemini LLM Analysis         |                       |
|                    |----------------------------------|                      |
|                    | Input:                          |                       |
|                    | - News sentiment                |                       |
|                    | - Fundamentals (P/E, ROE, etc) |                       |
|                    | - Technical indicators          |                       |
|                    | - Current price & trend         |                       |
|                    |                                  |                       |
|                    | Output:                          |                       |
|                    | - Action: BUY / HOLD / AVOID    |                       |
|                    | - Entry Price                   |                       |
|                    | - Stop Loss                     |                       |
|                    | - Target Price                  |                       |
|                    | - Max Hold Days                 |                       |
|                    | - Scores (0-100 each)           |                       |
|                    +----------------+----------------+                       |
|                                     |                                        |
|                                     v                                        |
|                    +----------------+----------------+                       |
|                    | Filter: Score >= 65 & BUY       |                       |
|                    +----------------+----------------+                       |
|                                     |                                        |
|                                     v                                        |
|                    +----------------+----------------+                       |
|                    | Save to SQLite                  |                       |
|                    | (recommendations table)         |                       |
|                    | Max 5 per run                   |                       |
|                    +---------------------------------+                       |
|                                                                              |
+==============================================================================+
                                     |
                                     v
+==============================================================================+
|                    STEP 5: UPDATE PREDICTIONS                                |
+==============================================================================+
|                                                                              |
|  +-------------------+                                                       |
|  | Load Active       |     status = 'pending' OR 'entry_hit'                 |
|  | Predictions       |                                                       |
|  +--------+----------+                                                       |
|           |                                                                  |
|           v                                                                  |
|  +--------+----------+                                                       |
|  | Fetch Current     |     Yahoo Finance real-time quote                     |
|  | Price for Each    |                                                       |
|  +--------+----------+                                                       |
|           |                                                                  |
|           v                                                                  |
|  +--------+-------------------------------+                                  |
|  |           Status Check Logic           |                                  |
|  |-----------------------------------------|                                 |
|  |                                         |                                 |
|  |  pending:                               |                                 |
|  |    price <= entry  -->  entry_hit       |                                 |
|  |                                         |                                 |
|  |  entry_hit:                             |                                 |
|  |    price >= target -->  target_hit      |                                 |
|  |    price <= stop   -->  sl_hit          |                                 |
|  |    days > max      -->  expired         |                                 |
|  |                                         |                                 |
|  +--------+-------------------------------+                                  |
|           |                                                                  |
|           v                                                                  |
|  +--------+----------+                                                       |
|  | Update SQLite     |     Record exit_date, exit_price, final status       |
|  | (recommendations) |                                                       |
|  +-------------------+                                                       |
|                                                                              |
+==============================================================================+
                                     |
                                     v
                          +----------+----------+
                          |   JOB COMPLETE      |
                          |---------------------|
                          | - Articles crawled  |
                          | - Tickers extracted |
                          | - Recommendations   |
                          | - Predictions updated|
                          +---------------------+
```

## Prerequisites

- Bun v1.0 or later (https://bun.sh)
- Antigravity Manager running locally (OpenAI-compatible LLM proxy)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/yourusername/sentimeter.git
cd sentimeter
```

2. Install backend dependencies:

```bash
bun install
```

3. Install frontend dependencies:

```bash
bun install --cwd web
```

4. Initialize the database:

```bash
bun run src/lib/database/migrate.ts
```

5. Start Antigravity Manager:

https://github.com/lbjlaq/Antigravity-Manager

## Configuration

Create a `.env` file in the project root:

```env
# Antigravity Manager (OpenAI-compatible proxy)
ANTIGRAVITY_BASE_URL=http://127.0.0.1:8045/v1
ANTIGRAVITY_API_KEY=your_antigravity_api_key_here
ANTIGRAVITY_MODEL=gemini-3.0-flash

# Optional: API server port (default: 3001)
PORT=3001
```

### Antigravity Manager Setup

Sentimeter uses Antigravity Manager as an LLM proxy to avoid quota issues with direct API calls. The proxy provides an OpenAI-compatible API that routes requests to Gemini models.

1. Install and start Antigravity Manager (from Google's Antigravity IDE)
2. Get your API key from the Antigravity Manager dashboard
3. Configure the environment variables above
4. Verify connection:

```bash
# Test the LLM client
bun test src/lib/analyzer/llm-client.test.ts
```

## Usage

### Running the API Server

```bash
bun run src/api/index.ts
```

The API will be available at http://localhost:3001

### Running the Frontend

```bash
cd web
bun run dev
```

The dashboard will be available at http://localhost:3000

### Running Daily Analysis Manually

```bash
bun run src/jobs/daily-analysis.ts
```

This will:

1. Crawl all news portals
2. Extract tickers using Gemini AI
3. Fetch market data from Yahoo Finance
4. Generate recommendations
5. Update existing prediction statuses

### Running the Scheduler

```bash
bun run src/jobs/scheduler.ts
```

The scheduler runs the analysis automatically at:

- Morning: 7:30 WIB (before market open)
- Evening: 16:30 WIB (after market close)

## API Reference

### GET /health

Health check endpoint.

Response:

```json
{
  "status": "ok",
  "service": "sentimeter",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### GET /api/recommendations

Get today's stock recommendations and active positions.

Query Parameters:

- date (optional): Specific date in YYYY-MM-DD format

Response:

```json
{
  "success": true,
  "data": {
    "date": "2024-01-15",
    "schedule": "morning",
    "generatedAt": "2024-01-15T07:30:00.000Z",
    "recommendations": [
      {
        "ticker": "BBCA",
        "companyName": "Bank Central Asia Tbk",
        "action": "BUY",
        "entryPrice": 9500,
        "stopLoss": 9200,
        "targetPrice": 10200,
        "maxHoldDays": 14,
        "overallScore": 78.5,
        "analysisSummary": "Strong earnings beat with positive sentiment..."
      }
    ],
    "activePositions": [],
    "summary": {
      "totalActive": 3,
      "totalPending": 2,
      "winRate": 65.5,
      "avgReturn": 4.2
    }
  }
}
```

### GET /api/history

Get historical recommendations with pagination and filters.

Query Parameters:

- page (default: 1)
- pageSize (default: 20, max: 100)
- ticker (optional): Filter by ticker
- status (optional): pending, entry_hit, target_hit, sl_hit, expired
- startDate (optional): YYYY-MM-DD
- endDate (optional): YYYY-MM-DD

Response:

```json
{
  "success": true,
  "data": {
    "items": [],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 150,
      "totalPages": 8
    },
    "stats": {
      "totalRecommendations": 150,
      "winRate": 62.3,
      "avgReturn": 3.8,
      "bestPick": { "ticker": "TLKM", "returnPct": 15.2 },
      "worstPick": { "ticker": "ASII", "returnPct": -8.1 }
    }
  }
}
```

### POST /api/refresh

Trigger a manual analysis refresh.

Response:

```json
{
  "success": true,
  "data": {
    "triggered": true,
    "schedule": "morning",
    "jobId": 42,
    "message": "morning analysis triggered. Job ID: 42."
  }
}
```

## Project Structure

```
sentimeter/
├── src/
│   ├── api/                    # REST API server
│   │   ├── index.ts            # Server entry point
│   │   ├── types.ts            # API response types
│   │   ├── middleware/
│   │   │   └── cors.ts         # CORS handling
│   │   └── routes/
│   │       ├── recommendations.ts
│   │       ├── history.ts
│   │       └── refresh.ts
│   │
│   ├── jobs/                   # Scheduled jobs
│   │   ├── daily-analysis.ts   # Main analysis pipeline
│   │   └── scheduler.ts        # Cron-like scheduler
│   │
│   └── lib/                    # Core libraries
│       ├── analyzer/           # Gemini LLM integration
│       │   ├── types.ts
│       │   ├── gemini-client.ts
│       │   ├── ticker-extractor.ts
│       │   └── stock-analyzer.ts
│       │
│       ├── crawler/            # News scraping
│       │   ├── types.ts
│       │   ├── portal-configs.ts
│       │   ├── fetcher.ts
│       │   ├── parser.ts
│       │   ├── deduplicator.ts
│       │   └── orchestrator.ts
│       │
│       ├── database/           # SQLite with Bun
│       │   ├── types.ts
│       │   ├── schema.ts
│       │   ├── queries.ts
│       │   └── migrate.ts
│       │
│       ├── market-data/        # Yahoo Finance
│       │   ├── types.ts
│       │   ├── yahoo-client.ts
│       │   ├── fundamental.ts
│       │   └── technical.ts
│       │
│       └── prediction-tracker/ # Position tracking
│           ├── types.ts
│           ├── status-checker.ts
│           └── updater.ts
│
├── web/                        # React frontend
│   ├── src/
│   │   ├── components/         # UI components
│   │   ├── pages/              # Dashboard, History
│   │   ├── lib/                # API client, hooks
│   │   └── App.tsx
│   ├── package.json
│   └── vite.config.ts
│
├── data/                       # SQLite database files
├── .env                        # Environment variables
├── package.json
└── tsconfig.json
```

## How It Works

### 1. News Crawling

The crawler fetches articles from 14 Indonesian financial news portals:

- Kontan, Bisnis Indonesia, CNBC Indonesia
- Detik Finance, Kompas Money, Liputan6 Bisnis
- Tempo Bisnis, Tribun Bisnis, Okezone Economy
- IDN Times Business, Kumparan Bisnis
- Investor Daily, Market Bisnis, IDX Channel

Each portal has custom CSS selectors for extracting article titles, content, and dates. The crawler uses rate limiting (1.5-2s delays) to avoid being blocked.

### 2. Ticker Extraction

Articles are sent to Google Gemini with a prompt asking it to:

- Extract Indonesian stock tickers (4-letter codes like BBCA, TLKM)
- Rate sentiment from -1 (bearish) to 1 (bullish)
- Rate relevance from 0 to 1
- Provide reasoning for each ticker

### 3. Market Data Fetching

For each extracted ticker, the system fetches:

- Quote: Current price, volume, change
- Fundamentals: P/E, P/B, ROE, debt-to-equity, dividend yield
- Price History: 3 months of OHLCV data

Indonesian stocks use the .JK suffix on Yahoo Finance (e.g., BBCA.JK).

### 4. Technical Analysis

From price history, the system calculates:

- Simple Moving Averages (SMA 20, 50, 200)
- Average True Range (ATR 14)
- Support and resistance levels
- Trend direction and strength

### 5. Recommendation Generation

Gemini analyzes all data and generates:

- Action: BUY, HOLD, or AVOID
- Entry Price: Suggested buy price
- Stop Loss: Maximum loss threshold (typically 3-5% below entry)
- Target Price: Profit target (typically 5-10% above entry)
- Max Hold Days: Position duration limit (typically 7-21 days)
- Scores: Sentiment (0-100), Fundamental (0-100), Technical (0-100), Overall (0-100)

Only recommendations with overall score >= 65 and action = BUY are saved.

### 6. Prediction Tracking

Active predictions are monitored for status changes:

- pending: Waiting for price to hit entry level
- entry_hit: Position opened, monitoring for target/stop
- target_hit: Target price reached, closed with profit
- sl_hit: Stop loss hit, closed with loss
- expired: Max hold days exceeded, closed at market

## Development

### Type Checking

```bash
# Backend
bunx tsc --noEmit

# Frontend
bunx tsc --noEmit --project web/tsconfig.json
```

### Adding a New News Portal

1. Add configuration to src/lib/crawler/portal-configs.ts:

```typescript
{
  name: "portal-name",
  baseUrl: "https://example.com/finance",
  articleLinkSelector: "a.article-link",
  titleSelector: "h1.title",
  contentSelector: "div.article-body",
  dateSelector: "time.published",
  removeSelectors: [".ads", ".related"],
  delayMs: 2000,
}
```

2. Add parser logic if needed in src/lib/crawler/parser.ts.

### Database Schema

The SQLite database contains these tables:

- news_articles: Crawled news with content hash for deduplication
- news_tickers: Extracted tickers with sentiment scores
- recommendations: Generated buy signals with price targets
- stock_fundamentals: Cached company data
- price_history: Historical OHLCV data
- job_executions: Job run history and status

### Environment Variables

| Variable             | Required | Description                                                     |
| -------------------- | -------- | --------------------------------------------------------------- |
| ANTIGRAVITY_BASE_URL | Yes      | Antigravity Manager API URL (default: http://127.0.0.1:8045/v1) |
| ANTIGRAVITY_API_KEY  | Yes      | Antigravity Manager API key                                     |
| ANTIGRAVITY_MODEL    | No       | Model to use (default: gemini-2.0-flash)                        |
| PORT                 | No       | API server port (default: 3001)                                 |

## Disclaimer

This software is for educational purposes only. Stock trading involves significant risk of loss. The recommendations generated by this system should not be considered financial advice. Always do your own research and consult with a qualified financial advisor before making investment decisions.

## License

MIT
