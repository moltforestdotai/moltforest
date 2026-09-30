// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReceiptRegistry} from "../src/ReceiptRegistry.sol";
import {IIdentityRegistry} from "../src/IIdentityRegistry.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockSmartAccount} from "./mocks/MockSmartAccount.sol";

contract ReceiptRegistryTest is Test {
    MockIdentityRegistry internal identity;
    ReceiptRegistry internal registry;

    uint256 internal constant PROVIDER_ID = 7;
    uint256 internal constant CLIENT_ID = 0; // agent 0 exists on both Monad chains
    uint256 internal providerKey = 0xB0B;
    uint256 internal clientKey = 0xA11CE;
    uint256 internal ownerKey = 0x0C0FFEE;
    address internal provider;
    address internal client;
    address internal owner;

    event ReceiptAnchored(
        bytes32 indexed receiptHash,
        uint256 indexed providerAgentId,
        uint256 indexed clientAgentId,
        uint8 level,
        address providerSigner,
        address clientSigner
    );
    event ReceiptCoSigned(bytes32 indexed receiptHash, uint256 indexed clientAgentId, address clientSigner);

    function setUp() public {
        provider = vm.addr(providerKey);
        client = vm.addr(clientKey);
        owner = vm.addr(ownerKey);
        identity = new MockIdentityRegistry();
        identity.setAgent(PROVIDER_ID, owner, provider); // wallet differs from owner (like agent #1937)
        identity.setAgent(CLIENT_ID, client, address(0)); // no wallet set: the owner signs
        registry = new ReceiptRegistry(IIdentityRegistry(address(identity)));
    }

    function _receipt() internal pure returns (ReceiptRegistry.Receipt memory) {
        return ReceiptRegistry.Receipt({
            taskId: keccak256("task-1"),
            clientAgentId: CLIENT_ID,
            providerAgentId: PROVIDER_ID,
            requestHash: keccak256("request"),
            resultHash: keccak256("result"),
            paymentRef: bytes32(0),
            startedAt: 1_790_000_000,
            completedAt: 1_790_000_042,
            proofType: 0,
            proofRef: bytes32(0)
        });
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- levels ---

    function test_providerSignatureAnchorsLevel1() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        vm.expectEmit(address(registry));
        emit ReceiptAnchored(h, PROVIDER_ID, CLIENT_ID, 1, provider, address(0));
        (bytes32 anchored, uint8 level) = registry.anchor(r, _sign(providerKey, h), "");
        assertEq(anchored, h);
        assertEq(level, 1);
        assertEq(registry.levelOf(h), 1);
    }

    function test_clientCoSignatureAnchorsLevel2() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        vm.expectEmit(address(registry));
        emit ReceiptAnchored(h, PROVIDER_ID, CLIENT_ID, 2, provider, client);
        (, uint8 level) = registry.anchor(r, _sign(providerKey, h), _sign(clientKey, h));
        assertEq(level, 2);
        assertEq(registry.levelOf(h), 2);
    }

    function test_claimedProofTypeDoesNotRaiseLevel() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        r.proofType = 1; // "zk" claimed by the signers, not verified
        r.proofRef = keccak256("proof");
        bytes32 h = registry.hashReceipt(r);
        (, uint8 level) = registry.anchor(r, _sign(providerKey, h), "");
        assertEq(level, 1);
    }

    function test_anyoneCanSubmit() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        bytes memory sig = _sign(providerKey, h);
        vm.prank(makeAddr("relayer"));
        registry.anchor(r, sig, "");
        assertEq(registry.levelOf(h), 1);
    }

    // --- who may sign ---

    function test_ownerSignsWhenNoAgentWalletIsSet() public {
        identity.setAgent(PROVIDER_ID, owner, address(0));
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        assertEq(registry.signerOf(PROVIDER_ID), owner);
        (, uint8 level) = registry.anchor(r, _sign(ownerKey, h), "");
        assertEq(level, 1);
    }

    function test_ownerCannotSignWhenAgentWalletIsSet() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        bytes memory sig = _sign(ownerKey, h);
        vm.expectRevert(ReceiptRegistry.InvalidProviderSignature.selector);
        registry.anchor(r, sig, "");
    }

    function test_smartAccountWalletCanSign() public {
        uint256 deviceKey = 0xDE71CE;
        MockSmartAccount account = new MockSmartAccount(vm.addr(deviceKey));
        identity.setAgent(PROVIDER_ID, owner, address(account));
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        (, uint8 level) = registry.anchor(r, _sign(deviceKey, h), "");
        assertEq(level, 1);
    }

    function test_unknownProviderReverts() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        r.providerAgentId = 999;
        bytes32 h = registry.hashReceipt(r);
        bytes memory sig = _sign(providerKey, h);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.UnknownAgent.selector, 999));
        registry.anchor(r, sig, "");
    }

    function test_unknownClientRevertsWhenCoSigned() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        r.clientAgentId = 999;
        bytes32 h = registry.hashReceipt(r);
        bytes memory pSig = _sign(providerKey, h);
        bytes memory cSig = _sign(clientKey, h);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.UnknownAgent.selector, 999));
        registry.anchor(r, pSig, cSig);
    }

    // --- bad signatures ---

    function test_wrongProviderSignatureReverts() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        bytes memory sig = _sign(clientKey, h);
        vm.expectRevert(ReceiptRegistry.InvalidProviderSignature.selector);
        registry.anchor(r, sig, "");
    }

    function test_malformedSignatureReverts() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        vm.expectRevert(ReceiptRegistry.InvalidProviderSignature.selector);
        registry.anchor(r, hex"1234", "");
    }

    function test_invalidClientSignatureRevertsInsteadOfDowngrading() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        bytes memory pSig = _sign(providerKey, h);
        bytes memory badClientSig = _sign(ownerKey, h);
        vm.expectRevert(ReceiptRegistry.InvalidClientSignature.selector);
        registry.anchor(r, pSig, badClientSig);
        assertEq(registry.levelOf(h), 0);
    }

    function test_signatureOverDifferentFieldsIsRejected() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes memory sig = _sign(providerKey, registry.hashReceipt(r));
        r.resultHash = keccak256("tampered result");
        vm.expectRevert(ReceiptRegistry.InvalidProviderSignature.selector);
        registry.anchor(r, sig, "");
    }

    function test_signatureForAnotherDeploymentIsRejected() public {
        ReceiptRegistry other = new ReceiptRegistry(IIdentityRegistry(address(identity)));
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes memory sig = _sign(providerKey, other.hashReceipt(r));
        vm.expectRevert(ReceiptRegistry.InvalidProviderSignature.selector);
        registry.anchor(r, sig, "");
    }

    // --- replay and level raising ---

    function test_duplicateLevel1Reverts() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        bytes memory sig = _sign(providerKey, h);
        registry.anchor(r, sig, "");
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.AlreadyAnchored.selector, h, 1));
        registry.anchor(r, sig, "");
    }

    function test_duplicateLevel2Reverts() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        bytes memory pSig = _sign(providerKey, h);
        bytes memory cSig = _sign(clientKey, h);
        registry.anchor(r, pSig, cSig);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.AlreadyAnchored.selector, h, 2));
        registry.anchor(r, pSig, cSig);
    }

    function test_frontRunLevel1IsRaisedByClientCoSignature() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        bytes memory pSig = _sign(providerKey, h);
        bytes memory cSig = _sign(clientKey, h);

        vm.prank(makeAddr("front-runner"));
        registry.anchor(r, pSig, "");
        assertEq(registry.levelOf(h), 1);

        vm.expectEmit(address(registry));
        emit ReceiptCoSigned(h, CLIENT_ID, client);
        (, uint8 level) = registry.anchor(r, pSig, cSig);
        assertEq(level, 2);
        assertEq(registry.levelOf(h), 2);
    }

    function test_coSignatureWorksAfterProviderWalletRotates() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        registry.anchor(r, _sign(providerKey, h), "");
        identity.setAgent(PROVIDER_ID, owner, makeAddr("new provider wallet"));
        (, uint8 level) = registry.anchor(r, "", _sign(clientKey, h));
        assertEq(level, 2);
    }

    function test_invalidCoSignatureOnLevel1Reverts() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        bytes32 h = registry.hashReceipt(r);
        registry.anchor(r, _sign(providerKey, h), "");
        bytes memory badClientSig = _sign(providerKey, h);
        vm.expectRevert(ReceiptRegistry.InvalidClientSignature.selector);
        registry.anchor(r, "", badClientSig);
        assertEq(registry.levelOf(h), 1);
    }

    // --- sanity checks ---

    function test_selfReceiptReverts() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        r.clientAgentId = PROVIDER_ID;
        bytes memory sig = _sign(providerKey, registry.hashReceipt(r));
        vm.expectRevert(ReceiptRegistry.SelfReceipt.selector);
        registry.anchor(r, sig, "");
    }

    function test_completedBeforeStartedReverts() public {
        ReceiptRegistry.Receipt memory r = _receipt();
        r.completedAt = r.startedAt - 1;
        bytes memory sig = _sign(providerKey, registry.hashReceipt(r));
        vm.expectRevert(ReceiptRegistry.InvalidTimestamps.selector);
        registry.anchor(r, sig, "");
    }

    // --- fuzz ---

    function testFuzz_anyReceiptSignedByBothAnchorsAtLevel2(
        bytes32 taskId,
        bytes32 requestHash,
        bytes32 resultHash,
        bytes32 paymentRef,
        uint64 startedAt,
        uint64 duration,
        uint8 proofType,
        bytes32 proofRef
    ) public {
        vm.assume(duration <= type(uint64).max - startedAt);
        ReceiptRegistry.Receipt memory r = ReceiptRegistry.Receipt({
            taskId: taskId,
            clientAgentId: CLIENT_ID,
            providerAgentId: PROVIDER_ID,
            requestHash: requestHash,
            resultHash: resultHash,
            paymentRef: paymentRef,
            startedAt: startedAt,
            completedAt: startedAt + duration,
            proofType: proofType,
            proofRef: proofRef
        });
        bytes32 h = registry.hashReceipt(r);
        (, uint8 level) = registry.anchor(r, _sign(providerKey, h), _sign(clientKey, h));
        assertEq(level, 2);
    }
}
