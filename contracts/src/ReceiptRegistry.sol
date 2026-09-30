// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IIdentityRegistry} from "./IIdentityRegistry.sol";

/// @title ReceiptRegistry
/// @notice Anchors the hashes of EIP-712 execution receipts signed by ERC-8004 agents.
///
/// A receipt is evidence that a job happened, not a proof of what happened. The contract assigns:
///   - level 1 when the provider agent signed the receipt;
///   - level 2 when the client agent co-signed it as well.
/// `proofType` and `proofRef` are recorded as the signers' claims and never raise the level.
///
/// An agent signs with its ERC-8004 agent wallet, or with its owner when no agent wallet is set.
/// Both EOA and ERC-1271 (smart account) signatures are accepted.
///
/// Only the hash is stored; the full receipt lives off-chain (MoltForest API).
contract ReceiptRegistry is EIP712 {
    struct Receipt {
        bytes32 taskId;
        uint256 clientAgentId;
        uint256 providerAgentId;
        bytes32 requestHash; // commitment to the request / input
        bytes32 resultHash; // commitment to the output
        bytes32 paymentRef; // x402 settlement tx hash, or zero
        uint64 startedAt; // unix seconds
        uint64 completedAt; // unix seconds
        uint8 proofType; // 0 none, 1 zk, 2 tee, 3 validator (claimed, not verified here)
        bytes32 proofRef;
    }

    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(bytes32 taskId,uint256 clientAgentId,uint256 providerAgentId,bytes32 requestHash,bytes32 resultHash,bytes32 paymentRef,uint64 startedAt,uint64 completedAt,uint8 proofType,bytes32 proofRef)"
    );

    uint8 public constant LEVEL_PROVIDER_SIGNED = 1;
    uint8 public constant LEVEL_CLIENT_COSIGNED = 2;

    IIdentityRegistry public immutable identityRegistry;

    /// @notice Level of an anchored receipt; 0 when the hash was never anchored.
    mapping(bytes32 receiptHash => uint8 level) public levelOf;

    /// @notice First anchor of a receipt. Signer addresses are recorded because agent wallets can change later.
    event ReceiptAnchored(
        bytes32 indexed receiptHash,
        uint256 indexed providerAgentId,
        uint256 indexed clientAgentId,
        uint8 level,
        address providerSigner,
        address clientSigner
    );

    /// @notice A level-1 receipt was raised to level 2 by the client's co-signature.
    event ReceiptCoSigned(bytes32 indexed receiptHash, uint256 indexed clientAgentId, address clientSigner);

    error SelfReceipt();
    error InvalidTimestamps();
    error UnknownAgent(uint256 agentId);
    error InvalidProviderSignature();
    error InvalidClientSignature();
    error AlreadyAnchored(bytes32 receiptHash, uint8 level);

    constructor(IIdentityRegistry identityRegistry_) EIP712("MoltForestReceipts", "1") {
        identityRegistry = identityRegistry_;
    }

    /// @notice Anchors a receipt. Anyone may submit; the signatures decide the level.
    /// @dev `clientSig` is optional. If it is present it must be valid, so a bad co-signature is never
    ///      silently recorded as level 1. A level-1 receipt can be raised to level 2 later by calling
    ///      again with a valid `clientSig`; this also defeats front-running a level-2 anchor with a
    ///      provider-only copy of the same receipt.
    function anchor(Receipt calldata r, bytes calldata providerSig, bytes calldata clientSig)
        external
        returns (bytes32 receiptHash, uint8 level)
    {
        if (r.providerAgentId == r.clientAgentId) revert SelfReceipt();
        if (r.startedAt > r.completedAt) revert InvalidTimestamps();

        receiptHash = hashReceipt(r);
        uint8 current = levelOf[receiptHash];
        if (current >= LEVEL_CLIENT_COSIGNED || (current != 0 && clientSig.length == 0)) {
            revert AlreadyAnchored(receiptHash, current);
        }

        // Zero when not checked in this call: the provider on a level raise, the client at level 1.
        address providerSigner = address(0);
        if (current == 0) {
            providerSigner = signerOf(r.providerAgentId);
            if (!SignatureChecker.isValidSignatureNow(providerSigner, receiptHash, providerSig)) {
                revert InvalidProviderSignature();
            }
        }

        address clientSigner = address(0);
        level = LEVEL_PROVIDER_SIGNED;
        if (clientSig.length != 0) {
            clientSigner = signerOf(r.clientAgentId);
            if (!SignatureChecker.isValidSignatureNow(clientSigner, receiptHash, clientSig)) {
                revert InvalidClientSignature();
            }
            level = LEVEL_CLIENT_COSIGNED;
        }

        levelOf[receiptHash] = level;
        if (current == 0) {
            emit ReceiptAnchored(receiptHash, r.providerAgentId, r.clientAgentId, level, providerSigner, clientSigner);
        } else {
            emit ReceiptCoSigned(receiptHash, r.clientAgentId, clientSigner);
        }
    }

    /// @notice The EIP-712 digest both agents sign. It is also the receipt's id.
    function hashReceipt(Receipt calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RECEIPT_TYPEHASH, r)));
    }

    /// @notice The address that signs for an agent: its agent wallet, or its owner when no wallet is set.
    function signerOf(uint256 agentId) public view returns (address) {
        address wallet = identityRegistry.getAgentWallet(agentId);
        if (wallet != address(0)) return wallet;
        try identityRegistry.ownerOf(agentId) returns (address owner) {
            return owner;
        } catch {
            revert UnknownAgent(agentId);
        }
    }
}
