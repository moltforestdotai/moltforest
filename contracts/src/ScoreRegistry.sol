// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title ScoreRegistry
/// @notice Publishes epoch Merkle roots for agent trust scores (Floor 3).
///
/// Verifiers recompute `inputsRoot` and `scoresRoot` off-chain from chain data and co-sign.
/// Anyone may call `publishEpoch` with 2-of-3 EIP-712 signatures (sorted by signer address).
/// Consumers verify one agent's score with a Merkle proof against the latest (or a given) epoch.
///
/// Leaf encoding matches OpenZeppelin StandardMerkleTree / double-hash:
///   leaf = keccak256(bytes.concat(keccak256(abi.encode(agentId, scoreBps, confidenceBps,
///          paidReviews, independentClusters, totalPaidVolume))))
///
/// Network: Monad testnet and mainnet (Floor-3).
contract ScoreRegistry is EIP712 {
    using ECDSA for bytes32;

    /// @notice Per-agent score row committed under `scoresRoot`.
    struct Score {
        uint256 agentId;
        uint16 scoreBps; // 0..10_000
        uint16 confidenceBps; // 0..10_000
        uint32 paidReviews;
        uint32 independentClusters;
        uint256 totalPaidVolume; // token base units (e.g. USDC 6 decimals)
    }

    /// @notice Frozen roots for one scoring window.
    struct Epoch {
        bytes32 inputsRoot;
        bytes32 scoresRoot;
        bytes32 algoHash; // keccak256 of pinned algorithm / container digest
        uint64 publishedAt; // unix seconds, filled on-chain at publish
    }

    bytes32 public constant EPOCH_TYPEHASH =
        keccak256("Epoch(uint64 epochId,bytes32 inputsRoot,bytes32 scoresRoot,bytes32 algoHash)");

    uint8 public constant VERIFIER_COUNT = 3;
    uint8 public constant THRESHOLD = 2;

    /// @notice Exactly three distinct verifier addresses, sorted ascending at construction.
    address[VERIFIER_COUNT] public verifiers;

    /// @notice Latest published epoch id (0 before the first publish).
    uint64 public latestEpochId;

    mapping(uint64 epochId => Epoch) public epochs;

    event EpochPublished(
        uint64 indexed epochId, bytes32 inputsRoot, bytes32 scoresRoot, bytes32 algoHash, address[THRESHOLD] signers
    );

    error InvalidVerifierSet();
    error EpochAlreadyPublished(uint64 epochId);
    error EpochNotPublished(uint64 epochId);
    error BadSignatureCount();
    error UnorderedOrDuplicateSigners();
    error NotAVerifier(address signer);
    error InvalidScoreProof();
    error ScoreOutOfRange();

    /// @param verifiers_ Three distinct addresses; they will be stored sorted ascending.
    constructor(address[VERIFIER_COUNT] memory verifiers_) EIP712("MoltForestScores", "1") {
        address a = verifiers_[0];
        address b = verifiers_[1];
        address c = verifiers_[2];
        if (a == address(0) || b == address(0) || c == address(0)) revert InvalidVerifierSet();
        // Sort ascending so checks and events are canonical.
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        if (a == b || b == c) revert InvalidVerifierSet();
        verifiers[0] = a;
        verifiers[1] = b;
        verifiers[2] = c;
    }

    /// @notice EIP-712 digest verifiers sign for an epoch. Does not include `publishedAt`.
    function hashEpoch(uint64 epochId, bytes32 inputsRoot, bytes32 scoresRoot, bytes32 algoHash)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(EPOCH_TYPEHASH, epochId, inputsRoot, scoresRoot, algoHash)));
    }

    /// @notice Double-hashed leaf for one agent score (OZ StandardMerkleTree compatible).
    function hashScoreLeaf(Score calldata s) public pure returns (bytes32) {
        if (s.scoreBps > 10_000 || s.confidenceBps > 10_000) revert ScoreOutOfRange();
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        s.agentId, s.scoreBps, s.confidenceBps, s.paidReviews, s.independentClusters, s.totalPaidVolume
                    )
                )
            )
        );
    }

    /// @notice Publish epoch `epochId` with exactly two ECDSA signatures over `hashEpoch(...)`.
    /// @dev Signatures must recover to two distinct members of `verifiers`, sorted by signer ascending.
    function publishEpoch(
        uint64 epochId,
        bytes32 inputsRoot,
        bytes32 scoresRoot,
        bytes32 algoHash,
        bytes[THRESHOLD] calldata signatures
    ) external {
        if (epochs[epochId].publishedAt != 0) revert EpochAlreadyPublished(epochId);

        bytes32 digest = hashEpoch(epochId, inputsRoot, scoresRoot, algoHash);
        address[THRESHOLD] memory signers;
        for (uint256 i = 0; i < THRESHOLD; i++) {
            address signer = digest.recover(signatures[i]);
            if (!_isVerifier(signer)) revert NotAVerifier(signer);
            signers[i] = signer;
        }
        if (signers[0] >= signers[1]) revert UnorderedOrDuplicateSigners();

        epochs[epochId] = Epoch({
            inputsRoot: inputsRoot, scoresRoot: scoresRoot, algoHash: algoHash, publishedAt: uint64(block.timestamp)
        });
        if (epochId > latestEpochId) latestEpochId = epochId;

        emit EpochPublished(epochId, inputsRoot, scoresRoot, algoHash, signers);
    }

    /// @notice Verify `score` is in `epochId`'s `scoresRoot` via Merkle proof.
    function verifyScore(uint64 epochId, Score calldata score, bytes32[] calldata proof) external view returns (bool) {
        Epoch storage e = epochs[epochId];
        if (e.publishedAt == 0) revert EpochNotPublished(epochId);
        return MerkleProof.verify(proof, e.scoresRoot, hashScoreLeaf(score));
    }

    /// @notice Convenience: verify against `latestEpochId`.
    function verifyScoreLatest(Score calldata score, bytes32[] calldata proof) external view returns (bool) {
        uint64 id = latestEpochId;
        if (id == 0 || epochs[id].publishedAt == 0) revert EpochNotPublished(id);
        return MerkleProof.verify(proof, epochs[id].scoresRoot, hashScoreLeaf(score));
    }

    function getEpoch(uint64 epochId) external view returns (Epoch memory) {
        Epoch memory e = epochs[epochId];
        if (e.publishedAt == 0) revert EpochNotPublished(epochId);
        return e;
    }

    function _isVerifier(address account) internal view returns (bool) {
        return account == verifiers[0] || account == verifiers[1] || account == verifiers[2];
    }
}
