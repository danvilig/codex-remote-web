# Native macOS gateway

The macOS DMG can bundle the Go gateway with the existing AppKit and WebKit desktop shell. The installed gateway uses neither Bun nor Node. Build tools are needed only to assemble the package. Running Codex sessions still requires the Codex CLI; Git supports workspace and review operations, and `cloudflared` is needed for remote access.

The Go gateway serves the existing browser UI. The desktop app manages background startup, fixed-domain Cloudflare Access, temporary access and cleanup. Local browser and standalone setup sessions use loopback and never accept Cloudflare management tokens on macOS; use the desktop app for fixed-domain setup. Linux and Windows packages retain the existing gateway.

Use the Go version pinned in `go.mod` to run the module tests or build a stripped binary:

```sh
go test -mod=readonly -race ./...
go vet -mod=readonly ./...
CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags='-s -w' -o ../.artifacts/native-gateway .
```

The tests use disposable directories and simulated Codex and Cloudflare responses. Select **native_gateway** when manually running **Native platform packages** to build on macOS 15 and validate the exact same DMG on macOS 27. The installed package checks cover the native runtime, real PTY, Finder layout, visible desktop UI, background lifecycle and cleanup. Download quarantine and manual Gatekeeper approval are separate from CI's ad hoc signature verification.
