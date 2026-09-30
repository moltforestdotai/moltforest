// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReceiptRegistry} from "../src/ReceiptRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @dev Same vector as packages/receipts/test/vector.test.ts: a digest and a signature produced by the
///      TypeScript package must match what the contract computes and accepts.
contract ReceiptVectorTest is Test {
    address internal constant VERIFYING_CONTRACT = 0x1111111111111111111111111111111111111111;
    bytes32 internal constant DIGEST = 0x94572fc1551f980d79934a1f789411f5d3cde61f606a925b656d94a87a92c6bc;
    bytes internal constant SIGNATURE =
        hex"b32adb7a65c2d38dffdc3156b245c44e8e12698a8ffa18688d97c1257db8f08d05a307c4b10bd1893704cc9311649fe5a5549f2b68662fd35fb2d853a39610fa1c";
    // Address of Anvil's first well-known test key.
    address internal constant SIGNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    ReceiptRegistry internal registry;

    function setUp() public {
        MockIdentityRegistry identity = new MockIdentityRegistry();
        identity.setAgent(7, makeAddr("owner"), SIGNER);
        identity.setAgent(0, makeAddr("client"), address(0));
        vm.chainId(10143);
        deployCodeTo("ReceiptRegistry.sol:ReceiptRegistry", abi.encode(address(identity)), VERIFYING_CONTRACT);
        registry = ReceiptRegistry(VERIFYING_CONTRACT);
    }

    function _receipt() internal pure returns (ReceiptRegistry.Receipt memory) {
        return ReceiptRegistry.Receipt({
            taskId: keccak256("task-1"),
            clientAgentId: 0,
            providerAgentId: 7,
            requestHash: keccak256("request"),
            resultHash: keccak256("result"),
            paymentRef: bytes32(0),
            startedAt: 1_790_000_000,
            completedAt: 1_790_000_042,
            proofType: 0,
            proofRef: bytes32(0)
        });
    }

    function test_digestMatchesTypeScript() public view {
        assertEq(registry.hashReceipt(_receipt()), DIGEST);
    }

    function test_typeScriptSignatureIsAccepted() public {
        (bytes32 receiptHash, uint8 level) = registry.anchor(_receipt(), SIGNATURE, "");
        assertEq(receiptHash, DIGEST);
        assertEq(level, 1);
    }
}
