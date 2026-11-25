import {
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type Curve,
  type Holding,
  type OrderInput,
  type Pubkey,
  type TradeEventRecord,
} from './vendor/makefun-bot.ts';

export interface StrategyConfig {
  readonly minRealSolLamports: bigint;
  readonly maxRealSolLamports: bigint;
  readonly minCreateAgeSlots: number;
  readonly maxCreateAgeSlots: number;
  readonly minTrades: number;
  readonly minUniqueBuyers: number;
  readonly flowWindowSlots: number;
  readonly minRecentUniqueBuyers: number;
  readonly minRecentBuys: number;
  readonly minBuySellVolRatio: number;
  readonly maxRecentBuySolLamports: bigint;
  readonly minPeakRetentionRatio: number;
  readonly targetBuyCapLamports: bigint;
  readonly minBuyLamports: bigint;
  readonly buySlippageBps: number;
  readonly sellSlippageBps: number;
  readonly emergencySlippageBps: number;
  readonly stopLossBps: number;
  readonly minHoldBeforeStopSlots: number;
  readonly tp1Bps: number;
  readonly tp2Bps: number;
  readonly trailArmBps: number;
  readonly trailDropBps: number;
  readonly lockAfterTp1Bps: number;
  readonly stagnationHoldSlots: number;
  readonly stagnationQuietSlots: number;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  minRealSolLamports: LAMPORTS_PER_SOL * 10n, // 10 SOL -> maxBuy >= 0.10 SOL, low tx fee drag & higher quality
  maxRealSolLamports: LAMPORTS_PER_SOL * 45n,
  minCreateAgeSlots: 50, // let initial sniper melee settle before evaluating organic flow
  maxCreateAgeSlots: 200_000,
  minTrades: 30,
  minUniqueBuyers: 18,
  flowWindowSlots: 40,
  minRecentUniqueBuyers: 3,
  minRecentBuys: 3,
  minBuySellVolRatio: 1.3,
  maxRecentBuySolLamports: LAMPORTS_PER_SOL * 8n, // avoid single-whale spikes with heavy s+2 drift
  minPeakRetentionRatio: 0.90,
  targetBuyCapLamports: (LAMPORTS_PER_SOL * 20n) / 100n, // 0.20 SOL max per position (2% of 10 SOL capital)
  minBuyLamports: LAMPORTS_PER_SOL / 100n, // 0.01 SOL guardrail
  buySlippageBps: 750, // allow genuine fast movers while still capping extreme s+2 jumps
  sellSlippageBps: 900,
  emergencySlippageBps: 1500,
  stopLossBps: -1650, // ~-14% gross after 2.5% round-trip curve fee
  minHoldBeforeStopSlots: 2,
  tp1Bps: 1500, // ~+18% gross: clean full exit on short-horizon impulse
  tp2Bps: 4500,
  trailArmBps: 100_000, // disabled below tp1 so normal pullbacks do not cut off +15% targets
  trailDropBps: 900,
  lockAfterTp1Bps: 400,
  stagnationHoldSlots: 200, // unconditional time exit to avoid slow pump.fun decay & rotate slots
  stagnationQuietSlots: 0,
};

interface RecentTrade {
  readonly slot: number;
  readonly isBuy: boolean;
  readonly quoteLamports: bigint;
  readonly user: Pubkey;
}

export interface MintStats {
  readonly buyers: Set<Pubkey>;
  readonly recent: RecentTrade[];
  buyCount: number;
  sellCount: number;
  peakRealSol: bigint;
  lastTradeSlot: number;
  lastTradeIsBuy: boolean;
}

export interface PositionTracker {
  entrySlot: number;
  peakReturnBps: number;
  tp1Taken: boolean;
  tp2Taken: boolean;
}

export class MomentumTracker {
  readonly mintStats = new Map<Pubkey, MintStats>();
  readonly enteredMints = new Set<Pubkey>();
  readonly filledMints = new Set<Pubkey>();
  readonly positionMeta = new Map<Pubkey, PositionTracker>();
  readonly cfg: StrategyConfig;
  firstSlot: number | null = null;
  seedState: bigint;

  constructor(seed: string, cfg: StrategyConfig = DEFAULT_CONFIG) {
    this.cfg = cfg;
    this.seedState = BigInt(seed) || 1n;
  }

  /** Deterministic xorshift64* PRNG seeded strictly from hello.seed. */
  nextUnitRand(): number {
    let x = this.seedState;
    x ^= x >> 12n;
    x ^= (x << 25n) & 0xffffffffffffffffn;
    x ^= x >> 27n;
    this.seedState = x;
    const mixed = (x * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
    return Number(mixed >> 11n) / 9007199254740992;
  }

  observeBatch(state: BotState, batch: Batch): void {
    if (this.firstSlot === null) {
      this.firstSlot = batch.slot;
    }
    // Sync buy fills (prevent chasing rejected/failed spikes) and closed positions
    for (const fill of batch.fills) {
      if (fill.side === 'buy') {
        this.enteredMints.add(fill.mint);
        if (fill.status === 'filled') {
          this.filledMints.add(fill.mint);
          if (!this.positionMeta.has(fill.mint)) {
            this.positionMeta.set(fill.mint, {
              entrySlot: fill.slot,
              peakReturnBps: 0,
              tp1Taken: false,
              tp2Taken: false,
            });
          }
        }
      }
    }

    for (const mint of this.positionMeta.keys()) {
      if (!state.positions.has(mint)) {
        this.positionMeta.delete(mint);
      }
    }

    for (const ev of batch.events) {
      if (ev.event === 'TradeEvent') {
        this.#recordTrade(ev);
      }
    }
  }

  #recordTrade(ev: TradeEventRecord): void {
    let st = this.mintStats.get(ev.mint);
    if (st === undefined) {
      st = {
        buyers: new Set<Pubkey>(),
        recent: [],
        buyCount: 0,
        sellCount: 0,
        peakRealSol: 0n,
        lastTradeSlot: ev.slot,
        lastTradeIsBuy: ev.is_buy,
      };
      this.mintStats.set(ev.mint, st);
    }
    const quoteAmt = BigInt(ev.real_quote_reserves);
    if (quoteAmt > st.peakRealSol) st.peakRealSol = quoteAmt;
    if (ev.is_buy) {
      st.buyCount += 1;
      st.buyers.add(ev.user);
    } else {
      st.sellCount += 1;
    }
    st.lastTradeSlot = ev.slot;
    st.lastTradeIsBuy = ev.is_buy;
    st.recent.push({
      slot: ev.slot,
      isBuy: ev.is_buy,
      quoteLamports: BigInt(ev.quote_amount),
      user: ev.user,
    });
    const cutoff = ev.slot - this.cfg.flowWindowSlots;
    while (st.recent.length > 0 && st.recent[0].slot < cutoff) {
      st.recent.shift();
    }
  }
}

/** Estimate net SOL proceeds (after protocol+creator fallback curve fees and tx fee) of selling tokens. */
export function estimateSellNetLamports(
  state: BotState,
  curve: Curve,
  tokenAmount: bigint,
): bigint {
  if (tokenAmount <= 0n || curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) {
    return 0n;
  }
  // Constant product sell: dy = (y * dx) / (x + dx)
  const grossSol =
    (curve.virtual_quote_reserves * tokenAmount) / (curve.virtual_token_reserves + tokenAmount);
  const feeBps = BigInt(
    state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback,
  );
  const afterCurveFee = (grossSol * (BPS - feeBps)) / BPS;
  const txFee = state.txFeeLamports();
  return afterCurveFee > txFee ? afterCurveFee - txFee : 0n;
}

export function decideOrders(
  state: BotState,
  batch: Batch,
  tracker: MomentumTracker,
): OrderInput[] {
  tracker.observeBatch(state, batch);

  const cfg = tracker.cfg;
  const orders: OrderInput[] = [];
  const maxOrders = state.hello.caps.max_orders_per_batch;

  const pendingMints = new Set<Pubkey>();
  for (const p of state.pending.values()) {
    pendingMints.add(p.order.mint);
  }

  // 1. Evaluate exits on existing holdings first so freed slots/cash are tracked cleanly
  for (const [mint, holding] of state.positions) {
    if (orders.length >= maxOrders) break;
    if (pendingMints.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;

    const sellOrder = evaluateExit(state, batch.slot, mint, holding, curve, tracker);
    if (sellOrder !== null) {
      orders.push(sellOrder);
      pendingMints.add(mint);
    }
  }

  // 2. Evaluate momentum entries up to max_open_positions
  let openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
  if (openSlots <= 0 || orders.length >= maxOrders) {
    return orders;
  }

  let freeCash = state.freeCashLamports();
  const txFee = state.txFeeLamports();

  const candidates: Array<{ mint: Pubkey; score: number; buyLamports: bigint }> = [];
  const touchedMints = new Set<Pubkey>();
  for (const ev of batch.events) {
    if (ev.event === 'TradeEvent' && ev.is_buy) {
      touchedMints.add(ev.mint);
    }
  }

  for (const mint of touchedMints) {
    if (tracker.enteredMints.has(mint) || state.positions.has(mint) || pendingMints.has(mint)) {
      continue;
    }
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete || curve.created_slot === null) continue;

    const score = scoreEntryCandidate(batch.slot, curve, tracker);
    if (score <= 0) continue;

    const cap = state.maxBuyLamports(mint);
    if (cap < cfg.minBuyLamports) continue;

    const desired = cap < cfg.targetBuyCapLamports ? cap : cfg.targetBuyCapLamports;
    candidates.push({ mint, score, buyLamports: desired });
  }

  candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.mint < b.mint ? -1 : 1));

  for (const c of candidates) {
    if (openSlots <= 0 || orders.length >= maxOrders) break;
    if (freeCash < c.buyLamports + txFee * 2n) continue;

    orders.push({
      side: 'buy',
      mint: c.mint,
      quote_lamports: c.buyLamports,
      max_slippage_bps: cfg.buySlippageBps,
    });
    pendingMints.add(c.mint);
    freeCash -= c.buyLamports + txFee;
    openSlots -= 1;
  }

  return orders;
}

function evaluateExit(
  state: BotState,
  slot: number,
  mint: Pubkey,
  holding: Holding,
  curve: Curve,
  tracker: MomentumTracker,
): OrderInput | null {
  const cfg = tracker.cfg;
  const meta = tracker.positionMeta.get(mint) ?? {
    entrySlot: slot,
    peakReturnBps: 0,
    tp1Taken: false,
    tp2Taken: false,
  };
  tracker.positionMeta.set(mint, meta);

  if (holding.cost_lamports <= 0n || holding.token_amount <= 0n) return null;

  const netValue = estimateSellNetLamports(state, curve, holding.token_amount);
  const retBps = Number(((netValue - holding.cost_lamports) * BPS) / holding.cost_lamports);
  if (retBps > meta.peakReturnBps) {
    meta.peakReturnBps = retBps;
  }

  const heldSlots = slot - meta.entrySlot;

  // Hard stop-loss
  if (heldSlots >= cfg.minHoldBeforeStopSlots && retBps <= cfg.stopLossBps) {
    return {
      side: 'sell',
      mint,
      token_amount: holding.token_amount,
      max_slippage_bps: cfg.emergencySlippageBps,
    };
  }

  // Trailing stop once armed
  if (meta.peakReturnBps >= cfg.trailArmBps) {
    const floorBps = Math.max(
      meta.peakReturnBps - cfg.trailDropBps,
      meta.tp1Taken ? cfg.lockAfterTp1Bps : -500,
    );
    if (retBps <= floorBps) {
      return {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: cfg.sellSlippageBps,
      };
    }
  }

  // Partial take profit 2
  if (!meta.tp2Taken && retBps >= cfg.tp2Bps) {
    const sellAmt = holding.token_amount / 2n;
    if (sellAmt > 0n) {
      meta.tp2Taken = true;
      return {
        side: 'sell',
        mint,
        token_amount: sellAmt,
        max_slippage_bps: cfg.sellSlippageBps,
      };
    }
  }

  // Take profit 1: full exit on short-horizon impulse to capture alpha & save sell fees
  if (!meta.tp1Taken && retBps >= cfg.tp1Bps) {
    meta.tp1Taken = true;
    return {
      side: 'sell',
      mint,
      token_amount: holding.token_amount,
      max_slippage_bps: cfg.sellSlippageBps,
    };
  }

  // Unconditional time exit to harvest short-horizon flow and rotate position slots
  if (heldSlots >= cfg.stagnationHoldSlots) {
    return {
      side: 'sell',
      mint,
      token_amount: holding.token_amount,
      max_slippage_bps: cfg.sellSlippageBps,
    };
  }

  return null;
}

function scoreEntryCandidate(
  slot: number,
  curve: Curve,
  tracker: MomentumTracker,
): number {
  const cfg = tracker.cfg;
  if (curve.created_slot === null) return 0;
  const age = slot - curve.created_slot;
  if (age < cfg.minCreateAgeSlots || age > cfg.maxCreateAgeSlots) return 0;

  const guardrailRelaxed =
    tracker.firstSlot !== null &&
    slot - tracker.firstSlot >= 90_000 &&
    tracker.filledMints.size < 20;
  const minReserve = guardrailRelaxed ? LAMPORTS_PER_SOL * 7n : cfg.minRealSolLamports;
  const minTrades = guardrailRelaxed ? 20 : cfg.minTrades;
  const minBuyers = guardrailRelaxed ? 14 : cfg.minUniqueBuyers;

  if (curve.real_quote_reserves < minReserve) return 0;
  if (curve.real_quote_reserves > cfg.maxRealSolLamports) return 0;
  if (curve.trades < minTrades) return 0;

  const st = tracker.mintStats.get(curve.mint);
  if (st === undefined) return 0;
  if (st.buyers.size < minBuyers) return 0;
  if (!st.lastTradeIsBuy) return 0;

  if (st.peakRealSol > 0n) {
    const retention = Number(curve.real_quote_reserves) / Number(st.peakRealSol);
    if (retention < cfg.minPeakRetentionRatio) return 0;
  }

  const cutoff = slot - cfg.flowWindowSlots;
  let recentBuyVol = 0n;
  let recentSellVol = 0n;
  let recentBuys = 0;
  const recentBuyers = new Set<Pubkey>();
  for (const r of st.recent) {
    if (r.slot < cutoff) continue;
    if (r.isBuy) {
      recentBuyVol += r.quoteLamports;
      recentBuys += 1;
      recentBuyers.add(r.user);
    } else {
      recentSellVol += r.quoteLamports;
    }
  }
  if (recentBuys < cfg.minRecentBuys) return 0;
  if (recentBuyers.size < cfg.minRecentUniqueBuyers) return 0;
  if (recentBuyVol >= cfg.maxRecentBuySolLamports) return 0;
  if (recentSellVol > 0n) {
    const ratio = Number(recentBuyVol) / Number(recentSellVol);
    if (ratio < cfg.minBuySellVolRatio) return 0;
  }

  const reserveSol = Number(curve.real_quote_reserves) / 1e9;
  return recentBuyers.size * 12 + recentBuys * 6 + st.buyers.size * 2 + reserveSol;
}
