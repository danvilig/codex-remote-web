FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun-runtime
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime-base
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap git openssh-client && rm -rf /var/lib/apt/lists/*
ENV HOST=0.0.0.0 PORT=8899 CODEX_HOME=/home/node/.codex
WORKDIR /app

FROM runtime-base AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 pkg-config && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile && npm_config_nodedir=/usr/local npm rebuild node-pty
COPY scripts/build.ts scripts/setup.ts scripts/
COPY src/ src/
COPY public/ public/
RUN bun run build && bun install --production --frozen-lockfile

FROM runtime-base AS production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public/app.bundle.js ./public/app.bundle.js
COPY --from=build --chown=node:node /app/public/setup.bundle.js ./public/setup.bundle.js
COPY --chown=node:node package.json bun.lock LICENSE THIRD_PARTY_NOTICES.md README.md ./
COPY --chown=node:node public/index.html public/style.css public/workspace.css public/favicon.svg public/auth-bootstrap.js public/access-session.js public/i18n.js public/codex-brand.js public/setup.html public/remote-access.css ./public/
RUN bun -e 'const p = await Bun.file("package.json").json(); p.scripts = {start:"bun run dist/server.js", "start:production":"bun run dist/server.js", "setup:cloudflare":"bun run dist/setup.js"}; await Bun.write("package.json", JSON.stringify(p, null, 2))'
USER node
EXPOSE 8899
CMD ["bun", "run", "dist/server.js"]
