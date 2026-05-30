// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BoonGratitudeAttestation} from "../BoonGratitudeAttestation.sol";

contract BoonGratitudeAttestationTest is Test {
    BoonGratitudeAttestation internal sbt;
    address internal minter = address(0xB00B);
    address internal recipient = address(0xA11CE);
    bytes32 internal handleHash = keccak256(bytes("agent:42"));
    bytes32 internal commitment = keccak256("private");

    function setUp() public {
        sbt = new BoonGratitudeAttestation();
    }

    function test_initializeMinterOnceAndLock() public {
        sbt.initializeMinter(minter);
        assertEq(sbt.minter(), minter);
        assertTrue(sbt.minterLocked());

        vm.expectRevert(BoonGratitudeAttestation.MinterLocked.selector);
        sbt.initializeMinter(address(0xCAFE));
    }

    function test_initializeMinterOnlyDeployer() public {
        vm.expectRevert(BoonGratitudeAttestation.NotDeployer.selector);
        vm.prank(address(0xBAD));
        sbt.initializeMinter(minter);
    }

    function test_mintStoresSoulboundAttestation() public {
        sbt.initializeMinter(minter);

        vm.prank(minter);
        sbt.mint(7, recipient, handleHash, 42, commitment, 3_500_000e18);

        assertEq(sbt.ownerOf(7), recipient);
        assertEq(sbt.balanceOf(recipient), 1);
        assertTrue(sbt.locked(7));
        (
            address storedRecipient,
            bytes32 storedHandleHash,
            uint256 agentId,
            bytes32 storedCommitment,
            uint256 boonBurned,
            uint256 mintedAt
        ) = sbt.attestations(7);
        assertEq(storedRecipient, recipient);
        assertEq(storedHandleHash, handleHash);
        assertEq(agentId, 42);
        assertEq(storedCommitment, commitment);
        assertEq(boonBurned, 3_500_000e18);
        assertEq(mintedAt, block.timestamp);
    }

    function test_mintOnlyMinter() public {
        sbt.initializeMinter(minter);
        vm.expectRevert(BoonGratitudeAttestation.NotMinter.selector);
        sbt.mint(1, recipient, handleHash, 42, commitment, 1);
    }

    function test_transferAndApprovalsRevertSoulbound() public {
        sbt.initializeMinter(minter);
        vm.prank(minter);
        sbt.mint(1, recipient, handleHash, 42, commitment, 1);

        vm.expectRevert(BoonGratitudeAttestation.Soulbound.selector);
        vm.prank(recipient);
        sbt.transferFrom(recipient, address(0xCAFE), 1);

        vm.expectRevert(BoonGratitudeAttestation.Soulbound.selector);
        vm.prank(recipient);
        sbt.safeTransferFrom(recipient, address(0xCAFE), 1);

        vm.expectRevert(BoonGratitudeAttestation.Soulbound.selector);
        vm.prank(recipient);
        sbt.safeTransferFrom(recipient, address(0xCAFE), 1, "");

        vm.expectRevert(BoonGratitudeAttestation.Soulbound.selector);
        vm.prank(recipient);
        sbt.approve(address(0xCAFE), 1);

        vm.expectRevert(BoonGratitudeAttestation.Soulbound.selector);
        vm.prank(recipient);
        sbt.setApprovalForAll(address(0xCAFE), true);
    }

    function test_supportsErc721AndErc5192() public view {
        assertTrue(sbt.supportsInterface(0x01ffc9a7)); // ERC-165
        assertTrue(sbt.supportsInterface(0x80ac58cd)); // ERC-721
        assertTrue(sbt.supportsInterface(0x5b5e139f)); // ERC-721 Metadata
        assertTrue(sbt.supportsInterface(0xb45a3c0e)); // ERC-5192
    }

    function test_tokenUriRequiresMintAndReturnsDataUri() public {
        vm.expectRevert(BoonGratitudeAttestation.TokenNotMinted.selector);
        sbt.tokenURI(1);

        sbt.initializeMinter(minter);
        vm.prank(minter);
        sbt.mint(1, recipient, handleHash, 42, commitment, 1);

        string memory uri = sbt.tokenURI(1);
        assertEq(bytes(uri)[0], bytes1("d"));
    }

    function test_tokenUriAllowsTipIdZeroAndUsesApiBaseUri() public {
        sbt.initializeMetadataBaseURI("https://api.boonprotocol.com/api/v1/attestations/");
        sbt.initializeMinter(minter);

        vm.prank(minter);
        sbt.mint(0, recipient, handleHash, 42, commitment, 1);

        assertEq(sbt.tokenURI(0), "https://api.boonprotocol.com/api/v1/attestations/0");
    }
}
