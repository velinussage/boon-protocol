// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BoonV3} from "../BoonV3.sol";
import {BoonGratitudeAttestationV3} from "../BoonGratitudeAttestationV3.sol";
import {MockBOON} from "./mocks/MockBOON.sol";

contract MockUSDCV3 {
    string public name = "USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public rejectTransferTo;

    BoonV3 public reenterTarget;
    bytes32 public reenterHandleHash;
    bool public reenterOnTransfer;
    bytes4 public observedReenterSelector;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function setRejectTransferTo(address to, bool value) external {
        rejectTransferTo[to] = value;
    }

    function setReenterOnTransfer(BoonV3 target, bytes32 handleHash, bool value) external {
        reenterTarget = target;
        reenterHandleHash = handleHash;
        reenterOnTransfer = value;
        observedReenterSelector = bytes4(0);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!rejectTransferTo[to], "recipient rejected");
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (reenterOnTransfer) {
            reenterOnTransfer = false;
            try reenterTarget.claim(reenterHandleHash, 1) {}
            catch (bytes memory reason) {
                observedReenterSelector = _selector(reason);
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!rejectTransferTo[to], "recipient rejected");
        require(balanceOf[from] >= amount, "insufficient");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "not approved");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function _selector(bytes memory reason) internal pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(reason, 32))
        }
    }
}

contract MockIdentityRegistryV3 {
    mapping(uint256 => address) internal owners;
    mapping(uint256 => address) internal wallets;
    mapping(uint256 => bool) public ownerReverts;

    function setAgent(uint256 agentId, address owner, address wallet) external {
        owners[agentId] = owner;
        wallets[agentId] = wallet;
        ownerReverts[agentId] = false;
    }

    function setOwnerReverts(uint256 agentId, bool value) external {
        ownerReverts[agentId] = value;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        if (ownerReverts[agentId]) revert("missing");
        address owner = owners[agentId];
        if (owner == address(0)) revert("missing");
        return owner;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return wallets[agentId];
    }
}

contract BoonV3Test is Test {
    uint256 internal constant PRIVATE_TIP_BURN = 500_000e18;
    uint256 internal constant ATTESTATION_BURN = 3_000_000e18;
    uint256 internal constant UNLOCK_PRICE_USDC = 1_000_000;

    MockUSDCV3 internal usdc;
    MockBOON internal boonToken;
    MockIdentityRegistryV3 internal registry;
    BoonGratitudeAttestationV3 internal sbt;
    BoonV3 internal boon;

    uint256 internal signerKey = 0xA11CE;
    uint256 internal guardianKey = 0xB0B0;
    address internal signer;
    address internal guardian;
    address internal multisig = address(0x515AFE);

    address internal tipper = address(0xCAFE);
    address internal otherTipper = address(0xD00D);
    address internal alice = address(0xA11C);
    address internal bob = address(0xB0B);
    address internal agentOwner = address(0xA901);
    address internal agentWallet = address(0xA902);

    string internal constant HANDLE = "github:alice";
    bytes32 internal constant HANDLE_HASH = keccak256(bytes(HANDLE));

    function setUp() public {
        signer = vm.addr(signerKey);
        guardian = vm.addr(guardianKey);
        usdc = new MockUSDCV3();
        boonToken = new MockBOON();
        registry = new MockIdentityRegistryV3();
        sbt = new BoonGratitudeAttestationV3(address(this), multisig, 48 hours);
        boon = new BoonV3(
            address(usdc),
            address(boonToken),
            address(registry),
            address(sbt),
            signer,
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            guardian
        );
        sbt.initializeMinter(address(boon));
        registry.setAgent(42, agentOwner, agentWallet);
        _fundAndApprove(tipper);
        _fundAndApprove(otherTipper);
        _fundAndApprove(alice);
        _fundAndApprove(bob);
    }

    function test_constructorStoresV3ImmutablesAndDomain() public view {
        assertEq(boon.USDC(), address(usdc));
        assertEq(boon.BOON(), address(boonToken));
        assertEq(boon.IDENTITY_REGISTRY(), address(registry));
        assertEq(boon.ATTESTATION_CONTRACT(), address(sbt));
        assertEq(boon.PRIVATE_TIP_BURN(), PRIVATE_TIP_BURN);
        assertEq(boon.ATTESTATION_BURN(), ATTESTATION_BURN);
        assertEq(boon.UNLOCK_PRICE_USDC(), UNLOCK_PRICE_USDC);
        assertEq(boon.ESCROW_REFUND_DELAY(), 180 days);
        assertEq(
            boon.DOMAIN_SEPARATOR(), _domainSeparator("Boon", "3", block.chainid, address(boon))
        );
    }

    function test_constructorRejectsZeroAndCollidingTokens() public {
        vm.expectRevert(BoonV3.ZeroAddress.selector);
        new BoonV3(
            address(0),
            address(boonToken),
            address(registry),
            address(sbt),
            signer,
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            guardian
        );

        vm.expectRevert(BoonV3.TokenAddressCollision.selector);
        new BoonV3(
            address(usdc),
            address(usdc),
            address(registry),
            address(sbt),
            signer,
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            guardian
        );
    }

    function test_publicTipToUnlinkedHandleEscrowsThenLinkAndClaimPaysFirstClaimWallet() public {
        vm.prank(tipper);
        uint256 tipId =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());

        assertEq(tipId, 1);
        assertEq(usdc.balanceOf(address(boon)), 1e6);
        assertEq(boon.escrowCount(HANDLE_HASH), 1);
        assertEq(boon.firstEscrowedTipId(HANDLE_HASH), tipId);
        BoonV3.EscrowEntry memory entry = boon.getEscrowEntry(tipId);
        assertEq(entry.tipper, tipper);
        assertEq(entry.usdcAmount, 1e6);
        assertEq(entry.noteHash, keccak256(bytes("v3 note")));
        assertFalse(entry.mintAttestation);

        uint256 aliceBefore = usdc.balanceOf(alice);
        _linkAndClaim(HANDLE_HASH, alice, 32);

        assertEq(boon.linkedWallet(HANDLE_HASH), alice);
        assertEq(boon.firstClaimWallet(HANDLE_HASH), alice);
        assertEq(boon.escrowCount(HANDLE_HASH), 0);
        assertEq(boon.firstEscrowedTipId(HANDLE_HASH), 0);
        assertEq(usdc.balanceOf(address(boon)), 0);
        assertEq(usdc.balanceOf(alice), aliceBefore + 1e6);
        assertTrue(boon.getEscrowEntry(tipId).claimed);
    }

    function test_publicTipToLinkedHandleRoutesDirectlyAndMintsAttestation() public {
        _linkEmptyHandle(HANDLE_HASH, alice);

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(tipper);
        uint256 tipId = boon.tip(HANDLE_HASH, HANDLE, alice, 2e6, "v3 note", true, _emptyPermit());

        assertEq(usdc.balanceOf(alice), aliceBefore + 2e6);
        assertEq(usdc.balanceOf(address(boon)), 0);
        assertEq(boon.escrowCount(HANDLE_HASH), 0);
        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), ATTESTATION_BURN);
        assertEq(sbt.ownerOf(tipId), alice);
    }

    function test_privateTipToUnlinkedHandleBurnsImmediatelyAndDefersSbtToClaim() public {
        bytes32 commitment = keccak256("private v3");

        vm.prank(tipper);
        uint256 tipId =
            boon.tipPrivate(HANDLE_HASH, HANDLE, address(0), 3e6, commitment, true, _emptyPermit());

        assertEq(usdc.balanceOf(address(boon)), 3e6);
        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), PRIVATE_TIP_BURN + ATTESTATION_BURN);
        assertEq(boon.blobKeyCommitment(tipId), commitment);
        BoonV3.EscrowEntry memory entry = boon.getEscrowEntry(tipId);
        assertEq(entry.privateCommitment, commitment);
        assertEq(entry.boonBurned, PRIVATE_TIP_BURN + ATTESTATION_BURN);
        assertTrue(entry.mintAttestation);

        uint256 aliceBefore = usdc.balanceOf(alice);
        _linkAndClaim(HANDLE_HASH, alice, 32);

        assertEq(usdc.balanceOf(alice), aliceBefore + 3e6);
        assertEq(sbt.ownerOf(tipId), alice);
        assertTrue(sbt.locked(tipId));
    }

    function test_relinkDoesNotCaptureOldEscrowButReceivesFutureDirectTips() public {
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());
        vm.prank(otherTipper);
        boon.tip(HANDLE_HASH, HANDLE, address(0), 2e6, "v3 note", false, _emptyPermit());

        _linkEscrowedOnly(HANDLE_HASH, alice);
        assertEq(boon.firstClaimWallet(HANDLE_HASH), alice);

        _relink(HANDLE_HASH, bob);
        assertEq(boon.linkedWallet(HANDLE_HASH), bob);
        assertEq(boon.firstClaimWallet(HANDLE_HASH), alice);

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        boon.claim(HANDLE_HASH, 10);
        assertEq(usdc.balanceOf(alice), aliceBefore + 3e6);
        assertEq(usdc.balanceOf(bob), bobBefore);

        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, bob, 4e6, "v3 note", false, _emptyPermit());
        assertEq(usdc.balanceOf(bob), bobBefore + 4e6);
        assertEq(boon.escrowCount(HANDLE_HASH), 0);
    }

    function test_refundAfterDelayReturnsUsdcButBurnStaysBurned() public {
        vm.prank(tipper);
        uint256 tipId = boon.tipPrivate(
            HANDLE_HASH, HANDLE, address(0), 3e6, keccak256("refund"), false, _emptyPermit()
        );

        vm.expectRevert(BoonV3.RefundDelayNotMet.selector);
        vm.prank(tipper);
        boon.refund(tipId);

        vm.warp(block.timestamp + 180 days);
        uint256 tipperBefore = usdc.balanceOf(tipper);
        vm.prank(tipper);
        boon.refund(tipId);

        assertEq(usdc.balanceOf(tipper), tipperBefore + 3e6);
        assertEq(usdc.balanceOf(address(boon)), 0);
        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), PRIVATE_TIP_BURN);
        assertTrue(boon.getEscrowEntry(tipId).claimed);
    }

    function test_guardianIsRequiredForEscrowFirstLinkAndLinkAndClaim() public {
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());

        uint256 nonce = boon.nonces(HANDLE_HASH);
        bytes memory workerSig = _signLink(signerKey, HANDLE_HASH, alice, nonce);
        bytes memory wrongGuardianSig = _signLink(signerKey, HANDLE_HASH, alice, nonce);

        vm.expectRevert(BoonV3.InvalidVoucher.selector);
        boon.linkEscrowed(HANDLE_HASH, alice, nonce, workerSig, wrongGuardianSig);

        vm.expectRevert(BoonV3.InvalidVoucher.selector);
        boon.linkAndClaim(HANDLE_HASH, alice, nonce, workerSig, wrongGuardianSig, 32);
    }

    function test_tipPrivateAgentRoutesDirectAndMintsSbt() public {
        bytes32 commitment = keccak256("agent private v3");

        vm.prank(tipper);
        uint256 tipId = boon.tipPrivateAgent(42, agentWallet, 5e6, commitment, true, _emptyPermit());

        assertEq(usdc.balanceOf(agentWallet), 5e6);
        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), PRIVATE_TIP_BURN + ATTESTATION_BURN);
        assertEq(sbt.ownerOf(tipId), agentWallet);
        assertEq(boon.blobKeyCommitment(tipId), commitment);
    }

    function test_amountFloorAndEscrowCapProtectWalletlessStorage() public {
        uint256 minEscrowUsdc = boon.MIN_ESCROW_USDC();
        uint256 maxEscrowPerHandle = boon.MAX_ESCROW_PER_HANDLE();

        vm.expectRevert(BoonV3.AmountTooLow.selector);
        vm.prank(tipper);
        boon.tip(
            HANDLE_HASH, HANDLE, address(0), minEscrowUsdc - 1, "v3 note", false, _emptyPermit()
        );

        for (uint256 i; i < maxEscrowPerHandle; ++i) {
            address actor = address(uint160(0x1000 + i));
            _fundAndApprove(actor);
            vm.prank(actor);
            boon.tip(
                HANDLE_HASH, HANDLE, address(0), minEscrowUsdc, "v3 note", false, _emptyPermit()
            );
        }
        _fundAndApprove(address(0xFFFF));
        vm.expectRevert(BoonV3.EscrowCapExceeded.selector);
        vm.prank(address(0xFFFF));
        boon.tip(HANDLE_HASH, HANDLE, address(0), minEscrowUsdc, "v3 note", false, _emptyPermit());
    }

    function test_constructorRejectsZeroAmounts() public {
        vm.expectRevert(BoonV3.ZeroAmount.selector);
        new BoonV3(
            address(usdc),
            address(boonToken),
            address(registry),
            address(sbt),
            signer,
            0,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            guardian
        );

        vm.expectRevert(BoonV3.ZeroAmount.selector);
        new BoonV3(
            address(usdc),
            address(boonToken),
            address(registry),
            address(sbt),
            signer,
            PRIVATE_TIP_BURN,
            0,
            UNLOCK_PRICE_USDC,
            guardian
        );

        vm.expectRevert(BoonV3.ZeroAmount.selector);
        new BoonV3(
            address(usdc),
            address(boonToken),
            address(registry),
            address(sbt),
            signer,
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            0,
            guardian
        );
    }

    function test_tipRejectsMismatchSelfAndUnsupportedInputs() public {
        vm.expectRevert(BoonV3.HandleEmpty.selector);
        vm.prank(tipper);
        boon.tip(keccak256(bytes("")), "", address(0), 1e6, "v3 note", false, _emptyPermit());

        vm.expectRevert(BoonV3.UnsupportedHandle.selector);
        vm.prank(tipper);
        boon.tip(
            keccak256(bytes("agent:42")),
            "agent:42",
            address(0),
            1e6,
            "v3 note",
            false,
            _emptyPermit()
        );

        vm.expectRevert(BoonV3.HandleHashMismatch.selector);
        vm.prank(tipper);
        boon.tip(
            keccak256(bytes("github:bob")),
            HANDLE,
            address(0),
            1e6,
            "v3 note",
            false,
            _emptyPermit()
        );

        bytes memory bigNote = new bytes(281);
        vm.expectRevert(BoonV3.NoteTooLong.selector);
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, string(bigNote), false, _emptyPermit());

        _linkEmptyHandle(HANDLE_HASH, alice);
        vm.expectRevert(BoonV3.RecipientWalletMismatch.selector);
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, bob, 1e6, "v3 note", false, _emptyPermit());

        vm.expectRevert(BoonV3.SelfTipNotAllowed.selector);
        vm.prank(alice);
        boon.tip(HANDLE_HASH, HANDLE, alice, 1e6, "v3 note", false, _emptyPermit());
    }

    function test_tipAgentRoutesDirectAndRejectsBadAgentInputs() public {
        vm.prank(tipper);
        uint256 tipId = boon.tipAgent(42, agentWallet, 5e6, "v3 note", true, _emptyPermit());

        assertEq(usdc.balanceOf(agentWallet), 5e6);
        assertEq(sbt.ownerOf(tipId), agentWallet);
        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), ATTESTATION_BURN);

        registry.setAgent(43, agentOwner, address(0));
        uint256 ownerBefore = usdc.balanceOf(agentOwner);
        vm.prank(tipper);
        boon.tipAgent(43, agentOwner, 2e6, "owner fallback", false, _emptyPermit());
        assertEq(usdc.balanceOf(agentOwner), ownerBefore + 2e6);

        vm.expectRevert(BoonV3.ZeroAmount.selector);
        vm.prank(tipper);
        boon.tipAgent(42, agentWallet, 0, "v3 note", false, _emptyPermit());

        vm.expectRevert(BoonV3.AgentIdZero.selector);
        vm.prank(tipper);
        boon.tipAgent(0, agentWallet, 1e6, "v3 note", false, _emptyPermit());

        bytes memory bigAgentNote = new bytes(281);
        vm.expectRevert(BoonV3.NoteTooLong.selector);
        vm.prank(tipper);
        boon.tipAgent(42, agentWallet, 1e6, string(bigAgentNote), false, _emptyPermit());

        vm.expectRevert(BoonV3.RecipientNotResolvable.selector);
        vm.prank(tipper);
        boon.tipAgent(999, agentWallet, 1e6, "v3 note", false, _emptyPermit());

        registry.setAgent(44, agentOwner, agentWallet);
        registry.setOwnerReverts(44, true);
        vm.expectRevert(BoonV3.RecipientNotResolvable.selector);
        vm.prank(tipper);
        boon.tipAgent(44, agentWallet, 1e6, "v3 note", false, _emptyPermit());

        vm.expectRevert(BoonV3.RecipientWalletMismatch.selector);
        vm.prank(tipper);
        boon.tipAgent(42, bob, 1e6, "v3 note", false, _emptyPermit());

        _fundAndApprove(agentOwner);
        vm.expectRevert(BoonV3.SelfTipNotAllowed.selector);
        vm.prank(agentOwner);
        boon.tipAgent(42, agentWallet, 1e6, "v3 note", false, _emptyPermit());
    }

    function test_privateLinkedPathAndDuplicateCommitmentGuards() public {
        _linkEmptyHandle(HANDLE_HASH, alice);

        vm.expectRevert(BoonV3.InvalidPrivateCommitment.selector);
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 1e6, bytes32(0), false, _emptyPermit());

        bytes32 commitment = keccak256("linked private");
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 7e6, commitment, false, _emptyPermit());
        assertEq(usdc.balanceOf(alice), aliceBefore + 7e6);

        vm.expectRevert(BoonV3.DuplicateCommitment.selector);
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 1e6, commitment, false, _emptyPermit());

        vm.expectRevert(BoonV3.RecipientWalletMismatch.selector);
        vm.prank(otherTipper);
        boon.tipPrivate(
            HANDLE_HASH, HANDLE, bob, 1e6, keccak256("wrong expected"), false, _emptyPermit()
        );
    }

    function test_claimSpecificCanSettleNonHeadAndRejectsZeroSettled() public {
        vm.prank(tipper);
        uint256 one =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());
        vm.prank(otherTipper);
        uint256 two =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 2e6, "v3 note", false, _emptyPermit());
        vm.prank(tipper);
        uint256 three =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 3e6, "v3 note", false, _emptyPermit());
        assertEq(one, 1);
        assertEq(two, 2);
        assertEq(three, 3);

        uint256[] memory ids = boon.getEscrowedTipIds(HANDLE_HASH, 2);
        assertEq(ids.length, 2);
        assertEq(ids[0], one);
        assertEq(ids[1], two);

        _linkEscrowedOnly(HANDLE_HASH, alice);
        uint256[] memory specific = new uint256[](1);
        specific[0] = two;
        uint256 aliceBefore = usdc.balanceOf(alice);
        boon.claimSpecific(specific);
        vm.expectRevert(BoonV3.NoClaimSettled.selector);
        boon.claimSpecific(specific);

        assertEq(usdc.balanceOf(alice), aliceBefore + 2e6);
        assertEq(boon.escrowCount(HANDLE_HASH), 2);
        uint256[] memory remaining = boon.getEscrowedTipIds(HANDLE_HASH, 10);
        assertEq(remaining.length, 2);
        assertEq(remaining[0], one);
        assertEq(remaining[1], three);

        uint256[] memory empty = new uint256[](0);
        vm.expectRevert(BoonV3.NoClaimSettled.selector);
        boon.claimSpecific(empty);
    }

    function test_refundRejectsWrongTipperMissingEscrowAndLinkedHandle() public {
        vm.expectRevert(BoonV3.NoEscrow.selector);
        boon.refund(999);

        vm.prank(tipper);
        uint256 tipId =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());

        vm.warp(block.timestamp + 180 days);
        vm.expectRevert(BoonV3.NotTipper.selector);
        vm.prank(otherTipper);
        boon.refund(tipId);

        _linkEscrowedOnly(HANDLE_HASH, alice);
        vm.expectRevert(BoonV3.AlreadyLinked.selector);
        vm.prank(tipper);
        boon.refund(tipId);
    }

    function test_adminRotationOwnershipAndPause() public {
        vm.expectRevert(BoonV3.NotOwner.selector);
        vm.prank(tipper);
        boon.pause();

        boon.pause();
        vm.expectRevert(BoonV3.PausedError.selector);
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());
        boon.unpause();

        address newGuardian = address(0xA0A0);
        address newSigner = vm.addr(0xFEED);
        boon.rotateEscrowGuardian(newGuardian);
        boon.setTrustedSigner(newSigner);
        assertEq(boon.escrowGuardian(), newGuardian);
        assertEq(boon.trustedSigner(), newSigner);

        vm.expectRevert(BoonV3.ZeroAddress.selector);
        boon.rotateEscrowGuardian(address(0));
        vm.expectRevert(BoonV3.ZeroAddress.selector);
        boon.setTrustedSigner(address(0));

        boon.transferOwnership(bob);
        assertEq(boon.owner(), bob);
        vm.expectRevert(BoonV3.NotOwner.selector);
        boon.pause();
        vm.prank(bob);
        boon.pause();
        assertTrue(boon.paused());
    }

    function test_attestationMetadataSoulboundOwnershipAndCancelPaths() public {
        vm.expectRevert(BoonGratitudeAttestationV3.NotOwner.selector);
        vm.prank(tipper);
        sbt.transferOwnership(tipper);

        sbt.initializeMetadataBaseURI("https://api.boonprotocol.com/api/v1/attestations/");
        _linkEmptyHandle(HANDLE_HASH, alice);
        vm.prank(tipper);
        uint256 tipId = boon.tip(HANDLE_HASH, HANDLE, alice, 1e6, "v3 note", true, _emptyPermit());

        assertTrue(sbt.supportsInterface(0x80ac58cd));
        assertEq(sbt.getApproved(tipId), address(0));
        assertFalse(sbt.isApprovedForAll(alice, bob));
        assertEq(
            sbt.tokenURI(tipId),
            string.concat("https://api.boonprotocol.com/api/v1/attestations/", _uintToString(tipId))
        );
        vm.expectRevert(BoonGratitudeAttestationV3.Soulbound.selector);
        sbt.transferFrom(alice, bob, tipId);
        vm.expectRevert(BoonGratitudeAttestationV3.Soulbound.selector);
        vm.prank(bob);
        sbt.burn(tipId);
        vm.prank(alice);
        sbt.burn(tipId);
        assertEq(sbt.ownerOf(tipId), address(0));
        assertEq(sbt.balanceOf(alice), 0);
        vm.expectRevert(BoonGratitudeAttestationV3.TokenAlreadyMinted.selector);
        vm.prank(address(boon));
        sbt.mint(alice, tipId, HANDLE_HASH);
        vm.expectRevert(BoonGratitudeAttestationV3.TokenNotMinted.selector);
        sbt.tokenURI(tipId);
        vm.expectRevert(BoonGratitudeAttestationV3.TokenNotMinted.selector);
        sbt.tokenURI(999);

        address newMinter = address(0xB004);
        vm.prank(multisig);
        sbt.scheduleMinterRotation(newMinter);
        vm.prank(multisig);
        sbt.cancelMinterRotation();
        assertEq(sbt.pendingMinter(), address(0));

        sbt.transferOwnership(tipper);
        assertEq(sbt.owner(), tipper);
    }

    function test_claimBatchRevertsAtomicallyWhenTokenTransferFails() public {
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());

        usdc.setRejectTransferTo(alice, true);
        uint256 nonce = boon.nonces(HANDLE_HASH);
        bytes memory workerSig = _signLink(signerKey, HANDLE_HASH, alice, nonce);
        bytes memory guardianSig = _signLink(guardianKey, HANDLE_HASH, alice, nonce);
        vm.expectRevert("recipient rejected");
        boon.linkAndClaim(HANDLE_HASH, alice, nonce, workerSig, guardianSig, 32);

        assertEq(boon.linkedWallet(HANDLE_HASH), address(0));
        assertEq(boon.firstClaimWallet(HANDLE_HASH), address(0));
        assertEq(boon.escrowCount(HANDLE_HASH), 1);
        assertEq(usdc.balanceOf(address(boon)), 1e6);

        usdc.setRejectTransferTo(alice, false);
        _linkAndClaim(HANDLE_HASH, alice, 32);
        assertEq(boon.escrowCount(HANDLE_HASH), 0);
    }

    function test_claimTransferReentrancyIsBlocked() public {
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());
        _linkEscrowedOnly(HANDLE_HASH, alice);

        usdc.setReenterOnTransfer(boon, HANDLE_HASH, true);
        boon.claim(HANDLE_HASH, 1);

        assertEq(usdc.observedReenterSelector(), BoonV3.ReentrantCall.selector);
        assertEq(boon.escrowCount(HANDLE_HASH), 0);
    }

    function test_v2StyleVoucherCannotReplayAgainstV3Domain() public {
        bytes32 v2Domain = _domainSeparator("Boon", "2", block.chainid, address(boon));
        bytes32 structHash =
            keccak256(abi.encode(boon.LINK_TYPEHASH(), HANDLE_HASH, alice, uint256(0)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", v2Domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        vm.expectRevert(BoonV3.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, alice, 0, abi.encodePacked(r, s, v));
    }

    function test_multiTipperDeferredAttestationsMintDistinctSBTs() public {
        address thirdTipper = address(0xBEEF);
        _fundAndApprove(thirdTipper);

        vm.prank(tipper);
        uint256 tipOne =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", true, _emptyPermit());
        vm.prank(otherTipper);
        uint256 tipTwo =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 2e6, "v3 note", true, _emptyPermit());
        vm.prank(thirdTipper);
        uint256 tipThree =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 3e6, "v3 note", true, _emptyPermit());

        uint256 aliceBefore = usdc.balanceOf(alice);
        _linkAndClaim(HANDLE_HASH, alice, 32);

        assertEq(usdc.balanceOf(alice), aliceBefore + 6e6);
        assertEq(sbt.ownerOf(tipOne), alice);
        assertEq(sbt.ownerOf(tipTwo), alice);
        assertEq(sbt.ownerOf(tipThree), alice);
        assertEq(sbt.balanceOf(alice), 3);
    }

    function test_doubleClaimNoOpsAfterFirstSweep() public {
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "v3 note", false, _emptyPermit());
        _linkEscrowedOnly(HANDLE_HASH, alice);

        uint256 aliceBefore = usdc.balanceOf(alice);
        boon.claim(HANDLE_HASH, 32);
        boon.claim(HANDLE_HASH, 32);

        assertEq(usdc.balanceOf(alice), aliceBefore + 1e6);
        assertEq(boon.escrowCount(HANDLE_HASH), 0);
    }

    function test_attestationMinterRotationRequiresInitialMinter() public {
        BoonGratitudeAttestationV3 fresh =
            new BoonGratitudeAttestationV3(address(this), multisig, 48 hours);

        vm.expectRevert(BoonGratitudeAttestationV3.MinterNotInitialized.selector);
        vm.prank(multisig);
        fresh.scheduleMinterRotation(address(0xB004));
    }

    function test_attestationMinterRotationKeepsLegacyMinterForDeferredClaims() public {
        vm.prank(tipper);
        uint256 tipId =
            boon.tip(HANDLE_HASH, HANDLE, address(0), 1e6, "deferred", true, _emptyPermit());
        assertEq(sbt.nextMintableTipId(), tipId + 1);
        assertTrue(sbt.authorizedMinters(address(boon)));
        assertEq(sbt.reservedMinterOf(tipId), address(boon));

        _linkEscrowedOnly(HANDLE_HASH, alice);

        address newMinter = address(0xB004);
        vm.prank(multisig);
        sbt.scheduleMinterRotation(newMinter);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(multisig);
        sbt.executeMinterRotation();

        assertEq(sbt.minter(), newMinter);
        assertTrue(sbt.authorizedMinters(address(boon)));
        assertTrue(sbt.authorizedMinters(newMinter));

        uint256 aliceBefore = usdc.balanceOf(alice);
        boon.claim(HANDLE_HASH, 1);

        assertEq(usdc.balanceOf(alice), aliceBefore + 1e6);
        assertEq(sbt.ownerOf(tipId), alice);
        assertEq(sbt.reservedMinterOf(tipId), address(0));
        assertEq(boon.escrowCount(HANDLE_HASH), 0);
    }

    function test_rotatedFreshBoonSyncsPastActiveLegacyMinterTipIds() public {
        _linkEmptyHandle(HANDLE_HASH, alice);

        vm.prank(tipper);
        uint256 oldOne = boon.tip(HANDLE_HASH, HANDLE, alice, 1e6, "old one", true, _emptyPermit());
        vm.prank(tipper);
        uint256 oldTwo = boon.tip(HANDLE_HASH, HANDLE, alice, 1e6, "old two", true, _emptyPermit());

        assertEq(oldOne, 1);
        assertEq(oldTwo, 2);
        assertEq(sbt.nextMintableTipId(), 3);

        BoonV3 freshBoon = new BoonV3(
            address(usdc),
            address(boonToken),
            address(registry),
            address(sbt),
            signer,
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            guardian
        );
        assertEq(freshBoon.nextTipId(), 3);
        _approve(address(freshBoon), tipper);
        boonToken.mint(tipper, 5_000_000e18);

        vm.prank(multisig);
        sbt.scheduleMinterRotation(address(freshBoon));
        vm.warp(block.timestamp + 48 hours);
        vm.prank(multisig);
        sbt.executeMinterRotation();

        vm.prank(tipper);
        uint256 oldThree =
            boon.tip(HANDLE_HASH, HANDLE, alice, 1e6, "old three", true, _emptyPermit());
        assertEq(oldThree, 3);
        assertEq(sbt.ownerOf(oldThree), alice);
        assertEq(sbt.nextMintableTipId(), 4);

        string memory freshHandle = "github:fresh";
        bytes32 freshHandleHash = keccak256(bytes(freshHandle));
        _linkEmptyHandle(freshBoon, freshHandleHash, bob);

        vm.prank(tipper);
        uint256 freshTip =
            freshBoon.tip(freshHandleHash, freshHandle, bob, 1e6, "fresh", true, _emptyPermit());

        assertEq(freshTip, 4);
        assertEq(sbt.ownerOf(freshTip), bob);
        assertEq(sbt.ownerOf(oldOne), alice);
        assertEq(sbt.ownerOf(oldTwo), alice);
        assertEq(sbt.ownerOf(oldThree), alice);
        assertEq(sbt.nextMintableTipId(), 5);
    }

    function test_attestationMinterRotationRequiresMultisigAndTimelock() public {
        address newMinter = address(0xB003);
        vm.expectRevert(BoonGratitudeAttestationV3.NotMultisig.selector);
        sbt.scheduleMinterRotation(newMinter);

        vm.prank(multisig);
        sbt.scheduleMinterRotation(newMinter);

        vm.expectRevert(BoonGratitudeAttestationV3.TimelockNotReady.selector);
        vm.prank(multisig);
        sbt.executeMinterRotation();

        vm.warp(block.timestamp + 48 hours);
        vm.prank(multisig);
        sbt.executeMinterRotation();
        assertEq(sbt.minter(), newMinter);
        assertTrue(sbt.authorizedMinters(address(boon)));
        assertTrue(sbt.authorizedMinters(newMinter));
    }

    function _fundAndApprove(address actor) internal {
        usdc.mint(actor, 100_000e6);
        boonToken.mint(actor, 10_000_000e18);
        _approve(address(boon), actor);
    }

    function _approve(address spender, address actor) internal {
        vm.startPrank(actor);
        usdc.approve(spender, type(uint256).max);
        boonToken.approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _linkEmptyHandle(bytes32 handleHash, address recipient) internal {
        uint256 nonce = boon.nonces(handleHash);
        boon.link(handleHash, recipient, nonce, _signLink(signerKey, handleHash, recipient, nonce));
    }

    function _linkEmptyHandle(BoonV3 target, bytes32 handleHash, address recipient) internal {
        uint256 nonce = target.nonces(handleHash);
        target.link(
            handleHash, recipient, nonce, _signLink(target, signerKey, handleHash, recipient, nonce)
        );
    }

    function _linkEscrowedOnly(bytes32 handleHash, address recipient) internal {
        uint256 nonce = boon.nonces(handleHash);
        boon.linkEscrowed(
            handleHash,
            recipient,
            nonce,
            _signLink(signerKey, handleHash, recipient, nonce),
            _signLink(guardianKey, handleHash, recipient, nonce)
        );
    }

    function _linkAndClaim(bytes32 handleHash, address recipient, uint256 maxItems) internal {
        uint256 nonce = boon.nonces(handleHash);
        boon.linkAndClaim(
            handleHash,
            recipient,
            nonce,
            _signLink(signerKey, handleHash, recipient, nonce),
            _signLink(guardianKey, handleHash, recipient, nonce),
            maxItems
        );
    }

    function _relink(bytes32 handleHash, address recipient) internal {
        uint256 nonce = boon.nonces(handleHash);
        boon.relink(
            handleHash, recipient, nonce, _signLink(signerKey, handleHash, recipient, nonce)
        );
    }

    function _signLink(uint256 key, bytes32 handleHash, address recipient, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        return _signLink(boon, key, handleHash, recipient, nonce);
    }

    function _signLink(
        BoonV3 target,
        uint256 key,
        bytes32 handleHash,
        address recipient,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(target.LINK_TYPEHASH(), handleHash, recipient, nonce)
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", target.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            unchecked {
                ++digits;
                temp /= 10;
            }
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            unchecked {
                digits -= 1;
                buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
                value /= 10;
            }
        }
        return string(buffer);
    }

    function _emptyPermit() internal pure returns (BoonV3.Permit memory) {
        return BoonV3.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)});
    }
}
