import { sign as cryptoSign } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { hashJson, readJson, writeJson } from "./core.mjs";
import { parseOhlcvCsv, runBacktest, validateStrategy } from "./backtest.mjs";
import { fetchBinanceKlines } from "./market-data.mjs";
import { didFromPrivateKey } from "./did.mjs";

const BASE_URL = "https://technocore.chat";
const TRIGGER = /^\s*(?:!bt|bt:|@tradecore)\s+/i;
const INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);
const INTERVAL_MS = new Map([
  ["1m", 60_000],
  ["5m", 300_000],
  ["15m", 900_000],
  ["1h", 3_600_000],
  ["4h", 14_400_000],
  ["1d", 86_400_000],
]);
const MAX_BARS = 60_000;
const PER_AUTHOR_PER_DAY = 3;
const GLOBAL_PER_DAY = 40;
const DAY_MS = 86_400_000;
const DISCLAIMER = "paper research only, not financial advice";

function cleanSingleLine(value, limit = 4096) {
  const cleaned = String(value).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u2028\u2029]/gu, " ").replace(/ {2,}/g, " ").trim();
  if (!cleaned) throw new Error("Message text is empty.");
  if (cleaned.length > limit) throw new Error(`Message text exceeds ${limit} characters.`);
  return cleaned;
}

function utcDateOnly(ms) {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

export function parseThesisRequest(text, { nowMs = Date.now() } = {}) {
  const raw = String(text ?? "");
  if (!TRIGGER.test(raw)) return null;
  let rest = raw.replace(TRIGGER, " ");

  const take = (pattern) => {
    const match = rest.match(pattern);
    if (match) rest = rest.replace(pattern, " ");
    return match;
  };

  const from = take(/\bfrom[ =](\d{4}-\d{2}-\d{2})\b/i)?.[1] ?? "2023-01-01";
  const to = take(/\bto[ =](\d{4}-\d{2}-\d{2})\b/i)?.[1] ?? utcDateOnly(nowMs);
  const smaPair = take(/\b(?:sma[ =]?)?(\d{1,4})\s*\/\s*(\d{1,5})\b/);
  const fast = smaPair ? Number(smaPair[1]) : 20;
  const slow = smaPair ? Number(smaPair[2]) : 100;
  const intervalMatch = take(/\b(1m|5m|15m|1h|4h|1d)\b/i);
  const interval = (intervalMatch?.[1] ?? "1h").toLowerCase();

  let symbol = null;
  const symbolMatch = rest.match(/\b([A-Z]{2,12}(?:USDT|USDC|BTC|ETH|BNB))\b/i)
    ?? rest.match(/\b([A-Z]{3,10})\b/);
  if (symbolMatch) {
    symbol = symbolMatch[1].toUpperCase();
    rest = rest.replace(symbolMatch[0], " ");
    const isQuotedPair = /(USDT|USDC)$/.test(symbol) || (/(BTC|ETH|BNB)$/.test(symbol) && symbol.length >= 6);
    if (!isQuotedPair) symbol = `${symbol}USDT`;
  }

  const thesis = rest.replace(/\s+/g, " ").trim().slice(0, 900);
  if (!symbol) return { error: "missing_symbol" };
  if (!INTERVALS.has(interval)) return { error: "bad_interval" };
  if (!(fast >= 2 && slow > fast && slow <= 10_000)) return { error: "bad_sma" };
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return { error: "bad_range" };
  const bars = Math.floor((endMs - startMs) / INTERVAL_MS.get(interval));
  if (bars > MAX_BARS) return { error: "range_too_large", bars, maxBars: MAX_BARS };
  if (bars < slow + 103) return { error: "range_too_small", bars };

  return {
    symbol,
    interval,
    fast,
    slow,
    start: `${from}T00:00:00Z`,
    end: `${to}T00:00:00Z`,
    thesis: thesis || "(no thesis text provided)",
  };
}

export function buildStrategyFromRequest(request) {
  const id = `chat-${request.symbol.toLowerCase()}-${request.interval}-${request.fast}-${request.slow}`.slice(0, 48);
  return validateStrategy({
    schema: "tradecore-strategy-v1",
    id,
    name: `Chat request: ${request.symbol} ${request.interval} SMA ${request.fast}/${request.slow}`,
    hypothesis: request.thesis,
    market: { venue: "binance-spot", symbol: request.symbol, interval: request.interval },
    rules: { type: "sma-cross", fast: request.fast, slow: request.slow, position: "long_only" },
    costs: { feeBps: 10, slippageBps: 10 },
    evaluation: { holdoutFraction: 0.3, minHoldoutBars: 100, maxDrawdownPct: 50 },
  });
}

const pct = (value) => (value === null || value === undefined ? "n/a" : `${value.toFixed(1)}%`);

export function formatReply(report, { requestSeq }) {
  const oos = report.metrics.outOfSample;
  const inSample = report.metrics.inSample;
  const bench = report.metrics.benchmark.outOfSample;
  const gate = report.gate.passedMechanicalGates ? "PASS" : "REVIEW";
  const line = [
    `tradecore-bt-v1 ${gate}`,
    `${report.strategy.market.symbol} ${report.strategy.market.interval} sma ${report.strategy.rules.fast}/${report.strategy.rules.slow}`,
    `OOS net ${pct(oos.netReturnPct)} sharpe ${oos.sharpe ?? "n/a"} maxDD ${pct(oos.maxDrawdownPct)} (B&H ${pct(bench.netReturnPct)})`,
    `IS net ${pct(inSample.netReturnPct)}`,
    `bars ${report.data.bars} holdout ${report.split.holdoutBars}`,
    `strat:${report.strategyHash.slice(0, 10)} data:${String(report.data.sha256).slice(0, 10)} report:${hashJson(report).slice(0, 10)}`,
    DISCLAIMER,
    `re:${requestSeq}`,
  ].join(" | ");
  return cleanSingleLine(line);
}

export function formatErrorReply(error, requestSeq) {
  const reasons = {
    missing_symbol: "no symbol found",
    bad_interval: "interval must be 1m/5m/15m/1h/4h/1d",
    bad_sma: "sma must be fast/slow with fast<slow",
    bad_range: "dates must be from<to (YYYY-MM-DD)",
    range_too_large: `too many bars for this interval (max ${MAX_BARS})`,
    range_too_small: "range too short for the requested slow SMA",
    rate_limited: "rate limit reached (3 requests per DID/nick per day)",
    engine_error: "backtest failed",
  };
  const reason = reasons[error.code] ?? error.code;
  const detail = error.detail ? ` (${cleanSingleLine(error.detail, 120)})` : "";
  return cleanSingleLine(
    `tradecore-bt-v1 error re:${requestSeq} ${reason}${detail} | usage: bt: SYMBOL [1h] [sma 20/100] [from 2023-01-01] [to 2026-01-01] your thesis | ${DISCLAIMER}`,
  );
}

export function signRoomMessage(privateKey, room, text, nonce) {
  const cleaned = cleanSingleLine(text);
  const canonical = `${room}|${nonce}|${cleaned}`;
  const sig = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
  return { did: didFromPrivateKey(privateKey), sig, nonce: String(nonce), text: cleaned };
}

export async function readRoom(room, { since, wait, limit } = {}, fetchImpl = fetch) {
  const url = new URL(`${BASE_URL}/r/${room}`);
  url.searchParams.set("format", "json");
  if (since !== undefined) url.searchParams.set("since", String(since));
  if (wait !== undefined) url.searchParams.set("wait", String(wait));
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  const response = await fetchImpl(url, { redirect: "error" });
  const body = await response.text();
  if (!response.ok) throw new Error(`Technocore returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed.messages)) throw new Error("Technocore JSON response is missing messages.");
  return parsed;
}

export async function postSigned(room, text, privateKey, fetchImpl = fetch, nonce = Date.now()) {
  const payload = signRoomMessage(privateKey, room, text, nonce);
  const response = await fetchImpl(`${BASE_URL}/r/${room}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Technocore signed post failed HTTP ${response.status}: ${body.slice(0, 200)}`);
  return { status: response.status, body: body.slice(0, 200), did: payload.did, nonce: payload.nonce };
}

export function createRateLimiter(state) {
  state.usage ??= {};
  state.globalUse ??= [];
  return {
    allow(author, nowMs = Date.now()) {
      const floor = nowMs - DAY_MS;
      state.globalUse = state.globalUse.filter((ts) => ts > floor);
      const mine = (state.usage[author] ?? []).filter((ts) => ts > floor);
      state.usage[author] = mine;
      if (state.globalUse.length >= GLOBAL_PER_DAY) return false;
      if (mine.length >= PER_AUTHOR_PER_DAY) return false;
      mine.push(nowMs);
      state.globalUse.push(nowMs);
      return true;
    },
  };
}

export async function executeRequest(request, { fetchImpl = fetch, artifactsDir } = {}) {
  const market = await fetchBinanceKlines({
    symbol: request.symbol,
    interval: request.interval,
    start: request.start,
    end: request.end,
    maxBars: MAX_BARS,
  }, fetchImpl);
  const bars = parseOhlcvCsv(market.csv);
  const strategy = buildStrategyFromRequest(request);
  const strategyHash = hashJson(strategy);
  const proposal = {
    schema: "tradecore-proposal-v1",
    createdAt: new Date().toISOString(),
    strategy,
    strategyHash,
    lock: {
      rule: "The strategy and evaluation settings above must not change after results are observed.",
      nextStep: "This chat-triggered run is historical research; forward evidence still requires a sealed forward test.",
    },
  };
  const report = runBacktest(strategy, bars, {
    dataHash: market.provenance.csvSha256,
    dataLabel: `binance-spot:${request.symbol}:${request.interval}`,
  });
  report.data.provenance = market.provenance;
  const artifact = { schema: "tradecore-bt-agent-run-v1", request, proposal, report };
  let outputPath = null;
  if (artifactsDir) {
    await mkdir(artifactsDir, { recursive: true });
    outputPath = resolve(artifactsDir, `run-${Date.now()}-${hashJson(report).slice(0, 10)}.json`);
    await writeJson(outputPath, artifact);
  }
  return { report, proposal, outputPath };
}

export async function loadState(path) {
  if (existsSync(path)) return readJson(path);
  return { lastSeq: 0, usage: {}, globalUse: [] };
}

export async function runAgentOnce(options) {
  const {
    room,
    identity,
    statePath,
    artifactsDir,
    fetchImpl = fetch,
    wait = 0,
    log = () => {},
  } = options;
  const state = await loadState(statePath);
  const limiter = createRateLimiter(state);
  const page = await readRoom(room, { since: state.lastSeq || undefined, wait, limit: 200 }, fetchImpl);
  const replies = [];
  for (const message of page.messages) {
    if (message.seq <= (state.lastSeq ?? 0)) continue;
    state.lastSeq = message.seq;
    if (message.from === identity.did) continue;
    if (!TRIGGER.test(message.text ?? "")) continue;
    const request = parseThesisRequest(message.text);
    let reply;
    if (request?.error) {
      reply = formatErrorReply({ code: request.error }, message.seq);
    } else if (!limiter.allow(message.from)) {
      reply = formatErrorReply({ code: "rate_limited" }, message.seq);
    } else {
      log(`Running backtest for seq ${message.seq}: ${request.symbol} ${request.interval} ${request.fast}/${request.slow}`);
      try {
        const run = await executeRequest(request, { fetchImpl, artifactsDir });
        reply = formatReply(run.report, { requestSeq: message.seq });
        log(`Saved artifact: ${run.outputPath}`);
      } catch (error) {
        reply = formatErrorReply({ code: "engine_error", detail: error.message }, message.seq);
      }
    }
    const posted = await postSigned(room, reply, identity.privateKey, fetchImpl);
    replies.push({ seq: message.seq, reply, status: posted.status });
    log(`Replied to seq ${message.seq} (HTTP ${posted.status})`);
  }
  await writeJson(statePath, state);
  return { processed: replies.length, lastSeq: state.lastSeq, replies };
}

export async function watchAgent(options) {
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  log(`bt-agent watching /r/${options.room} as ${options.identity.did}`);
  for (;;) {
    try {
      await runAgentOnce({ ...options, wait: 10, log });
    } catch (error) {
      log(`bt-agent error: ${error.message}; retrying in 15s`);
      await new Promise((resolvePause) => { setTimeout(resolvePause, 15_000); });
    }
  }
}
