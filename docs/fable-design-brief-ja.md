# TradeCore Testnet — Fable UI Design Brief

## 目的

TradeCoreは、DIDを持つAIエージェントが暗号資産の予測シグナルを提出し、共通の未観測期間でペーパー運用し、成績と独自貢献度に基づいてテストクレジットを得る公開実験場である。

Numeraiの「ラウンド、共通ターゲット、メタモデルへの貢献、履歴を消さない」という考え方を参考にする。ただしNumeraiとは無関係であり、実トークン、実資金、注文執行、投資助言は含めない。

## UIで達成したいこと

初見の人が30秒以内に、次の4点を理解できること。

1. 何を提出するのか：複数銘柄に対する0〜1の予測順位。
2. 何が評価されるのか：予測精度、全体モデルへの追加貢献、ペーパー損益。
3. 何が得られるのか：金銭価値も譲渡性もないテストクレジット。
4. 何が証拠になるのか：DID、提出ハッシュ、ラウンド設定、改変検知イベント履歴。

金融取引所のように見せず、「公開AI研究リーグ」に見せる。射幸心を煽る演出、価格チャート中心の画面、派手なBuy/Sellボタンは使わない。

## 必須画面

### 1. Testnet Overview

- テストネット状態：稼働中、ペーパーのみ、実資金なし
- 現在のラウンド：OPEN / LOCKED / RESOLVED
- 締切、対象期間、対象銘柄数、参加DID数
- Meta Modelの現在値または「ロック後に公開」
- CTA：「テストクレジットを受け取る」「予測を提出する」
- CTAの近くに「TCREDには金銭価値がありません」を常時表示
- 最新のイベント履歴を3件表示

### 2. Submit Signal

- 接続中のDIDを省略表示し、コピー可能にする
- 固定されたラウンド設定と設定ハッシュ
- 対象銘柄ごとの予測スコア入力（0〜1）
- JSONファイルの読み込みと、画面上での編集の両方を想定
- ステークは0でも提出可能
- 利用可能残高、ロック額、提出後残高を事前表示
- 提出前確認に、信号ハッシュと「締切後は変更不可」を表示
- 実売買ではないことを確認画面にも表示

### 3. Round Detail / Paper Portfolio

- ラウンド設定、対象銘柄、評価期間、コスト仮定
- 自分の予測順位と、結果確定後の実現リターン順位
- CORR：順位予測の精度
- Contribution：自分を加えたことでMeta Modelがどれだけ改善したか
- Score：`0.1 × CORR + 1.0 × Contribution`（設定値はラウンドごとに表示）
- ペーパーポートフォリオ：ロング／ショート比率、グロス・ネット損益、仮想コスト
- ステーク増減、残高、報酬上限
- 提出ハッシュ、ターゲットハッシュ、解決結果ハッシュ
- 専門用語には一文の説明を添える

### 4. Leaderboard

- 期間切り替え：Current round / 20 rounds / All history
- 順位、DID、CORR、Contribution、Paper Return、最大ドローダウン、参加回数
- 単発の利益より、継続性と貢献度を強調
- 未ステーク参加者も成績を表示し、報酬欄だけ0にする
- 過去の悪い結果も消せないことを明示

### 5. Reward & Event Ledger

- Faucet、Stake lock、Stake return、Reward、Burnを時系列表示
- 各イベントに連番、時刻、イベントハッシュ、直前ハッシュ
- 発行量、報酬発行量、バーン量、ロック総額
- 「テスト用・譲渡不可・換金不可・FLOP配布の約束ではない」を常時表示

## 共通ナビゲーション

- Overview
- Rounds
- Submit
- Leaderboard
- Ledger
- Protocol

DIDの接続状態、TCRED残高、ペーパーモード表示をヘッダーに置く。スマートフォンでは下部ナビゲーションにしてよい。

## デザイン方向

- 暗色を基調にするが、典型的な暗号資産カジノ風にはしない
- 研究端末、公開台帳、AIエージェントの協調を感じる
- メイン色：深いネイビー／チャコール
- 成功：控えめなライム、注意：アンバー、失敗：コーラル
- 数値は等幅、説明文は読みやすいサンセリフ
- 状態は色だけで区別せず、必ずテキストとアイコンを併用
- モバイル幅375pxとデスクトップ1440pxで破綻しない
- WCAG AA相当のコントラストとキーボード操作を考慮

## 実装上の境界

- 既存リポジトリ：https://github.com/maffmoff/tradecore-ai
- UIの作業ブランチ名：`design/fable-testnet`
- 既存のバックテスト・DID・Technocoreコードは変更しない
- まずモックデータで画面を完成させる
- UIは静的に動作し、GitHub Pagesで表示できるようにする
- 秘密鍵、パスフレーズ、APIキー、ウォレット接続を要求しない
- 実注文を送る処理を追加しない
- 外部サービスや有料フォントを必須にしない
- 成果物に、使用した色・余白・文字・コンポーネント状態をまとめた `docs/ui-system.md` を含める

## UIが受け取るデータ契約

テストネット状態：

```json
{
  "schema": "tradecore-testnet-v1",
  "config": {
    "name": "TradeCore Public Testnet",
    "creditSymbol": "TCRED",
    "disclaimer": "Test credits have no monetary value and are non-transferable."
  },
  "accounts": {},
  "rounds": {},
  "events": [],
  "accounting": {
    "faucetIssued": 0,
    "rewardsMinted": 0,
    "creditsBurned": 0
  }
}
```

予測提出：

```json
{
  "schema": "tradecore-signal-v1",
  "roundId": "tc-sandbox-001",
  "predictions": [
    { "symbol": "BTCUSDT", "score": 0.72 },
    { "symbol": "ETHUSDT", "score": 0.64 },
    { "symbol": "SOLUSDT", "score": 0.31 }
  ]
}
```

## 完了条件

1. 5画面すべてにデスクトップとモバイルの状態がある。
2. OPEN、LOCKED、RESOLVED、空状態、エラー状態を確認できる。
3. Faucet → Submit → Lock → Resolve → Reward/Burnの流れが画面上で追える。
4. TCREDを実資産と誤認する表現がない。
5. 静的プレビューがローカルとGitHub Pagesの両方で動く。
6. Fableの変更を`design/fable-testnet`へコミットし、変更点と未実装点をREADMEへ記載する。

## Fableへの依頼文

この文書を設計の正本として、TradeCore Testnetの情報設計、デザインシステム、レスポンシブUIを作成してください。先に全体の画面構造とコンポーネント体系を示し、その後に静的に操作できるモックを実装してください。バックエンドの評価式や既存コードは書き換えず、UIから必要になる追加データがあれば`docs/ui-data-needs.md`へ明記してください。実資金・実トークン・ウォレット接続・取引所注文は追加しないでください。
