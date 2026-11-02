# Agent contribution rules

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [the Git workflow](docs/GIT_WORKFLOW.md) before changing this repository. Human instructions take precedence; report conflicts instead of inventing approval.

- Inspect `git status`, the current branch and remotes first. Preserve unrelated changes. Work on a focused `codex/<topic>` branch from `develop`; never commit or push directly to `main`, `develop` or `release/*`.
- The private historical development checkout is not the public Git history. Never push it, mirror its refs, force-push or attach its old history to the public repository. Public contributions must descend from the existing public `develop`. Transfer reviewed file changes to a public-history checkout when necessary.
- One PR should solve one reviewable problem. Avoid unrelated refactors, dependency upgrades, generated bundles and formatting sweeps. Explain behavior changes, affected interfaces and migrations.
- Run checks appropriate to the change and report exact commands, results and omissions. Never claim a check passed without running it. Wait for final CI results; a queued or partially completed run is not success.
- Default checks use fixtures, disposable projects and simulated authentication. Do not call paid models, use personal credentials, modify Cloudflare resources or restart services without task authorization.
- Keep authentication, Origin, filesystem/symlink, approval and execution boundaries enforced on the server. Do not widen access or suppress security checks to make a test pass.
- Disclose AI tools, contribution scope, contributor review and remaining uncertainty in the PR. Do not invent human review, screenshots, native capabilities or test evidence.
- Complete the PR template with concrete evidence. Screenshots use synthetic data only; external code/assets require provenance and licensing. Follow SECURITY.md for private vulnerability reporting.
- An agent may prepare commits and a PR when authorized. It must not approve its own work, merge, bypass rules, publish a release or move a published tag without explicit human instruction for that action. Passing CI is not human approval.
- Maintainers must inspect changes to CI, the policy checker, AGENTS.md, CODEOWNERS, authentication and release scripts especially carefully. Automated PR checks validate structure, not correctness or the truth of self-reported review.
