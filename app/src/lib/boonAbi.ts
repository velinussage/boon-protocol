/*
 * Minimal Boon contract ABI for the frontend.
 *
 * Kept as `as const` so wagmi/viem can infer arg + return types statically.
 * Only the entry points the SPA actually calls are listed. If you add a
 * call here, mirror the exact signature from the matching contract source.
 */
export const boonAbi = [
  {
    type: "function",
    name: "link",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "canonicalHandle", type: "string" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "handleHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "tip",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "displayHandle", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "linkedWallet",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "escrow",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const emptyPermit = {
  deadline: 0n,
  v: 0,
  r: "0x0000000000000000000000000000000000000000000000000000000000000000",
  s: "0x0000000000000000000000000000000000000000000000000000000000000000",
} as const;


export const boonV3Abi = [
  {
    type: "event",
    name: "Tip",
    inputs: [
      { name: "tipId", type: "uint256", indexed: true },
      { name: "handleHash", type: "bytes32", indexed: true },
      { name: "tipper", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      { name: "displayHandle", type: "string", indexed: false },
      { name: "note", type: "string", indexed: false },
      { name: "usdcAmount", type: "uint256", indexed: false },
      { name: "mintAttestation", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TipAgent",
    inputs: [
      { name: "tipId", type: "uint256", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "tipper", type: "address", indexed: true },
      { name: "resolvedAgentWallet", type: "address", indexed: false },
      { name: "note", type: "string", indexed: false },
      { name: "usdcAmount", type: "uint256", indexed: false },
      { name: "mintAttestation", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PrivateTip",
    inputs: [
      { name: "tipId", type: "uint256", indexed: true },
      { name: "handleHash", type: "bytes32", indexed: true },
      { name: "tipper", type: "address", indexed: true },
      { name: "displayHandle", type: "string", indexed: false },
      { name: "privateCommitment", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TipEscrowed",
    inputs: [
      { name: "tipId", type: "uint256", indexed: true },
      { name: "handleHash", type: "bytes32", indexed: true },
      { name: "tipper", type: "address", indexed: true },
      { name: "displayHandle", type: "string", indexed: false },
      { name: "note", type: "string", indexed: false },
      { name: "usdcAmount", type: "uint256", indexed: false },
      { name: "mintAttestation", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PrivateTipEscrowed",
    inputs: [
      { name: "tipId", type: "uint256", indexed: true },
      { name: "handleHash", type: "bytes32", indexed: true },
      { name: "tipper", type: "address", indexed: true },
      { name: "displayHandle", type: "string", indexed: false },
      { name: "privateCommitment", type: "bytes32", indexed: false },
      { name: "mintAttestation", type: "bool", indexed: false },
    ],
  },
  {
    type: "function",
    name: "linkedWallet",
    stateMutability: "view",
    inputs: [{ name: "handleHash", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getEscrowCount",
    stateMutability: "view",
    inputs: [{ name: "handleHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "firstClaimWallet",
    stateMutability: "view",
    inputs: [{ name: "handleHash", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "linkAndClaim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "workerSig", type: "bytes" },
      { name: "guardianSig", type: "bytes" },
      { name: "maxItems", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "maxItems", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimSpecific",
    stateMutability: "nonpayable",
    inputs: [{ name: "tipIds", type: "uint256[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "tipId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "tip",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "displayHandle", type: "string" },
      { name: "expectedWalletOrZero", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "tipId", type: "uint256" }],
  },
  {
    type: "function",
    name: "tipAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "expectedWallet", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "tipId", type: "uint256" }],
  },
  {
    type: "function",
    name: "tipPrivate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "displayHandle", type: "string" },
      { name: "expectedWalletOrZero", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "privateCommitment", type: "bytes32" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "tipId", type: "uint256" }],
  },
  {
    type: "function",
    name: "tipPrivateAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "expectedWallet", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "privateCommitment", type: "bytes32" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "tipId", type: "uint256" }],
  },
] as const;

/*
 * Minimal BoonV2 ABI retained for legacy reads. Current sends use BoonV3;
 * legacy calls require an explicit configured V2 address and otherwise fail
 * validation instead of silently using v1.
 */
export const boonV2Abi = [
  {
    type: "function",
    name: "linkedWallet",
    stateMutability: "view",
    inputs: [{ name: "handleHash", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tip",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handle", type: "string" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "tipAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "expectedWallet", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "note", type: "string" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "tipPrivate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "handleHash", type: "bytes32" },
      { name: "displayHandle", type: "string" },
      { name: "expectedWalletOrZero", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "privateCommitment", type: "bytes32" },
      { name: "mintAttestation", type: "bool" },
      {
        name: "permit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
] as const;


export const burnVoteRegistrarAbi = [
  {
    type: "function",
    name: "currentRoundId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "rounds",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [
      { name: "nominationOpensAt", type: "uint256" },
      { name: "votingOpensAt", type: "uint256" },
      { name: "votingClosesAt", type: "uint256" },
      { name: "snapshotBlock", type: "uint256" },
      { name: "nominationFloor", type: "uint256" },
      { name: "nominationBurnCap", type: "uint256" },
      { name: "maxCandidates", type: "uint256" },
      { name: "exists", type: "bool" },
      { name: "closed", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getCandidates",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    // Nomination = burn-to-rank. Burns `amount` $BOON for `agentId`; the first
    // burn (>= nominationFloor) registers the agent, later burns add to its
    // nomination total. Ranking is min(total, nominationBurnCap) computed
    // off-chain from NominationBurnAdded events; top-10 become the ballot.
    type: "function",
    name: "burnForCandidate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    // Per-agent cumulative nomination burn for a round (wei). Surfaces the
    // candidate's running nomination score on the UI.
    type: "function",
    name: "nominationBurnByAgent",
    stateMutability: "view",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // Block at which the agent first crossed the nomination floor. 0 = not yet
    // registered. Used as the deterministic earliest-to-floor tiebreak.
    type: "function",
    name: "agentFirstBurnBlock",
    stateMutability: "view",
    inputs: [
      { name: "roundId", type: "uint256" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
