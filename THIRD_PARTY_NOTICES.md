# Third-party notices

MoltForest's own code in this repository is licensed under the MIT License (see [LICENSE](LICENSE)). It uses third-party software that keeps its own license.

## Envio HyperIndex

The indexer in `apps/indexer` is built with [Envio HyperIndex](https://envio.dev) (npm package `envio`). Credit to HyperIndex by Envio.

HyperIndex is not open-source software. The HyperIndex CLI, and the code it generates for this indexer, are licensed by Envio under its own terms: see the `licenses/` folder of the `envio` package. The generated code (`apps/indexer/generated/`) is not part of this repository; `pnpm codegen` recreates it. The MIT License above does not cover HyperIndex or its generated code.

## Other dependencies

npm packages and the Solidity libraries (OpenZeppelin Contracts, forge-std) are installed from their registries and keep their own licenses. None of them is copied into this repository.
