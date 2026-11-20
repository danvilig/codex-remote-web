FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS frontend
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY scripts/build.ts scripts/native-gateway.ts scripts/
COPY src/ src/
COPY public/ public/
RUN bun scripts/build.ts --frontend-only && \
    mkdir -p /bundle/public && \
    cp public/index.html public/app.bundle.js public/setup.html public/setup.bundle.js public/style.css public/workspace.css public/remote-access.css public/favicon.svg public/auth-bootstrap.js public/access-session.js public/i18n.js public/codex-brand.js /bundle/public/ && \
    bun -e 'import { stageBrowserVendor, stageDependencyNotices } from "./scripts/native-gateway.ts"; await stageBrowserVendor("/src", "/bundle"); await stageDependencyNotices("/src", "/bundle"); const {version} = await Bun.file("package.json").json(); if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Invalid gateway version"); await Bun.write("/version", version);' && \
    chmod -R a+rX /bundle

FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS gateway
ENV GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src/native-gateway
COPY native-gateway/go.mod native-gateway/go.sum ./
RUN go mod download
COPY native-gateway/ ./
COPY --from=frontend /version /version
RUN version="$(cat /version)" && \
    go build -mod=readonly -buildvcs=false -trimpath -ldflags "-s -w -X main.version=$version" -o /bundle/codex-remote-web . && \
    cp -r licenses /bundle/native-licenses && \
    cp /usr/local/go/LICENSE /bundle/native-licenses/GO-LICENSE && \
    cp /usr/local/go/PATENTS /bundle/native-licenses/GO-PATENTS && \
    chmod -R a+rX /bundle

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap git openssh-client && rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 1000 node && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/node --shell /bin/bash node
ENV HOST=0.0.0.0 PORT=8899 CODEX_HOME=/home/node/.codex CODEX_WEBUI_APP_SERVER_MODE=isolated
WORKDIR /app
COPY --from=frontend /bundle/ ./
COPY --from=gateway /bundle/ ./
COPY LICENSE THIRD_PARTY_NOTICES.md README.md ./
RUN chmod a+r LICENSE THIRD_PARTY_NOTICES.md README.md
USER node
EXPOSE 8899
CMD ["/app/codex-remote-web"]
