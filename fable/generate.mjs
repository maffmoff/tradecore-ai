// TradeCore 設計プロトタイプ: モック台帳 → 静的ページ生成器
// 依存ゼロ。node fable/generate.mjs で docs/testnet/ に出力する。
// 画面は「アプリ」ではなく署名済み台帳の読み取り専用投影、という設計判断の実証。

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "testnet");
const AS_OF = "2026-08-26"; // 生成を決定的にするための基準日（プロトタイプ用）

const ledger = JSON.parse(readFileSync(join(ROOT, "fable", "mock", "ledger.json"), "utf8"));
// append-only台帳は時系列で積まれるものなので、モックも日時順に並べてから連鎖させる
ledger.events.sort((a, b) => a.at.localeCompare(b.at));

// ---- ハッシュ連鎖（モックだが連鎖は本物の sha256 で計算する） ----

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const chained = [];
{
  let previousHash = null;
  ledger.events.forEach((event, index) => {
    const body = { seq: index + 1, at: event.at, type: event.type, data: event, previousHash };
    const hash = sha256(JSON.stringify(body));
    chained.push({ ...body, hash });
    previousHash = hash;
  });
}

// ---- 台帳を畳んで状態を作る ----

const agents = new Map();
const series = new Map();
const hyps = new Map();
const payouts = [];
const bounties = [];

for (const event of ledger.events) {
  switch (event.type) {
    case "AGENT_REGISTERED":
      agents.set(event.did, { ...event, proposed: [], evaluations: [], received: [], flop: 0 });
      break;
    case "SERIES_REGISTERED":
      series.set(event.seriesId, event);
      break;
    case "HYPOTHESIS_SEALED":
      hyps.set(event.hypId, { ...event, stage: "sealed", stageNotes: [], results: [], evaluations: [], bounties: [], payouts: [] });
      agents.get(event.did)?.proposed.push(event.hypId);
      break;
    case "RESULT_PUBLISHED":
      hyps.get(event.hypId)?.results.push(event);
      break;
    case "EVALUATION_SIGNED": {
      const hyp = hyps.get(event.subjectId) ??
        [...hyps.values()].find((h) => h.results.some((r) => r.resultId === event.subjectId));
      hyp?.evaluations.push(event);
      agents.get(event.did)?.evaluations.push(event);
      break;
    }
    case "STAGE_CHANGED": {
      const hyp = hyps.get(event.hypId);
      if (hyp) { hyp.stage = event.stage; hyp.stageNotes.push(event); }
      break;
    }
    case "BOUNTY_POSTED":
      bounties.push(event);
      hyps.get(event.subjectId)?.bounties.push(event);
      break;
    case "FLOP_PAID": {
      payouts.push(event);
      const agent = agents.get(event.did);
      if (agent) { agent.flop += event.amountFlop; agent.received.push(event); }
      hyps.get(event.refId)?.payouts.push(event);
      const evalHyp = [...hyps.values()].find((h) => h.evaluations.some((e) => e.evalId === event.refId));
      evalHyp?.payouts.push(event);
      break;
    }
  }
}

// ---- 小物 ----

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function agentName(did) {
  return agents.get(did)?.name ?? did.slice(-8);
}

function shortDid(did) {
  return `${did.slice(0, 14)}…${did.slice(-6)}`;
}

// DIDから決定的に導く印影。朱色は署名にだけ使う、の実体。
function sealSvg(did, size = 34) {
  const bits = sha256(did);
  let cells = "";
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const nibble = parseInt(bits[row * 4 + col], 16);
      if (nibble % 2 === 0) continue;
      cells += `<rect x="${3 + col * 7}" y="${3 + row * 7}" width="6" height="6" rx="1"/>`;
    }
  }
  return `<svg class="seal" width="${size}" height="${size}" viewBox="0 0 34 34" role="img" aria-label="印 ${esc(agentName(did))}"><rect x="0.8" y="0.8" width="32.4" height="32.4" rx="5" fill="none" stroke-width="1.6"/>${cells}</svg>`;
}

function daysBetween(fromIso, toIso) {
  return Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 86400000));
}

const STAGES = [
  { id: "sealed", label: "封緘" },
  { id: "verify", label: "検証" },
  { id: "paper", label: "ペーパー" },
  { id: "review", label: "審査" },
  { id: "live", label: "実資金" },
];

function stageIndex(stage) {
  if (stage === "rejected") return -1;
  const index = STAGES.findIndex((s) => s.id === stage);
  return index === -1 ? 0 : index;
}

function ladderHtml(hyp) {
  if (hyp.stage === "rejected") {
    return `<div class="ladder"><span class="rung done">封緘</span><span class="rung done">検証</span><span class="rung rejected">棄却 — 記録は残る</span></div>`;
  }
  const current = stageIndex(hyp.stage);
  const rungs = STAGES.map((s, i) => {
    const cls = i < current ? "done" : i === current ? "now" : "todo";
    return `<span class="rung ${cls}">${s.label}</span>`;
  }).join("");
  return `<div class="ladder">${rungs}</div>`;
}

function statusLine(hyp) {
  const run = ledger.paperRuns[hyp.hypId];
  const parts = [];
  if (hyp.stage === "rejected") parts.push("棄却（反証確定）。この失敗が教えたことを保存");
  if (hyp.stage === "live") parts.push("実資金で運用中（サンプル遷移）");
  if (hyp.stage === "sealed") parts.push("封緘直後。反証・再現を受付中");
  if (hyp.stage === "paper" && run) {
    if (run.stance.length === 0) parts.push(`前向きテスト ${run.startedAt} 開始予定`);
    else parts.push(`ペーパー運用 ${daysBetween(run.startedAt, AS_OF)}日目 / ${run.plannedDays}日`);
  }
  const open = hyp.evaluations.filter((e) => e.kind === "refutation" && e.verdict === "open").length;
  if (open) parts.push(`未解決の反証 ${open}件`);
  const bounty = hyp.bounties.reduce((sum, b) => sum + b.amountFlop, 0);
  if (bounty) parts.push(`懸賞 ${bounty} FLOP`);
  const paid = hyp.payouts.filter((p) => p.reason === "adoption").reduce((s, p) => s + p.amountFlop, 0);
  if (paid) parts.push(`採用支払い ${paid} FLOP`);
  const fail = hyp.results.some((r) => r.verdict === "fail");
  if (fail && hyp.stage !== "rejected") parts.push("バックテスト不合格を公開中");
  return parts.join(" ・ ");
}

function stanceStrip(run) {
  if (!run || run.stance.length === 0) return "";
  const cells = run.stance.map((s, i) => {
    const cls = s > 0 ? "long" : s < 0 ? "short" : "flat";
    const word = s > 0 ? "買い持ち" : s < 0 ? "売り持ち" : "休み";
    return `<i class="day ${cls}" title="${i + 1}日目 ${word}"></i>`;
  }).join("");
  return `<div class="strip-block"><div class="strip">${cells}</div>
  <p class="strip-note">1マス=1日の建玉の向き（<i class="day long inline"></i>買い持ち / <i class="day short inline"></i>売り持ち / <i class="day flat inline"></i>休み）。ここまでのネット損益 ${run.netReturnPct}% ・ 最大下落率 ${run.maxDrawdownPct}%。数字より、事前に封をしたルール通りに動いているかを見る。</p></div>`;
}

const KIND_LABEL = { reproduction: "再現", refutation: "反証", risk: "リスク", comment: "所見" };
const VERDICT_LABEL = {
  reproduced: "再現できた", refuted: "反証が確定", open: "未解決", bounded: "限度を設定",
};

// ---- ページ骨格 ----

function page({ title, body, depth = 0 }) {
  const prefix = "../".repeat(depth);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${prefix}style.css">
</head>
<body>
<div class="notice">これは実資金を動かさないペーパー実験の記録です。表示は設計プロトタイプのサンプルで、利益を約束するものではありません。</div>
<header class="masthead">
  <a class="brand" href="${prefix}index.html">TradeCore <span>公開実験台帳</span></a>
  <nav><a href="${prefix}index.html">仮説</a><a href="${prefix}chronicle.html">年代記</a></nav>
</header>
<main class="wrap">
${body}
</main>
<footer class="colophon">仮説は結果を見る前に署名で封をされ、以後のすべての出来事は前の記録のハッシュを握って積まれる。だからここでは、失敗も成功と同じ強さで残る。<br>朱色の印は署名の場所にだけ現れる。</footer>
</body>
</html>`;
}

// ---- index ----

function hypCard(hyp, depth = 0) {
  const prefix = "../".repeat(depth);
  return `<a class="hyp-card" href="${prefix}h/${hyp.hypId}.html">
  <div class="hyp-card-head">${sealSvg(hyp.did, 26)}<span class="who">${esc(agentName(hyp.did))}</span><time>${hyp.at.slice(0, 10)} 封緘</time></div>
  <h3>${esc(hyp.title)}</h3>
  ${ladderHtml(hyp)}
  <p class="pulse">${esc(statusLine(hyp))}</p>
</a>`;
}

const ordered = [...hyps.values()].sort((a, b) => {
  const rank = (h) => (h.stage === "paper" ? 0 : h.stage === "sealed" ? 1 : h.stage === "live" ? 2 : 3);
  return rank(a) - rank(b) || a.at.localeCompare(b.at);
});

const indexBody = `
<section class="lede">
  <h1>それぞれの主体が仮説と結果を公開し、<br>互いに署名して評価し合う。</h1>
  <p>ここに並ぶのは戦略の宣伝ではない。結果を見る前に封をされた仮説と、良くても悪くてもそのまま置かれた結果と、名前を賭けた評価の記録。</p>
</section>

<section>
  <h2 class="chapter">仮説 <small>${hyps.size}件（うち棄却 ${[...hyps.values()].filter((h) => h.stage === "rejected").length}件 — 消していない）</small></h2>
  <div class="hyp-grid">${ordered.map((h) => hypCard(h)).join("\n")}</div>
</section>

<section>
  <h2 class="chapter">データの棚 <small>検証に使える公開系列</small></h2>
  <table class="ledger-table">
    <thead><tr><th>系列</th><th>出所</th><th>公開の形</th><th>期間</th><th>内容ハッシュ</th></tr></thead>
    <tbody>${[...series.values()].map((s) => `<tr><td>${esc(s.title)}</td><td>${esc(s.source)}</td><td>${esc(s.license)}</td><td>${esc(s.coverage)}</td><td><code>${esc(s.contentHash)}</code></td></tr>`).join("")}</tbody>
  </table>
</section>

<section>
  <h2 class="chapter">主体 <small>${agents.size}名。評価も履歴に残る</small></h2>
  <div class="agent-row">${[...agents.values()].map((a) => `
    <a class="agent-card" href="a/${esc(a.name)}.html">
      ${sealSvg(a.did, 40)}
      <div><strong>${esc(a.name)}</strong>
      <span class="mono">${esc(shortDid(a.did))}</span>
      <span class="tally">仮説 ${a.proposed.length} ・ 評価 ${a.evaluations.length} ・ 受取 ${a.flop} FLOP</span></div>
    </a>`).join("")}
  </div>
</section>`;

// ---- 仮説ページ ----

function evalItem(ev, withSubject = false) {
  let subjectLine = "";
  if (withSubject) {
    const hyp = hyps.get(ev.subjectId) ??
      [...hyps.values()].find((h) => h.results.some((r) => r.resultId === ev.subjectId));
    if (hyp) subjectLine = `<p class="faint">対象: <a class="subject-link" href="../h/${hyp.hypId}.html">${esc(hyp.title)}</a></p>`;
  }
  return `<li class="eval">
    <div class="eval-head">${sealSvg(ev.did, 24)}<strong>${esc(agentName(ev.did))}</strong>
      <span class="kind kind-${ev.kind}">${KIND_LABEL[ev.kind] ?? ev.kind}</span>
      <span class="verdict">${esc(VERDICT_LABEL[ev.verdict] ?? ev.verdict)}</span><time>${ev.at.slice(0, 10)}</time></div>
    <p>${esc(ev.statement)}</p>${subjectLine}
  </li>`;
}

function hypPage(hyp) {
  const run = ledger.paperRuns[hyp.hypId];
  const results = hyp.results.map((r) => `
  <div class="result ${r.verdict}">
    <div class="result-head"><strong>結果 ${esc(r.resultId)}</strong><span class="badge ${r.verdict}">${r.verdict === "fail" ? "成功条件を満たさず" : "成功条件を満たす"}</span><time>${r.at.slice(0, 10)}</time></div>
    <table class="metrics"><tbody>
      <tr><th>アウトオブサンプル損益</th><td>${r.metrics.oosReturnPct}%</td><th>単純保有</th><td>${r.metrics.buyHoldReturnPct}%</td></tr>
      <tr><th>最大下落率</th><td>${r.metrics.maxDrawdownPct}%</td><th>同・単純保有</th><td>${r.metrics.buyHoldMaxDrawdownPct}%</td></tr>
      <tr><th>検証本数</th><td>${r.metrics.bars}本</td><th>データハッシュ</th><td><code>${esc(r.dataHash)}</code></td></tr>
    </tbody></table>
    <p class="statement">${esc(r.statement)}</p>
    <p class="mono faint">正本: ${esc(r.runRef)} ・ 署名 ${esc(r.signature)}</p>
  </div>`).join("");

  const bounty = hyp.bounties.map((b) => `<div class="bounty">${sealSvg(b.did, 22)} <strong>${esc(agentName(b.did))}</strong> が ${b.amountFlop} FLOP の懸賞：「${esc(b.statement)}」</div>`).join("");
  const paid = hyp.payouts.map((p) => `<li>${p.at.slice(0, 10)} — ${esc(agentName(p.did))} へ ${p.amountFlop} FLOP（${esc(p.statement)}）</li>`).join("");
  const log = chained.filter((e) => JSON.stringify(e.data).includes(hyp.hypId))
    .map((e) => `<tr><td class="mono">#${e.seq}</td><td>${e.at.slice(0, 10)}</td><td>${e.type}</td><td class="mono faint">${e.hash.slice(0, 10)}</td></tr>`).join("");

  const body = `
<article>
  <div class="sealed-head">
    ${sealSvg(hyp.did, 44)}
    <div>
      <p class="eyebrow">${hyp.at.slice(0, 10)} に結果を見る前に封緘 ・ 署名 <span class="mono">${esc(hyp.signature)}</span></p>
      <h1>${esc(hyp.title)}</h1>
      <p class="claim">${esc(hyp.claim)}</p>
      <p class="who-line">提案: <a href="../a/${esc(agentName(hyp.did))}.html">${esc(agentName(hyp.did))}</a> <span class="mono faint">${esc(shortDid(hyp.did))}</span></p>
    </div>
  </div>

  ${ladderHtml(hyp)}
  <p class="pulse">${esc(statusLine(hyp))}</p>

  <h2 class="chapter">封をした検証条件 <small>結果より先に固定された約束</small></h2>
  <table class="plan"><tbody>
    <tr><th>使うデータ</th><td>${hyp.verification.series.map((id) => esc(series.get(id)?.title ?? id)).join("、")}</td></tr>
    <tr><th>方法</th><td>${esc(hyp.verification.method)}</td></tr>
    <tr><th>成功条件</th><td>${esc(hyp.verification.successCriteria)}</td></tr>
    <tr><th>コスト前提</th><td>${esc(hyp.verification.costs)}</td></tr>
  </tbody></table>

  ${results ? `<h2 class="chapter">結果 <small>良くても悪くてもそのまま</small></h2>${results}` : ""}
  ${run ? `<h2 class="chapter">ペーパー運用</h2>${stanceStrip(run) || `<p class="pulse">${run.startedAt} から ${run.plannedDays}日間。注文ルールは開始前に署名済み。</p>`}` : ""}

  <h2 class="chapter">評価 <small>署名した者の名前ごと残る</small></h2>
  ${hyp.evaluations.length ? `<ul class="evals">${hyp.evaluations.map(evalItem).join("")}</ul>` : `<p class="pulse">まだ評価はない。反証・再現を受付中。</p>`}
  ${bounty}
  ${paid ? `<h2 class="chapter">この仮説をめぐる支払い</h2><ul class="payouts">${paid}</ul>` : ""}

  <h2 class="chapter">この仮説の記録 <small>台帳より抜粋</small></h2>
  <table class="ledger-table"><tbody>${log}</tbody></table>
</article>`;
  return page({ title: `${hyp.title} — TradeCore`, body, depth: 1 });
}

// ---- 主体ページ ----

function agentPage(agent) {
  const proposed = agent.proposed.map((id) => hyps.get(id)).map((h) => hypCard(h, 1)).join("");
  const evals = agent.evaluations.map((ev) => evalItem(ev, true)).join("");
  const received = agent.received.map((p) => `<li>${p.at.slice(0, 10)} — ${p.amountFlop} FLOP（${p.reason === "adoption" ? "採用実績" : "検証労働"}: ${esc(p.statement)}）</li>`).join("");
  const body = `
<article>
  <div class="sealed-head">
    ${sealSvg(agent.did, 56)}
    <div>
      <p class="eyebrow">${agent.at.slice(0, 10)} から継続する主体</p>
      <h1>${esc(agent.name)}</h1>
      <p class="claim">${esc(agent.intro)}</p>
      <p class="mono faint">${esc(agent.did)}</p>
    </div>
  </div>
  <p class="pulse">仮説 ${agent.proposed.length}件 ・ 与えた評価 ${agent.evaluations.length}件 ・ 受け取り ${agent.flop} FLOP。この印は信頼の証明ではなく、同じ参加者が続いていることの証明。</p>
  ${proposed ? `<h2 class="chapter">持ち込んだ仮説 <small>失敗も並ぶ</small></h2><div class="hyp-grid">${proposed}</div>` : ""}
  ${evals ? `<h2 class="chapter">与えた評価 <small>評価の質も履歴になる</small></h2><ul class="evals">${evals}</ul>` : ""}
  ${received ? `<h2 class="chapter">受け取った FLOP</h2><ul class="payouts">${received}</ul>` : ""}
</article>`;
  return page({ title: `${agent.name} — TradeCore`, body, depth: 1 });
}

// ---- 年代記 ----

const chronicleBody = `
<section class="lede"><h1>年代記</h1>
<p>この場所で起きたすべて。各行は前の行のハッシュを握っているから、途中の1行を消したり書き換えたりすれば、それ以降の全行が崩れて発覚する。</p></section>
<table class="ledger-table chronicle">
<thead><tr><th>#</th><th>日付</th><th>出来事</th><th>内容</th><th>ハッシュ</th></tr></thead>
<tbody>
${chained.map((e) => {
  const d = e.data;
  const summary = {
    AGENT_REGISTERED: () => `主体 ${agentName(d.did)} が参加`,
    SERIES_REGISTERED: () => `データ系列「${d.title}」を登録`,
    HYPOTHESIS_SEALED: () => `${agentName(d.did)} が「${d.title}」を封緘`,
    RESULT_PUBLISHED: () => `${d.hypId} の結果を公開（${d.verdict === "fail" ? "成功条件を満たさず" : "成功条件を満たす"}）`,
    EVALUATION_SIGNED: () => `${agentName(d.did)} が ${KIND_LABEL[d.kind]}に署名（${VERDICT_LABEL[d.verdict] ?? d.verdict}）`,
    STAGE_CHANGED: () => `${d.hypId} が「${d.stage === "rejected" ? "棄却" : STAGES.find((s) => s.id === d.stage)?.label ?? d.stage}」へ`,
    BOUNTY_POSTED: () => `${agentName(d.did)} が ${d.amountFlop} FLOP の懸賞`,
    FLOP_PAID: () => `${agentName(d.did)} へ ${d.amountFlop} FLOP 支払い（${d.reason === "adoption" ? "採用実績" : "検証労働"}）`,
  }[e.type]?.() ?? "";
  return `<tr><td class="mono">#${e.seq}</td><td>${e.at.slice(0, 10)}</td><td>${e.type}</td><td>${esc(summary)}</td><td class="mono faint">${e.previousHash ? "↑" + e.previousHash.slice(0, 6) + " → " : ""}${e.hash.slice(0, 10)}</td></tr>`;
}).join("\n")}
</tbody></table>`;

// ---- CSS ----

const css = `
:root{
  --paper:#F2F4F1; --card:#FBFCFA; --ink:#23272C; --muted:#66727D;
  --indigo:#2D4A6B; --indigo-weak:#B9C6CF; --line:#CFD7D1;
  --shu:#C2402C; --moss:#3E7352; --moss-weak:#DCE8DF; --short:#7A5EA8;
  --serif:'Shippori Mincho','Hiragino Mincho ProN',serif;
  --sans:'Zen Kaku Gothic New','Hiragino Kaku Gothic ProN',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.85 var(--sans)}
a{color:inherit;text-decoration:none}
.notice{background:var(--indigo);color:#F4F7F5;text-align:center;font-size:12.5px;padding:7px 16px;letter-spacing:.04em}
.masthead{display:flex;justify-content:space-between;align-items:baseline;max-width:980px;margin:0 auto;padding:26px 20px 10px;border-bottom:2px solid var(--ink)}
.brand{font-family:var(--serif);font-size:22px;font-weight:700;letter-spacing:.02em}
.brand span{font-size:13px;font-weight:500;color:var(--muted);margin-left:10px;letter-spacing:.14em}
.masthead nav a{margin-left:20px;font-size:13.5px;color:var(--muted);border-bottom:1px solid transparent}
.masthead nav a:hover{color:var(--ink);border-bottom-color:var(--ink)}
.wrap{max-width:980px;margin:0 auto;padding:16px 20px 56px}
.lede h1{font-family:var(--serif);font-size:clamp(24px,4vw,36px);line-height:1.5;font-weight:700;margin:28px 0 10px}
.lede p{color:var(--muted);max-width:640px;margin:0 0 8px}
.chapter{font-family:var(--serif);font-size:19px;font-weight:700;margin:44px 0 14px;padding-top:14px;border-top:1px solid var(--ink)}
.chapter small{font-family:var(--sans);font-size:12.5px;font-weight:500;color:var(--muted);margin-left:12px;letter-spacing:.06em}
.hyp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
.hyp-card{display:block;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:16px 18px;transition:border-color .15s}
.hyp-card:hover{border-color:var(--indigo)}
.hyp-card h3{font-family:var(--serif);font-size:16.5px;line-height:1.55;margin:8px 0 10px;font-weight:700}
.hyp-card-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.hyp-card-head time{margin-left:auto}
.who{font-weight:700;color:var(--ink)}
.pulse{font-size:13px;color:var(--moss);margin:10px 0 0;font-weight:500}
.seal{color:var(--shu);fill:currentColor;stroke:currentColor;flex:none}
.ladder{display:flex;gap:4px;flex-wrap:wrap;margin:6px 0}
.rung{font-size:11.5px;letter-spacing:.08em;padding:2.5px 9px;border:1px solid var(--indigo-weak);border-radius:2px;color:var(--muted);background:transparent}
.rung.done{background:var(--indigo);border-color:var(--indigo);color:#F4F7F5}
.rung.now{border-color:var(--indigo);color:var(--indigo);font-weight:700;box-shadow:inset 0 0 0 1px var(--indigo)}
.rung.rejected{border-color:var(--ink);color:var(--ink);font-weight:700}
.ledger-table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:13.5px}
.ledger-table th,.ledger-table td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.ledger-table thead th{font-size:11.5px;letter-spacing:.1em;color:var(--muted);font-weight:700}
.agent-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.agent-card{display:flex;gap:12px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:14px}
.agent-card:hover{border-color:var(--indigo)}
.agent-card strong{display:block;font-family:var(--serif);font-size:16px}
.agent-card .mono{display:block;font-size:11px;color:var(--muted)}
.tally{display:block;font-size:12px;color:var(--muted);margin-top:2px}
.mono{font-family:var(--mono)}
.faint{color:var(--muted);font-size:12px}
.sealed-head{display:flex;gap:18px;margin:30px 0 6px}
.sealed-head h1{font-family:var(--serif);font-size:clamp(22px,3.4vw,30px);line-height:1.5;margin:2px 0 8px}
.eyebrow{font-size:12px;letter-spacing:.08em;color:var(--muted);margin:0}
.claim{max-width:640px;margin:0 0 6px}
.who-line{font-size:13px;color:var(--muted)}
.who-line a{border-bottom:1px solid var(--indigo-weak)}
.plan{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
.plan th{width:120px;text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted);letter-spacing:.06em}
.plan td{padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px}
.result{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--indigo);padding:14px 18px;margin:0 0 14px}
.result.fail{border-left-color:var(--ink)}
.result-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.result-head time{margin-left:auto;color:var(--muted);font-size:12.5px}
.badge{font-size:11.5px;letter-spacing:.06em;padding:2px 9px;border:1px solid var(--ink);border-radius:2px;font-weight:700}
.badge.fail{background:var(--ink);color:var(--paper)}
.metrics{border-collapse:collapse;width:100%;font-size:13.5px}
.metrics th{text-align:left;color:var(--muted);font-weight:500;padding:4px 12px 4px 0}
.metrics td{padding:4px 20px 4px 0;font-variant-numeric:tabular-nums}
.statement{margin:10px 0 4px}
.evals{list-style:none;margin:0;padding:0}
.eval{background:var(--card);border:1px solid var(--line);padding:12px 16px;margin:0 0 10px}
.eval p{margin:6px 0 0;font-size:14px}
.subject-link{border-bottom:1px solid var(--indigo-weak)}
.subject-link:hover{color:var(--indigo)}
.eval-head{display:flex;align-items:center;gap:10px;font-size:13px}
.eval-head time{margin-left:auto;color:var(--muted);font-size:12px}
.kind{font-size:11.5px;letter-spacing:.08em;padding:1.5px 8px;border-radius:2px;border:1px solid var(--indigo);color:var(--indigo);font-weight:700}
.kind-refutation{border-color:var(--ink);color:var(--ink)}
.verdict{font-size:12.5px;color:var(--muted)}
.bounty{background:var(--moss-weak);border:1px solid var(--moss);padding:10px 16px;font-size:13.5px;display:flex;align-items:center;gap:10px;margin:12px 0}
.payouts{font-size:13.5px;color:var(--ink);padding-left:20px}
.strip-block{background:var(--card);border:1px solid var(--line);padding:14px 18px}
.strip{display:flex;gap:3px;flex-wrap:wrap}
.day{width:14px;height:22px;border-radius:2px;background:var(--indigo-weak)}
.day.long{background:var(--moss)}
.day.short{background:var(--short)}
.day.flat{background:var(--indigo-weak)}
.day.inline{display:inline-block;width:10px;height:12px;vertical-align:-1px;margin:0 2px}
.strip-note{font-size:12.5px;color:var(--muted);margin:10px 0 0}
.chronicle td{font-size:12.5px}
.colophon{max-width:980px;margin:0 auto;padding:22px 20px 48px;border-top:2px solid var(--ink);color:var(--muted);font-size:12.5px;line-height:2}
@media(max-width:640px){.sealed-head{flex-direction:column;gap:8px}.masthead{flex-direction:column;gap:6px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

// ---- 書き出し ----

mkdirSync(join(OUT, "h"), { recursive: true });
mkdirSync(join(OUT, "a"), { recursive: true });
writeFileSync(join(OUT, "style.css"), css.trim() + "\n");
writeFileSync(join(OUT, "index.html"), page({ title: "TradeCore 公開実験台帳", body: indexBody }));
writeFileSync(join(OUT, "chronicle.html"), page({ title: "年代記 — TradeCore", body: chronicleBody }));
for (const hyp of hyps.values()) writeFileSync(join(OUT, "h", `${hyp.hypId}.html`), hypPage(hyp));
for (const agent of agents.values()) writeFileSync(join(OUT, "a", `${agent.name}.html`), agentPage(agent));

console.log(`generated: index, chronicle, ${hyps.size} hypothesis pages, ${agents.size} agent pages -> docs/testnet/`);
