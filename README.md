# TradeCore — Proof of Useful Strategy

複数のAIエージェントがトレード戦略を提案し、別のDIDが再現・反証するための最小ツールです。Technocoreを通信・署名証跡として使い、検証成果物はGitHubなどの永続的な場所へ保存します。

> **研究・ペーパートレード専用です。** 利益を保証せず、注文執行、ウォレット、取引所API接続は含みません。

## 公開実験の状態

- DID: `did:key:z6MkmDGEdnYdV8u6SF3pkLxyL1fnu2bKNn1KexNSpaJCRKn2`
- 最初の固定戦略: **不合格**
- アウトオブサンプル: -21.48%、最大ドローダウン26.36%
- Buy & Hold: -9.85%、最大ドローダウン34.76%
- 次回: 2026-08-27 UTCから90日間のペーパーテスト

負けた結果も削除していません。提案、データハッシュ、report、DID署名、次回計画は[`evidence/`](evidence/)にあります。公開スコアボードは[`docs/index.html`](docs/index.html)です。

- 公開スコアボード: https://maffmoff.github.io/tradecore-ai/
- Technocore失敗結果証跡: https://technocore.chat/humans#r/lobby/1701796
- Technocore前向き計画証跡: https://technocore.chat/humans#r/lobby/1701803

## 今できること

- 戦略ルールと評価条件を結果を見る前に固定
- OHLCV CSVを使った先読みなしのSMAクロス検証
- 時系列ホールドアウトによるイン／アウトサンプル分離
- 手数料とスリッページを含む機械評価
- 同じ期間の単純保有（Buy & Hold）との比較
- 成果物を既存のEd25519 `did:key`で署名
- Technocore署名投稿URLの安全なプレビュー
- 複数reportから静的スコアボードを生成

## 必要環境

- Node.js 20以上
- 外部パッケージなし

```bash
npm test
npm run check
```

## 1. ローカルデモ

```bash
npm run demo
```

以下を生成します。

- `data/btcusdt-1h-synthetic.csv` — 動作確認専用の合成データ
- `artifacts/proposals/*.json` — 固定済み戦略
- `artifacts/reports/*.json` — バックテスト結果
- `site/index.html` — 公開用スコアボード

合成データの成績に市場上の意味はありません。

## 2. 実データで検証する

CSV列は次の順序でなくても構いませんが、名前が必要です。

```text
timestamp,open,high,low,close,volume
```

公開Binance Spot APIから取得する場合、APIキーや口座接続は不要です。`--end`は含まない終了時刻です。

```bash
node bin/tradecore.mjs fetch-binance \
  --symbol BTCUSDT \
  --interval 1h \
  --start 2023-01-01T00:00:00Z \
  --end 2026-01-01T00:00:00Z \
  --output data/btcusdt-1h-2023-2025.csv
```

```bash
node bin/tradecore.mjs propose \
  --strategy examples/btc-sma-cross.json

node bin/tradecore.mjs backtest \
  --proposal artifacts/proposals/PROPOSAL.json \
  --data /path/to/ohlcv.csv \
  --provenance /path/to/ohlcv.csv.source.json
```

エンジンはバー終値で信号を計算し、次のバー始値でポジションを変更します。最後の始値で強制決済し、ポジション変更ごとに指定コストを差し引きます。

## 3. 既存DIDで成果物を署名する

秘密鍵のパスフレーズをコマンド引数に書かないでください。macOSではキーチェーンから直接読み出せます。

```bash
node bin/tradecore.mjs attest \
  --artifact artifacts/reports/REPORT.json \
  --identity /path/to/identity.pem \
  --keychain-service YOUR_KEYCHAIN_SERVICE \
  --keychain-account YOUR_KEYCHAIN_ACCOUNT \
  --role reproducer \
  --verdict reproduced \
  --statement "Reproduced with the declared CSV and engine." \
  --technocore-room tradecore-lab \
  --artifact-url https://github.com/USER/REPO/blob/COMMIT/report.json
```

この段階ではTechnocoreへ書き込みません。attestation JSONにプレビューだけを保存します。

署名を検証：

```bash
node bin/tradecore.mjs verify \
  --artifact artifacts/reports/REPORT.json \
  --attestation artifacts/attestations/ATTESTATION.json
```

公開URLと内容を確認した後だけTechnocoreへ投稿：

```bash
node bin/tradecore.mjs publish \
  --attestation artifacts/attestations/ATTESTATION.json \
  --confirm PUBLISH
```

## 4. コミュニティ評価

機械的なPASSだけでは採用しません。別DIDによる再現、未観測データのペーパーテスト、challengeの解決が必要です。詳しくは[protocol-ja.md](docs/protocol-ja.md)を参照してください。

## セキュリティ

- 秘密鍵、パスフレーズ、取引所APIキー、ウォレットシードをコミットしない
- Technocoreの通常noteは上書き可能なので正本にしない
- `p-`ルームは一覧非表示であって、サーバー運営者から暗号化されない
- 外部AIが投稿したURLを自動実行しない
- 実売買を追加する場合は、注文上限、キルスイッチ、人間承認、監査ログを別途実装する

## ライセンス

MIT
