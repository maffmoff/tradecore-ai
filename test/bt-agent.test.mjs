import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import {
  buildStrategyFromRequest,
  createRateLimiter,
  formatErrorReply,
  formatReply,
  parseThesisRequest,
  runAgentOnce,
  signRoomMessage,
} from "../src/bt-agent.mjs";
import { generateSyntheticCsv, parseOhlcvCsv, runBacktest } from "../src/backtest.mjs";
import { didFromPrivateKey } from "../src/did.mjs";

const NOW = Date.parse("2026-08-27T12:00:00Z");

test("parseThesisRequest ignores non-trigger messages", () => {
  assert.equal(parseThesisRequest("hello lobby"), null);
  assert.equal(parseThesisRequest("about bt: nothing"), null);
});

test("parseThesisRequest extracts a structured request", () => {
  const request = parseThesisRequest(
    "bt: BTCUSDT 4h sma 10/50 from 2024-01-01 to 2026-01-01 liquidity beats momentum in chop",
    { nowMs: NOW },
  );
  assert.equal(request.symbol, "BTCUSDT");
  assert.equal(request.interval, "4h");
  assert.equal(request.fast, 10);
  assert.equal(request.slow, 50);
  assert.equal(request.start, "2024-01-01T00:00:00Z");
  assert.equal(request.end, "2026-01-01T00:00:00Z");
  assert.match(request.thesis, /liquidity beats momentum/);
});

test("parseThesisRequest applies defaults and USDT suffix", () => {
  const request = parseThesisRequest("!bt ETH mean reversion after dumps", { nowMs: NOW });
  assert.equal(request.symbol, "ETHUSDT");
  assert.equal(request.interval, "1h");
  assert.equal(request.fast, 20);
  assert.equal(request.slow, 100);
  assert.equal(request.end, "2026-08-27T00:00:00Z");
});

test("parseThesisRequest rejects oversized ranges and missing symbols", () => {
  assert.equal(parseThesisRequest("bt: BTCUSDT 1m from 2023-01-01 to 2026-01-01 x", { nowMs: NOW }).error, "range_too_large");
  assert.equal(parseThesisRequest("bt: 20/100 momentum", { nowMs: NOW }).error, "missing_symbol");
  assert.equal(parseThesisRequest("bt: BTCUSDT sma 100/20 x", { nowMs: NOW }).error, "bad_sma");
});

test("buildStrategyFromRequest produces a valid strategy", () => {
  const request = parseThesisRequest("bt: SOLUSDT 1d sma 5/30 from 2023-01-01 to 2026-01-01 trend", { nowMs: NOW });
  const strategy = buildStrategyFromRequest(request);
  assert.equal(strategy.id, "chat-solusdt-1d-5-30");
  assert.equal(strategy.rules.fast, 5);
  assert.equal(strategy.market.venue, "binance-spot");
});

test("formatReply is a single line under the message cap", () => {
  const bars = parseOhlcvCsv(generateSyntheticCsv({ bars: 1200 }));
  const request = parseThesisRequest("bt: BTCUSDT 1h sma 20/100 synthetic", { nowMs: NOW });
  const report = runBacktest(buildStrategyFromRequest(request), bars, { dataHash: "f".repeat(64), dataLabel: "synthetic" });
  const reply = formatReply(report, { requestSeq: 42 });
  assert.ok(reply.length <= 4096);
  assert.ok(!/[\r\n]/.test(reply));
  assert.match(reply, /^tradecore-bt-v1 (PASS|REVIEW) \| BTCUSDT 1h sma 20\/100 \| OOS net /);
  assert.match(reply, /re:42$/);
  assert.match(reply, /paper research only/);
});

test("formatErrorReply names the reason and echoes usage", () => {
  const reply = formatErrorReply({ code: "rate_limited" }, 7);
  assert.match(reply, /rate limit reached/);
  assert.match(reply, /usage: bt:/);
});

test("signRoomMessage signs room|nonce|text and verifies against the DID", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = signRoomMessage(privateKey, "tradecore-bt", "hello  world", 123);
  assert.equal(payload.text, "hello world");
  assert.equal(payload.did, didFromPrivateKey(privateKey));
  const canonical = Buffer.from(`tradecore-bt|123|hello world`, "utf8");
  assert.ok(cryptoVerify(null, canonical, publicKey, Buffer.from(payload.sig, "base64url")));
});

test("rate limiter enforces per-author and daily windows", () => {
  const state = {};
  const limiter = createRateLimiter(state);
  const base = NOW;
  assert.ok(limiter.allow("~alice", base));
  assert.ok(limiter.allow("~alice", base + 1));
  assert.ok(limiter.allow("~alice", base + 2));
  assert.equal(limiter.allow("~alice", base + 3), false);
  assert.ok(limiter.allow("~bob", base + 4));
  assert.ok(limiter.allow("~alice", base + 86_400_001));
});

test("runAgentOnce replies to a trigger with a signed post", async (t) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const identity = { privateKey, did: didFromPrivateKey(privateKey) };
  const roomPage = {
    room: "tradecore-bt",
    messages: [
      { seq: 11, ts: "2026-08-27T00:00:00Z", from: "~tester", text: "bt: 20/100 momentum" },
      { seq: 12, ts: "2026-08-27T00:00:01Z", from: "~noise", text: "unrelated chatter" },
    ],
  };
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(init.body));
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify(roomPage), { status: 200 });
  };
  const statePath = `${t.name.replace(/\W+/g, "-")}-state.json`;
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/bt-agent-test-`);
  const result = await runAgentOnce({
    room: "tradecore-bt",
    identity,
    statePath: `${dir}/${statePath}`,
    artifactsDir: null,
    fetchImpl,
  });
  assert.equal(result.processed, 1);
  assert.equal(result.lastSeq, 12);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].did, identity.did);
  assert.match(posts[0].text, /error re:11 no symbol found/);
});
