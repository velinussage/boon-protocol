// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {Boon} from "../Boon.sol";

/**
 * Invariant tests for Boon (USDC-only).
 *
 * Handler always passes (handleHash, displayHandle) consistently from a
 * fixed catalog of already-canonical handles. These invariants focus on
 * conservation and link-nonce monotonicity across random sequences.
 */

contract MockToken {
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

contract BoonHandler is Test {
    Boon public boon;
    MockToken public token;
    uint256 public signerKey;

    string[] public handles;
    bytes32[] public handleHashes;
    mapping(bytes32 => bool) public hashSeen;

    uint256 public totalTipped;
    uint256 public totalPushed;
    uint256 public totalEscrowedNow;
    uint256 public totalClaimed;
    uint256 public linkOps;
    mapping(bytes32 => uint256) public expectedLinkNonce;

    address[] public actors;

    constructor(Boon _boon, MockToken _token, uint256 _signerKey) {
        boon = _boon;
        token = _token;
        signerKey = _signerKey;

        for (uint256 i; i < 3; ++i) {
            address a = address(uint160(0x10 + i));
            actors.push(a);
            token.mint(a, 1_000_000e6);
            vm.prank(a);
            token.approve(address(boon), type(uint256).max);
        }
    }

    // ── actions ─────────────────────────────────────────────────────────

    function tip(uint8 actorSeed, uint8 handleSeed, uint96 amount, uint16 noteLen) external {
        address actor = actors[actorSeed % actors.length];
        (string memory handle, bytes32 handleHash) = _handleFor(handleSeed);
        amount = uint96(bound(amount, 1, 100e6));
        string memory note = _note(noteLen);

        bool wasLinked = boon.linkedWallet(handleHash) != address(0);

        vm.prank(actor);
        try boon.tip(handleHash, handle, amount, note) {
            totalTipped += amount;
            if (wasLinked) {
                totalPushed += amount;
            } else {
                totalEscrowedNow += amount;
            }
        } catch {}
    }

    function link(uint8 handleSeed, uint8 walletSeed) external {
        (string memory handle, bytes32 handleHash) = _handleFor(handleSeed);
        if (boon.linkedWallet(handleHash) != address(0)) return;

        address wallet = address(uint160(0x100 + (walletSeed % 50)));
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = boon.linkNonce(handleHash);

        bytes memory sig = _signLink(handle, wallet, deadline, nonce);
        try boon.link(handleHash, handle, wallet, deadline, sig) {
            linkOps++;
            expectedLinkNonce[handleHash] = nonce + 1;
        } catch {}
    }

    function claim(uint8 handleSeed) external {
        (, bytes32 handleHash) = _handleFor(handleSeed);
        address linked = boon.linkedWallet(handleHash);
        if (linked == address(0)) return;

        uint256 before = boon.escrow(handleHash);
        try boon.claim(handleHash) {
            if (before > 0) {
                totalClaimed += before;
                totalEscrowedNow -= before;
            }
        } catch {}
    }

    // ── helpers ─────────────────────────────────────────────────────────

    function _handleFor(uint8 seed) internal returns (string memory, bytes32) {
        string[8] memory choices = [
            "github:a",
            "github:b",
            "github:c",
            "x:alpha",
            "x:beta",
            "x:gamma",
            "github:user-one",
            "x:user_two"
        ];
        string memory h = choices[seed % choices.length];
        bytes32 hash = keccak256(bytes(h));
        if (!hashSeen[hash]) {
            hashSeen[hash] = true;
            handles.push(h);
            handleHashes.push(hash);
        }
        return (h, hash);
    }

    function _note(uint16 len) internal pure returns (string memory) {
        bytes memory b = new bytes(uint256(len) % 64);
        for (uint256 i; i < b.length; ++i) b[i] = "x";
        return string(b);
    }

    function _signLink(string memory canonicalHandle, address recipient, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                boon.LINK_TYPEHASH(),
                _providerHash(canonicalHandle),
                keccak256(bytes(canonicalHandle)),
                recipient,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", boon.DOMAIN_SEPARATOR(), structHash));
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
            unchecked { ++i; }
        }

        bytes memory provider = new bytes(providerLength);
        for (uint256 i; i < providerLength;) {
            provider[i] = handleBytes[i];
            unchecked { ++i; }
        }
        return keccak256(provider);
    }

    function hashesLength() external view returns (uint256) {
        return handleHashes.length;
    }
}

contract BoonInvariantTest is StdInvariant, Test {
    Boon internal boon;
    MockToken internal token;
    BoonHandler internal handler;
    uint256 internal signerKey = 0xA11CE;

    function setUp() public {
        token = new MockToken();
        boon = new Boon(vm.addr(signerKey), address(token));
        handler = new BoonHandler(boon, token, signerKey);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = BoonHandler.tip.selector;
        selectors[1] = BoonHandler.link.selector;
        selectors[2] = BoonHandler.claim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_tokensConserved() public view {
        uint256 inContract = token.balanceOf(address(boon));
        assertEq(inContract, handler.totalEscrowedNow(), "contract balance != currently escrowed");
        assertEq(
            handler.totalTipped(),
            handler.totalPushed() + handler.totalClaimed() + handler.totalEscrowedNow(),
            "tipped != pushed + claimed + escrowed"
        );
    }

    function invariant_linkNonceMonotonic() public view {
        uint256 n = handler.hashesLength();
        for (uint256 i; i < n; ++i) {
            bytes32 h = handler.handleHashes(i);
            assertEq(boon.linkNonce(h), handler.expectedLinkNonce(h), "nonce drift");
        }
    }

    function invariant_linkOnceForever() public view {
        uint256 n = handler.hashesLength();
        for (uint256 i; i < n; ++i) {
            bytes32 h = handler.handleHashes(i);
            if (boon.linkNonce(h) > 0) {
                assertTrue(boon.linkedWallet(h) != address(0), "nonce > 0 but no linked wallet");
            }
        }
    }
}
