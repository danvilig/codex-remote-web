# Native gateway

The desktop installers, portable archives, Linux deployment archives, and Docker runtime ship the Go gateway. The installed gateway requires neither Bun nor Node. Running Codex sessions still requires the Codex CLI; Git supports workspace and review operations, and `cloudflared` is needed for remote access.

The Go gateway serves the existing browser UI. The desktop app manages background startup, fixed-domain Cloudflare Access, temporary access and cleanup. On Linux, the standalone setup wizard can manage a user systemd installation. On macOS and Windows, use the desktop app for fixed-domain setup.

Use the Go version pinned in `go.mod` to run the module tests or build a stripped binary:

```sh
go test -mod=readonly -race ./...
go vet -mod=readonly ./...
CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags='-s -w' -o ../.artifacts/native-gateway .
```

The tests use disposable directories and simulated Codex and Cloudflare responses. **Native platform packages** builds on macOS 15 and validates the exact same DMG on macOS 27. The installed package checks cover the native runtime, real PTY, Finder layout, visible desktop UI, background lifecycle and cleanup. Download quarantine and manual Gatekeeper approval are separate from CI's ad hoc signature verification.
