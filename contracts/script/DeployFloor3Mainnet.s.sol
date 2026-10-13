// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC8183} from "../src/vendor/erc8183/ERC8183.sol";
import {ScoreGateHook} from "../src/ScoreGateHook.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {CreScorePublisher} from "../src/CreScorePublisher.sol";

/// @notice Deploys the full Floor-3 stack on Monad mainnet (chain id 143).
///
/// Order: ScoreRegistry → ERC8183 + ScoreGateHook → CreScorePublisher.
///
/// Env:
///   VERIFIER_1, VERIFIER_2, VERIFIER_3 — distinct verifier EOAs (required; fund with real MON for ops)
///   DEPLOYER_PRIVATE_KEY — broadcast key (hex with or without 0x); needs real MON for gas
///   TREASURY — optional (defaults to deployer)
///   CRE_MODE — `simulation` (default, hackathon) | `production` (live DON)
///   CRE_FORWARDER — optional override; defaults from CRE_MODE:
///     simulation → MockKeystoneForwarder 0x9eF646…784d (cre workflow simulate --broadcast)
///     production → KeystoneForwarder 0x76c9cf…15E62
///   MIN_SCORE_BPS / MIN_CONFIDENCE_BPS / MIN_INDEPENDENT_CLUSTERS — optional gate thresholds
///
/// After broadcast: `pnpm record:floor3-mainnet` (or paste into NETWORKS.mainnet + config.mainnet.json).
contract DeployFloor3Mainnet is Script {
    uint256 internal constant MONAD_MAINNET = 143;
    address internal constant USDC_MAINNET = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    /// @dev Chainlink CRE simulation MockKeystoneForwarder on monad-mainnet.
    address internal constant CRE_MOCK_FORWARDER = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    /// @dev Chainlink CRE production KeystoneForwarder on monad-mainnet.
    address internal constant CRE_PROD_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function run() external {
        require(block.chainid == MONAD_MAINNET, "not Monad mainnet");

        address[3] memory verifiers =
            [vm.envAddress("VERIFIER_1"), vm.envAddress("VERIFIER_2"), vm.envAddress("VERIFIER_3")];
        address forwarder = _resolveForwarder();
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

    function _resolveForwarder() internal view returns (address) {
        address overrideFwd = vm.envOr("CRE_FORWARDER", address(0));
        if (overrideFwd != address(0)) return overrideFwd;
        string memory mode = vm.envOr("CRE_MODE", string("simulation"));
        if (keccak256(bytes(mode)) == keccak256(bytes("production"))) return CRE_PROD_FORWARDER;
        // Default: simulation MockForwarder so `cre workflow simulate --broadcast` works with real MON.
        return CRE_MOCK_FORWARDER;
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
        console.log("Next: pnpm record:floor3-mainnet with SCORE_REGISTRY / ERC8183 / SCORE_GATE_HOOK / CRE_SCORE_PUBLISHER / DEPLOY_BLOCK");
    }
}
