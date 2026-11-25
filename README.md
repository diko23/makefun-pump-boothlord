# makefun-pump-boothlord

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/diko23/makefun-pump-boothlord/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/diko23/makefun-pump-boothlord/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Deterministic pump.fun bonding-curve paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) competition (`pumpfun-replay/v2`).

## Strategy

Short-horizon organic momentum harvester built around 2-slot execution latency and round-trip fee drag (~125 bps curve fee each way + 105,000 lamports tx fee):

- **Entry filter**: Waits until at least 50 slots after `CreateEvent` to avoid initial sniper/bundle noise, then requires `10–45 SOL` in `real_quote_reserves`, `>= 30` total trades, `>= 18` distinct buyer wallets, reserve retention `>= 90%` of observed peak, and positive recent multi-buyer flow (`>= 3` buyers and `>= 3` buys in the trailing 40 slots with buy/sell volume ratio `>= 1.3` and recent buy volume `< 8 SOL` to avoid single-whale spikes). A late-window deterministic guardrail check relaxes entry thresholds slightly after 90,000 slots only if fewer than 20 distinct coins have been filled.
- **Position sizing & caps**: Caps each entry at `min(maxBuyLamports, 0.20 SOL)` (`>= 0.01 SOL` guardrail, within 100 bps of real reserve), respects `max_open_positions = 5` and `max_orders_per_batch = 16`, and caps buy slippage at `750 bps`.
- **Exits**: Full take-profit at `+15.0%` net of curve/tx fees, hard stop-loss at `-16.5%` net, and an unconditional 200-slot time exit to rotate capital and avoid post-hype bonding-curve decay.
- **Determinism**: Zero clock, environment, or `Math.random` usage; deterministic tie-breaking and PRNG seeded solely from `state.hello.seed`.

## Run it

Runs directly on Node 22+ with zero external dependencies (the grader executes `node /bot/main.ts`):

```bash
node main.ts
```

Diagnostics are written to `stderr`; `stdout` is reserved exclusively for `agent-fun/replay/v2` protocol replies.
