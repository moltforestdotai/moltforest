/** Minimal ScoreRegistry ABI for epoch publish + verify. */
export const scoreRegistryAbi = [
  {
    type: "function",
    name: "publishEpoch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint64" },
      { name: "inputsRoot", type: "bytes32" },
      { name: "scoresRoot", type: "bytes32" },
      { name: "algoHash", type: "bytes32" },
      { name: "signatures", type: "bytes[2]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "verifyScore",
    stateMutability: "view",
    inputs: [
      { name: "epochId", type: "uint64" },
      {
        name: "score",
        type: "tuple",
        components: [
          { name: "agentId", type: "uint256" },
          { name: "scoreBps", type: "uint16" },
          { name: "confidenceBps", type: "uint16" },
          { name: "paidReviews", type: "uint32" },
          { name: "independentClusters", type: "uint32" },
          { name: "totalPaidVolume", type: "uint256" },
        ],
      },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "hashScoreLeaf",
    stateMutability: "pure",
    inputs: [
      {
        name: "s",
        type: "tuple",
        components: [
          { name: "agentId", type: "uint256" },
          { name: "scoreBps", type: "uint16" },
          { name: "confidenceBps", type: "uint16" },
          { name: "paidReviews", type: "uint32" },
          { name: "independentClusters", type: "uint32" },
          { name: "totalPaidVolume", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "latestEpochId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "verifiers",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getEpoch",
    stateMutability: "view",
    inputs: [{ name: "epochId", type: "uint64" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "inputsRoot", type: "bytes32" },
          { name: "scoresRoot", type: "bytes32" },
          { name: "algoHash", type: "bytes32" },
          { name: "publishedAt", type: "uint64" },
        ],
      },
    ],
  },
] as const;
