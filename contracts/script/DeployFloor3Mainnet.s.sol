// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ScoreGateHook} from "../src/ScoreGateHook.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {CreScorePublisher} from "../src/CreScorePublisher.sol";

/// @notice Deploys the full Floor-3 stack on Monad mainnet (chain id 143).
///
/// Order: ScoreRegistry → ERC8183 + ScoreGateHook → CreScorePublisher (prod Forwarder).
///
/// Env:
///   VERIFIER_1, VERIFIER_2, VERIFIER_3 — distinct verifier EOAs (required)
///   DEPLOYER_PRIVATE_KEY — broadcast key (hex with or without 0x)
///   TREASURY — optional (defaults to deployer)
///   CRE_FORWARDER — optional; defaults to Monad mainnet production KeystoneForwarder
///   MIN_SCORE_BPS / MIN_CONFIDENCE_BPS / MIN_INDEPENDENT_CLUSTERS — optional gate thresholds
///
/// After broadcast: record addresses in packages/chain NETWORKS.mainnet and cre configs.
contract DeployFloor3Mainnet is Script {
    uint256 internal constant MONAD_MAINNET = 143;
    address internal constant USDC_MAINNET = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    /// @dev Chainlink CRE production KeystoneForwarder on monad-mainnet.
    address internal constant CRE_PROD_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function run() external {
        require(block.chainid == MONAD_MAINNET, "not Monad mainnet");

        address[3] memory verifiers = [vm.envAddress("VERIFIER_1"), vm.envAddress("VERIFIER_2"), vm.envAddress("VERIFIER_3")];
        address forwarder = vm.envOr("CRE_FORWARDER", CRE_PROD_FORWARDER);
        uint16 minScoreBps = uint16(vm.envOr("MIN_SCORE_BPS", uint256(5_000)));
        uint16 minConfidenceBps = uint16(vm.envOr("MIN_CONFIDENCE_BPS", uint256(2_000)));
        uint32 minClusters = uint32(vm.envOr("MIN_INDEPENDENT_CLUSTERS", uint256(1)));

        address deployer = _startBroadcast();
        address treasury = vm.envOr("TREASURY", deployer);

        ScoreRegistry registry = new ScoreRegistry(verifiers);

        ERC8183 market = new ERC8183(0, 0, treasury, deployer);
        market.setPaymentTokenAllowed(USDC_MAINNET, true);

        ScoreGateHook hook = new ScoreGateHook(address(market), registry, minScoreBps, minConfidenceBps, minClusters);
        market.setHookWhitelist(address(hook), true);

        CreScorePublisher publisher = new CreScorePublisher(forwarder, address(registry));

        vm.stopBroadcast();

        _log(address(registry), address(market), address(hook), address(publisher), forwarder);
    }

    function _startBroadcast() internal returns (address deployer) {
        string memory deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        if (bytes(deployerKey).length != 0) {
            if (bytes(deployerKey)[0] != "0") deployerKey = string.concat("0x", deployerKey);
            uint256 pk = vm.parseUint(deployerKey);
            deployer = vm.addr(pk);
            vm.startBroadcast(pk);
        } else {
            vm.startBroadcast();
            deployer = msg.sender;
        }
    }

    function _log(address registry, address market, address hook, address publisher, address forwarder) internal view {
        console.log("=== Monad mainnet Floor-3 ===");
        console.log("ScoreRegistry:", registry);
        console.log("ERC8183:", market);
        console.log("ScoreGateHook:", hook);
        console.log("CreScorePublisher:", publisher);
        console.log("CRE Forwarder:", forwarder);
        console.log("USDC:", USDC_MAINNET);
        console.log("Chain id:", block.chainid);
    }
}
