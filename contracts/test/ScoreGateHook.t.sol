// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {ScoreGateHook} from "../src/ScoreGateHook.sol";
import {IERC8183} from "../src/erc8183/IERC8183.sol";
import {IERC8183Hook} from "../src/erc8183/IERC8183Hook.sol";

/// @dev Minimal ERC-8183 stub: stores one job and invokes the hook on fund like the real kernel.
contract MockERC8183 {
    IERC8183.Job internal job;
    uint256 public lastFunded;

    function setJob(IERC8183.Job memory j) external {
        job = j;
    }

    function getJob(uint256) external view returns (IERC8183.Job memory) {
        return job;
    }

    function fund(uint256 jobId, address, uint256, bytes calldata optParams) external {
        // Mirror qntx: beforeAction(jobId, fund.selector, abi.encode(caller, optParams))
        IERC8183Hook(job.hook).beforeAction(jobId, this.fund.selector, abi.encode(msg.sender, optParams));
        lastFunded = jobId;
        job.status = IERC8183.JobStatus.Funded;
    }
}

contract ScoreGateHookTest is Test {
    ScoreRegistry internal scores;
    MockERC8183 internal market;
    ScoreGateHook internal hook;

    uint256 internal keyA = 0xA11CE;
    uint256 internal keyB = 0xB0B;
    uint256 internal keyC = 0xC0FFEE;

    address internal client = address(0xC1);
    address internal provider = address(0xB1);
    address internal evaluator = address(0xE1);
    address internal usdc = address(0x1234);

    function setUp() public {
        address[3] memory verifiers = [vm.addr(keyA), vm.addr(keyB), vm.addr(keyC)];
        scores = new ScoreRegistry(verifiers);
        market = new MockERC8183();
        hook = new ScoreGateHook(
            address(market),
            scores,
            /* minScoreBps */
            5_000,
            /* minConfidenceBps */
            2_000,
            /* minIndependentClusters */
            1
        );
    }

    function _keyFor(address who) internal view returns (uint256) {
        if (who == vm.addr(keyA)) return keyA;
        if (who == vm.addr(keyB)) return keyB;
        return keyC;
    }

    function _signDigest(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _publish(ScoreRegistry.Score memory score) internal {
        bytes32 leaf = scores.hashScoreLeaf(score);
        bytes32 digest = scores.hashEpoch(1, keccak256("inputs"), leaf, keccak256("algo"));
        bytes[2] memory sigs;
        sigs[0] = _signDigest(_keyFor(scores.verifiers(0)), digest);
        sigs[1] = _signDigest(_keyFor(scores.verifiers(1)), digest);
        scores.publishEpoch(1, keccak256("inputs"), leaf, keccak256("algo"), sigs);
    }

    function _job(uint256 agentId) internal view returns (IERC8183.Job memory) {
        return IERC8183.Job({
            client: client,
            status: IERC8183.JobStatus.Open,
            provider: provider,
            expiredAt: uint48(block.timestamp + 1 days),
            evaluator: evaluator,
            submittedAt: 0,
            budget: 1e6,
            hook: address(hook),
            paymentToken: usdc,
            providerAgentId: agentId,
            description: "demo",
            settledAmount: 0,
            payoutReceiver: provider
        });
    }

    function _opt(
        ScoreRegistry.Score memory score,
        bytes32 clientCluster,
        bytes32 providerCluster,
        bytes32 evaluatorCluster
    ) internal pure returns (bytes memory) {
        bytes32[] memory proof = new bytes32[](0);
        return abi.encode(uint64(1), score, proof, clientCluster, providerCluster, evaluatorCluster);
    }

    function test_fundSucceedsWhenScoreClearsGate() public {
        ScoreRegistry.Score memory score = ScoreRegistry.Score({
            agentId: 7,
            scoreBps: 6_500,
            confidenceBps: 4_000,
            paidReviews: 3,
            independentClusters: 2,
            totalPaidVolume: 30_000
        });
        _publish(score);
        market.setJob(_job(7));

        bytes32 cCluster = keccak256("client");
        bytes32 pCluster = keccak256("provider");
        bytes32 eCluster = keccak256("evaluator");
        market.fund(1, usdc, 1e6, _opt(score, cCluster, pCluster, eCluster));
        assertEq(market.lastFunded(), 1);
    }

    function test_fundRevertsOnLowScore() public {
        ScoreRegistry.Score memory score = ScoreRegistry.Score({
            agentId: 7,
            scoreBps: 1_000,
            confidenceBps: 4_000,
            paidReviews: 1,
            independentClusters: 1,
            totalPaidVolume: 1
        });
        _publish(score);
        market.setJob(_job(7));

        vm.expectRevert(abi.encodeWithSelector(ScoreGateHook.ScoreTooLow.selector, uint16(1_000), uint16(5_000)));
        market.fund(1, usdc, 1e6, _opt(score, keccak256("a"), keccak256("b"), keccak256("c")));
    }

    function test_fundRevertsOnColludingCluster() public {
        ScoreRegistry.Score memory score = ScoreRegistry.Score({
            agentId: 7,
            scoreBps: 6_500,
            confidenceBps: 4_000,
            paidReviews: 3,
            independentClusters: 2,
            totalPaidVolume: 30_000
        });
        _publish(score);
        market.setJob(_job(7));

        bytes32 same = keccak256("sybil-ring");
        vm.expectRevert(ScoreGateHook.ColludingCluster.selector);
        market.fund(1, usdc, 1e6, _opt(score, same, keccak256("other"), same));
    }

    function test_fundRevertsOnBadProof() public {
        ScoreRegistry.Score memory score = ScoreRegistry.Score({
            agentId: 7,
            scoreBps: 6_500,
            confidenceBps: 4_000,
            paidReviews: 3,
            independentClusters: 2,
            totalPaidVolume: 30_000
        });
        _publish(score);
        market.setJob(_job(7));

        score.scoreBps = 9_000; // tampered vs published leaf
        vm.expectRevert(ScoreGateHook.InvalidScoreProof.selector);
        market.fund(1, usdc, 1e6, _opt(score, keccak256("a"), keccak256("b"), keccak256("c")));
    }

    function test_supportsIERC8183HookInterface() public view {
        assertTrue(hook.supportsInterface(type(IERC8183Hook).interfaceId));
    }
}
