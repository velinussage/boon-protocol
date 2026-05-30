// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BoonV2Test} from "./BoonV2.t.sol";

contract BoonV2InvariantTest is BoonV2Test {
    function test_nextTipIdOnlyAdvancesOnSuccessfulTips() public {
        assertEq(boon.nextTipId(), 0);
        _link(HANDLE, alice);

        vm.prank(tipper);
        boon.tip(HANDLE, 1e6, "first", false, _emptyPermit());
        assertEq(boon.nextTipId(), 1);

        vm.expectRevert();
        vm.prank(tipper);
        boon.tipAgent(42, address(0xBAD), 1e6, "bad", false, _emptyPermit());
        assertEq(boon.nextTipId(), 1);

        vm.prank(tipper);
        boon.tipPrivate(
            HANDLE_HASH, HANDLE, alice, 1e6, keccak256("private"), false, _emptyPermit()
        );
        assertEq(boon.nextTipId(), 2);
        assertEq(boon.tipperOf(0), tipper);
        assertEq(boon.tipperOf(1), tipper);
    }

    function test_privateTipStateIsSetOnceForSuccessfulPrivateTip() public {
        _link(HANDLE, alice);
        bytes32 commitment = keccak256("state once");

        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 1e6, commitment, false, _emptyPermit());

        assertTrue(boon.isPrivateTip(0));
        assertEq(boon.privateCommitmentOf(0), commitment);
        assertEq(boon.blobKeyCommitment(0), commitment);
        assertEq(boon.tipperOf(0), tipper);

        vm.expectRevert();
        vm.prank(tipper);
        boon.tipPrivate(HANDLE_HASH, HANDLE, alice, 1e6, commitment, false, _emptyPermit());
        assertEq(boon.privateCommitmentOf(0), commitment);
    }
}
