// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {BoonV2} from "../BoonV2.sol";
import {BoonGratitudeAttestation} from "../BoonGratitudeAttestation.sol";
import {MockBOON} from "./mocks/MockBOON.sol";

contract MockUSDCV2 {
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
        require(allowance[from][msg.sender] >= amount, "not approved");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockIdentityRegistry {
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

contract ReenteringAttestation {
    BoonV2 public target;
    uint8 public attackMode;
    bytes4 public observedSelector;

    function setTarget(BoonV2 target_) external {
        target = target_;
    }

    function setAttackMode(uint8 mode) external {
        attackMode = mode;
        observedSelector = bytes4(0);
    }

    function mint(uint256, address, bytes32, uint256, bytes32, uint256) external {
        BoonV2.Permit memory emptyPermit;
        if (attackMode == 0) {
            try target.tip("github:reenter", 1, "reenter", false, emptyPermit) {}
            catch (bytes memory reason) {
                observedSelector = _selector(reason);
            }
        } else if (attackMode == 1) {
            try target.tipAgent(42, address(0xBEEF), 1, "reenter", false, emptyPermit) {}
            catch (bytes memory reason) {
                observedSelector = _selector(reason);
            }
        } else {
            try target.tipPrivate(
                keccak256(bytes("github:reenter")),
                "github:reenter",
                address(0xBEEF),
                1,
                keccak256("reenter-private"),
                false,
                emptyPermit
            ) {}
            catch (bytes memory reason) {
                observedSelector = _selector(reason);
            }
        }
    }

    function _selector(bytes memory reason) internal pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(reason, 32))
        }
    }
}

contract BoonV2Test is Test {
    uint256 internal constant PRIVATE_TIP_BURN = 500_000e18;
    uint256 internal constant ATTESTATION_BURN = 3_000_000e18;
    uint256 internal constant UNLOCK_PRICE_USDC = 1_000_000;

    MockUSDCV2 internal usdc;
    MockBOON internal boonToken;
    MockIdentityRegistry internal registry;
    BoonGratitudeAttestation internal sbt;
    BoonV2 internal boon;

    uint256 internal signerKey = 0xA11CE;
    address internal signer;

    address internal tipper = address(0xCAFE);
    address internal otherTipper = address(0xD00D);
    address internal alice = address(0xA11C);
    address internal agentOwner = address(0xA901);
    address internal agentWallet = address(0xA902);

    string internal constant HANDLE = "github:alice";
    bytes32 internal constant HANDLE_HASH = keccak256(bytes(HANDLE));
    bytes32 internal constant GITHUB_PROVIDER_HASH = keccak256(bytes("github"));

    function setUp() public {
        signer = vm.addr(signerKey);
        usdc = new MockUSDCV2();
        boonToken = new MockBOON();
        registry = new MockIdentityRegistry();
        sbt = new BoonGratitudeAttestation();
        boon = new BoonV2(
            address(usdc),
            address(boonToken),
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            address(registry),
            address(sbt),
            signer
        );
        sbt.initializeMinter(address(boon));

        _fundAndApprove(tipper);
        _fundAndApprove(otherTipper);
        registry.setAgent(42, agentOwner, agentWallet);
    }

    function test_constructorStoresLockedImmutables() public view {
        assertEq(boon.boonToken(), address(boonToken));
        assertEq(boon.identityRegistry(), address(registry));
        assertEq(boon.attestationContract(), address(sbt));
        assertEq(boon.PRIVATE_TIP_BURN(), PRIVATE_TIP_BURN);
        assertEq(boon.ATTESTATION_BURN(), ATTESTATION_BURN);
        assertEq(boon.UNLOCK_PRICE_USDC(), UNLOCK_PRICE_USDC);
    }

    function test_domainSeparatorUsesVersion2() public view {
        assertEq(
            boon.DOMAIN_SEPARATOR(), _domainSeparator("Boon", "2", block.chainid, address(boon))
        );
        assertTrue(
            boon.DOMAIN_SEPARATOR() != _domainSeparator("Boon", "1", block.chainid, address(boon))
        );
    }

    function test_constructorRevertsOnZeroAddresses() public {
        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(0), address(boonToken), address(registry), address(sbt), signer);

        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(usdc), address(0), address(registry), address(sbt), signer);

        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(usdc), address(boonToken), address(0), address(sbt), signer);

        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(usdc), address(boonToken), address(registry), address(0), signer);

        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(usdc), address(boonToken), address(registry), address(sbt), address(0));
    }

    function test_constructorRevertsOnZeroAmounts() public {
        vm.expectRevert(BoonV2.ZeroAmount.selector);
        _deployAmounts(0, ATTESTATION_BURN, UNLOCK_PRICE_USDC);

        vm.expectRevert(BoonV2.ZeroAmount.selector);
        _deployAmounts(PRIVATE_TIP_BURN, 0, UNLOCK_PRICE_USDC);

        vm.expectRevert(BoonV2.ZeroAmount.selector);
        _deployAmounts(PRIVATE_TIP_BURN, ATTESTATION_BURN, 0);
    }

    function test_tipRejectsUnlinkedSocialHandle() public {
        vm.expectRevert(BoonV2.RecipientNotLinked.selector);
        vm.prank(tipper);
        boon.tip(HANDLE, 1e6, "thanks", false, _emptyPermit());
    }

    function test_tipAllocatesMonotonicTipIdsAndPushesAtomically() public {
        _link(HANDLE, alice);
        _link("github:bob", address(0xB0B));

        vm.expectEmit(true, true, true, true);
        emit BoonV2.Tip(0, HANDLE_HASH, tipper, 1e6, HANDLE, "thanks");
        vm.prank(tipper);
        boon.tip(HANDLE, 1e6, "thanks", false, _emptyPermit());

        vm.prank(tipper);
        boon.tip("github:bob", 2e6, "second", false, _emptyPermit());

        assertEq(boon.nextTipId(), 2);
        assertEq(boon.tipperOf(0), tipper);
        assertEq(boon.tipperOf(1), tipper);
        assertEq(usdc.balanceOf(address(boon)), 0);
        assertEq(usdc.balanceOf(alice), 1e6);
        assertEq(usdc.balanceOf(address(0xB0B)), 2e6);
    }

    function test_tipPushesToLinkedWalletAndRejectsSelfTip() public {
        _link(HANDLE, alice);

        vm.expectEmit(true, true, false, true);
        emit BoonV2.Pushed(HANDLE_HASH, alice, 7e6);
        vm.prank(tipper);
        boon.tip(HANDLE, 7e6, "merged my PR", false, _emptyPermit());

        assertEq(usdc.balanceOf(alice), 7e6);
        assertEq(usdc.balanceOf(address(boon)), 0);

        _fundAndApprove(alice);
        vm.expectRevert(BoonV2.SelfTipNotAllowed.selector);
        vm.prank(alice);
        boon.tip(HANDLE, 1e6, "self", false, _emptyPermit());
    }

    function test_tipWithAttestationRequiresLinkedRecipientAndMintsSbt() public {
        vm.expectRevert(BoonV2.RecipientNotLinked.selector);
        vm.prank(tipper);
        boon.tip(HANDLE, 1e6, "sbt", true, _emptyPermit());

        _link(HANDLE, alice);
        vm.prank(tipper);
        boon.tip(HANDLE, 1e6, "sbt", true, _emptyPermit());

        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), ATTESTATION_BURN);
        assertEq(sbt.ownerOf(0), alice);
        assertTrue(sbt.locked(0));
    }

    function test_tipAgentRoutesToAgentWallet() public {
        vm.expectEmit(true, true, true, true);
        emit BoonV2.Tip(0, keccak256(bytes("agent:42")), tipper, 5e6, "agent:42", "good bot");

        vm.prank(tipper);
        boon.tipAgent(42, agentWallet, 5e6, "good bot", false, _emptyPermit());

        assertEq(usdc.balanceOf(agentWallet), 5e6);
        assertEq(boon.tipperOf(0), tipper);
        assertEq(boon.nextTipId(), 1);
    }

    function test_tipAgentFallsBackToOwnerWhenAgentWalletIsZero() public {
        registry.setAgent(43, agentOwner, address(0));

        vm.prank(tipper);
        boon.tipAgent(43, agentOwner, 5e6, "owner fallback", false, _emptyPermit());

        assertEq(usdc.balanceOf(agentOwner), 5e6);
    }

    function test_tipAgentRejectsWrongExpectedWalletBeforeTransfer() public {
        vm.expectRevert(BoonV2.AgentWalletMismatch.selector);
        vm.prank(tipper);
        boon.tipAgent(42, address(0xBADA55), 5e6, "stale", false, _emptyPermit());

        assertEq(usdc.balanceOf(tipper), 100_000e6);
        assertEq(boon.nextTipId(), 0);
    }

    function test_tipAgentRejectsSelfTipFromOwnerOrWallet() public {
        _fundAndApprove(agentOwner);
        vm.expectRevert(BoonV2.SelfTipNotAllowed.selector);
        vm.prank(agentOwner);
        boon.tipAgent(42, agentWallet, 1e6, "self owner", false, _emptyPermit());

        _fundAndApprove(agentWallet);
        vm.expectRevert(BoonV2.SelfTipNotAllowed.selector);
        vm.prank(agentWallet);
        boon.tipAgent(42, agentWallet, 1e6, "self wallet", false, _emptyPermit());
    }

    function test_tipAgentRejectsZeroAndMissingAgent() public {
        vm.expectRevert(BoonV2.AgentIdZero.selector);
        vm.prank(tipper);
        boon.tipAgent(0, agentWallet, 1e6, "zero", false, _emptyPermit());

        vm.expectRevert(BoonV2.AgentWalletNotFound.selector);
        vm.prank(tipper);
        boon.tipAgent(999, agentWallet, 1e6, "missing", false, _emptyPermit());
    }

    function test_tipAndTipAgentAndTipPrivate_revertOnZeroAmount() public {
        _link(HANDLE, alice);

        vm.expectRevert(BoonV2.ZeroAmount.selector);
        vm.prank(tipper);
        boon.tip(HANDLE, 0, "zero", false, _emptyPermit());

        vm.expectRevert(BoonV2.ZeroAmount.selector);
        vm.prank(tipper);
        boon.tipAgent(42, agentWallet, 0, "zero", false, _emptyPermit());

        vm.expectRevert(BoonV2.ZeroAmount.selector);
        vm.prank(tipper);
        boon.tipPrivate(
            HANDLE_HASH, HANDLE, alice, 0, keccak256("zero amount"), false, _emptyPermit()
        );
    }

    function test_tipRejectsAgentHandleThroughHumanPath() public {
        vm.expectRevert(BoonV2.UnsupportedHandle.selector);
        vm.prank(tipper);
        boon.tip("agent:0", 1e6, "wrong path", false, _emptyPermit());
    }

    function test_tipPrivateToLinkedHumanBurnsAndStoresCommitment() public {
        _link(HANDLE, alice);
        bytes32 commitment = keccak256("private-commitment");

        vm.expectEmit(true, true, true, true);
        emit BoonV2.PrivateTip(0, HANDLE_HASH, tipper, HANDLE, commitment);
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 9e6, commitment, false, _emptyPermit());

        assertEq(usdc.balanceOf(alice), 9e6);
        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), PRIVATE_TIP_BURN);
        assertEq(boon.tipperOf(0), tipper);
        assertTrue(boon.isPrivateTip(0));
        assertEq(boon.privateCommitmentOf(0), commitment);
        assertEq(boon.blobKeyCommitment(0), commitment);
        assertEq(boon.nextTipId(), 1);
    }

    function test_privateTipEventShapeDoesNotExposeAmountNoteOrBurns() public {
        _link(HANDLE, alice);
        bytes32 commitment = keccak256("shape");

        vm.recordLogs();
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 9e6, commitment, false, _emptyPermit());

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 privateTipSig = keccak256("PrivateTip(uint256,bytes32,address,string,bytes32)");
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == privateTipSig) {
                assertEq(logs[i].data.length, abi.encode(HANDLE, commitment).length);
                found = true;
            }
        }
        assertTrue(found, "PrivateTip log missing");
    }

    function test_tipPrivateRejectsUnlinkedOrWrongExpectedHumanBeforeSideEffects() public {
        bytes32 commitment = keccak256("private-commitment");

        vm.expectRevert(BoonV2.RecipientNotLinked.selector);
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 9e6, commitment, false, _emptyPermit());

        _link(HANDLE, alice);
        vm.expectRevert(BoonV2.AgentWalletMismatch.selector);
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, address(0xB0B), 9e6, commitment, false, _emptyPermit());

        assertEq(boon.nextTipId(), 0);
        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), 0);
    }

    function test_tipPrivateRejectsZeroAndDuplicateCommitmentPerTipper() public {
        _link(HANDLE, alice);

        vm.expectRevert(BoonV2.InvalidPrivateCommitment.selector);
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 9e6, bytes32(0), false, _emptyPermit());

        bytes32 commitment = keccak256("dup");
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 9e6, commitment, false, _emptyPermit());

        vm.expectRevert(BoonV2.DuplicateCommitment.selector);
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 9e6, commitment, false, _emptyPermit());

        vm.prank(otherTipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 1e6, commitment, false, _emptyPermit());
        assertEq(boon.nextTipId(), 2);
    }

    function test_tipPrivateAgentMintsSbtAndBurnsPrivacyPlusAttestation() public {
        bytes32 handleHash = keccak256(bytes("agent:42"));
        bytes32 commitment = keccak256("agent private");

        vm.prank(tipper);
        boon.tipPrivate(handleHash, "agent:42", agentWallet, 4e6, commitment, true, _emptyPermit());

        assertEq(usdc.balanceOf(agentWallet), 4e6);
        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), PRIVATE_TIP_BURN + ATTESTATION_BURN);
        assertEq(sbt.ownerOf(0), agentWallet);
        (
            address recipient,
            bytes32 storedHandleHash,
            uint256 agentId,
            bytes32 storedCommitment,
            uint256 boonBurned,
            uint256 mintedAt
        ) = sbt.attestations(0);
        assertEq(recipient, agentWallet);
        assertEq(storedHandleHash, handleHash);
        assertEq(agentId, 42);
        assertEq(storedCommitment, commitment);
        assertEq(boonBurned, PRIVATE_TIP_BURN + ATTESTATION_BURN);
        assertEq(mintedAt, block.timestamp);
    }

    function test_nonReentrantBlocksCallbacksIntoAllValueMovingTipEntrypoints() public {
        ReenteringAttestation reenteringAttestation = new ReenteringAttestation();
        BoonV2 guarded = new BoonV2(
            address(usdc),
            address(boonToken),
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            address(registry),
            address(reenteringAttestation),
            signer
        );
        reenteringAttestation.setTarget(guarded);
        _fundAndApprove(tipper, guarded);

        for (uint8 mode; mode < 3; mode++) {
            reenteringAttestation.setAttackMode(mode);
            vm.prank(tipper);
            guarded.tipAgent(42, agentWallet, 1e6, "guarded attestation", true, _emptyPermit());
            assertEq(reenteringAttestation.observedSelector(), BoonV2.ReentrantCall.selector);
        }
    }

    function test_permitFailureWithInsufficientAllowanceRevertsBeforeTransfer() public {
        _link(HANDLE, alice);
        address noBoonAllowance = address(0xF00D);
        usdc.mint(noBoonAllowance, 100e6);
        boonToken.mint(noBoonAllowance, PRIVATE_TIP_BURN);
        vm.prank(noBoonAllowance);
        usdc.approve(address(boon), type(uint256).max);

        vm.expectRevert(BoonV2.PermitFailedAndAllowanceInsufficient.selector);
        vm.prank(noBoonAllowance);
        boon.tipPrivate(
            HANDLE_HASH, HANDLE, alice, 1e6, keccak256("needs permit"), false, _emptyPermit()
        );

        assertEq(usdc.balanceOf(alice), 0);
        assertEq(boon.nextTipId(), 0);
    }

    function test_permitFrontRunGraceUsesExistingAllowance() public {
        _link(HANDLE, alice);
        boonToken.setRejectPermit(true);

        vm.prank(tipper);
        boon.tipPrivate(
            HANDLE_HASH, HANDLE, alice, 1e6, keccak256("front run grace"), false, _emptyPermit()
        );

        assertEq(boonToken.balanceOf(boon.BOON_BURN_ADDRESS()), PRIVATE_TIP_BURN);
    }

    function test_relinkSucceedsWithSignerVoucher() public {
        _link(HANDLE, alice);
        address bob = address(0xB0B);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(HANDLE, bob, deadline, boon.linkNonce(HANDLE_HASH));

        boon.relink(HANDLE_HASH, HANDLE, bob, deadline, sig);

        assertEq(boon.linkedWallet(HANDLE_HASH), bob);
    }

    // ── S6 granular constructor zero-address reverts ──────────────────────
    // Each test below isolates one constructor argument so a regression that
    // accidentally loosens a single check still fails loudly. The aggregate
    // test_constructorRevertsOnZeroAddresses above is preserved on purpose.

    function test_constructorRevertsOnZeroUsdc() public {
        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(0), address(boonToken), address(registry), address(sbt), signer);
    }

    function test_constructorRevertsOnZeroBoonToken() public {
        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(usdc), address(0), address(registry), address(sbt), signer);
    }

    function test_constructorRevertsOnZeroIdentityRegistry() public {
        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(usdc), address(boonToken), address(0), address(sbt), signer);
    }

    function test_constructorRevertsOnZeroAttestationContract() public {
        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(address(usdc), address(boonToken), address(registry), address(0), signer);
    }

    function test_constructorRevertsOnZeroTrustedSigner() public {
        vm.expectRevert(BoonV2.ZeroAddress.selector);
        _deploy(
            address(usdc), address(boonToken), address(registry), address(sbt), address(0)
        );
    }

    function test_constructorRevertsOnZeroPrivateTipBurn() public {
        vm.expectRevert(BoonV2.ZeroAmount.selector);
        _deployAmounts(0, ATTESTATION_BURN, UNLOCK_PRICE_USDC);
    }

    function test_constructorRevertsOnZeroAttestationBurn() public {
        vm.expectRevert(BoonV2.ZeroAmount.selector);
        _deployAmounts(PRIVATE_TIP_BURN, 0, UNLOCK_PRICE_USDC);
    }

    function test_constructorRevertsOnZeroUnlockPriceUsdc() public {
        vm.expectRevert(BoonV2.ZeroAmount.selector);
        _deployAmounts(PRIVATE_TIP_BURN, ATTESTATION_BURN, 0);
    }

    // ── S6 granular zero-amount reverts per entrypoint ────────────────────
    // The aggregate test_tipAndTipAgentAndTipPrivate_revertOnZeroAmount above
    // is preserved on purpose; these split it so a single broken entrypoint
    // produces a single, clearly named failure.

    function test_tipRevertsOnZeroAmount() public {
        _link(HANDLE, alice);
        vm.expectRevert(BoonV2.ZeroAmount.selector);
        vm.prank(tipper);
        boon.tip(HANDLE, 0, "zero", false, _emptyPermit());
    }

    function test_tipAgentRevertsOnZeroAmount() public {
        vm.expectRevert(BoonV2.ZeroAmount.selector);
        vm.prank(tipper);
        boon.tipAgent(42, agentWallet, 0, "zero", false, _emptyPermit());
    }

    function test_tipPrivateRevertsOnZeroAmount() public {
        _link(HANDLE, alice);
        vm.expectRevert(BoonV2.ZeroAmount.selector);
        vm.prank(tipper);
        boon.tipPrivate(
            HANDLE_HASH, HANDLE, alice, 0, keccak256("zero amount"), false, _emptyPermit()
        );
    }

    function _deploy(
        address usdc_,
        address boonToken_,
        address registry_,
        address sbt_,
        address signer_
    ) internal returns (BoonV2) {
        return new BoonV2(
            usdc_,
            boonToken_,
            PRIVATE_TIP_BURN,
            ATTESTATION_BURN,
            UNLOCK_PRICE_USDC,
            registry_,
            sbt_,
            signer_
        );
    }

    function _deployAmounts(
        uint256 privateTipBurn,
        uint256 attestationBurn,
        uint256 unlockPriceUsdc
    ) internal returns (BoonV2) {
        return new BoonV2(
            address(usdc),
            address(boonToken),
            privateTipBurn,
            attestationBurn,
            unlockPriceUsdc,
            address(registry),
            address(sbt),
            signer
        );
    }

    function _fundAndApprove(address actor) internal {
        _fundAndApprove(actor, boon);
    }

    function _fundAndApprove(address actor, BoonV2 target) internal {
        usdc.mint(actor, 100_000e6);
        boonToken.mint(actor, 10_000_000e18);
        vm.startPrank(actor);
        usdc.approve(address(target), type(uint256).max);
        boonToken.approve(address(target), type(uint256).max);
        vm.stopPrank();
    }

    function _link(string memory handle, address recipient) internal {
        bytes32 handleHash = keccak256(bytes(handle));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(handle, recipient, deadline, boon.linkNonce(handleHash));
        boon.link(handleHash, handle, recipient, deadline, sig);
    }

    function _signLink(
        string memory canonicalHandle,
        address recipient,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        return _signLinkWithKey(signerKey, canonicalHandle, recipient, deadline, nonce);
    }

    function _signLinkWithKey(
        uint256 key,
        string memory canonicalHandle,
        address recipient,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 handleHash = keccak256(bytes(canonicalHandle));
        bytes32 structHash = keccak256(
            abi.encode(
                boon.LINK_TYPEHASH(),
                _providerHash(canonicalHandle),
                handleHash,
                recipient,
                nonce,
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", boon.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _providerHash(string memory canonicalHandle) internal pure returns (bytes32) {
        bytes memory handleBytes = bytes(canonicalHandle);
        uint256 providerLength = handleBytes.length;
        for (uint256 i; i < handleBytes.length;) {
            if (handleBytes[i] == ":") {
                providerLength = i;
                break;
            }
            unchecked {
                ++i;
            }
        }

        bytes memory provider = new bytes(providerLength);
        for (uint256 i; i < providerLength;) {
            provider[i] = handleBytes[i];
            unchecked {
                ++i;
            }
        }
        return keccak256(provider);
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

    function _emptyPermit() internal pure returns (BoonV2.Permit memory) {
        return BoonV2.Permit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)});
    }
}
