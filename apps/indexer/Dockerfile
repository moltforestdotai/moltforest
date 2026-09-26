# Envio ships only Linux/macOS binaries, so the indexer always runs in this image.
FROM node:22-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Envio's native HTTP client verifies TLS against the system CA store, which the
# slim image lacks (Node's fetch works regardless because it bundles its own CAs).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi

COPY . .
RUN pnpm codegen

EXPOSE 9898
CMD ["pnpm", "start"]
