# Public evidence

This directory deliberately preserves a failed first experiment. TradeCore does not delete negative results.

## Pre-commit

- Strategy hash: `f43be632329b4faddbf3241531a16d077d7cf82f78590be55a6340b90878f547`
- Strategy and downloader were committed at `3d459784545ce1c2be80c6245fed6f6c489bc21a` before the real-data download.
- The locked proposal was created at `2026-08-26T10:23:35.269Z`.
- Binance data was fetched afterward at `2026-08-26T11:27:05.085Z`.

## Dataset

- Source: Binance public Spot market-data API
- Market: BTCUSDT, 1-hour bars
- Requested range: 2023-01-01 through 2025-12-31 UTC
- Rows: 26,303
- CSV SHA-256: `6a49ec19499f43ac85d4b56f2292398532c123ca7d898f6293d1bd6f9d2d8dcb`
- Quality note: one missing hourly bar follows `2023-03-24T12:00:00Z`; the report marks data quality as `review`.

The raw CSV is not committed. Re-download it with the command in the main README and compare the hash. Providers can correct historical data, so a future download may differ.

## Result: failed

The locked 30% chronological holdout runs from 2025-02-07 through 2025-12-31.

| Metric | SMA strategy | Buy & Hold |
|---|---:|---:|
| Net return | -21.48% | -9.85% |
| Sharpe | -0.78 | -0.05 |
| Max drawdown | 26.36% | 34.76% |
| Exposure | 50.58% | 100% |

The strategy failed because net return was negative and drawdown exceeded its locked 25% limit. It reduced drawdown versus Buy & Hold but lost more money. No parameter was changed after seeing this result.

## Next experiment

`forward-plan.json` locks a 90-day paper test beginning 2026-08-27 UTC. It contains no live orders. Acceptance still requires reproduction by another DID.
