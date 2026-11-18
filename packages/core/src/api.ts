// Striker HTTP API (JSON). Amounts are decimal strings (bigints), keys and scripts hex.
// Asset amounts are base units (the demo USD has 8 decimals); BTC amounts are sats.
import type { QuoteWire, Side } from './quote.js';
import type { SwapTermsWire } from './swap.js';

/** GET /v1/info */
export interface InfoResponse {
  network: string;
  arkUrl: string;
  /** x-only hex. */
  serverKey: string;
  emulatorKey: string;
  dust: string;
  asset: { id: string; ticker: string; decimals: number };
  feeBps: string;
  /** Striker's fee address (Ark address) and its scriptPubKey. */
  feeAddress: string;
  feeScript: string;
  /** Renew leaf parameters every offer covenant must carry. */
  renew: { cosigner: string; delegateKey: string; window: string };
  offerExitSeconds: string;
  swapExitSeconds: string;
  /** Seconds a swap address stays fillable. */
  swapTtl: number;
}

/** POST /v1/quotes: a maker publishes its latest quotes for one offer covenant. */
export interface PublishQuotesRequest { maker: string; epoch: string; quotes: QuoteWire[] }
export interface PublishQuotesResponse { address: string; accepted: number }

/** One live quote in the book. */
export interface BookEntry {
  maker: string; epoch: string; address: string;
  side: Side;
  /** Raw signed rate: buy ≥ sell × num / den (maker's perspective). */
  rateNum: string; rateDen: string;
  /** USD per BTC this quote trades at (display only). */
  price: number;
  /** Sell-side units available above the floor, in the maker's sell unit (sats or asset units). */
  available: string;
  minFill: string;
  expiry: string;
  /** The offer VTXO the quote would fill against. */
  outpoint: string;
}
/** GET /v1/book and each `book` event of GET /v1/book/stream (SSE). */
export interface BookSnapshot {
  asset: string;
  /** Maker sells BTC (user buys BTC with USD), best (lowest price) first. */
  asks: BookEntry[];
  /** Maker sells the asset (user sells BTC for USD), best (highest price) first. */
  bids: BookEntry[];
  updatedAt: number;
}

/** POST /v1/swaps: the simple flow (DESIGN.md §5, U1). */
export interface CreateSwapRequest {
  /** What the user deposits. */
  sell: 'BTC' | 'ASSET';
  /** exact-in: `amount` of the sell side. exact-out: `amount` of the buy side, net of fee. */
  mode: 'exactIn' | 'exactOut';
  amount: string;
  slippageBps: number;
  receiveAddress: string;
  refundAddress: string;
  /** x-only hex, generated and kept by the user (refund-key and L1 exit leaves). */
  refundPubkey: string;
}

export type SwapStatus = 'awaiting_deposit' | 'deposited' | 'filled' | 'refunding' | 'refunded' | 'expired' | 'failed';

export interface SwapView {
  id: string;
  address: string;
  status: SwapStatus;
  terms: SwapTermsWire;
  /** What to send to `address`. */
  deposit: { sats: string; asset?: { id: string; amount: string } };
  /** At the current best quote, before price moves. */
  expected: { sats: string; asset: string };
  /** Guaranteed minimum at the deposit amount (min_rate, net of fee). */
  minimum: { sats: string; asset: string };
  makerPrice: number;
  feeBps: string;
  deadline: number;
  createdAt: number;
  depositOutpoint?: string;
  fillTxid?: string;
  refundTxid?: string;
  /** Received on fill, from the fill tx. */
  received?: { sats: string; asset: string };
  error?: string;
}

/** POST /v1/swaps/preview: same body as CreateSwapRequest (addresses and refundPubkey may be empty). */
export type PreviewResponse = Pick<SwapView, 'deposit' | 'expected' | 'minimum' | 'makerPrice'>;
