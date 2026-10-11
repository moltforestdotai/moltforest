// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CreScorePublisher} from "../src/CreScorePublisher.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {IReceiver} from "../src/cre/IReceiver.sol";

/// @dev Stand-in for MockKeystoneForwarder: only this address may call onReport in unit tests.
contract MockCreForwarder {
    function deliver(address receiver, bytes calldata report) external {
        IReceiver(receiver).onReport("", report);
    }
}

contract CreScorePublisherTest is Test {
    uint256 internal constant V1_KEY = uint256(keccak256("verifier-1"));
    uint256 internal constant V2_KEY = uint256(keccak256("verifier-2"));
    uint256 internal constant V3_KEY = uint256(keccak256("verifier-3"));

    address internal v1;
    address internal v2;
    address internal v3;

    MockCreForwarder internal forwarder;
    ScoreRegistry internal registry;
    CreScorePublisher internal publisher;

    function setUp() public {
        v1 = vm.addr(V1_KEY);
        v2 = vm.addr(V2_KEY);
        v3 = vm.addr(V3_KEY);
        // ScoreRegistry sorts verifiers ascending at construction.
        registry = new ScoreRegistry([v1, v2, v3]);
        forwarder = new MockCreForwarder();
        publisher = new CreScorePublisher(address(forwarder), address(registry));
    }

    function test_supportsIReceiver() public view {
        assertTrue(publisher.supportsInterface(type(IReceiver).interfaceId));
    }

    function test_publishViaCreReport() public {
        uint64 epochId = 1;
        bytes32 inputsRoot = keccak256("inputs");
        bytes32 scoresRoot = keccak256("scores");
        bytes32 algoHash = keccak256("algo");

        bytes32 digest = registry.hashEpoch(epochId, inputsRoot, scoresRoot, algoHash);
        // Sign with sorted ascending signers (v addresses sorted).
        address[3] memory ordered = _sorted(v1, v2, v3);
        uint256[3] memory keys = _keysFor(ordered);

        bytes memory sig0 = _sign(keys[0], digest);
        bytes memory sig1 = _sign(keys[1], digest);

        bytes memory report = abi.encode(epochId, inputsRoot, scoresRoot, algoHash, sig0, sig1);
        forwarder.deliver(address(publisher), report);

        ScoreRegistry.Epoch memory e = registry.getEpoch(epochId);
        assertEq(e.scoresRoot, scoresRoot);
        assertEq(registry.latestEpochId(), epochId);
    }

    function test_revertWhenNotForwarder() public {
        bytes memory report = abi.encode(uint64(1), bytes32(0), bytes32(0), bytes32(0), bytes(""), bytes(""));
        vm.expectRevert();
        publisher.onReport("", report);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sorted(address a, address b, address c) internal pure returns (address[3] memory out) {
        out = [a, b, c];
        if (out[0] > out[1]) (out[0], out[1]) = (out[1], out[0]);
        if (out[1] > out[2]) (out[1], out[2]) = (out[2], out[1]);
        if (out[0] > out[1]) (out[0], out[1]) = (out[1], out[0]);
    }

    function _keysFor(address[3] memory ordered) internal view returns (uint256[3] memory keys) {
        for (uint256 i = 0; i < 3; i++) {
            if (ordered[i] == v1) keys[i] = V1_KEY;
            else if (ordered[i] == v2) keys[i] = V2_KEY;
            else keys[i] = V3_KEY;
        }
    }
}
