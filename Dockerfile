# Dockside hosted image (M55, ADR-0027): one container that runs the control API, the worker and the
# web app behind a single HTTP port. Guide: docs/runbooks/hosted-deploy.md.
#
# What is NOT in this image: any key. The relayer's function-call key comes from the host's secret
# store at start (deploy/entrypoint.sh); the service key seeds are created on the persistent volume
# on first start. The database and the evidence objects live on that volume (/data).
#
# The base image is the official Node.js 22 image pinned by digest, the same pin as the
# reproducible contract build (scripts/lib/docker.mjs, ADR-0021).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# ---- build: the same commands as a developer machine --------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build && pnpm --filter @dockside/web run build

# Runtime tree: production dependencies only, the compiled packages, the SQL migrations, the
# isolated signer script, the web build and the static proof site (payment receipts, M54). No
# sources, no tests, no development tools.
RUN set -eu; mkdir /out; \
    cp package.json pnpm-lock.yaml pnpm-workspace.yaml /out/; \
    find packages services apps -mindepth 2 -maxdepth 2 -name package.json -exec cp --parents {} /out/ \; ; \
    for d in packages/* services/*; do cp -r "$d/dist" "/out/$d/dist"; done; \
    cd /out; pnpm install --prod --frozen-lockfile --ignore-scripts --filter "@dockside/hosted..."; cd /src; \
    find /out -name "*.tsbuildinfo" -delete; \
    cp -r packages/store/migrations /out/packages/store/migrations; \
    cp -r packages/authority/signer /out/packages/authority/signer; \
    cp -r apps/web/dist /out/apps/web/dist; \
    mkdir /out/site; cp -r site/proof /out/site/proof; \
    mkdir /out/deploy; \
    cp deploy/entrypoint.sh deploy/escrow-manifest.json /out/deploy/; chmod 0755 /out/deploy/entrypoint.sh

# ---- runtime ------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
RUN groupadd --gid 10001 dockside \
    && useradd --uid 10001 --gid dockside --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dockside \
    && mkdir /data && chown dockside:dockside /data
WORKDIR /app
COPY --from=build /out/ /app/
# PORT is the public listener (hosts that assign their own port override it). The manifest
# (deploy/escrow-manifest.json) is the artifact record of the deployed escrow
# gnanam1990-dock-escrow2.testnet; startup refuses unless the escrow's on-chain code hash equals it.
ENV NODE_ENV=production \
    PORT=8080 \
    HOSTED_DATA_DIR=/data \
    DOCKSIDE_ESCROW_MANIFEST=/app/deploy/escrow-manifest.json
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["serve"]
