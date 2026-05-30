// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Boon} from "../Boon.sol";

contract MockUSDC {
    string public name = "USDC";
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

contract BoonTest is Test {
    Boon internal boon;
    MockUSDC internal usdc;

    uint256 internal signerKey = 0xA11CE;
    uint256 internal guardianKey = 0xB00B;
    address internal signer;
    address internal guardian;

    address internal tipper = address(0xCAFE);
    address internal alice = address(0xA11C);
    address internal keeper = address(0xBEEF);

    string internal constant HANDLE = "github:alice";
    bytes32 internal HANDLE_HASH = keccak256(bytes(HANDLE));
    bytes32 internal GITHUB_PROVIDER_HASH = keccak256(bytes("github"));

    function setUp() public {
        signer = vm.addr(signerKey);
        guardian = vm.addr(guardianKey);
        usdc = new MockUSDC();
        boon = new Boon(signer, address(usdc));
        boon.rotateEscrowGuardian(guardian);

        usdc.mint(tipper, 1000e6);
        vm.prank(tipper);
        usdc.approve(address(boon), type(uint256).max);
    }

    // ── tip() ───────────────────────────────────────────────────────────

    function test_tip_escrowsWhenHandleNotLinked() public {
        vm.expectEmit(true, true, false, true);
        emit Boon.Tip(HANDLE_HASH, tipper, 10e6, HANDLE, "thanks");

        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, 10e6, "thanks");

        assertEq(usdc.balanceOf(address(boon)), 10e6);
        assertEq(boon.escrow(HANDLE_HASH), 10e6);
    }

    function test_tip_pushesImmediatelyWhenHandleLinked() public {
        _link(HANDLE, alice);

        vm.expectEmit(true, true, false, true);
        emit Boon.Pushed(HANDLE_HASH, alice, 7e6);

        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, 7e6, "merged my PR");

        assertEq(usdc.balanceOf(alice), 7e6);
        assertEq(usdc.balanceOf(address(boon)), 0);
        assertEq(boon.escrow(HANDLE_HASH), 0);
    }

    function test_tip_revertsWhenTipperNotApproved() public {
        address poor = address(0xBADD);
        vm.expectRevert();
        vm.prank(poor);
        boon.tip(HANDLE_HASH, HANDLE, 1e6, "");
    }

    // ── Canonical handle validation ─────────────────────────────────────

    function test_tip_revertsOnHashMismatch() public {
        // Hash for "github:alice" but display "github:Alice" — would let a
        // malicious client log a misleading event. Contract must reject.
        vm.expectRevert(Boon.HandleHashMismatch.selector);
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, "github:Alice", 1e6, "");
    }

    function test_tip_revertsOnEmptyDisplayHandle() public {
        vm.expectRevert(Boon.HandleEmpty.selector);
        vm.prank(tipper);
        boon.tip(keccak256(""), "", 1e6, "");
    }

    function test_tip_revertsOnHandleTooLong() public {
        // Exactly one byte over MAX_HANDLE_LEN (= 64). Earlier this test used
        // 129 bytes — far above the limit — so it kept passing even when v0.3
        // tightened MAX_HANDLE_LEN from 128 → 64. Testing the actual boundary
        // catches future off-by-one regressions.
        bytes memory big = new bytes(65);
        for (uint256 i; i < 65; i++) {
            big[i] = "x";
        }
        string memory longHandle = string(big);

        vm.expectRevert(Boon.HandleTooLong.selector);
        vm.prank(tipper);
        boon.tip(keccak256(big), longHandle, 1e6, "");
    }

    function test_tip_revertsOnUnsupportedHandle() public {
        string memory unsupported = "discord:alice";
        vm.expectRevert(Boon.UnsupportedHandle.selector);
        vm.prank(tipper);
        boon.tip(keccak256(bytes(unsupported)), unsupported, 1e6, "");
    }

    function test_tip_revertsOnNoteTooLong() public {
        bytes memory big = new bytes(281);
        for (uint256 i; i < 281; i++) {
            big[i] = "n";
        }

        vm.expectRevert(Boon.NoteTooLong.selector);
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, 1e6, string(big));
    }

    function test_link_revertsOnHashMismatch() public {
        bytes memory sig = _signLink(HANDLE, alice, block.timestamp + 1 hours, 0);
        // Voucher signed for HANDLE_HASH, but display claims a different handle
        vm.expectRevert(Boon.HandleHashMismatch.selector);
        boon.link(HANDLE_HASH, "github:Alice", alice, block.timestamp + 1 hours, sig);
    }

    // ── link() ──────────────────────────────────────────────────────────

    function test_link_setsWalletAndEmits() public {
        bytes memory sig = _signLink(HANDLE, alice, block.timestamp + 1 hours, 0);

        vm.expectEmit(true, true, false, true);
        emit Boon.Linked(HANDLE_HASH, alice, HANDLE);

        boon.link(HANDLE_HASH, HANDLE, alice, block.timestamp + 1 hours, sig);

        assertEq(boon.linkedWallet(HANDLE_HASH), alice);
        assertEq(boon.linkNonce(HANDLE_HASH), 1);
    }

    function test_link_rejectsExpiredVoucher() public {
        bytes memory sig = _signLink(HANDLE, alice, block.timestamp + 10, 0);
        vm.warp(block.timestamp + 11);

        vm.expectRevert(Boon.VoucherExpired.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, block.timestamp - 1, sig);
    }

    function test_link_rejectsBadSignature() public {
        uint256 wrongKey = 0xBADD;
        bytes memory sig = _signLinkWith(wrongKey, HANDLE, alice, block.timestamp + 1 hours, 0);

        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, block.timestamp + 1 hours, sig);
    }

    function test_link_rejectsVoucherSignedForDifferentProvider() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLinkWithProviderHash(
            signerKey, keccak256(bytes("x")), HANDLE_HASH, alice, deadline, 0
        );

        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, deadline, sig);
    }

    function test_link_rejectsVoucherSignedForDifferentHandleHash() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 wrongHandleHash = keccak256(bytes("github:not-alice"));
        bytes memory sig = _signLinkWithProviderHash(
            signerKey, GITHUB_PROVIDER_HASH, wrongHandleHash, alice, deadline, 0
        );

        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, deadline, sig);
    }

    function test_link_rejectsVoucherSignedForDifferentRecipient() public {
        uint256 deadline = block.timestamp + 1 hours;
        address bob = address(0xB0B);
        bytes memory sig = _signLink(HANDLE, bob, deadline, 0);

        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, deadline, sig);
    }

    function test_link_rejectsVoucherSignedForDifferentContractAddress() public {
        uint256 deadline = block.timestamp + 1 hours;
        Boon otherBoon = new Boon(signer, address(usdc));
        bytes memory sig =
            _signLinkForDomain(otherBoon.DOMAIN_SEPARATOR(), HANDLE, alice, deadline, 0);

        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, deadline, sig);
    }

    function test_link_rejectsVoucherSignedForDifferentChainId() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 wrongChainDomainSeparator =
            _domainSeparator("Boon", "1", block.chainid + 1, address(boon));
        bytes memory sig = _signLinkForDomain(wrongChainDomainSeparator, HANDLE, alice, deadline, 0);

        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, deadline, sig);
    }

    function test_linkVoucherSharedVectorRecoversExpectedSigner() public view {
        string memory json = vm.readFile("test-vectors/link-voucher.json");

        (bytes32 typeHash, bytes32 providerHash, bytes32 handleHash) = _assertVectorIdentity(json);
        bytes32 domainSeparator = _assertVectorDomain(json);
        bytes32 structHash = _assertVectorStruct(json, typeHash, providerHash, handleHash);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        assertEq(digest, vm.parseJsonBytes32(json, ".digest"), "digest");

        bytes memory signature = vm.parseJsonBytes(json, ".signature");
        address recovered = _recoverMemory(digest, signature);
        assertEq(recovered, vm.parseJsonAddress(json, ".expectedSigner"), "expected signer");
        assertEq(recovered, vm.parseJsonAddress(json, ".recoveredSigner"), "recovered signer");
    }

    function test_link_rejectsZeroRecipient() public {
        bytes memory sig = _signLink(HANDLE, address(0), block.timestamp + 1 hours, 0);
        vm.expectRevert(Boon.ZeroAddress.selector);
        boon.link(HANDLE_HASH, HANDLE, address(0), block.timestamp + 1 hours, sig);
    }

    function test_link_rejectsDoubleLink() public {
        _link(HANDLE, alice);

        address bob = address(0xB0B);
        bytes memory sig = _signLink(HANDLE, bob, block.timestamp + 1 hours, 1);

        vm.expectRevert(Boon.AlreadyLinked.selector);
        boon.link(HANDLE_HASH, HANDLE, bob, block.timestamp + 1 hours, sig);
    }

    function test_link_rejectsReplayedVoucher() public {
        bytes memory sig = _signLink(HANDLE, alice, block.timestamp + 1 hours, 0);
        boon.link(HANDLE_HASH, HANDLE, alice, block.timestamp + 1 hours, sig);

        vm.expectRevert(Boon.AlreadyLinked.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, block.timestamp + 1 hours, sig);
    }

    function test_link_rejectsEscrowedHandleWithoutGuardianVoucher() public {
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, 5e6, "escrow");

        bytes memory sig = _signLink(HANDLE, alice, block.timestamp + 1 hours, 0);
        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, block.timestamp + 1 hours, sig);
    }

    function test_linkEscrowed_acceptsGuardianVoucher() public {
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, 5e6, "escrow");

        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(HANDLE, alice, deadline, 0);
        bytes memory guardianSig = _signLinkWith(guardianKey, HANDLE, alice, deadline, 0);

        boon.linkEscrowed(HANDLE_HASH, HANDLE, alice, deadline, sig, guardianSig);
        assertEq(boon.linkedWallet(HANDLE_HASH), alice);
        assertEq(boon.linkNonce(HANDLE_HASH), 1);
    }

    function test_relink_rotatesFuturePushWallet() public {
        _link(HANDLE, alice);

        address bob = address(0xB0B);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signLink(HANDLE, bob, deadline, 1);
        boon.relink(HANDLE_HASH, HANDLE, bob, deadline, sig);

        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, 3e6, "future");

        assertEq(boon.linkedWallet(HANDLE_HASH), bob);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(bob), 3e6);
        assertEq(boon.linkNonce(HANDLE_HASH), 2);
    }

    // ── claim() ─────────────────────────────────────────────────────────

    function test_claim_sweepsEscrowToLinkedWallet() public {
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, 25e6, "a");
        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, 15e6, "b");

        _link(HANDLE, alice);

        vm.expectEmit(true, true, false, true);
        emit Boon.Claimed(HANDLE_HASH, alice, 40e6);

        vm.prank(keeper);
        boon.claim(HANDLE_HASH);

        assertEq(usdc.balanceOf(alice), 40e6);
        assertEq(boon.escrow(HANDLE_HASH), 0);
    }

    function test_claim_revertsWhenNotLinked() public {
        vm.expectRevert(Boon.NotLinked.selector);
        boon.claim(HANDLE_HASH);
    }

    function test_claim_noopsForEmptyTokenBalance() public {
        _link(HANDLE, alice);

        boon.claim(HANDLE_HASH);
        assertEq(usdc.balanceOf(alice), 0);
    }

    // ── admin ───────────────────────────────────────────────────────────

    function test_rotateSigner_onlyOwner() public {
        address newSigner = address(0xC0DE);

        vm.expectRevert(Boon.NotOwner.selector);
        vm.prank(tipper);
        boon.rotateSigner(newSigner);

        boon.rotateSigner(newSigner);
        assertEq(boon.trustedSigner(), newSigner);
    }

    function test_rotateSigner_invalidatesPreviousVouchers() public {
        bytes memory oldSig = _signLink(HANDLE, alice, block.timestamp + 1 hours, 0);

        uint256 newKey = 0xC0DE;
        boon.rotateSigner(vm.addr(newKey));

        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, block.timestamp + 1 hours, oldSig);
    }

    function test_rotateSigner_invalidatesOldVouchersAndAcceptsNewSignerVouchers() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory oldSig = _signLink(HANDLE, alice, deadline, 0);

        uint256 newKey = 0xC0DE;
        boon.rotateSigner(vm.addr(newKey));

        vm.expectRevert(Boon.InvalidVoucher.selector);
        boon.link(HANDLE_HASH, HANDLE, alice, deadline, oldSig);

        bytes memory newSig = _signLinkWith(newKey, HANDLE, alice, deadline, 0);
        boon.link(HANDLE_HASH, HANDLE, alice, deadline, newSig);

        assertEq(boon.linkedWallet(HANDLE_HASH), alice);
        assertEq(boon.linkNonce(HANDLE_HASH), 1);
    }

    function test_transferOwnership_onlyOwner() public {
        address newOwner = address(0x0007);

        vm.expectRevert(Boon.NotOwner.selector);
        vm.prank(tipper);
        boon.transferOwnership(newOwner);

        boon.transferOwnership(newOwner);
        assertEq(boon.owner(), newOwner);
    }

    // ── fuzz ────────────────────────────────────────────────────────────

    function testFuzz_tipEscrowsCorrectAmount(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 1000e6);

        vm.prank(tipper);
        boon.tip(HANDLE_HASH, HANDLE, amount, "fuzz");

        assertEq(boon.escrow(HANDLE_HASH), amount);
    }

    function testFuzz_linkWithValidVoucher(address recipient, uint64 deadlineOffset) public {
        vm.assume(recipient != address(0));
        vm.assume(deadlineOffset > 0 && deadlineOffset < 365 days);

        uint256 deadline = block.timestamp + deadlineOffset;
        bytes memory sig = _signLink(HANDLE, recipient, deadline, 0);

        boon.link(HANDLE_HASH, HANDLE, recipient, deadline, sig);
        assertEq(boon.linkedWallet(HANDLE_HASH), recipient);
    }

    // ── helpers ─────────────────────────────────────────────────────────

    function _link(string memory handle, address recipient) internal {
        bytes32 h = keccak256(bytes(handle));
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = boon.linkNonce(h);
        bytes memory sig = _signLink(handle, recipient, deadline, nonce);
        if (boon.escrow(h) == 0) {
            boon.link(h, handle, recipient, deadline, sig);
        } else {
            bytes memory guardianSig =
                _signLinkWith(guardianKey, handle, recipient, deadline, nonce);
            boon.linkEscrowed(h, handle, recipient, deadline, sig, guardianSig);
        }
    }

    function _signLink(
        string memory canonicalHandle,
        address recipient,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        return _signLinkWith(signerKey, canonicalHandle, recipient, deadline, nonce);
    }

    function _signLinkWith(
        uint256 pk,
        string memory canonicalHandle,
        address recipient,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 handleHash = keccak256(bytes(canonicalHandle));
        return _signLinkWithProviderHash(
            pk, _providerHash(canonicalHandle), handleHash, recipient, deadline, nonce
        );
    }

    function _signLinkWithProviderHash(
        uint256 pk,
        bytes32 providerHash,
        bytes32 handleHash,
        address recipient,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(boon.LINK_TYPEHASH(), providerHash, handleHash, recipient, nonce, deadline)
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", boon.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signLinkForDomain(
        bytes32 domainSeparator,
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
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

    function _assertVectorIdentity(string memory json)
        internal
        view
        returns (bytes32 typeHash, bytes32 providerHash, bytes32 handleHash)
    {
        string memory linkType = vm.parseJsonString(json, ".linkType");
        typeHash = keccak256(bytes(linkType));
        assertEq(typeHash, boon.LINK_TYPEHASH(), "contract LINK_TYPEHASH");
        assertEq(typeHash, vm.parseJsonBytes32(json, ".typeHash"), "vector typeHash");

        string memory provider = vm.parseJsonString(json, ".provider");
        providerHash = vm.parseJsonBytes32(json, ".providerHash");
        assertEq(providerHash, GITHUB_PROVIDER_HASH, "github provider hash");
        assertEq(providerHash, keccak256(bytes(provider)), "provider hash convention");

        string memory canonicalHandle = vm.parseJsonString(json, ".canonicalHandle");
        handleHash = vm.parseJsonBytes32(json, ".handleHash");
        assertEq(handleHash, keccak256(bytes(canonicalHandle)), "handle hash convention");
    }

    function _assertVectorDomain(string memory json)
        internal
        pure
        returns (bytes32 domainSeparator)
    {
        domainSeparator = _domainSeparator(
            vm.parseJsonString(json, ".domain.name"),
            vm.parseJsonString(json, ".domain.version"),
            vm.parseJsonUint(json, ".domain.chainId"),
            vm.parseJsonAddress(json, ".domain.verifyingContract")
        );
        assertEq(domainSeparator, vm.parseJsonBytes32(json, ".domainSeparator"), "domain separator");
    }

    function _assertVectorStruct(
        string memory json,
        bytes32 typeHash,
        bytes32 providerHash,
        bytes32 handleHash
    ) internal pure returns (bytes32 structHash) {
        structHash = keccak256(
            abi.encode(
                typeHash,
                providerHash,
                handleHash,
                vm.parseJsonAddress(json, ".recipient"),
                vm.parseJsonUint(json, ".nonce"),
                vm.parseJsonUint(json, ".deadline")
            )
        );
        assertEq(structHash, vm.parseJsonBytes32(json, ".structHash"), "struct hash");
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

    function _recoverMemory(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
