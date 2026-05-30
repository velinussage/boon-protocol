// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BurnVoteRegistrar} from "../BurnVoteRegistrar.sol";
import {MockBOON} from "./mocks/MockBOON.sol";

contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "not approved");
        require(balanceOf[from] >= amount, "insufficient");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return false;
    }
}

/// @dev minimal ERC-8004 identity registry stub. Tests
///      register their candidate agent IDs as "resolvable" by calling
///      `setOwner(id, address)`. Unknown IDs return `address(0)`, causing
///      `BurnVoteRegistrar._isAllowedCandidate` to refuse them.
contract MockIdentityRegistry {
    mapping(uint256 => address) public ownerOfAgent;

    function setOwner(uint256 agentId, address ownerAddress) external {
        ownerOfAgent[agentId] = ownerAddress;
    }

    function setOwners(uint256[] calldata agentIds, address ownerAddress) external {
        for (uint256 i = 0; i < agentIds.length; i++) {
            ownerOfAgent[agentIds[i]] = ownerAddress;
        }
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return ownerOfAgent[agentId];
    }
}

/// @dev USDT-style: transferFrom does not return a value. The bytes returned
///      from the low-level call have length 0, so BurnVoteRegistrar's
///      `data.length != 0 && !decode(...)` check passes and the burn succeeds.
contract EmptyReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "not approved");
        require(balanceOf[from] >= amount, "insufficient");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

contract BurnVoteRegistrarSpecTest is Test {
    uint256 internal constant ROUND_ID = 1;
    uint256 internal constant SNAPSHOT_BLOCK = 46_600_000;
    uint256 internal constant FLOOR = 1000e18; // NOMINATION_FLOOR default
    uint256 internal constant BURN_CAP = 10_000e18; // NOMINATION_BURN_CAP default
    uint256 internal constant MAX_CANDIDATES = 8;
    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    MockBOON internal boon;
    MockIdentityRegistry internal identityRegistry;
    BurnVoteRegistrar internal registrar;

    address internal owner = address(0xA11CE);
    address internal newOwner = address(0xB0B0);
    address internal nominator = address(0xCAFE);
    address internal nominator2 = address(0xD00D);

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
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
    event NominationBurnAdded(
        uint256 indexed roundId,
        uint256 indexed agentId,
        address indexed nominator,
        uint256 amount,
        uint256 cumulativeForAgent
    );
    event RoundAborted(uint256 indexed roundId, string reason, uint256 blockNumber);

    function setUp() public {
        // snapshotBlock must be STRICTLY less than block.number, so
        // roll to SNAPSHOT_BLOCK + 1.
        vm.roll(SNAPSHOT_BLOCK + 1);
        boon = new MockBOON();
        // the contract's BASE_IDENTITY_REGISTRY default points at the
        // mainnet 0x8004…431b address which has no bytecode in foundry's
        // local VM, so _isAllowedCandidate would refuse every agent id. We
        // deploy a mock registry, point the contract at it via the owner
        // setter, and whitelist the test agent ids the suite uses.
        identityRegistry = new MockIdentityRegistry();
        registrar = new BurnVoteRegistrar(address(boon), BURN_ADDRESS, owner);
        vm.prank(owner);
        registrar.setIdentityRegistry(address(identityRegistry));
        uint256[] memory whitelist = new uint256[](12);
        whitelist[0] = 1; whitelist[1] = 2; whitelist[2] = 3; whitelist[3] = 4;
        whitelist[4] = 5; whitelist[5] = 7; whitelist[6] = 8; whitelist[7] = 9;
        whitelist[8] = 100; whitelist[9] = 101; whitelist[10] = 200; whitelist[11] = 999;
        identityRegistry.setOwners(whitelist, address(0xCA11));
        _fundAndApprove(nominator);
        _fundAndApprove(nominator2);
    }

    function test_constructorStoresImmutablesAndOwner() public view {
        assertEq(registrar.BOON(), address(boon));
        assertEq(registrar.BOON_BURN_ADDRESS(), BURN_ADDRESS);
        assertEq(registrar.owner(), owner);
        assertEq(registrar.pendingOwner(), address(0));
        assertEq(registrar.currentRoundId(), 0);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(BurnVoteRegistrar.ZeroAddress.selector);
        new BurnVoteRegistrar(address(0), BURN_ADDRESS, owner);

        vm.expectRevert(BurnVoteRegistrar.ZeroAddress.selector);
        new BurnVoteRegistrar(address(boon), address(0), owner);

        vm.expectRevert(BurnVoteRegistrar.ZeroAddress.selector);
        new BurnVoteRegistrar(address(boon), BURN_ADDRESS, address(0));

        vm.expectRevert(BurnVoteRegistrar.InvalidTokenAddress.selector);
        new BurnVoteRegistrar(address(0x1234), BURN_ADDRESS, owner);
    }

    function test_twoStepOwnershipTransfer() public {
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.NotOwner.selector);
        registrar.transferOwnership(newOwner);

        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.ZeroAddress.selector);
        registrar.transferOwnership(address(0));

        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(registrar));
        emit OwnershipTransferStarted(owner, newOwner);
        registrar.transferOwnership(newOwner);
        assertEq(registrar.pendingOwner(), newOwner);
        assertEq(registrar.owner(), owner);

        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.NotPendingOwner.selector);
        registrar.acceptOwnership();

        vm.prank(newOwner);
        vm.expectEmit(true, true, false, true, address(registrar));
        emit OwnershipTransferred(owner, newOwner);
        registrar.acceptOwnership();
        assertEq(registrar.owner(), newOwner);
        assertEq(registrar.pendingOwner(), address(0));
    }

    function test_openRoundStoresConfigAndAutoCandidates() public {
        uint256[] memory autoCandidates = _candidates(1, 2, 3);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(registrar));
        emit RoundOpened(ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, FLOOR, BURN_CAP, MAX_CANDIDATES);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, autoCandidates, FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        assertEq(registrar.currentRoundId(), ROUND_ID);
        (
            uint256 nominationOpensAt,
            uint256 votingOpensAt,
            uint256 votingClosesAt,
            uint256 snapshotBlock,
            uint256 nominationFloor,
            uint256 nominationBurnCap,
            uint256 maxCandidates,
            bool exists,
            bool closed
        ) = registrar.rounds(ROUND_ID);
        assertEq(nominationOpensAt, 100);
        assertEq(votingOpensAt, 200);
        assertEq(votingClosesAt, 300);
        assertEq(snapshotBlock, SNAPSHOT_BLOCK);
        assertEq(nominationFloor, FLOOR);
        assertEq(nominationBurnCap, BURN_CAP);
        assertEq(maxCandidates, MAX_CANDIDATES);
        assertTrue(exists);
        assertFalse(closed);
        assertTrue(registrar.isCandidate(ROUND_ID, 1));
        assertTrue(registrar.isCandidate(ROUND_ID, 2));
        assertTrue(registrar.isCandidate(ROUND_ID, 3));
        assertEq(registrar.candidateCount(ROUND_ID), 3);
        assertEq(registrar.getCandidates(ROUND_ID), autoCandidates);
    }

    function test_openRoundOwnerAndValidationErrors() public {
        vm.prank(nominator2);
        vm.expectRevert(BurnVoteRegistrar.NotOwner.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        vm.startPrank(owner);
        vm.expectRevert(BurnVoteRegistrar.InvalidRound.selector);
        registrar.openRound(
            0, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        // nominationOpensAt > votingOpensAt
        vm.expectRevert(BurnVoteRegistrar.InvalidWindow.selector);
        registrar.openRound(
            ROUND_ID, 201, 200, 300, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        // votingOpensAt >= votingClosesAt
        vm.expectRevert(BurnVoteRegistrar.InvalidWindow.selector);
        registrar.openRound(
            ROUND_ID, 100, 300, 300, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        // nominationFloor == 0
        vm.expectRevert(BurnVoteRegistrar.InvalidRound.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1), 0, BURN_CAP, MAX_CANDIDATES
        );

        // maxCandidates == 0
        vm.expectRevert(BurnVoteRegistrar.InvalidRound.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, 0
        );

        // nominationBurnCap < nominationFloor
        vm.expectRevert(BurnVoteRegistrar.InvalidRound.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1), FLOOR, FLOOR - 1, MAX_CANDIDATES
        );

        // autoCandidates.length > maxCandidates
        vm.expectRevert(BurnVoteRegistrar.InvalidRound.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1, 2, 3), FLOOR, BURN_CAP, 2
        );

        // zero / unresolvable auto-candidate
        vm.expectRevert(BurnVoteRegistrar.CandidateNotAllowed.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(0), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        // duplicate auto-candidate
        vm.expectRevert(BurnVoteRegistrar.CandidateNotAllowed.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1, 1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );
        vm.stopPrank();
    }

    function test_previousRoundMustCloseBeforeNextRound() public {
        _openDefaultRound();
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.PreviousRoundActive.selector);
        registrar.openRound(
            2, 1000, 2000, 3000, SNAPSHOT_BLOCK, _candidates(4), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        vm.warp(301);
        vm.prank(owner);
        registrar.closeRound(ROUND_ID);

        vm.prank(owner);
        registrar.openRound(
            2, 1000, 2000, 3000, SNAPSHOT_BLOCK, _candidates(4), FLOOR, BURN_CAP, MAX_CANDIDATES
        );
        assertEq(registrar.currentRoundId(), 2);
    }

    // ── burnForCandidate ─────────────────────────────────────────────────

    /// @dev First burn for an agent registers it, requires amount >= floor,
    ///      stamps firstBurnBlock, accrues raw, and emits both CandidateAdded
    ///      and NominationBurnAdded only within the nomination window.
    function test_burnForCandidateRegistersOnFirstBurn() public {
        _openDefaultRound(); // auto-candidates 1, 2

        // Before the nomination window opens.
        vm.warp(99);
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.RoundNotInNominationWindow.selector);
        registrar.burnForCandidate(4, FLOOR);

        vm.warp(100);
        uint256 beforeNominator = boon.balanceOf(nominator);
        uint256 beforeBurn = boon.balanceOf(BURN_ADDRESS);

        vm.prank(nominator);
        vm.expectEmit(true, true, true, true, address(registrar));
        emit CandidateAdded(ROUND_ID, 4, nominator, 1);
        vm.expectEmit(true, true, true, true, address(registrar));
        emit NominationBurnAdded(ROUND_ID, 4, nominator, FLOOR, FLOOR);
        registrar.burnForCandidate(4, FLOOR);

        assertTrue(registrar.isCandidate(ROUND_ID, 4));
        assertEq(registrar.candidateCount(ROUND_ID), 3);
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 4), FLOOR);
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 4), block.number);
        assertEq(boon.balanceOf(nominator), beforeNominator - FLOOR);
        assertEq(boon.balanceOf(BURN_ADDRESS), beforeBurn + FLOOR);

        // After the nomination window closes (voting open).
        vm.warp(200);
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.RoundNotInNominationWindow.selector);
        registrar.burnForCandidate(5, FLOOR);
    }

    /// @dev First burn below the floor reverts BurnTooLow and registers nothing.
    function test_burnForCandidateRejectsFirstBurnBelowFloor() public {
        _openDefaultRound();
        vm.warp(100);
        uint256 beforeNominator = boon.balanceOf(nominator);

        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.BurnTooLow.selector);
        registrar.burnForCandidate(4, FLOOR - 1);

        assertFalse(registrar.isCandidate(ROUND_ID, 4));
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 4), 0);
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 4), 0);
        assertEq(boon.balanceOf(nominator), beforeNominator);
    }

    /// @dev Cumulative raw accrual: once registered, later burns of ANY non-zero
    ///      size accrue (even below the floor); firstBurnBlock stays fixed;
    ///      multiple nominators sum into the same agent total.
    function test_burnForCandidateAccruesRawAcrossBurnsAndNominators() public {
        _openDefaultRound();
        vm.warp(100);

        vm.prank(nominator);
        registrar.burnForCandidate(4, FLOOR);
        uint256 firstBlock = registrar.agentFirstBurnBlock(ROUND_ID, 4);

        // Roll forward; a later sub-floor top-up is allowed and firstBurnBlock
        // must NOT move.
        vm.roll(block.number + 5);
        uint256 topUp = 1e18;
        vm.prank(nominator);
        vm.expectEmit(true, true, true, true, address(registrar));
        emit NominationBurnAdded(ROUND_ID, 4, nominator, topUp, FLOOR + topUp);
        registrar.burnForCandidate(4, topUp);
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 4), firstBlock);
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 4), FLOOR + topUp);

        // A different nominator can burn for the same agent; raw total sums and
        // there is NO on-chain cap (accrual exceeds nominationBurnCap freely).
        uint256 whaleBurn = BURN_CAP * 3;
        vm.prank(nominator2);
        registrar.burnForCandidate(4, whaleBurn);
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 4), FLOOR + topUp + whaleBurn);
        assertGt(registrar.nominationBurnByAgent(ROUND_ID, 4), BURN_CAP);
        // Still exactly one candidate slot consumed for agent 4.
        assertEq(registrar.candidateCount(ROUND_ID), 3);
    }

    /// @dev A subsequent burn of zero reverts BurnTooLow (registered agent, but
    ///      amount must be > 0).
    function test_burnForCandidateRejectsZeroSubsequentBurn() public {
        _openDefaultRound();
        vm.warp(100);
        vm.prank(nominator);
        registrar.burnForCandidate(4, FLOOR);

        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.BurnTooLow.selector);
        registrar.burnForCandidate(4, 0);
    }

    /// @dev burnForCandidate refuses agent ids that don't resolve through the
    ///      ERC-8004 identity registry, and excluded ids.
    function test_burnForCandidateRejectsUnresolvableAndExcluded() public {
        // Exclude agent 7 before opening (locked during an active round).
        vm.prank(owner);
        registrar.setCandidateExcluded(7, true);
        _openDefaultRound();
        vm.warp(100);

        // 42424 is not whitelisted in the registry.
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.CandidateNotAllowed.selector);
        registrar.burnForCandidate(42424, FLOOR);

        // 7 resolves but is excluded.
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.CandidateNotAllowed.selector);
        registrar.burnForCandidate(7, FLOOR);

        assertFalse(registrar.isCandidate(ROUND_ID, 42424));
        assertFalse(registrar.isCandidate(ROUND_ID, 7));
    }

    /// @dev maxCandidates backstop: once the distinct-registered count hits the
    ///      cap, a NEW agent's first burn reverts CandidateSetFull, but an
    ///      already-registered agent can still receive more burns.
    function test_burnForCandidateEnforcesMaxCandidatesBackstop() public {
        // maxCandidates = 3, with 1 auto-candidate, leaving room for 2 more.
        uint256[] memory autoCandidates = _candidates(1);
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, autoCandidates, FLOOR, BURN_CAP, 3
        );
        vm.warp(100);

        vm.prank(nominator);
        registrar.burnForCandidate(2, FLOOR); // count -> 2
        vm.prank(nominator);
        registrar.burnForCandidate(3, FLOOR); // count -> 3 (full)
        assertEq(registrar.candidateCount(ROUND_ID), 3);

        // New agent 4 can't register: set full.
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.CandidateSetFull.selector);
        registrar.burnForCandidate(4, FLOOR);
        assertFalse(registrar.isCandidate(ROUND_ID, 4));

        // But an already-registered agent still accepts more burns.
        vm.prank(nominator2);
        registrar.burnForCandidate(2, FLOOR);
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 2), FLOOR * 2);
        assertEq(registrar.candidateCount(ROUND_ID), 3);
    }

    /// @dev Boosting an owner-seeded auto-candidate accrues raw burn WITHOUT a
    ///      duplicate _roundCandidates entry and WITHOUT consuming a new slot.
    ///      Regression: previously burnForCandidate keyed registration off
    ///      agentFirstBurnBlock == 0, so an auto-candidate (block 0, no burn)
    ///      was mis-treated as new — double-pushed and re-checked maxCandidates.
    function test_burnForCandidateBoostAutoCandidateNoDuplicateNoNewSlot() public {
        _openDefaultRound(); // auto-candidates 1, 2; agentFirstBurnBlock == 0
        vm.warp(100);

        // Auto-candidate 1 is already registered with no burn / no firstBlock.
        assertTrue(registrar.isCandidate(ROUND_ID, 1));
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 1), 0);
        assertEq(registrar.candidateCount(ROUND_ID), 2);

        // Boosting it does NOT emit CandidateAdded (no re-registration); it only
        // accrues raw burn. A sub-floor boost is fine — it already holds a slot.
        uint256 boost = FLOOR / 2; // below the first-burn floor, allowed here
        vm.prank(nominator);
        vm.expectEmit(true, true, true, true, address(registrar));
        emit NominationBurnAdded(ROUND_ID, 1, nominator, boost, boost);
        registrar.burnForCandidate(1, boost);

        // No duplicate slot, count unchanged, raw accrued.
        assertEq(registrar.candidateCount(ROUND_ID), 2);
        assertEq(registrar.getCandidates(ROUND_ID), _candidates(1, 2));
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 1), boost);
    }

    /// @dev An auto-candidate's FIRST boost stamps agentFirstBurnBlock (it was 0
    ///      at openRound). A later boost must NOT move it — earliest-to-floor
    ///      tiebreak stays deterministic.
    function test_burnForCandidateAutoCandidateFirstBoostStampsFirstBurnBlock() public {
        _openDefaultRound();
        vm.warp(100);
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 1), 0);

        vm.roll(block.number + 3);
        uint256 stamped = block.number;
        vm.prank(nominator);
        registrar.burnForCandidate(1, FLOOR);
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 1), stamped);

        // Subsequent boost leaves the stamp fixed.
        vm.roll(block.number + 7);
        vm.prank(nominator2);
        registrar.burnForCandidate(1, 1e18);
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 1), stamped);
    }

    /// @dev Even when the candidate set is FULL, an auto-candidate can still be
    ///      boosted (it already holds a slot) — no CandidateSetFull. A genuinely
    ///      new agent still hits the backstop. Regression for the un-boostable
    ///      auto-candidate bug at capacity.
    function test_burnForCandidateBoostAutoCandidateWhenSetFull() public {
        // maxCandidates = 2 with both slots taken by auto-candidates 1, 2.
        uint256[] memory autoCandidates = _candidates(1, 2);
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, autoCandidates, FLOOR, BURN_CAP, 2
        );
        vm.warp(100);
        assertEq(registrar.candidateCount(ROUND_ID), 2); // full

        // Auto-candidate 2 is still boostable despite the full set.
        vm.prank(nominator);
        registrar.burnForCandidate(2, FLOOR);
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 2), FLOOR);
        assertEq(registrar.candidateCount(ROUND_ID), 2);

        // A genuinely-new agent 4 still hits the backstop.
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.CandidateSetFull.selector);
        registrar.burnForCandidate(4, FLOOR);
        assertFalse(registrar.isCandidate(ROUND_ID, 4));
    }

    /// @dev An auto-candidate's boost is NOT subject to the first-burn floor (it
    ///      already holds a slot); only genuinely-new agents must clear the floor
    ///      and the slot backstop on their first burn.
    function test_burnForCandidateAutoCandidateNotSubjectToFloorButNewIs() public {
        _openDefaultRound(); // auto-candidates 1, 2
        vm.warp(100);

        // Auto-candidate accepts a sub-floor boost.
        vm.prank(nominator);
        registrar.burnForCandidate(1, 1); // 1 wei, well below FLOOR
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 1), 1);

        // A genuinely-new agent below the floor is rejected and registers nothing.
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.BurnTooLow.selector);
        registrar.burnForCandidate(4, FLOOR - 1);
        assertFalse(registrar.isCandidate(ROUND_ID, 4));
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 4), 0);
    }

    function test_burnForCandidateRejectsWhenNoRoundOrClosed() public {
        // No round opened yet.
        vm.warp(100);
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.RoundNotInNominationWindow.selector);
        registrar.burnForCandidate(4, FLOOR);

        // Aborted round blocks further burns.
        _openDefaultRound();
        vm.warp(100);
        vm.prank(owner);
        registrar.abortRound(ROUND_ID, "halt");
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.RoundNotInNominationWindow.selector);
        registrar.burnForCandidate(4, FLOOR);
    }

    function test_transferFailureRevertsAndRollsBackRegistration() public {
        _openDefaultRound();
        address unfunded = address(0xFEED);
        vm.warp(100);
        vm.prank(unfunded);
        vm.expectRevert(BurnVoteRegistrar.TransferFailed.selector);
        registrar.burnForCandidate(4, FLOOR);
        assertFalse(registrar.isCandidate(ROUND_ID, 4));
        assertEq(registrar.nominationBurnByAgent(ROUND_ID, 4), 0);
        assertEq(registrar.agentFirstBurnBlock(ROUND_ID, 4), 0);
    }

    function test_openRoundRejectsFutureSnapshotBlock() public {
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.SnapshotBlockInFuture.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, block.number + 1, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );
    }

    function test_falseReturningTokenReverts() public {
        FalseReturnToken token = new FalseReturnToken();
        BurnVoteRegistrar badRegistrar = new BurnVoteRegistrar(address(token), BURN_ADDRESS, owner);
        vm.prank(owner);
        badRegistrar.setIdentityRegistry(address(identityRegistry));
        token.mint(nominator, 10_000_000e18);
        vm.prank(nominator);
        token.approve(address(badRegistrar), type(uint256).max);

        vm.prank(owner);
        badRegistrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        vm.warp(100);
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.TransferFailed.selector);
        badRegistrar.burnForCandidate(2, FLOOR);
    }

    function test_closeRoundOwnerOnlyAndWindow() public {
        _openDefaultRound();
        vm.prank(nominator2);
        vm.expectRevert(BurnVoteRegistrar.NotOwner.selector);
        registrar.closeRound(ROUND_ID);

        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.RoundNotInNominationWindow.selector);
        registrar.closeRound(ROUND_ID);

        vm.warp(300);
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(registrar));
        emit RoundClosed(ROUND_ID, block.number);
        registrar.closeRound(ROUND_ID);

        (,,,,,,, , bool closed) = registrar.rounds(ROUND_ID);
        assertTrue(closed);

        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.InvalidRound.selector);
        registrar.closeRound(ROUND_ID);
    }

    function test_abortRoundOwnerOnlyAndClosesRound() public {
        _openDefaultRound();

        vm.prank(nominator2);
        vm.expectRevert(BurnVoteRegistrar.NotOwner.selector);
        registrar.abortRound(ROUND_ID, "bad setup");

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(registrar));
        emit RoundAborted(ROUND_ID, "bad setup", block.number);
        registrar.abortRound(ROUND_ID, "bad setup");

        (,,,,,,, , bool closed) = registrar.rounds(ROUND_ID);
        assertTrue(closed);

        vm.warp(100);
        vm.prank(nominator);
        vm.expectRevert(BurnVoteRegistrar.RoundNotInNominationWindow.selector);
        registrar.burnForCandidate(4, FLOOR);
    }

    /// @dev Regression guard: burns transfer to the dead address, they do NOT
    ///      decrement totalSupply. Off-chain scorers and treasury dashboards
    ///      rely on the invariant that totalSupply is conserved.
    function test_burnPreservesTotalSupplyAndOnlyShiftsBalances() public {
        _openDefaultRound();
        vm.warp(100);
        uint256 supplyBefore = boon.totalSupply();
        uint256 nominatorBefore = boon.balanceOf(nominator);
        uint256 burnBefore = boon.balanceOf(BURN_ADDRESS);

        uint256 amount = 4000e18;
        vm.prank(nominator);
        registrar.burnForCandidate(4, amount);

        assertEq(boon.totalSupply(), supplyBefore, "totalSupply must not change on burn-to-dead");
        assertEq(boon.balanceOf(nominator), nominatorBefore - amount);
        assertEq(boon.balanceOf(BURN_ADDRESS), burnBefore + amount);
        assertEq(
            boon.balanceOf(nominator) + boon.balanceOf(BURN_ADDRESS), nominatorBefore + burnBefore
        );
    }

    /// @dev openRound must emit CandidateAdded for each auto-candidate, in order.
    function test_openRoundEmitsCandidateAddedForEachAutoCandidate() public {
        uint256[] memory autoCandidates = _candidates(7, 8, 9);
        vm.prank(owner);

        vm.expectEmit(true, true, true, true, address(registrar));
        emit CandidateAdded(ROUND_ID, 7, address(0), 0);
        vm.expectEmit(true, true, true, true, address(registrar));
        emit CandidateAdded(ROUND_ID, 8, address(0), 0);
        vm.expectEmit(true, true, true, true, address(registrar));
        emit CandidateAdded(ROUND_ID, 9, address(0), 0);

        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, autoCandidates, FLOOR, BURN_CAP, MAX_CANDIDATES
        );
    }

    /// @dev USDT-style non-bool-returning transferFrom must be accepted.
    function test_emptyReturnTokenSucceedsOnBurnForCandidate() public {
        EmptyReturnToken token = new EmptyReturnToken();
        BurnVoteRegistrar quirkRegistrar =
            new BurnVoteRegistrar(address(token), BURN_ADDRESS, owner);
        vm.prank(owner);
        quirkRegistrar.setIdentityRegistry(address(identityRegistry));
        token.mint(nominator, 10_000_000e18);
        vm.prank(nominator);
        token.approve(address(quirkRegistrar), type(uint256).max);

        vm.prank(owner);
        quirkRegistrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        vm.warp(100);
        vm.prank(nominator);
        quirkRegistrar.burnForCandidate(2, FLOOR);

        assertEq(token.balanceOf(BURN_ADDRESS), FLOOR);
        assertEq(quirkRegistrar.nominationBurnByAgent(ROUND_ID, 2), FLOOR);
    }

    /// @dev closeRound must reject stale roundIds.
    function test_closeRoundRejectsStaleRoundId() public {
        _openDefaultRound();
        vm.warp(300);
        vm.prank(owner);
        registrar.closeRound(ROUND_ID);

        vm.prank(owner);
        registrar.openRound(
            ROUND_ID + 1, 400, 500, 600, SNAPSHOT_BLOCK, _candidates(4), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        vm.warp(600);
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.InvalidRound.selector);
        registrar.closeRound(ROUND_ID);

        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.InvalidRound.selector);
        registrar.closeRound(9999);
    }

    /// @dev adv-h1: after votingClosesAt the only legal transition is closeRound.
    function test_abortRoundRejectsAfterVotingClosed() public {
        _openDefaultRound();

        vm.warp(250);
        vm.prank(owner);
        registrar.abortRound(ROUND_ID, "still inside");
        (,,,,,,, , bool closed) = registrar.rounds(ROUND_ID);
        assertTrue(closed);

        // Fresh round; wait out the abort cooldown so adv-m4 doesn't fire.
        vm.warp(250 + 7 days + 1);
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID + 1,
            block.timestamp + 100,
            block.timestamp + 200,
            block.timestamp + 300,
            SNAPSHOT_BLOCK,
            _candidates(1, 2),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );
        vm.warp(block.timestamp + 300);
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.AbortWindowClosed.selector);
        registrar.abortRound(ROUND_ID + 1, "results-aware abuse");
    }

    /// @dev adv-h2: openRound must refuse round durations beyond MAX_ROUND_DURATION.
    function test_openRoundRejectsRoundDurationOverCap() public {
        uint256 cap = registrar.MAX_ROUND_DURATION();
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.InvalidWindow.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, 200 + cap + 1, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.InvalidWindow.selector);
        registrar.openRound(
            ROUND_ID, 100, 200, type(uint256).max, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );

        // Exactly the cap is allowed.
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID, 100, 200, 200 + cap, SNAPSHOT_BLOCK, _candidates(1), FLOOR, BURN_CAP, MAX_CANDIDATES
        );
    }

    /// @dev adv-m3: openRound timestamps must not be in the past.
    function test_openRoundRejectsPastNominationOpensAt() public {
        vm.warp(10_000);
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.InvalidWindow.selector);
        registrar.openRound(
            ROUND_ID,
            block.timestamp - 1,
            block.timestamp + 100,
            block.timestamp + 200,
            SNAPSHOT_BLOCK,
            _candidates(1),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );

        // Same block is allowed.
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID,
            block.timestamp,
            block.timestamp + 100,
            block.timestamp + 200,
            SNAPSHOT_BLOCK,
            _candidates(1),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );
    }

    /// @dev adv-m4: a freshly-aborted round must cool down before the next round.
    function test_openRoundEnforcesPostAbortCooldown() public {
        _openDefaultRound();
        vm.warp(150);
        vm.prank(owner);
        registrar.abortRound(ROUND_ID, "operator typo");
        uint256 abortedAt = registrar.lastAbortAt();
        assertEq(abortedAt, 150);

        vm.warp(150 + 1 days);
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.AbortCooldownActive.selector);
        registrar.openRound(
            ROUND_ID + 1,
            block.timestamp + 100,
            block.timestamp + 200,
            block.timestamp + 300,
            SNAPSHOT_BLOCK,
            _candidates(1, 2),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );

        vm.warp(abortedAt + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.AbortCooldownActive.selector);
        registrar.openRound(
            ROUND_ID + 1,
            block.timestamp + 100,
            block.timestamp + 200,
            block.timestamp + 300,
            SNAPSHOT_BLOCK,
            _candidates(1, 2),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );

        vm.warp(abortedAt + 7 days);
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID + 1,
            block.timestamp + 100,
            block.timestamp + 200,
            block.timestamp + 300,
            SNAPSHOT_BLOCK,
            _candidates(1, 2),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );
        assertEq(registrar.currentRoundId(), ROUND_ID + 1);
    }

    /// @dev openRound must refuse `snapshotBlock == block.number`.
    function test_openRoundRejectsSameBlockSnapshot() public {
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.SnapshotBlockInFuture.selector);
        registrar.openRound(
            ROUND_ID,
            block.timestamp + 100,
            block.timestamp + 200,
            block.timestamp + 300,
            block.number,
            _candidates(1),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );

        // One block earlier is allowed.
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID,
            block.timestamp + 100,
            block.timestamp + 200,
            block.timestamp + 300,
            block.number - 1,
            _candidates(1),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );
    }

    /// @dev the owner-managed exclusion list must block auto-candidates.
    function test_setCandidateExcludedBlocksAutoCandidates() public {
        vm.prank(owner);
        registrar.setCandidateExcluded(1, true);
        assertTrue(registrar.excludedCandidateIds(1));

        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.CandidateNotAllowed.selector);
        registrar.openRound(
            ROUND_ID,
            block.timestamp + 100,
            block.timestamp + 200,
            block.timestamp + 300,
            block.number - 1,
            _candidates(1),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );

        vm.prank(owner);
        registrar.setCandidateExcluded(1, false);
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID,
            block.timestamp + 100,
            block.timestamp + 200,
            block.timestamp + 300,
            block.number - 1,
            _candidates(1, 2),
            FLOOR,
            BURN_CAP,
            MAX_CANDIDATES
        );
        assertTrue(registrar.isCandidate(ROUND_ID, 1));
    }

    /// @dev setIdentityRegistry and setCandidateExcluded are locked
    ///      while a round is active.
    function test_registryAndExclusionLockedDuringActiveRound() public {
        _openDefaultRound();

        MockIdentityRegistry alt = new MockIdentityRegistry();

        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.PreviousRoundActive.selector);
        registrar.setIdentityRegistry(address(alt));

        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.PreviousRoundActive.selector);
        registrar.setCandidateExcluded(7, true);

        vm.warp(300);
        vm.prank(owner);
        registrar.closeRound(ROUND_ID);

        vm.prank(owner);
        registrar.setIdentityRegistry(address(alt));
        vm.prank(owner);
        registrar.setCandidateExcluded(7, true);
    }

    /// @dev setIdentityRegistry refuses zero.
    function test_setIdentityRegistryRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(BurnVoteRegistrar.ZeroAddress.selector);
        registrar.setIdentityRegistry(address(0));
    }

    function _openDefaultRound() internal {
        vm.prank(owner);
        registrar.openRound(
            ROUND_ID, 100, 200, 300, SNAPSHOT_BLOCK, _candidates(1, 2), FLOOR, BURN_CAP, MAX_CANDIDATES
        );
    }

    function _fundAndApprove(address account) internal {
        boon.mint(account, 100_000_000e18);
        vm.prank(account);
        boon.approve(address(registrar), type(uint256).max);
    }

    function _candidates(uint256 a) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](1);
        arr[0] = a;
    }

    function _candidates(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }

    function _candidates(uint256 a, uint256 b, uint256 c)
        internal
        pure
        returns (uint256[] memory arr)
    {
        arr = new uint256[](3);
        arr[0] = a;
        arr[1] = b;
        arr[2] = c;
    }
}
