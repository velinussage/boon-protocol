// cli/test/auction-tally.test.mjs
//
// Differential test for the CLI-local auction-tally port (cli/src/auction-tally.ts).
//
// The reference tally oracle has zero exports and runs
// main() unconditionally on import, so we CANNOT import its functions. Instead
// every expected ("oracle") value below is computed *independently* — by hand
// or inline from the documented formula — and we assert the compiled TS port
// (../dist/auction-tally.js) reproduces it exactly.
//
// Voter-power formula (LINEAR, confirmed by Tyler 2026-05-30):
//   voterPower      = balWhole                                (1 $BOON = 1 vote, NO burn term)
//   contribScaled   = voterPower · weight · SCORE_SCALE / totalWeight   (per choice)
//   SCORE_SCALE = 1e12, WEIGHT_SCALE = 1e9
//   balWhole = wei / 1e18 (integer truncation)
//
// Finalist selection (burn-to-rank, off-chain reproducible):
//   score(agent) = nominationBurnTotal   (RAW cumulative burn — no cap)
//   finalists    = top N by score desc; tiebreak firstBurnBlock asc, agentId asc
//
// Build first: pnpm --filter @velinussage/boon-cli build
// Run:         node cli/test/auction-tally.test.mjs

import assert from "node:assert/strict";
import {
  sqrtBigInt,
  wholeBoonUnits,
  scoreDisplayFromScaled,
  parseWeightUnits,
  normalizeChoiceToWeights,
  latestVoteByVoter,
  buildTally,
  selectFinalists,
  assertEligibleWinner,
  buildSafeJson,
  buildTallyMarkdown,
  RecipientNotResolvable,
  IneligibleCandidate,
  ATTESTATION_BURN_WEI,
  NOMINATION_FLOOR_WEI,
  FINALIST_COUNT_DEFAULT,
  SCORE_SCALE,
  USDC,
  BOON_TOKEN,
  BOON_V3,
  BOON_SAFE,
  ZERO_ADDRESS,
} from "../dist/auction-tally.js";

const E18 = 10n ** 18n;
let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Independent oracle re-implementations of the documented formula. These are
// deliberately written *differently* from the port so a copy-paste bug in
// either side surfaces as a mismatch.
function oracleSqrt(n) {
  // Math.isqrt via float seed + bigint correction (independent of Newton port).
  if (n < 0n) throw new Error("neg");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}
function oracleVoterPower(balWei) {
  // linear holdings (1 $BOON = 1 vote): burns no longer contribute to voter power.
  return balWei / E18;
}
function oracleContribScaled(voterPower, weight, totalWeight) {
  return (voterPower * weight * BigInt(SCORE_SCALE)) / totalWeight;
}

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const D = "0xdddddddddddddddddddddddddddddddddddddddd";

// Build a balance-reader from a wei map (default 0).
function balReader(map) {
  return (voter) => map.get(voter.toLowerCase()) ?? 0n;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("sqrtBigInt boundary values");
{
  const cases = [
    0n,
    1n,
    2n,
    3n,
    4n,
    8n,
    9n,
    15n,
    16n,
    99n,
    100n,
    10n ** 12n,
    (10n ** 18n - 1n),
    10n ** 18n,
    123456789n * 123456789n,
    123456789n * 123456789n + 1n,
    2n ** 256n - 1n, // very large
    3_000_000n,
  ];
  for (const v of cases) {
    assert.equal(sqrtBigInt(v), oracleSqrt(v), `sqrt(${v})`);
  }
  // floor property: r^2 <= v < (r+1)^2
  for (const v of cases) {
    const r = sqrtBigInt(v);
    assert.ok(r * r <= v && (r + 1n) * (r + 1n) > v, `floor property sqrt(${v})`);
  }
  assert.throws(() => sqrtBigInt(-1n), /non-negative/);
  ok("sqrtBigInt matches oracle on 0/1/perfect-squares/non-squares/2^256-1 + rejects negatives");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("wholeBoonUnits / scoreDisplayFromScaled / parseWeightUnits");
{
  assert.equal(wholeBoonUnits(0n), 0n);
  assert.equal(wholeBoonUnits(E18), 1n);
  assert.equal(wholeBoonUnits(E18 - 1n), 0n, "truncates");
  assert.equal(wholeBoonUnits(2_500_000n * E18 + 999n), 2_500_000n);

  assert.equal(scoreDisplayFromScaled(0n), "0");
  assert.equal(scoreDisplayFromScaled(SCORE_SCALE), "1");
  assert.equal(scoreDisplayFromScaled(SCORE_SCALE + SCORE_SCALE / 2n), "1.5");
  assert.equal(scoreDisplayFromScaled(-SCORE_SCALE * 3n), "-3");
  // 1.000001 → trailing zeros trimmed
  assert.equal(scoreDisplayFromScaled(SCORE_SCALE + 1_000_000n), "1.000001");

  assert.equal(parseWeightUnits(1), 10n ** 9n);
  assert.equal(parseWeightUnits("5"), 5n * 10n ** 9n);
  assert.equal(parseWeightUnits(0), 0n);
  assert.equal(parseWeightUnits(-3), 0n);
  assert.equal(parseWeightUnits("0.5"), 5n * 10n ** 8n);
  assert.equal(parseWeightUnits("abc"), 0n);
  assert.throws(() => parseWeightUnits("1.0000000001"), /9 decimal places/);
  ok("supporting helpers match documented behaviour");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("normalizeChoiceToWeights (single / weighted / approval / abstain)");
{
  const choices = ["agent:1", "agent:2", "Abstain"];
  const single = normalizeChoiceToWeights(1, choices);
  assert.equal(single.totalWeight, 10n ** 9n);
  assert.deepEqual([...single.weights.entries()], [[0, 10n ** 9n]]);

  const weighted = normalizeChoiceToWeights({ 1: 5, 2: 3 }, choices);
  assert.equal(weighted.totalWeight, 8n * 10n ** 9n);
  assert.equal(weighted.weights.get(0), 5n * 10n ** 9n);
  assert.equal(weighted.weights.get(1), 3n * 10n ** 9n);

  const approval = normalizeChoiceToWeights([1, 3], choices);
  assert.equal(approval.totalWeight, 2n * 10n ** 9n);
  assert.equal(approval.weights.get(0), 10n ** 9n);
  assert.equal(approval.weights.get(2), 10n ** 9n);

  const none = normalizeChoiceToWeights(null, choices);
  assert.equal(none.totalWeight, 0n);

  // out-of-range index ignored
  const oob = normalizeChoiceToWeights({ 9: 1 }, choices);
  assert.equal(oob.totalWeight, 0n);
  ok("choice normalization covers single/weighted/approval/null/out-of-range");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("latestVoteByVoter (dedupe + tie-break)");
{
  const votes = [
    { id: "v1", voter: A, choice: 1, created: 100 },
    { id: "v2", voter: "0x" + A.slice(2).toUpperCase(), choice: 2, created: 200 }, // later wins, case-insensitive
    { id: "v3", voter: B, choice: 1, created: 50 },
    { id: "z9", voter: B, choice: 2, created: 50 }, // same created → greater id wins
  ];
  const latest = latestVoteByVoter(votes);
  assert.equal(latest.length, 2);
  const byVoter = Object.fromEntries(latest.map((v) => [v.voter, v]));
  assert.equal(byVoter[A.toLowerCase()].choice, 2, "later created wins");
  assert.equal(byVoter[B.toLowerCase()].id, "z9", "id tie-break wins");
  ok("latest vote dedupe collapses duplicates with correct tie-break");
}

// ─────────────────────────────────────────────────────────────────────────────
// Round-1000 known-good fixture. Constructed deterministically so the expected
// per-candidate scores are computable from the sqrt-only formula.
//
// snapshotBlock arbitrary. Candidates 53785 + 99999. Voters (linear, 1 BOON = 1 vote):
//   A: bal 4 BOON   → power 4,   votes agent:53785
//   B: bal 100 BOON → power 100, votes agent:53785
//   C: bal 9 BOON   → power 9,   votes agent:99999
// burnVotes are passed but IGNORED (burns no longer amplify voter power).
// Expected (single-choice, weight=1e9, total=1e9, contrib = power·SCORE_SCALE):
//   agent:53785 = (4+100)·1e12 = 104e12
//   agent:99999 = 9·1e12       = 9e12
// Winner: agent:53785.
console.log("round-1000 happy-path fixture → winner agent:53785 (linear holdings)");
let round1000Tally;
{
  const proposal = {
    id: "0xround1000",
    title: "Boon Round 1000",
    state: "closed",
    choices: ["agent:53785", "agent:99999", "Abstain"],
    snapshot: "30000000",
    space: { id: "boonprotocol.eth" },
  };
  const roundConfig = { snapshotBlock: 30000000n, closed: true, exists: true };
  const votes = [
    { id: "a", voter: A, choice: 1, created: 10 }, // agent:53785
    { id: "b", voter: B, choice: 1, created: 11 }, // agent:53785
    { id: "c", voter: C, choice: 2, created: 12 }, // agent:99999
  ];
  // Passed deliberately to prove buildTally IGNORES burns for voter power.
  const burnVotes = [
    { voter: B, cumulativeAfter: (30n * E18).toString() },
  ];
  const candidates = [
    { agentId: 53785, source: 1, addedAtTimestamp: 1700000000, firstNominator: A },
    { agentId: 99999, source: 0, addedAtTimestamp: 1700000100, firstNominator: C },
  ];
  const balances = new Map([
    [A, 4n * E18],
    [B, 100n * E18],
    [C, 9n * E18],
  ]);

  round1000Tally = await buildTally({
    roundConfig,
    proposal,
    votes,
    burnVotes,
    candidates,
    readBalanceAt: balReader(balances),
  });

  // Independently computed oracle scores (linear holdings).
  const powerA = oracleVoterPower(4n * E18); // 4
  const powerB = oracleVoterPower(100n * E18); // 100 (burn ignored)
  const powerC = oracleVoterPower(9n * E18); // 9
  assert.equal(powerA, 4n);
  assert.equal(powerB, 100n);
  assert.equal(powerC, 9n);
  const W = 10n ** 9n;
  const score53785 = oracleContribScaled(powerA, W, W) + oracleContribScaled(powerB, W, W);
  const score99999 = oracleContribScaled(powerC, W, W);
  assert.equal(score53785, 104n * SCORE_SCALE);
  assert.equal(score99999, 9n * SCORE_SCALE);

  assert.equal(round1000Tally.winner.agentId, "53785", "winner agentId");
  assert.equal(round1000Tally.winner.label, "agent:53785");
  assert.equal(round1000Tally.settlementStatus, "unique-winner");
  const row53785 = round1000Tally.rows.find((r) => r.label === "agent:53785");
  const row99999 = round1000Tally.rows.find((r) => r.label === "agent:99999");
  assert.equal(row53785.scoreScaled, score53785, "agent:53785 exact score");
  assert.equal(row99999.scoreScaled, score99999, "agent:99999 exact score");
  assert.equal(row53785.scoreDisplay, "104");
  assert.equal(row99999.scoreDisplay, "9");
  // B's burn is ignored: power is pure linear holdings 100, and no burn fields remain.
  const rowB = round1000Tally.voterRows.find((r) => r.voter === B);
  assert.equal(rowB.voterPower, "100", "burn ignored → power == holdings (linear)");
  assert.equal(rowB.effectiveBurnWhole, undefined, "no effectiveBurnWhole field");
  assert.equal(rowB.burnWhole, undefined, "no burnWhole field");
  ok("round-1000: winner=agent:53785, linear scores 104e12 / 9e12, burns ignored");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("round-1000 Safe batch → exact calldata values");
{
  // prizeUnits for 1000 USDC: oracle parseUsdcDecimalToUnits("1000") =
  //   1000 * 1_000_000 = 1_000_000_000 (NOT 10_000000). Derived from
  //   settle-round.mjs lines 156-161.
  const prizeUnits = 1000n * 1_000_000n;
  assert.equal(prizeUnits, 1_000_000_000n, "1000 USDC = 1e9 base units");

  const payoutWallet = "0x1234567890123456789012345678901234567890";
  const note = "Boon Round 1000: agent:53785";
  const safe = buildSafeJson({
    roundId: 1000,
    winnerAgentId: round1000Tally.winner.agentId,
    payoutWallet,
    prizeUnits,
    note,
    createdAt: 1_700_000_000_000, // fixed → deterministic
  });

  assert.equal(safe.version, "1.0");
  assert.equal(safe.chainId, "8453");
  assert.equal(safe.createdAt, 1_700_000_000_000);
  assert.equal(safe.meta.createdFromSafeAddress, BOON_SAFE);
  assert.equal(safe.transactions.length, 3);

  const [tx1, tx2, tx3] = safe.transactions;
  // Tx1: USDC.approve(BoonV3, 1_000_000_000)
  assert.equal(tx1.to, USDC);
  assert.equal(tx1.contractMethod.name, "approve");
  assert.equal(tx1.contractInputsValues.spender, BOON_V3);
  assert.equal(tx1.contractInputsValues.amount, "1000000000");
  // Tx2: BOON.approve(BoonV3, 3_000_000e18)
  assert.equal(tx2.to, BOON_TOKEN);
  assert.equal(tx2.contractMethod.name, "approve");
  assert.equal(tx2.contractInputsValues.spender, BOON_V3);
  assert.equal(tx2.contractInputsValues.amount, "3000000000000000000000000");
  assert.equal(ATTESTATION_BURN_WEI, 3_000_000n * E18);
  // Tx3: BoonV3.tipAgent(53785, payoutWallet, 1e9, note, true, zeroPermit)
  assert.equal(tx3.to, BOON_V3);
  assert.equal(tx3.contractMethod.name, "tipAgent");
  assert.equal(tx3.contractInputsValues.agentId, "53785");
  assert.equal(tx3.contractInputsValues.expectedWallet, payoutWallet);
  assert.equal(tx3.contractInputsValues.amount, "1000000000");
  assert.equal(tx3.contractInputsValues.note, note);
  assert.equal(tx3.contractInputsValues.mintAttestation, "true");
  assert.equal(
    tx3.contractInputsValues.permit,
    '["0","0","0x0000000000000000000000000000000000000000000000000000000000000000","0x0000000000000000000000000000000000000000000000000000000000000000"]',
  );
  ok("Safe batch: exact USDC.approve / BOON.approve / tipAgent calldata values");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("differential matrix");

// 1. Tie → no unique winner (needs-u14).
{
  const proposal = { id: "p", choices: ["agent:1", "agent:2"], state: "closed" };
  const votes = [
    { id: "a", voter: A, choice: 1, created: 1 },
    { id: "b", voter: B, choice: 2, created: 1 },
  ];
  const balances = new Map([[A, 4n * E18], [B, 4n * E18]]); // both power 2
  const candidates = [
    { agentId: 1, addedAtTimestamp: 1 },
    { agentId: 2, addedAtTimestamp: 2 },
  ];
  const t = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal,
    votes,
    burnVotes: [],
    candidates,
    readBalanceAt: balReader(balances),
  });
  assert.equal(t.winner, null, "tie has no winner");
  assert.equal(t.settlementStatus, "needs-u14");
  assert.equal(t.topSet.length, 2, "both candidates in top set");
  // U14 override resolves the tie.
  const t2 = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal,
    votes,
    burnVotes: [],
    candidates,
    readBalanceAt: balReader(balances),
    winnerAgentId: "2",
  });
  assert.equal(t2.winner.agentId, "2");
  assert.equal(t2.settlementStatus, "u14-selected");
  ok("tie → needs-u14; winnerAgentId override → u14-selected");
}

// 2. Zero-vote → no candidate score.
{
  const t = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal: { id: "p", choices: ["agent:1"], state: "closed" },
    votes: [],
    burnVotes: [],
    candidates: [{ agentId: 1, addedAtTimestamp: 1 }],
    readBalanceAt: balReader(new Map()),
  });
  assert.equal(t.winner, null);
  assert.equal(t.settlementStatus, "no-agent-candidate-score");
  assert.equal(t.rows.length, 0);
  ok("zero-vote → no-agent-candidate-score");
}

// 3. Abstain-only → abstain in top set, no agent winner.
{
  const proposal = { id: "p", choices: ["agent:1", "Abstain"], state: "closed" };
  const votes = [{ id: "a", voter: A, choice: 2, created: 1 }]; // Abstain
  const balances = new Map([[A, 100n * E18]]);
  const t = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal,
    votes,
    burnVotes: [],
    candidates: [{ agentId: 1, addedAtTimestamp: 1 }],
    readBalanceAt: balReader(balances),
  });
  assert.equal(t.winner, null, "abstain top → no winner");
  assert.equal(t.settlementStatus, "no-agent-candidate-score");
  assert.ok(t.topLabels.includes("Abstain"), "Abstain present in top set");
  ok("abstain-only → no winner, Abstain in top set");
}

// 4. Burns are ignored: a large burn does NOT change voter power.
{
  // bal 16 → power 16 regardless of any burn passed.
  const balances = new Map([[A, 16n * E18]]);
  const t = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal: { id: "p", choices: ["agent:1"], state: "closed" },
    votes: [{ id: "a", voter: A, choice: 1, created: 1 }],
    burnVotes: [{ voter: A, cumulativeAfter: (12n * E18).toString() }],
    candidates: [{ agentId: 1, addedAtTimestamp: 1 }],
    readBalanceAt: balReader(balances),
  });
  const row = t.voterRows[0];
  assert.equal(row.snapshotBalanceWhole, "16");
  assert.equal(row.voterPower, "16", "voterPower == holdings (linear), burn ignored");
  assert.equal(row.sqrtHolderWhole, undefined, "no sqrtHolderWhole field remains");
  assert.equal(row.effectiveBurnWhole, undefined, "no burn fields remain");
  assert.equal(t.winner.scoreScaled, oracleVoterPower(16n * E18) * SCORE_SCALE);
  ok("burns ignored: voter power is linear holdings regardless of burn");
}

// 5. Holdings-only power; a wallet with zero holdings has zero power even with
//    a huge burn (no holdings → no voting weight).
{
  // bal 9 → power 9, any burn irrelevant.
  const balances = new Map([[A, 9n * E18]]);
  const t = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal: { id: "p", choices: ["agent:1"], state: "closed" },
    votes: [{ id: "a", voter: A, choice: 1, created: 1 }],
    burnVotes: [{ voter: A, cumulativeAfter: (1_000_000n * E18).toString() }],
    candidates: [{ agentId: 1, addedAtTimestamp: 1 }],
    readBalanceAt: balReader(balances),
  });
  assert.equal(t.voterRows[0].voterPower, "9", "burn ignored → power == holdings (9)");
  // Zero-holdings voter has zero power regardless of any burn.
  const t0 = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal: { id: "p", choices: ["agent:1"], state: "closed" },
    votes: [{ id: "a", voter: A, choice: 1, created: 1 }],
    burnVotes: [{ voter: A, cumulativeAfter: (5000n * E18).toString() }],
    candidates: [{ agentId: 1, addedAtTimestamp: 1 }],
    readBalanceAt: balReader(new Map()),
  });
  assert.equal(t0.voterRows[0].voterPower, "0", "zero holdings → zero power");
  ok("zero-holdings voter has zero power even with a huge burn");
}

// 6. Large-balance → no overflow, linear matches oracle.
{
  const bigBal = 10_000_000_000n * E18; // 10B BOON whole
  const balances = new Map([[A, bigBal]]);
  const t = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal: { id: "p", choices: ["agent:1"], state: "closed" },
    votes: [{ id: "a", voter: A, choice: 1, created: 1 }],
    burnVotes: [],
    candidates: [{ agentId: 1, addedAtTimestamp: 1 }],
    readBalanceAt: balReader(balances),
  });
  const expectedPower = oracleVoterPower(bigBal);
  assert.equal(t.voterRows[0].voterPower, expectedPower.toString());
  assert.equal(t.winner.scoreScaled, expectedPower * SCORE_SCALE);
  ok(`large-balance (10B BOON) → linear power ${expectedPower} with no overflow`);
}

// 7. Weighted split → proportional contribution with bigint flooring.
{
  // bal 100 → power 100 (linear), weighted {1:5, 2:3} total 8.
  //   agent:1 contrib = 100·5e9·1e12 / 8e9 = 62_500_000_000_000 (= 62.5e12)
  //   agent:2 contrib = 100·3e9·1e12 / 8e9 = 37_500_000_000_000 (= 37.5e12)
  const balances = new Map([[A, 100n * E18]]);
  const t = await buildTally({
    roundConfig: { snapshotBlock: 1n, closed: true },
    proposal: { id: "p", choices: ["agent:1", "agent:2"], state: "closed" },
    votes: [{ id: "a", voter: A, choice: { 1: 5, 2: 3 }, created: 1 }],
    burnVotes: [],
    candidates: [
      { agentId: 1, addedAtTimestamp: 1 },
      { agentId: 2, addedAtTimestamp: 2 },
    ],
    readBalanceAt: balReader(balances),
  });
  const W = 10n ** 9n;
  const r1 = t.rows.find((r) => r.label === "agent:1");
  const r2 = t.rows.find((r) => r.label === "agent:2");
  assert.equal(r1.scoreScaled, oracleContribScaled(100n, 5n * W, 8n * W));
  assert.equal(r2.scoreScaled, oracleContribScaled(100n, 3n * W, 8n * W));
  assert.equal(r1.scoreScaled, 62_500_000_000_000n);
  assert.equal(r2.scoreScaled, 37_500_000_000_000n);
  assert.equal(t.winner.agentId, "1");
  ok("weighted split → proportional bigint-floored contributions");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("error path: RecipientNotResolvable");
{
  const base = {
    roundId: 1000,
    winnerAgentId: "53785",
    prizeUnits: 1_000_000_000n,
    note: "x",
    createdAt: 1,
  };
  // Zero address refuses.
  assert.throws(
    () => buildSafeJson({ ...base, payoutWallet: ZERO_ADDRESS }),
    (err) => err instanceof RecipientNotResolvable && /agent:53785/.test(err.message),
    "zero address must refuse",
  );
  // Empty / unresolvable refuses.
  assert.throws(
    () => buildSafeJson({ ...base, payoutWallet: "" }),
    RecipientNotResolvable,
  );
  // Mixed-case zero still refuses.
  assert.throws(
    () => buildSafeJson({ ...base, payoutWallet: "0x" + "0".repeat(40) }),
    RecipientNotResolvable,
  );
  // Valid wallet builds fine.
  const good = buildSafeJson({ ...base, payoutWallet: "0x" + "1".repeat(40) });
  assert.equal(good.transactions.length, 3);
  ok("buildSafeJson refuses zero/empty payoutWallet, accepts a real address");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("buildTallyMarkdown smoke (deterministic with fixed timestamp)");
{
  const md = buildTallyMarkdown({
    round: 1000,
    space: "boonprotocol.eth",
    roundConfig: { exists: true, closed: true, snapshotBlock: 30000000n },
    proposal: {
      id: "0xround1000",
      title: "Boon Round 1000",
      state: "closed",
      snapshot: "30000000",
      space: { id: "boonprotocol.eth" },
    },
    votes: [],
    candidates: [{ agentId: 53785, source: 1, addedAtTimestamp: 1700000000 }],
    tally: round1000Tally,
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    payoutWallet: "0x" + "1".repeat(40),
    prizeUnits: 1_000_000_000n,
    generatedAt: "2026-05-28T00:00:00.000Z",
  });
  assert.ok(md.includes("# Boon Round 1000 — Settlement Tally"));
  assert.ok(md.includes("**Winning agentId**: `53785`"));
  assert.ok(md.includes("1000000000 USDC units (1000.00 USDC)"));
  assert.ok(md.includes("2026-05-28T00:00:00.000Z"));
  ok("markdown renders winner + prize deterministically");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("selectFinalists (burn-to-rank, deterministic top-N + tiebreak)");
{
  // Locked defaults: floor 1000 BOON, N=10. (No cap — score = RAW burn.)
  assert.equal(NOMINATION_FLOOR_WEI, 1000n * E18);
  assert.equal(FINALIST_COUNT_DEFAULT, 10);

  // Candidates (mirrors hosted auction-candidate rows):
  //   agent:1 burned 5,000 → score 5,000, firstBurnBlock 100
  //   agent:2 burned 50,000 → score 50,000 (no cap), firstBurnBlock 200
  //   agent:3 burned 10,000 → score 10,000, firstBurnBlock 50
  //   agent:5 burned exactly 1,000 (== floor) → score 1,000, firstBurnBlock 300
  // RAW score-desc ranking: agent:2 (50,000), agent:3 (10,000), agent:1 (5,000),
  // agent:5 (1,000). No cap clamp, so the whale leads outright.
  const sel = selectFinalists({
    candidates: [
      { agentId: 1, nominationBurnTotal: (5000n * E18).toString(), firstBurnBlock: 100 },
      { agentId: 2, nominationBurnTotal: (50000n * E18).toString(), firstBurnBlock: 200 },
      { agentId: 3, nominationBurnTotal: (10000n * E18).toString(), firstBurnBlock: 50 },
      { agentId: 5, nominationBurnTotal: (1000n * E18).toString(), firstBurnBlock: 300 },
    ],
  });
  assert.deepEqual(sel.finalistAgentIds, ["2", "3", "1", "5"], "RAW score desc");
  assert.deepEqual(sel.snapshotChoices, ["agent:2", "agent:3", "agent:1", "agent:5", "Abstain"]);
  // No cap: agent:2 score == its full RAW burn.
  const a2 = sel.finalists.find((f) => f.agentId === "2");
  assert.equal(a2.scoreWei, 50000n * E18, "uncapped: score == raw burn");
  assert.equal(a2.nominationBurnTotalWei, 50000n * E18, "raw total preserved");

  // EDGE CASE — auto-seeded candidate never burned for: nominationBurnTotal 0,
  // firstBurnBlock null. Must NOT crash; scores 0 and ranks LAST, only reaching
  // the ballot when fewer than N agents have any burn.
  const withAuto = selectFinalists({
    candidates: [
      { agentId: 1, nominationBurnTotal: (5000n * E18).toString(), firstBurnBlock: 100 },
      { agentId: 7, nominationBurnTotal: "0", firstBurnBlock: null }, // auto-seeded, never burned
      { agentId: 8, nominationBurnTotal: 0n }, // firstBurnBlock omitted entirely
    ],
  });
  assert.deepEqual(withAuto.finalistAgentIds, ["1", "7", "8"], "burned agent first; null-block autos last, agentId asc among them");
  const a7 = withAuto.finalists.find((f) => f.agentId === "7");
  assert.equal(a7.scoreWei, 0n, "never-burned auto-candidate scores 0");
  assert.equal(a7.firstBurnBlock, null, "null firstBurnBlock preserved, no crash");

  // When >= N agents have burns, zero-score autos never make the top-N.
  const autoExcludedByN = selectFinalists({
    candidates: [
      { agentId: 1, nominationBurnTotal: (3000n * E18).toString(), firstBurnBlock: 1 },
      { agentId: 2, nominationBurnTotal: (2000n * E18).toString(), firstBurnBlock: 2 },
      { agentId: 9, nominationBurnTotal: "0", firstBurnBlock: null },
    ],
    finalistCount: 2,
  });
  assert.deepEqual(autoExcludedByN.finalistAgentIds, ["1", "2"], "zero-score auto excluded by top-N");

  // agentId numeric tiebreak when score AND firstBurnBlock tie.
  const tie = selectFinalists({
    candidates: [
      { agentId: 20, nominationBurnTotal: (2000n * E18).toString(), firstBurnBlock: 5 },
      { agentId: 3, nominationBurnTotal: (2000n * E18).toString(), firstBurnBlock: 5 },
    ],
  });
  assert.deepEqual(tie.finalistAgentIds, ["3", "20"], "agentId asc breaks full ties");

  // N truncation: with finalistCount=2, only the top 2 survive.
  const truncated = selectFinalists({
    candidates: [
      { agentId: 1, nominationBurnTotal: (3000n * E18).toString(), firstBurnBlock: 1 },
      { agentId: 2, nominationBurnTotal: (2000n * E18).toString(), firstBurnBlock: 1 },
      { agentId: 3, nominationBurnTotal: (1000n * E18).toString(), firstBurnBlock: 1 },
    ],
    finalistCount: 2,
  });
  assert.deepEqual(truncated.finalistAgentIds, ["1", "2"], "top-N truncation");
  assert.equal(truncated.ranked.length, 3, "ranked retains all floor-crossers for evidence");

  // Empty candidate set → just Abstain on the ballot.
  const empty = selectFinalists({ candidates: [] });
  assert.deepEqual(empty.snapshotChoices, ["Abstain"]);

  // A nominationBurnCapWei param is accepted for signature compat but NO LONGER
  // clamps the score — nomination is a pure burn-to-rank auction now.
  const customCap = selectFinalists({
    candidates: [{ agentId: 1, nominationBurnTotal: (8000n * E18).toString(), firstBurnBlock: 1 }],
    nominationBurnCapWei: 5000n * E18,
  });
  assert.equal(customCap.finalists[0].scoreWei, 8000n * E18, "cap param does not clamp (uncapped)");

  assert.throws(() => selectFinalists({ candidates: [], finalistCount: 0 }), /positive integer/);
  ok("selectFinalists: uncapped score + floor + top-N + (score,block,agentId) tiebreak are deterministic");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("assertEligibleWinner (8004-predate gate)");
{
  const owner = "0x" + "1".repeat(40);
  const ROUND_OPEN_BLOCK = 29000000n;

  // Resolves to a real owner at round-open → eligible, returns lowercased owner.
  const resolved = await assertEligibleWinner("53785", ROUND_OPEN_BLOCK, (agentId, block) => {
    assert.equal(agentId, "53785");
    assert.equal(block, ROUND_OPEN_BLOCK);
    return owner;
  });
  assert.equal(resolved, owner);

  // Zero owner at round-open (unregistered then) → ineligible.
  await assert.rejects(
    () => assertEligibleWinner("99999", ROUND_OPEN_BLOCK, () => ZERO_ADDRESS),
    (err) => err instanceof IneligibleCandidate && /agent:99999/.test(err.message),
    "zero owner at round-open → IneligibleCandidate",
  );

  // Reverting historical read (archival eth_call reverted) → ineligible.
  await assert.rejects(
    () => assertEligibleWinner("42", ROUND_OPEN_BLOCK, () => { throw new Error("execution reverted"); }),
    IneligibleCandidate,
    "revert at round-open → IneligibleCandidate",
  );
  ok("assertEligibleWinner: only an agent resolving at round-open is eligible");
}

console.log(`\nAll ${passed} auction-tally differential groups passed.`);
