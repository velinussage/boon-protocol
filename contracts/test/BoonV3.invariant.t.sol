// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {BoonV3} from "../BoonV3.sol";
import {BoonGratitudeAttestationV3} from "../BoonGratitudeAttestationV3.sol";
import {MockBOON} from "./mocks/MockBOON.sol";

/**
 * Handler-based invariants for BoonV3's walletless deferred-settlement state.
 *
 * This fuzzes random sequences of public/private social tips, empty-handle links,
 * escrowed links, link-and-claim batches, standalone claim batches, and relinks.
 * The handler keeps an independent model of per-handle pending tip queues so the
 * invariants can detect drift in the intrusive escrow linked list, first-claim
 * wallet immutability, nonce accounting, and USDC / BOON conservation.
 */
contract InvariantUSDCV3 {
    string public name = "USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "not approved");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract InvariantIdentityRegistryV3 {
    mapping(uint256 => address) internal owners;
    mapping(uint256 => address) internal wallets;

    function setAgent(uint256 agentId, address owner, address wallet) external {
        owners[agentId] = owner;
        wallets[agentId] = wallet;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = owners[agentId];
        if (owner == address(0)) revert("missing");
        return owner;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return wallets[agentId];
    }
}

contract BoonV3InvariantHandler is Test {
    uint256 internal constant PRIVATE_TIP_BURN = 500_000e18;

    BoonV3 public immutable boon;
    InvariantUSDCV3 public immutable usdc;
    MockBOON public immutable boonToken;
    uint256 public immutable signerKey;
    uint256 public immutable guardianKey;

    string[] public handles;
    bytes32[] public handleHashes;
    address[] public actors;
    address[] public recipients;

    mapping(bytes32 => bool) public hashSeen;
    mapping(bytes32 => uint256) public expectedNonce;
    mapping(bytes32 => address) public expectedFirstClaimWallet;
    mapping(bytes32 => address) public expectedLinkedWallet;
    mapping(bytes32 => uint256) public expectedEscrowCount;
    mapping(bytes32 => uint256[]) internal pendingByHash;
    mapping(bytes32 => uint256) internal pendingCursor;

    mapping(uint256 => bool) public expectedPending;
    mapping(uint256 => uint256) public expectedTipAmount;
    mapping(uint256 => bytes32) public expectedTipHandleHash;

    uint256 public trackedAcceptedUsdc;
    uint256 public trackedDirectUsdc;
    uint256 public trackedClaimedUsdc;
    uint256 public trackedCurrentEscrow;
    uint256 public trackedBoonBurn;
    uint256 internal privateCommitmentSeq;

    constructor(
        BoonV3 _boon,
        InvariantUSDCV3 _usdc,
        MockBOON _boonToken,
        uint256 _signerKey,
        uint256 _guardianKey
    ) {
        boon = _boon;
        usdc = _usdc;
        boonToken = _boonToken;
        signerKey = _signerKey;
        guardianKey = _guardianKey;

        for (uint256 i; i < 5; ++i) {
            address actor = address(uint160(0xA000 + i));
            actors.push(actor);
            usdc.mint(actor, 1_000_000e6);
            boonToken.mint(actor, 1_000_000_000e18);
            vm.startPrank(actor);
            usdc.approve(address(boon), type(uint256).max);
            boonToken.approve(address(boon), type(uint256).max);
            vm.stopPrank();
        }

        for (uint256 i; i < 6; ++i) {
            recipients.push(address(uint160(0xB000 + i)));
        }
    }

    // ── actions ─────────────────────────────────────────────────────────

    function tip(uint8 actorSeed, uint8 handleSeed, uint96 amount) external {
        address actor = actors[actorSeed % actors.length];
        (string memory handle, bytes32 handleHash) = _handleFor(handleSeed);
        uint256 usdcAmount = bound(uint256(amount), boon.MIN_ESCROW_USDC(), 25e6);

        address linked = boon.linkedWallet(handleHash);
        if (linked == actor) return;

        uint256 nextTipId = boon.nextTipId();
        vm.prank(actor);
        try boon.tip(
            handleHash, handle, linked, usdcAmount, "v3 note", false, _emptyPermit()
        ) returns (
            uint256 tipId
        ) {
            assertEq(tipId, nextTipId, "unexpected tipId");
            _recordAcceptedTip(tipId, handleHash, actor, usdcAmount, linked != address(0), 0);
        } catch {}
    }

    function tipPrivate(uint8 actorSeed, uint8 handleSeed, uint96 amount) external {
        address actor = actors[actorSeed % actors.length];
        (string memory handle, bytes32 handleHash) = _handleFor(handleSeed);
        uint256 usdcAmount = bound(uint256(amount), boon.MIN_ESCROW_USDC(), 25e6);

        address linked = boon.linkedWallet(handleHash);
        if (linked == actor) return;

        bytes32 commitment =
            keccak256(abi.encode(address(this), actor, handleHash, privateCommitmentSeq++));
        uint256 nextTipId = boon.nextTipId();
        vm.prank(actor);
        try boon.tipPrivate(
            handleHash, handle, linked, usdcAmount, commitment, false, _emptyPermit()
        ) returns (
            uint256 tipId
        ) {
            assertEq(tipId, nextTipId, "unexpected private tipId");
            _recordAcceptedTip(
                tipId, handleHash, actor, usdcAmount, linked != address(0), PRIVATE_TIP_BURN
            );
        } catch {}
    }

    function linkEmpty(uint8 handleSeed, uint8 recipientSeed) external {
        (, bytes32 handleHash) = _handleFor(handleSeed);
        if (boon.linkedWallet(handleHash) != address(0)) return;
        if (boon.firstEscrowedTipId(handleHash) != 0) return;

        address recipient = _recipientFor(recipientSeed);
        uint256 nonce = boon.nonces(handleHash);
        bytes memory workerSig = _signLink(signerKey, handleHash, recipient, nonce);

        try boon.link(handleHash, recipient, nonce, workerSig) {
            _recordLink(handleHash, recipient, nonce);
        } catch {}
    }

    function linkEscrowed(uint8 handleSeed, uint8 recipientSeed) external {
        (, bytes32 handleHash) = _handleFor(handleSeed);
        if (boon.linkedWallet(handleHash) != address(0)) return;
        if (boon.firstEscrowedTipId(handleHash) == 0) return;

        address recipient = _recipientFor(recipientSeed);
        uint256 nonce = boon.nonces(handleHash);
        bytes memory workerSig = _signLink(signerKey, handleHash, recipient, nonce);
        bytes memory guardianSig = _signLink(guardianKey, handleHash, recipient, nonce);

        try boon.linkEscrowed(handleHash, recipient, nonce, workerSig, guardianSig) {
            _recordLink(handleHash, recipient, nonce);
        } catch {}
    }

    function linkAndClaim(uint8 handleSeed, uint8 recipientSeed, uint8 maxItemsSeed) external {
        (, bytes32 handleHash) = _handleFor(handleSeed);
        if (boon.linkedWallet(handleHash) != address(0)) return;
        if (boon.firstEscrowedTipId(handleHash) == 0) return;

        address recipient = _recipientFor(recipientSeed);
        uint256 nonce = boon.nonces(handleHash);
        uint256 maxItems = bound(uint256(maxItemsSeed), 1, 16);
        bytes memory workerSig = _signLink(signerKey, handleHash, recipient, nonce);
        bytes memory guardianSig = _signLink(guardianKey, handleHash, recipient, nonce);

        try boon.linkAndClaim(handleHash, recipient, nonce, workerSig, guardianSig, maxItems) {
            _recordLink(handleHash, recipient, nonce);
            _settleHead(handleHash, maxItems);
        } catch {}
    }

    function claim(uint8 handleSeed, uint8 maxItemsSeed) external {
        (, bytes32 handleHash) = _handleFor(handleSeed);
        if (boon.firstClaimWallet(handleHash) == address(0)) return;

        uint256 maxItems = bound(uint256(maxItemsSeed), 1, 16);
        try boon.claim(handleHash, maxItems) {
            _settleHead(handleHash, maxItems);
        } catch {}
    }

    function relink(uint8 handleSeed, uint8 recipientSeed) external {
        (, bytes32 handleHash) = _handleFor(handleSeed);
        if (boon.linkedWallet(handleHash) == address(0)) return;

        address recipient = _recipientFor(recipientSeed);
        uint256 nonce = boon.nonces(handleHash);
        bytes memory workerSig = _signLink(signerKey, handleHash, recipient, nonce);

        try boon.relink(handleHash, recipient, nonce, workerSig) {
            expectedNonce[handleHash] = nonce + 1;
            expectedLinkedWallet[handleHash] = recipient;
        } catch {}
    }

    // ── invariant model helpers ─────────────────────────────────────────

    function _recordAcceptedTip(
        uint256 tipId,
        bytes32 handleHash,
        address,
        uint256 usdcAmount,
        bool direct,
        uint256 boonBurned
    ) internal {
        trackedAcceptedUsdc += usdcAmount;
        trackedBoonBurn += boonBurned;

        if (direct) {
            trackedDirectUsdc += usdcAmount;
            return;
        }

        pendingByHash[handleHash].push(tipId);
        expectedPending[tipId] = true;
        expectedTipAmount[tipId] = usdcAmount;
        expectedTipHandleHash[tipId] = handleHash;
        expectedEscrowCount[handleHash] += 1;
        trackedCurrentEscrow += usdcAmount;
    }

    function _recordLink(bytes32 handleHash, address recipient, uint256 nonce) internal {
        expectedLinkedWallet[handleHash] = recipient;
        if (expectedFirstClaimWallet[handleHash] == address(0)) {
            expectedFirstClaimWallet[handleHash] = recipient;
        }
        expectedNonce[handleHash] = nonce + 1;
    }

    function _settleHead(bytes32 handleHash, uint256 maxItems) internal {
        uint256 cursor = pendingCursor[handleHash];
        uint256[] storage queue = pendingByHash[handleHash];
        uint256 processed;
        while (cursor < queue.length && processed < maxItems) {
            uint256 tipId = queue[cursor];
            if (expectedPending[tipId]) {
                expectedPending[tipId] = false;
                uint256 amount = expectedTipAmount[tipId];
                trackedCurrentEscrow -= amount;
                trackedClaimedUsdc += amount;
                expectedEscrowCount[handleHash] -= 1;
                unchecked {
                    ++processed;
                }
            }
            unchecked {
                ++cursor;
            }
        }
        pendingCursor[handleHash] = cursor;
    }

    function expectedEscrowAmountForHash(bytes32 handleHash) external view returns (uint256 sum) {
        uint256[] storage queue = pendingByHash[handleHash];
        for (uint256 i = pendingCursor[handleHash]; i < queue.length;) {
            uint256 tipId = queue[i];
            if (expectedPending[tipId]) sum += expectedTipAmount[tipId];
            unchecked {
                ++i;
            }
        }
    }

    function expectedPendingTipIdAt(bytes32 handleHash, uint256 index)
        external
        view
        returns (uint256)
    {
        uint256[] storage queue = pendingByHash[handleHash];
        uint256 cursor = pendingCursor[handleHash];
        return queue[cursor + index];
    }

    function hashesLength() external view returns (uint256) {
        return handleHashes.length;
    }

    function _handleFor(uint8 seed) internal returns (string memory, bytes32) {
        string[8] memory choices = [
            "github:a",
            "github:b",
            "github:c",
            "github:user-one",
            "x:alpha",
            "x:beta",
            "x:user_two",
            "x:recipient"
        ];
        string memory handle = choices[seed % choices.length];
        bytes32 handleHash = keccak256(bytes(handle));
        if (!hashSeen[handleHash]) {
            hashSeen[handleHash] = true;
            handles.push(handle);
            handleHashes.push(handleHash);
        }
        return (handle, handleHash);
    }

    function _recipientFor(uint8 seed) internal view returns (address) {
        return recipients[seed % recipients.length];
    }

    function _signLink(uint256 key, bytes32 handleHash, address recipient, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(boon.LINK_TYPEHASH(), handleHash, recipient, nonce));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", boon.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _emptyPermit() internal pure returns (BoonV3.Permit memory) {
        return BoonV3.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)});
    }
}

contract BoonV3InvariantTest is StdInvariant, Test {
    uint256 internal constant PRIVATE_TIP_BURN = 500_000e18;
    uint256 internal constant ATTESTATION_BURN = 3_000_000e18;
    uint256 internal constant UNLOCK_PRICE_USDC = 1_000_000;

    InvariantUSDCV3 internal usdc;
    MockBOON internal boonToken;
    InvariantIdentityRegistryV3 internal registry;
    BoonGratitudeAttestationV3 internal sbt;
    BoonV3 internal boon;
    BoonV3InvariantHandler internal handler;

    uint256 internal signerKey = 0xA11CE;
    uint256 internal guardianKey = 0xB0B0;
    address internal multisig = address(0x515AFE);

    function setUp() public {
        usdc = new InvariantUSDCV3();
        boonToken = new MockBOON();
        registry = new InvariantIdentityRegistryV3();
        sbt = new BoonGratitudeAttestationV3(address(this), multisig, 48 hours);
        boon = new BoonV3(
            address(usdc),
            address(boonToken),
            address(registry),
            address(sbt),
            vm.addr(signerKey),
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            vm.addr(guardianKey)
        );
        sbt.initializeMinter(address(boon));
        handler = new BoonV3InvariantHandler(boon, usdc, boonToken, signerKey, guardianKey);

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = BoonV3InvariantHandler.tip.selector;
        selectors[1] = BoonV3InvariantHandler.tipPrivate.selector;
        selectors[2] = BoonV3InvariantHandler.linkEmpty.selector;
        selectors[3] = BoonV3InvariantHandler.linkEscrowed.selector;
        selectors[4] = BoonV3InvariantHandler.linkAndClaim.selector;
        selectors[5] = BoonV3InvariantHandler.claim.selector;
        selectors[6] = BoonV3InvariantHandler.relink.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_v3UsdcEscrowConserved() public view {
        assertEq(
            usdc.balanceOf(address(boon)),
            handler.trackedCurrentEscrow(),
            "contract USDC != model escrow"
        );
        assertEq(
            handler.trackedAcceptedUsdc(),
            handler.trackedDirectUsdc() + handler.trackedClaimedUsdc()
                + handler.trackedCurrentEscrow(),
            "accepted USDC != direct + claimed + escrow"
        );
    }

    function invariant_v3EscrowLinkedListsMatchModel() public view {
        uint256 n = handler.hashesLength();
        for (uint256 i; i < n; ++i) {
            bytes32 handleHash = handler.handleHashes(i);
            uint256 expectedCount = handler.expectedEscrowCount(handleHash);
            assertEq(boon.escrowCount(handleHash), expectedCount, "escrow count drift");

            uint256[] memory ids = boon.getEscrowedTipIds(handleHash, 0);
            assertEq(ids.length, expectedCount, "escrow id length drift");

            uint256 sum;
            for (uint256 j; j < ids.length; ++j) {
                uint256 tipId = ids[j];
                assertEq(tipId, handler.expectedPendingTipIdAt(handleHash, j), "escrow order drift");
                BoonV3.EscrowEntry memory entry = boon.getEscrowEntry(tipId);
                assertEq(entry.handleHash, handleHash, "entry handle drift");
                assertFalse(entry.claimed, "pending entry marked claimed");
                assertEq(entry.usdcAmount, handler.expectedTipAmount(tipId), "entry amount drift");
                sum += entry.usdcAmount;
            }
            assertEq(sum, handler.expectedEscrowAmountForHash(handleHash), "escrow amount drift");
            if (expectedCount == 0) {
                assertEq(boon.firstEscrowedTipId(handleHash), 0, "empty head not cleared");
                assertEq(boon.lastEscrowedTipId(handleHash), 0, "empty tail not cleared");
            }
        }
    }

    function invariant_v3FirstClaimWalletIsStableAndRelinkOnlyMovesFutureTips() public view {
        uint256 n = handler.hashesLength();
        for (uint256 i; i < n; ++i) {
            bytes32 handleHash = handler.handleHashes(i);
            assertEq(
                boon.firstClaimWallet(handleHash),
                handler.expectedFirstClaimWallet(handleHash),
                "firstClaimWallet drift"
            );
            assertEq(
                boon.linkedWallet(handleHash),
                handler.expectedLinkedWallet(handleHash),
                "linked wallet drift"
            );
        }
    }

    function invariant_v3NoncesTracked() public view {
        uint256 n = handler.hashesLength();
        for (uint256 i; i < n; ++i) {
            bytes32 handleHash = handler.handleHashes(i);
            assertEq(boon.nonces(handleHash), handler.expectedNonce(handleHash), "nonce drift");
            if (boon.nonces(handleHash) > 0) {
                assertTrue(boon.linkedWallet(handleHash) != address(0), "nonce > 0 but no link");
                assertTrue(
                    boon.firstClaimWallet(handleHash) != address(0),
                    "nonce > 0 but no first claim wallet"
                );
            }
        }
    }

    function invariant_v3BoonBurnConserved() public view {
        assertEq(
            boonToken.balanceOf(boon.BOON_BURN_ADDRESS()),
            handler.trackedBoonBurn(),
            "BOON burn drift"
        );
    }

    // ── Additional invariants (failure modes 6, 7, 8 from plan) ───────────

    /// Claimed entries are terminal. Once `entry.claimed == true`, the entry must
    /// no longer appear in any handle's pending list (next pointer cleared, handler
    /// model marks it not-pending). Catches double-claim resurrection and stale
    /// linked-list residue from `_settleEscrowEntry` / `_unlinkEscrowEntry`.
    function invariant_v3ClaimedEntriesAreTerminal() public view {
        uint256 last = boon.nextTipId();
        for (uint256 tipId = 1; tipId < last; ++tipId) {
            BoonV3.EscrowEntry memory entry = boon.getEscrowEntry(tipId);
            if (!entry.claimed) continue;
            assertFalse(
                handler.expectedPending(tipId),
                "claimed entry still flagged pending in handler model"
            );
            assertEq(entry.nextTipId, 0, "claimed entry retains stale linked-list next pointer");
        }
    }

    /// Contract USDC balance is always large enough to honor every outstanding
    /// (unclaimed, non-refunded) escrow entry at its recorded amount. Catches any
    /// path that drains USDC without zeroing the corresponding escrow entry, and
    /// catches accounting drift between `trackedCurrentEscrow` and per-entry
    /// `usdcAmount` reads from contract storage.
    function invariant_v3ContractCanFulfillOutstandingEscrow() public view {
        uint256 outstanding;
        uint256 last = boon.nextTipId();
        for (uint256 tipId = 1; tipId < last; ++tipId) {
            BoonV3.EscrowEntry memory entry = boon.getEscrowEntry(tipId);
            if (!entry.claimed && entry.tipper != address(0)) {
                outstanding += entry.usdcAmount;
            }
        }
        assertGe(
            usdc.balanceOf(address(boon)),
            outstanding,
            "contract USDC balance cannot cover outstanding escrow"
        );
    }

    /// `firstClaimWallet[handleHash]` is only ever set inside a link operation,
    /// and once set persists. If `firstClaimWallet[h] != 0`, the handle must have
    /// been linked (`linkedWallet[h] != 0`). Strengthens Q8: there is no code path
    /// that can set `firstClaimWallet` without simultaneously setting `linkedWallet`,
    /// and no `relink` mutates `firstClaimWallet`. This complements the existing
    /// stability invariant (#3) with an existence check across all observed handles.
    function invariant_v3FirstClaimWalletImpliesLinked() public view {
        uint256 n = handler.hashesLength();
        for (uint256 i; i < n; ++i) {
            bytes32 handleHash = handler.handleHashes(i);
            address firstClaim = boon.firstClaimWallet(handleHash);
            if (firstClaim == address(0)) continue;
            assertTrue(
                boon.linkedWallet(handleHash) != address(0),
                "firstClaimWallet set but handle never linked"
            );
            assertTrue(boon.nonces(handleHash) > 0, "firstClaimWallet set but nonce never advanced");
        }
    }
}
