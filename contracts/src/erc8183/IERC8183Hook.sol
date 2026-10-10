// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IERC8183Hook
/// @notice Optional before/after callbacks on hookable ERC-8183 actions (qntx/market-contract).
/// @dev ERC-165 interface id is `0x7ff6bc9e`. The doc name "IACPHook" is outdated — use this.
interface IERC8183Hook is IERC165 {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
