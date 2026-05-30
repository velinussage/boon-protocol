// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBurnableERC20} from "./interfaces/IBurnableERC20.sol";

/// @dev Minimal ERC-8004 identity-registry interface. Only the
///      `ownerOf` call is needed to validate that a candidate agentId
///      resolves to a real owner on chain before it can be added to a round.
interface IIdentityRegistryV8004 {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @notice Event-only $BOON burn registrar for Boon's public tip auction.
/// @dev No custody, no tally state, no upgrades. Burns are $BOON transferFrom calls
///      to BOON_BURN_ADDRESS; the registrar holds no funds.
///
/// @dev Nomination is a competitive burn auction for the ballot ("burn-to-rank").
///      Anyone calls `burnForCandidate(agentId, amount)` during the nomination
///      window. The FIRST burn for a given agent registers it (must be ≥
///      `nominationFloor`) and stamps `agentFirstBurnBlock[round][agentId]`.
///      Subsequent burns just accrue into `nominationBurnByAgent[round][agentId]`.
///
/// @dev Voting power semantics (off-chain, applied by Snapshot strategy):
///      voter_power(roundId, voter) = boon_holdings_at_snapshotBlock (LINEAR, 1 $BOON = 1 vote)
///      There is NO burn term in the vote. Burns serve exactly one job:
///      NOMINATION RANKING. The holder vote (linear holdings at the snapshot
///      block) confers legitimacy; the nomination burn only gates and bounds the ballot.
///
/// @dev Ballot selection is OFF-CHAIN and reproducible from the
///      `NominationBurnAdded` events:
///        score(agent) = min(nominationBurnByAgent[round][agent], nominationBurnCap)
///        finalists    = top `N` (10) agents by score
///        tiebreak     = agentFirstBurnBlock asc, then agentId asc
///      The contract records RAW cumulative burn + first-burn block ONLY; it does
///      NOT enforce `nominationBurnCap` on-chain. `nominationBurnCap` is published
///      round metadata so independent verifiers reproduce the same ranking.
contract BurnVoteRegistrar {
    struct RoundConfig {
        uint256 nominationOpensAt;
        uint256 votingOpensAt;
        uint256 votingClosesAt;
        uint256 snapshotBlock;
        // Minimum amount of $BOON for an agent's FIRST burn (registration).
        uint256 nominationFloor;
        // Per-agent counted-burn cap used for OFF-CHAIN ballot ranking only.
        // Stored as published metadata; the contract does NOT enforce it.
        uint256 nominationBurnCap;
        // Backstop on the number of DISTINCT registered agents per round.
        uint256 maxCandidates;
        bool exists;
        bool closed;
    }

    address public immutable BOON;
    address public immutable BOON_BURN_ADDRESS;

    /// @dev ERC-8004 identity registry. Every nominated/auto agent id
    ///      is resolved through `ownerOf(agentId)` before being added to a
    ///      round; this prevents an attacker from burning to register
    ///      un-resolvable IDs that `BoonV3.tipAgent` would later refuse to
    ///      settle. Owner-managed and locked while a round is active to prevent
    ///      mid-round resets.
    address public identityRegistry;
    /// @dev owner-curated exclusion list. Even if an agent id resolves
    ///      against the registry, it can be blacklisted (e.g., post-incident
    ///      removal). Locked while a round is active.
    mapping(uint256 => bool) public excludedCandidateIds;

    /// @dev Canonical Base mainnet ERC-8004 identity registry. Captured in
    ///      memory: 0x8004…431b. Used as the default on construction so the
    ///      Boon team Safe never has to do a post-deploy bootstrap call.
    address internal constant BASE_IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    /// @dev adv-h2: hard ceiling on round duration. Without this, an owner
    ///      (or compromised Safe signer) could open a round with
    ///      votingClosesAt = type(uint256).max and freeze the protocol — no
    ///      future round could ever open because _hasActiveRound() stays
    ///      true forever. 60 days gives ops headroom while keeping abuse
    ///      bounded.
    uint256 public constant MAX_ROUND_DURATION = 60 days;

    /// @dev adv-m4: cooldown after abortRound. Prevents an owner from
    ///      open-then-abort cycling to repeatedly drain nominator burns.
    uint256 public constant POST_ABORT_COOLDOWN = 7 days;

    address public owner;
    address public pendingOwner;
    uint256 public currentRoundId;
    /// @dev adv-m4: timestamp of the most recent abortRound call. New rounds
    ///      must wait POST_ABORT_COOLDOWN past this before openRound succeeds.
    uint256 public lastAbortAt;

    mapping(uint256 => RoundConfig) public rounds;
    mapping(uint256 => mapping(uint256 => bool)) public isCandidate;
    mapping(uint256 => uint256[]) private _roundCandidates;

    /// @dev Cumulative RAW $BOON burned for each agent per round (NOT capped).
    ///      The off-chain ranker applies `min(., nominationBurnCap)`; on-chain
    ///      we keep the uncapped total so the full burn history is reproducible.
    mapping(uint256 => mapping(uint256 => uint256)) public nominationBurnByAgent;
    /// @dev Block at which an agent crossed the floor / first registered in a
    ///      round. 0 == not registered. Used off-chain as the deterministic
    ///      ranking tiebreak (earliest-to-floor wins).
    mapping(uint256 => mapping(uint256 => uint256)) public agentFirstBurnBlock;

    uint256 private _reentrancyLock;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event IdentityRegistryUpdated(address indexed previousRegistry, address indexed newRegistry);
    event CandidateExclusionUpdated(uint256 indexed candidateAgentId, bool excluded);
    event RoundOpened(
        uint256 indexed roundId,
        uint256 nominationOpensAt,
        uint256 votingOpensAt,
        uint256 votingClosesAt,
        uint256 snapshotBlock,
        uint256 nominationFloor,
        uint256 nominationBurnCap,
        uint256 maxCandidates
    );
    event CandidateAdded(
        uint256 indexed roundId,
        uint256 indexed candidateAgentId,
        address indexed nominator,
        uint8 source
    );
    event RoundClosed(uint256 indexed roundId, uint256 blockNumber);
    event RoundAborted(uint256 indexed roundId, string reason, uint256 blockNumber);
    /// @dev Emitted on every `burnForCandidate` call. `cumulativeForAgent` is the
    ///      agent's RAW running total burned in this round AFTER this burn settled;
    ///      off-chain rankers should treat it as the authoritative per-agent total
    ///      (rather than re-summing raw `amount`s) to defend against event reorder.
    event NominationBurnAdded(
        uint256 indexed roundId,
        uint256 indexed agentId,
        address indexed nominator,
        uint256 amount,
        uint256 cumulativeForAgent
    );

    error ZeroAddress();
    error InvalidTokenAddress();
    error InvalidRound();
    error InvalidWindow();
    error TransferFailed();
    error BurnTooLow();
    error RoundNotInNominationWindow();
    error CandidateNotAllowed();
    error CandidateSetFull();
    error NotOwner();
    error NotPendingOwner();
    error PreviousRoundActive();
    error SnapshotBlockInFuture();
    error Reentrant();
    error AbortWindowClosed();
    error AbortCooldownActive();
    error IdentityRegistryNotSet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock == 1) revert Reentrant();
        _reentrancyLock = 1;
        _;
        _reentrancyLock = 0;
    }

    constructor(address _boon, address _burnAddress, address _owner) {
        if (_boon == address(0) || _burnAddress == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        if (_boon.code.length == 0) revert InvalidTokenAddress();
        BOON = _boon;
        BOON_BURN_ADDRESS = _burnAddress;
        identityRegistry = BASE_IDENTITY_REGISTRY;
        owner = _owner;
        emit IdentityRegistryUpdated(address(0), BASE_IDENTITY_REGISTRY);
        emit OwnershipTransferred(address(0), _owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address oldOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }

    /// @notice Owner-only: rotate the ERC-8004 identity registry.
    /// @dev Locked while a round is active so a mid-round registry
    ///      swap can't change candidate validity rules after nominators started
    ///      burning. Useful for: registry-contract migrations, test setups,
    ///      and (rarely) emergency response if the registry contract itself
    ///      gets compromised.
    function setIdentityRegistry(address newIdentityRegistry) external onlyOwner {
        if (_hasActiveRound()) revert PreviousRoundActive();
        if (newIdentityRegistry == address(0)) revert ZeroAddress();
        address oldIdentityRegistry = identityRegistry;
        identityRegistry = newIdentityRegistry;
        emit IdentityRegistryUpdated(oldIdentityRegistry, newIdentityRegistry);
    }

    /// @notice Owner-only: flip a candidate agent id's exclusion bit.
    /// @dev Lets the operator publicly blacklist agent ids that are
    ///      identity-registry-resolvable but operationally unsafe (e.g.,
    ///      flagged post-hoc for ToS violation). Locked while a round is
    ///      active so the blacklist can't change mid-round.
    function setCandidateExcluded(uint256 candidateAgentId, bool excluded) external onlyOwner {
        if (_hasActiveRound()) revert PreviousRoundActive();
        excludedCandidateIds[candidateAgentId] = excluded;
        emit CandidateExclusionUpdated(candidateAgentId, excluded);
    }

    function openRound(
        uint256 roundId,
        uint256 nominationOpensAt,
        uint256 votingOpensAt,
        uint256 votingClosesAt,
        uint256 snapshotBlock,
        uint256[] calldata autoCandidates,
        uint256 nominationFloor,
        uint256 nominationBurnCap,
        uint256 maxCandidates
    ) external onlyOwner {
        if (_hasActiveRound()) revert PreviousRoundActive();
        // adv-m4: a freshly-aborted round must cool down before a new one can
        // be opened. Prevents open-abort-reopen wealth-extraction cycles.
        if (lastAbortAt != 0 && block.timestamp < lastAbortAt + POST_ABORT_COOLDOWN) {
            revert AbortCooldownActive();
        }
        if (roundId == 0 || snapshotBlock == 0 || rounds[roundId].exists) revert InvalidRound();
        // snapshotBlock must reference a STRICTLY
        // EARLIER, already-mined block. Allowing `==` left the round's holder
        // checkpoint mutable until the openRound block was finalized — an
        // attacker who saw the openRound tx in the mempool could land a
        // transfer/delegation in the same block and have their inflated
        // votes counted by `getPastVotes(snapshotBlock)`. With `>=`, the
        // snapshot block must be fully mined before openRound executes.
        if (snapshotBlock >= block.number) revert SnapshotBlockInFuture();
        if (nominationOpensAt > votingOpensAt || votingOpensAt >= votingClosesAt) {
            revert InvalidWindow();
        }
        // adv-m3: timestamps must not be in the past. Without this, an owner
        // could open a round with voting already active and nominate
        // permanently unreachable — only owner-supplied autoCandidates would
        // ever appear on the ballot.
        if (nominationOpensAt < block.timestamp) revert InvalidWindow();
        // adv-h2: bound round duration. Without this, owner could lock the
        // protocol with votingClosesAt = type(uint256).max.
        if (votingClosesAt - votingOpensAt > MAX_ROUND_DURATION) revert InvalidWindow();
        // nominationFloor must be non-zero (it gates first-burn registration);
        // nominationBurnCap must be at least the floor so the published ranking
        // metadata is internally consistent (a cap below the floor would make
        // every registered agent's capped score identical to the cap);
        // maxCandidates must leave room for at least one agent.
        if (
            nominationFloor == 0 || maxCandidates == 0 || nominationBurnCap < nominationFloor
                || autoCandidates.length > maxCandidates
        ) {
            revert InvalidRound();
        }
        // refuse to open a round if the identity registry is unset.
        // _addCandidate's allowed-check relies on it, so we fail fast here
        // rather than rejecting every auto-candidate one-by-one.
        if (identityRegistry == address(0)) revert IdentityRegistryNotSet();

        RoundConfig storage cfg = rounds[roundId];
        cfg.nominationOpensAt = nominationOpensAt;
        cfg.votingOpensAt = votingOpensAt;
        cfg.votingClosesAt = votingClosesAt;
        cfg.snapshotBlock = snapshotBlock;
        cfg.nominationFloor = nominationFloor;
        cfg.nominationBurnCap = nominationBurnCap;
        cfg.maxCandidates = maxCandidates;
        cfg.exists = true;
        currentRoundId = roundId;

        for (uint256 i = 0; i < autoCandidates.length; i++) {
            _addCandidate(roundId, autoCandidates[i], maxCandidates, address(0), 0);
        }

        emit RoundOpened(
            roundId,
            nominationOpensAt,
            votingOpensAt,
            votingClosesAt,
            snapshotBlock,
            nominationFloor,
            nominationBurnCap,
            maxCandidates
        );
    }

    /// @notice Burn $BOON to nominate / boost an agent's nomination ranking.
    /// @dev Burn-to-rank. Callable only during [nominationOpensAt, votingOpensAt).
    ///      The agent must resolve through the ERC-8004 identity registry and not
    ///      be excluded. A genuinely-new agent's FIRST burn (registration) must
    ///      be ≥ `nominationFloor` and is subject to the `maxCandidates` registry
    ///      backstop. Agents that are ALREADY candidates — owner-seeded
    ///      auto-candidates or previously-registered agents — are not subject to
    ///      the floor or the backstop on their boosting burns (they already hold
    ///      a slot); their burns need only be > 0. An auto-candidate's first boost
    ///      stamps `agentFirstBurnBlock` so the earliest-to-floor tiebreak works.
    ///      The contract records RAW
    ///      cumulative burn + first-burn block; the per-agent `nominationBurnCap`
    ///      is applied OFF-CHAIN when ranking the ballot, not here.
    function burnForCandidate(uint256 agentId, uint256 amount) external nonReentrant {
        uint256 roundId = currentRoundId;
        RoundConfig storage cfg = rounds[roundId];
        if (!cfg.exists || cfg.closed) revert RoundNotInNominationWindow();
        if (block.timestamp < cfg.nominationOpensAt || block.timestamp >= cfg.votingOpensAt) {
            revert RoundNotInNominationWindow();
        }
        if (!_isAllowedCandidate(agentId)) revert CandidateNotAllowed();

        // Branch on candidacy, NOT on agentFirstBurnBlock. An owner-supplied
        // auto-candidate is already registered with agentFirstBurnBlock == 0
        // (no burn occurred yet); keying off the block would mis-treat the
        // first boost of an auto-candidate as a brand-new registration — it
        // would double-push into _roundCandidates and re-consume a maxCandidates
        // slot (bricking boosts once the set is full).
        if (isCandidate[roundId][agentId]) {
            // Already a candidate (auto-seeded or previously registered): the
            // first-burn floor and the maxCandidates backstop do NOT apply —
            // it already holds a slot. Any non-zero amount accrues toward rank.
            if (amount == 0) revert BurnTooLow();
            // An auto-candidate's first boost stamps the deterministic tiebreak
            // block now (it was 0 because no burn had occurred at openRound).
            if (agentFirstBurnBlock[roundId][agentId] == 0) {
                agentFirstBurnBlock[roundId][agentId] = block.number;
            }
        } else {
            // Genuinely new agent: it must clear the nomination floor and there
            // must be room under the distinct-registered backstop. This
            // registers the agent and stamps the deterministic tiebreak block.
            if (amount < cfg.nominationFloor) revert BurnTooLow();
            if (_roundCandidates[roundId].length >= cfg.maxCandidates) revert CandidateSetFull();
            isCandidate[roundId][agentId] = true;
            _roundCandidates[roundId].push(agentId);
            agentFirstBurnBlock[roundId][agentId] = block.number;
            emit CandidateAdded(roundId, agentId, msg.sender, 1);
        }

        _pullBurn(msg.sender, amount);

        uint256 cumulativeForAgent = nominationBurnByAgent[roundId][agentId] + amount;
        nominationBurnByAgent[roundId][agentId] = cumulativeForAgent;

        emit NominationBurnAdded(roundId, agentId, msg.sender, amount, cumulativeForAgent);
    }

    function closeRound(uint256 roundId) external onlyOwner {
        RoundConfig storage cfg = rounds[roundId];
        if (!cfg.exists || cfg.closed || roundId != currentRoundId) revert InvalidRound();
        if (block.timestamp < cfg.votingClosesAt) revert RoundNotInNominationWindow();
        cfg.closed = true;
        emit RoundClosed(roundId, block.number);
    }

    /// @notice Owner emergency abort: closes a round regardless of timestamp.
    /// @dev adv-001 fix. The off-chain scorer listens for RoundAborted as a
    ///      distinct signal (vs RoundClosed) so it can drop the round rather
    ///      than score a half-state. The existing cfg.closed checks in
    ///      burnForCandidate already block further burns after abort.
    ///      Use cases: emergency response to malicious candidate, exploit in
    ///      the off-chain scorer, or operational mistake during configuration.
    function abortRound(uint256 roundId, string calldata reason) external onlyOwner {
        RoundConfig storage cfg = rounds[roundId];
        if (!cfg.exists || cfg.closed || roundId != currentRoundId) revert InvalidRound();
        // adv-h1: once voting has closed, the only legitimate transition is
        // closeRound. abortRound is for in-flight emergencies, not
        // results-aware censorship. Without this gate, owner can wait until
        // voting ends, read the result off-chain, then selectively abort
        // rounds whose outcomes they dislike — making abortRound strictly
        // more powerful than closeRound for the same time window.
        if (block.timestamp >= cfg.votingClosesAt) revert AbortWindowClosed();
        cfg.closed = true;
        // adv-m4: stamp the cooldown floor. openRound enforces the wait.
        lastAbortAt = block.timestamp;
        emit RoundAborted(roundId, reason, block.number);
    }

    function getCandidates(uint256 roundId) external view returns (uint256[] memory) {
        return _roundCandidates[roundId];
    }

    function candidateCount(uint256 roundId) external view returns (uint256) {
        return _roundCandidates[roundId].length;
    }

    function _hasActiveRound() internal view returns (bool) {
        uint256 roundId = currentRoundId;
        return roundId != 0 && rounds[roundId].exists && !rounds[roundId].closed;
    }

    /// @dev Auto-candidate path used by `openRound`. Public nomination now flows
    ///      through `burnForCandidate`, which registers inline; this helper only
    ///      handles owner-supplied auto-candidates (source 0). Auto-candidates do
    ///      not record an `agentFirstBurnBlock` (no burn occurred); the off-chain
    ///      ranker treats a zero-burn auto-candidate as score 0 unless burned for.
    function _addCandidate(
        uint256 roundId,
        uint256 candidateAgentId,
        uint256 maxCandidates,
        address nominator,
        uint8 source
    ) internal {
        // checks the ERC-8004 identity registry resolves the id and
        // that the id is not on the owner-managed exclusion list. Otherwise
        // an owner can seed the candidate set with un-resolvable IDs that
        // force settlement to abort.
        if (!_isAllowedCandidate(candidateAgentId)) revert CandidateNotAllowed();
        if (isCandidate[roundId][candidateAgentId]) revert CandidateNotAllowed();
        uint256 count = _roundCandidates[roundId].length;
        if (count >= maxCandidates) revert CandidateSetFull();
        isCandidate[roundId][candidateAgentId] = true;
        _roundCandidates[roundId].push(candidateAgentId);
        emit CandidateAdded(roundId, candidateAgentId, nominator, source);
    }

    /// @dev candidate-id gate. Refuses zero, excluded ids, and any id
    ///      the identity registry can't resolve. `try/catch` so a misbehaving
    ///      registry can't brick nominations — it just fails closed (returns
    ///      false → revert `CandidateNotAllowed`).
    function _isAllowedCandidate(uint256 candidateAgentId) internal view returns (bool) {
        if (candidateAgentId == 0 || excludedCandidateIds[candidateAgentId]) return false;
        try IIdentityRegistryV8004(identityRegistry).ownerOf(candidateAgentId) returns (
            address nftOwner
        ) {
            return nftOwner != address(0);
        } catch {
            return false;
        }
    }

    function _pullBurn(address from, uint256 amount) internal {
        if (BOON.code.length == 0) revert InvalidTokenAddress();
        (bool ok, bytes memory data) = BOON.call(
            abi.encodeCall(IBurnableERC20.transferFrom, (from, BOON_BURN_ADDRESS, amount))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
