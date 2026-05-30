export type ClaimProvider = "github" | "x";
export type CliDeviceStatus = "pending" | "approved-pending-confirm" | "approved" | "denied" | "expired";
export type CliDeviceDenialReason = "provider_mismatch" | "handle_mismatch" | "user_denied" | "confirmation_mismatch";

export interface CliDeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
  recipient: string;
  handle: string;
  provider: ClaimProvider;
}

export interface CliDeviceLookupResponse {
  status: CliDeviceStatus;
  denialReason: CliDeviceDenialReason | null;
  recipient: string;
  provider: ClaimProvider;
  expectedHandle: string;
  expiresAt: number;
}

export interface ClaimableTipPreview {
  amount?: string;
  note?: string;
  tipper?: { id?: string };
  blockTimestamp?: string;
  txHash?: string;
}

export interface ClaimableRecipientPreview {
  id?: string;
  handleHash?: string;
  linkedWallet?: string | null;
  totalReceived?: string;
  pushedAmount?: string;
  escrowedAmount?: string;
  claimedAmount?: string;
  tipCount?: number;
  lastTipAt?: string | null;
  firstTipAt?: string | null;
  tips?: ClaimableTipPreview[];
}

export type CliDevicePollResponse =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "denied"; denialReason?: CliDeviceDenialReason | string }
  | { status: "expired" }
  | {
      status: "approved";
      sessionId: string;
      sessionToken: string;
      handle: string;
      provider: ClaimProvider;
      handleHash: string;
      recipient: string;
      expiresAt?: number;
      source?: "subgraph" | "unconfigured";
      claimable?: ClaimableRecipientPreview;
    };

export interface CliDevicePeekResponse {
  handle: string;
  provider: ClaimProvider;
  recipient: string;
  totalUsdc: string;
  escrowedAmount: string;
  tipCount: number;
  source: "subgraph" | "unconfigured";
}

export type CliDeviceConfirmResponse = { ok: true };
export type CliDeviceDenyResponse = { ok: true };

export interface ClaimCompleteResponse {
  status?: string;
  stage?: string;
  code?: string;
  error?: string;
  retryAfterSeconds?: number;
  next?: string;
  relayerEnabled?: boolean;
  guardianEnabled?: boolean;
  requiresEscrowGuardian?: boolean;
  handle?: string;
  recipient?: string;
  linkedWallet?: string;
  escrow?: string;
  escrowGuardian?: string | null;
  claimedAmount?: string | number | bigint | null;
  txHash?: string | null;
  transactionHash?: string | null;
  linkTxHash?: string | null;
  claimTxHash?: string | null;
  basescanUrl?: string | null;
  explorerUrl?: string | null;
  cashoutUrl?: string | null;
  minRelayClaimAmount?: string;
  minRelayClaimUsdc?: string;
  message?: string;
  reason?: string;
  /**
   * PrivateTipIntent v0.1: number of off-chain gratitude intents pending
   * for the newly-linked handle. Populated after a successful claim/link;
   * absent (or 0) when no intents are queued. Execution itself is a follow-up
   * task; this is a preview only.
   */
  pendingPrivateTipIntentCount?: number;
  /**
   * Up to PRIVATE_TIP_INTENT_PENDING_PREVIEW_LIMIT (10) intent IDs so the
   * app can fetch their details via the public /private-tips/pending
   * surface without re-deriving the handleHash. Order is unspecified.
   */
  pendingPrivateTipIntentIds?: string[];
  /**
   * v3 atomic-per-batch recovery: true when the worker isolated one or more
   * undeliverable tipIds via `BoonV3.claimSpecific(remainingTipIds)` because
   * the original paged `claim(handleHash, maxItems)` batch reverted. The
   * recipient is still linked and the deliverable boons landed; only the
   * entries listed in `unrecoverableTipIds` remain unsettled in escrow.
   */
  partial?: boolean;
  /** Number of escrow entries left unsettled by the isolation route. */
  unrecoverableTipCount?: number;
  /** Tip IDs (uint256 strings) that simulated as undeliverable. */
  unrecoverableTipIds?: string[];
}
