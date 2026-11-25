import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type Done,
  type OrderInput,
} from './vendor/makefun-bot.ts';
import { decideOrders, DEFAULT_CONFIG, MomentumTracker } from './strategy.ts';

let tracker: MomentumTracker | null = null;
let batchesSeen = 0;
let ordersSubmitted = 0;
let fillsOk = 0;
let fillsRejected = 0;

export function createTracker(state: BotState): MomentumTracker {
  return new MomentumTracker(state.hello.seed, DEFAULT_CONFIG);
}

export function onBatch(state: BotState, batch: Batch): OrderInput[] {
  if (tracker === null) {
    tracker = createTracker(state);
  }
  batchesSeen += 1;
  for (const f of batch.fills) {
    if (f.status === 'filled') fillsOk += 1;
    else if (f.status === 'rejected') fillsRejected += 1;
  }
  const orders = decideOrders(state, batch, tracker);
  ordersSubmitted += orders.length;
  return orders;
}

await runBot({
  onHello(state: BotState): void {
    tracker = createTracker(state);
    batchesSeen = 0;
    ordersSubmitted = 0;
    fillsOk = 0;
    fillsRejected = 0;
    console.error(
      `[boothlord] hello protocol=${state.hello.protocol} capital=${Number(state.cash) / Number(LAMPORTS_PER_SOL)} SOL maxPos=${state.hello.caps.max_open_positions} latency=${state.hello.latency_slots}`,
    );
  },
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    return onBatch(state, batch);
  },
  onDone(state: BotState, done: Done): void {
    const pnlLamports = state.cash - BigInt(state.hello.capital.lamports);
    const pnlSol = Number(pnlLamports) / Number(LAMPORTS_PER_SOL);
    const coins = tracker !== null ? tracker.filledMints.size : 0;
    const avgPnlPerCoin = coins > 0 ? pnlSol / coins : 0;
    console.error(
      `[boothlord] done reason=${done.reason} batches=${batchesSeen} orders=${ordersSubmitted} fills=${fillsOk} rejected=${fillsRejected} coins=${coins} final_cash=${state.cash} pnl=${pnlSol.toFixed(6)} SOL avg_per_coin=${avgPnlPerCoin.toFixed(6)}`,
    );
  },
});
