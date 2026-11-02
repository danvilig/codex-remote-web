# Changelog

## 0.2.0-alpha.2

- Persist UUID-bound submission receipts before native dispatch; deduplicate HTTP/WS submissions and reconcile uncertain acceptance only by exact native client IDs, without replaying executions.
- Move the main chat queue to the gateway with versioned edits, background execution after all pages close, multi-tab synchronization and explicit resume after restart. Block every queue dispatch path behind unresolved receipts.
- Use stable SQLite transaction locks for same-host submissions, queues, schedules, attachment binding/cleanup and developer mutations. Cover simultaneous crash recovery and SIGKILL; upgrading requires stopping all older gateways sharing the Codex home.
- Invalidate approvals from earlier native connections, recover shared-session state after reconnect, and clean owned isolated process groups on exit without stopping a shared daemon.
- Add previewed project AGENTS.md creation/editing with revision conflicts and inherited-file metadata; manage only clean, unoccupied WebUI worktrees while preserving their branches.
- Add preview/revalidation cleanup for old unbound uploads and managed cache/logs, protect queued and conversation-bound attachments, and expose a read-only native MCP tool/resource inventory.
- Prepare independent clean public snapshots with full reachable-history pattern scanning, immutable candidate outputs, version-derived release notes, dependency inventory and SHA-256 manifests. Include WebKit preflight and a synthetic history performance baseline in shared release gates.
- Preserve the local skill installation draft when an earlier customization response refreshes the catalog, and wait for completed mutations in browser regressions. Cover the delayed-response race explicitly.
- Add Linux x64 and arm64 executable packages with bundled runtimes, web assets and prebuilt terminal modules, alongside dependency-installable JS deployment archives and GitHub source downloads. Gate publication on Verify and native checks of both exact package formats, including startup/files/PTY/setup/temporary access without host runtimes or compilers for executable packages.
- Scan maintained public repository history from its recorded public root, accepting GitHub checkout's HTTPS URL spelling while preserving strict single-commit/no-remote validation for independent exports.


- Keep history loading separate from execution: defer live presentation and approval cards until history finishes, reconcile the latest native turn afterwards, and prevent completed items or diff metadata from creating a spurious Working indicator.
- Show an immediate pending-send spinner and block duplicate submissions in both composers. Offer native Steering or a FIFO queue during work; retain each queued message's model, permissions and attachments, pause on failure/interruption or gateway restart, and allow cancellation or manual resume. Side chat retains its temporary memory-only queue.
- Delay history retry until 60 seconds; allow native reads up to 90 seconds and the browser 100 seconds to wait for their response. Keep native Approve for me available independently of login type in both composers; align permission menu borders and corner radii with the composer.
- Show project-relative paths and individual added/deleted line counts in edited-file summaries, aggregating repeated changes to the same file.
- Reuse an existing local Codex App Server over Unix WebSocket so Desktop and WebUI can resume and steer the same native conversation. Keep standalone stdio compatibility, expose explicit shared/isolated modes and preserve daemon lifetime when the gateway disconnects.
- Render uploaded image thumbnails in both composers and native image messages in main/Side chat, including image-only messages and clickable previews. Keep removal separate from preview and preserve restored drafts.
- Color added/deleted lines independently and remove the blue textarea focus rectangle while preserving keyboard focus on controls.

- Show live thinking, file/search/edit, command and response status with elapsed time, actual plan steps and event freshness; distinguish quiet work, waiting for input/approval, disconnection and failed/interrupted execution.
- Add animated history loading, slow-read/retry feedback, bounded read timeouts and measured incremental rendering of recent turns. Preserve drafts and cancel stale navigation results without replaying execution requests.
- Place expanded work below its Show/Hide work disclosure and keep final-answer controls independent. Include bilingual, mobile and reduced-motion coverage in workspace regression tests.

- Add local CodeMirror language highlighting and file editing, save shortcuts, same-page drafts and stale-write conflict handling. Support source-backed inline Markdown editing directly from the rendered preview, live output and full-source editing without HTML-to-Markdown conversion.
- Add authenticated same-origin document reads/writes within project browse boundaries, bounded UTF-8 validation and atomic replacement; preserve read-only/private-file and symlink restrictions.

- Fix reversible English/Chinese Explorer labels and remove centered Files layout spacing. Preview Markdown by default with a source toggle; show the tree beside the document on wide panels and a Back to files control on narrow panels.
- Add accessible mouse/touch/keyboard sidebar resizing with saved widths, plus right-panel maximize/restore without discarding the active tool or file.

- Use native ephemeral Side chat branches with bounded memory event snapshots, fixed source context, no persistent thread-list entry, page/tab cleanup and idle expiry; keep main-message Fork persistent.
- Add selected-text and `/side` entry, inline native approvals/questions and explicit persistent context import without executing/replaying messages. Disable Goal for ephemeral threads as required by the installed native server.
- Validate ephemeral protocol limitations and native context import using an isolated installed App Server, including close-during-send and uncertain-import guards.

- Replace Files cards with a lazy Explorer tree, folder collapse, keyboard navigation, context actions, paginated directories and a separate safe text preview with line numbers.
- Share main/Side chat composer controls and styling; add independent side model, reasoning, permission profiles, attachments, file references, plan mode and enabled skills without changing the main draft or choices. Native Goal remains available in persistent main chats and disabled in temporary Side chats.
- Keep side popovers within mobile/tablet bounds and isolate upload inputs and Goal dialogs between composers.

- Collapse completed work logs by default; make long final answers expandable, copy only final answer text, and fork directly at the selected native turn boundary without executing a new prompt.
- Add an independent context-preserving Side chat, native per-chat Goal controls, and enabled native skill/plugin selection (including Visualize when installed).
- Open the terminal directly from chat actions, reset both model and reasoning to server defaults, remove misleading menu focus, and keep narrow desktop split chats readable.
- Align file preview/download roots with project browsing while retaining credential and symlink restrictions; diagnose stale backend routes instead of reporting a generic file search failure.
- Publish complete scheduler lock records atomically so interrupted startup cannot leave an empty shared lock.

- Add tablet split panels and reliable right-panel toggles, themed rounded selects, verified Access email initials, notification sorting and configurable Dock visibility.
- Add bounded conversation Files browsing/search/preview/reference, project and recent-chat image galleries, and proportional storage charts.
- Separate shared/uploaded Library attachments from server folders; add guarded file uploads, native image input, tab draft recovery and a searchable composer project dropdown.
- Use consistent outline Dock/plugin and empty-chat icons; prevent composer control overlap across small desktops, tablets and phones.
- Add guarded native plugin install/uninstall/toggles and user skill install/remove/toggles. Preserve built-in and plugin skill ownership.
- Add persistent background schedules with fixed intervals, explicit execution confirmation, native approval waiting, stop/pause/history, interprocess reservations and no automatic replay after uncertain execution.
- Add isolated resource/security, scheduling, tablet and full interaction regressions; retain the existing Alpha candidate unchanged.

## 0.2.0-alpha.1 — 2026-10-31

- Fix temporary connector startup against real cloudflared: use `--output json`, select Quick Tunnel without a conflicting `--url`, validate the full command/configuration offline, and show safe failure categories.
- Add domain-free protected Quick Tunnels from the full WebUI, with one-email OTP, start/stop, process-local status, copy and locally generated QR codes.
- Share the current App Server through a private Unix socket, supervise connector lifetime including abrupt owner exit, and leave existing Cloudflare deployments unchanged.
- Reconnect temporary sessions through WebSocket without unsupported SSE fallback or automatic execution replay; preserve drafts across email reauthentication.

- Fix restoring completed Remote access installations when no in-memory progress array exists; show a management summary instead of onboarding progress.
- Save validated Cloudflare management tokens in an owner-only server credential file, restore them across management sessions/restarts, and provide replace/delete/retry controls without exposing token values.
- Extend Remote access changes to hostname/zone, existing Tunnel, service port and email in the current account, with prefilled forms, before/after previews, ownership checks and durable rollback/cleanup recovery.
- Remove first-setup token persistence messaging while retaining private credential reuse and replace/delete controls.

- Put interface language in General, complete Chinese/English settings copy and search page names and setting keywords in either language.
- Add versioned native approval, sandbox, network, memory-generation/use and custom-instruction settings; keep existing chats unchanged and explicitly select configuration permissions in the composer.
- Add searchable archived chats with project/type filters and native unarchive, including direct-route and reconnect loading.
- Report bounded, symlink-free Codex storage usage and registered Git worktrees; retain manual review before cleanup.
- Cover settings persistence, conflicts, multibyte instructions, permission inheritance, archive restoration and narrow mobile layouts with isolated regressions.

- Give side-panel tools independent closeable tabs, with keyboard navigation, shell disposal on close and session preservation when hidden.
- Match the desktop reasoning popover with a supported-level slider, model submenu and default-effort reset.
- Expose terminal connection/exit/retry states and stop repeatedly restarting exited or unavailable shells.

- Preserve tab-local conversation/project drafts across navigation and reload, and merge failed submissions with newer input.
- Freeze send targets and options, cancel execution when navigation happens during preparation, and block overlapping submissions.
- Dismiss the mobile drawer when starting a new chat and tolerate corrupted optional Review preferences.

- Contain long chat messages within the viewport while keeping code, tables and math independently scrollable; add mobile drawer swipe dismissal with vertical scrolling and background isolation.
- Make the visible top-right control toggle the right sidebar and preserve its selected view, conversation and draft.
- Show completed remote access configuration in settings without reopening setup or requesting a management token, including an authenticated read-only status view for public sessions.
- Accept authenticated top-level page navigation after Cloudflare login while retaining cross-site API, socket and mutation guards.
- Correct systemd environment file paths so protected production services load their intended port and authentication configuration.
- Annotate and recommend Tunnels matched to local connector identity; require confirmation for unconfirmed hosts and reject mixed connector locations.
- Support creating a dedicated Tunnel and a separate native connector, with guarded removal and private runtime token storage.
- Match hostname entry to Cloudflare's subdomain/domain form, including `@`, automatic suffixes and server-side Zone validation.
- Include failing API operation, required permission and safe numeric provider codes in setup errors.

- Add an integrated Cloudflare setup web wizard with the workspace theme, Chinese/English copy and mobile layout, plus an independent local setup entrypoint.
- Add scoped management API discovery, read-only previews, protected native service deployment, Tunnel/DNS provisioning, diagnostics and guarded cleanup.
- Add single-use setup credentials, local request guards, server-side management credentials, private deployment receipts and regression tests using simulated Cloudflare/systemd.
- Isolate release regression output so testing cannot overwrite an existing release candidate.

- Organize server, shared code, tests and development scripts; preserve HTTP URLs and browser preferences.
- Replace desktop-extracted brand and motion resources with original SVG/CSS resources.
- Add explicit single-identity Cloudflare Access authentication across HTTP, WebSocket and SSE, with verified JWTs and expiring transport leases.
- Add reauthentication UI, tab-local draft recovery and state reconciliation without automatic turn resubmission.
- Add native service/Tunnel templates, production packaging, dependency notices, checksums, CI and a manual prerelease artifact workflow.
- Record completed real-domain Access login and protected temporary-address connectivity; iPhone Safari, host-reboot service persistence and live revocation timing remain pending.
- Pin DOMPurify 3.4.17 and KaTeX 0.18.2, retain HTML sanitization and explicit untrusted math, and include dependency license notices.
- Allow projects explicitly configured outside HOME while denying parent, sibling and symlink escapes.
- Prepare an independent public source snapshot with a single initial commit, no inherited remote, and upstream/development provenance.
- Unify offline release verification, dependency audit, conditional real-cloudflared validation and Docker smoke tests; package from the clean snapshot commit.

## 0.1.0 — Development baseline

Independent development began from lezi-fun/codex-webui at 332b14d2600a7e14332fae7b6032b973c8e5b198. Added protocol lifecycle fixes, restricted downloads and direct-operation capability gates, workspace navigation/settings and real customization metadata. No public release was made.
