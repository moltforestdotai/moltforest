// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC8183} from "./IERC8183.sol";
import {IERC8183Hook} from "./IERC8183Hook.sol";

/// @title BaseERC8183Hook
/// @notice Routes `beforeAction`/`afterAction` to named virtuals (same pattern as qntx BaseERC8183Hook).
/// @dev Trimmed to the actions ScoreGateHook cares about (`fund`); other selectors no-op.
abstract contract BaseERC8183Hook is ERC165, IERC8183Hook {
    address public immutable erc8183Contract;

    error OnlyERC8183Contract();
    error ZeroAddress();

    modifier onlyERC8183(uint256 jobId) {
        _onlyERC8183(jobId);
        _;
    }

    function _onlyERC8183(uint256 jobId) internal view {
        if (msg.sender != erc8183Contract) {
            if (msg.sender != IERC8183(erc8183Contract).getJob(jobId).hook) {
                revert OnlyERC8183Contract();
            }
        }
    }

    constructor(address erc8183Contract_) {
        if (erc8183Contract_ == address(0)) revert ZeroAddress();
        erc8183Contract = erc8183Contract_;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IERC8183Hook).interfaceId || super.supportsInterface(interfaceId);
    }

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external override onlyERC8183(jobId) {
        if (selector == IERC8183.fund.selector) {
            (address caller, bytes memory optParams) = abi.decode(data, (address, bytes));
            _preFund(jobId, caller, optParams);
        }
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external override onlyERC8183(jobId) {
        if (selector == IERC8183.fund.selector) {
            (address caller, bytes memory optParams) = abi.decode(data, (address, bytes));
            _postFund(jobId, caller, optParams);
        }
    }

    function _preFund(uint256 jobId, address caller, bytes memory optParams) internal view virtual {}

    function _postFund(uint256 jobId, address caller, bytes memory optParams) internal virtual {}
}
