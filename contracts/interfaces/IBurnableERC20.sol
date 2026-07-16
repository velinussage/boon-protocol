// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface used by BurnVoteRegistrar.
/// @dev $BOON burn-votes are implemented by transferFrom(voter, burnSink, amount),
///      not by token totalSupply() destruction.
interface IBurnableERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
