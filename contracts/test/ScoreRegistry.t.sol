// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";

contract ScoreRegistryTest is Test {
    ScoreRegistry internal registry;

    uint256 internal keyA = 0xA11CE;
    uint256 internal keyB = 0xB0B;
    uint256 internal keyC = 0xC0FFEE;
    address internal verifierA;
    address internal verifierB;
    address internal verifierC;

    event EpochPublished(
        uint64 indexed epochId,
        bytes32 inputsRoot,
        bytes32 scoresRoot,
        bytes32 algoHash,
        address[2] signers
    );

    function setUp() public {
        verifierA = vm.addr(keyA);
        verifierB = vm.addr(keyB);
        verifierC = vm.addr(keyC);
        // Pass unsorted; constructor sorts them ascending.
        address[3] memory set = [verifierB, verifierC, verifierA];
        registry = new ScoreRegistry(set);
        assertTrue(registry.verifiers(0) < registry.verifiers(1));
        assertTrue(registry.verifiers(1) < registry.verifiers(2));
        assertTrue(_isOneOf(registry.verifiers(0)) && _isOneOf(registry.verifiers(1)) && _isOneOf(registry.verifiers(2)));
    }

    function _isOneOf(address a) internal view returns (bool) {
        return a == verifierA || a == verifierB || a == verifierC;
    }

    function _score(uint256 agentId, uint16 scoreBps) internal pure returns (ScoreRegistry.Score memory) {
        return ScoreRegistry.Score({
            agentId: agentId,
            scoreBps: scoreBps,
            confidenceBps: 4_000,
            paidReviews: 3,
            independentClusters: 2,
            totalPaidVolume: 30_000
        });
    }

    /// @dev Single-leaf tree: root == leaf.
    function _publishSingle(uint64 epochId, ScoreRegistry.Score memory score, bytes32 algoHash)
        internal
        returns (bytes32 leaf)
    {
        leaf = registry.hashScoreLeaf(score);
        bytes32 inputsRoot = keccak256("inputs");
        bytes32 digest = registry.hashEpoch(epochId, inputsRoot, leaf, algoHash);
        // Signers must be sorted ascending: A < B < C for our keys? Check addresses.
        address[2] memory pair;
        uint256[2] memory keys;
        if (verifierA < verifierB) {
            pair = [verifierA, verifierB];
            keys = [keyA, keyB];
        } else {
            pair = [verifierB, verifierA];
            keys = [keyB, keyA];
        }
        // Ensure pair is sorted
        if (pair[0] > pair[1]) {
            (pair[0], pair[1]) = (pair[1], pair[0]);
            (keys[0], keys[1]) = (keys[1], keys[0]);
        }
        bytes[2] memory sigs;
        sigs[0] = _sign(keys[0], digest);
        sigs[1] = _sign(keys[1], digest);
        registry.publishEpoch(epochId, inputsRoot, leaf, algoHash, sigs);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_constructorRejectsDuplicateVerifiers() public {
        address[3] memory bad = [verifierA, verifierA, verifierB];
        vm.expectRevert(ScoreRegistry.InvalidVerifierSet.selector);
        new ScoreRegistry(bad);
    }

    function test_publishEpochWithTwoOfThree() public {
        ScoreRegistry.Score memory s = _score(7, 6_500);
        bytes32 algo = keccak256("algo-v1");
        bytes32 leaf = registry.hashScoreLeaf(s);
        bytes32 inputsRoot = keccak256("inputs");
        bytes32 digest = registry.hashEpoch(1, inputsRoot, leaf, algo);

        address s0 = verifierA < verifierB ? verifierA : verifierB;
        address s1 = verifierA < verifierB ? verifierB : verifierA;
        uint256 k0 = s0 == verifierA ? keyA : keyB;
        uint256 k1 = s1 == verifierA ? keyA : keyB;

        bytes[2] memory sigs = [_sign(k0, digest), _sign(k1, digest)];
        vm.expectEmit(address(registry));
        emit EpochPublished(1, inputsRoot, leaf, algo, [s0, s1]);
        registry.publishEpoch(1, inputsRoot, leaf, algo, sigs);

        assertEq(registry.latestEpochId(), 1);
        ScoreRegistry.Epoch memory e = registry.getEpoch(1);
        assertEq(e.scoresRoot, leaf);
        assertEq(e.algoHash, algo);
        assertGt(e.publishedAt, 0);
    }

    function test_rejectUnorderedSigners() public {
        ScoreRegistry.Score memory s = _score(1, 1_000);
        bytes32 leaf = registry.hashScoreLeaf(s);
        bytes32 inputsRoot = bytes32(uint256(1));
        bytes32 algo = bytes32(uint256(2));
        bytes32 digest = registry.hashEpoch(1, inputsRoot, leaf, algo);

        address s0 = verifierA < verifierB ? verifierA : verifierB;
        address s1 = verifierA < verifierB ? verifierB : verifierA;
        uint256 k0 = s0 == verifierA ? keyA : keyB;
        uint256 k1 = s1 == verifierA ? keyA : keyB;

        // Deliberately reverse signature order so recovered signers are descending.
        bytes[2] memory sigs = [_sign(k1, digest), _sign(k0, digest)];
        vm.expectRevert(ScoreRegistry.UnorderedOrDuplicateSigners.selector);
        registry.publishEpoch(1, inputsRoot, leaf, algo, sigs);
    }

    function test_rejectNonVerifier() public {
        uint256 strangerKey = 0xDEAD;
        ScoreRegistry.Score memory s = _score(1, 1_000);
        bytes32 leaf = registry.hashScoreLeaf(s);
        bytes32 inputsRoot = bytes32(uint256(1));
        bytes32 algo = bytes32(uint256(2));
        bytes32 digest = registry.hashEpoch(1, inputsRoot, leaf, algo);

        address s0 = verifierA;
        // stranger address may sort before or after A
        bytes memory sigA = _sign(keyA, digest);
        bytes memory sigX = _sign(strangerKey, digest);
        address stranger = vm.addr(strangerKey);
        bytes[2] memory sigs;
        if (s0 < stranger) {
            sigs = [sigA, sigX];
        } else {
            sigs = [sigX, sigA];
        }
        vm.expectRevert(abi.encodeWithSelector(ScoreRegistry.NotAVerifier.selector, stranger));
        registry.publishEpoch(1, inputsRoot, leaf, algo, sigs);
    }

    function test_cannotRepublishSameEpoch() public {
        ScoreRegistry.Score memory s = _score(7, 6_500);
        bytes32 algo = keccak256("algo");
        _publishSingle(1, s, algo);

        bytes32 leaf = registry.hashScoreLeaf(s);
        bytes32 inputsRoot = keccak256("inputs");
        bytes32 digest = registry.hashEpoch(1, inputsRoot, leaf, algo);
        address s0 = registry.verifiers(0);
        address s1 = registry.verifiers(1);
        uint256 k0 = s0 == verifierA ? keyA : (s0 == verifierB ? keyB : keyC);
        uint256 k1 = s1 == verifierA ? keyA : (s1 == verifierB ? keyB : keyC);
        bytes[2] memory sigs = [_sign(k0, digest), _sign(k1, digest)];

        vm.expectRevert(abi.encodeWithSelector(ScoreRegistry.EpochAlreadyPublished.selector, uint64(1)));
        registry.publishEpoch(1, inputsRoot, leaf, algo, sigs);
    }

    function test_verifyScoreSingleLeaf() public {
        ScoreRegistry.Score memory s = _score(7, 6_500);
        _publishSingle(1, s, keccak256("algo"));
        bytes32[] memory proof = new bytes32[](0);
        assertTrue(registry.verifyScore(1, s, proof));
        assertTrue(registry.verifyScoreLatest(s, proof));
    }

    function test_verifyScoreRejectsTampered() public {
        ScoreRegistry.Score memory s = _score(7, 6_500);
        _publishSingle(1, s, keccak256("algo"));
        s.scoreBps = 9_999;
        bytes32[] memory proof = new bytes32[](0);
        assertFalse(registry.verifyScore(1, s, proof));
    }

    function test_hashScoreLeafRejectsOutOfRange() public {
        ScoreRegistry.Score memory s = _score(1, 10_001);
        vm.expectRevert(ScoreRegistry.ScoreOutOfRange.selector);
        registry.hashScoreLeaf(s);
    }
}
