# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse Code, fx) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks (our MIT license covers source code only, not T3 Code's trademarks or branding; see [TRADEMARK.md](TRADEMARK.md)). We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (`t3`) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## Terminology

- **you** = the agent reading this file. **we / us / maintainers** = Theo, Julius, and the people building T3 Code. **user** = person driving coding agents in T3 Code. **agent** = coding agent running inside T3 Code.
- Domain terms (environment, project, thread, turn, provider, checkpoint, etc.): [00_glossary.md](docs/internals/00_glossary.md).

## The four ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading or copying from it is fine. Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.
4. **Hijacking Tailscale Serve.** An agent shell can inherit `T3CODE_TAILSCALE_SERVE=true` from the background service it runs under, so any server you start there repoints the machine's Serve mapping on port 443 at your throwaway port, and the user's saved environment then fails with an environment ID mismatch. Start every dev or sandbox server with `T3CODE_TAILSCALE_SERVE=false` (`T3CODE_TAILSCALE_SERVE=false vp run dev`, `T3CODE_TAILSCALE_SERVE=false node apps/server/src/bin.ts serve …`), never pass `--tailscale-serve` yourself, and check `tailscale serve status` after stopping it. If 443 no longer points at the real server, restore it with `tailscale serve --bg --https=443 http://127.0.0.1:3773` and tell the user.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** Chat view, Settings, command palette, and keybindings. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (Electron shell/IPC), and mobile (React Native). Shared logic lives in `packages/client-runtime`.
- **Providers.** Every provider adapter needs a decision, even if the decision is "not supported here".
- **Agents.** Capabilities a user triggers should be service methods reachable by MCP tools and scheduled tasks, not inline handler code.
- **Contracts.** Wire changes go in `packages/contracts` so server, web, mobile, and desktop follow.
- **Reverse states.** Every way in needs a way out and a way to see it (snooze/unsnooze, close/reopen). A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel; multi-device and multi-environment.
- **Languages.** Translate user-facing copy in `apps/{web,mobile}/src/i18n/translations` (`vp run i18n:generate` / `vp run i18n:check`) and `apps/marketing/src/i18n`. See [14_i18n.md](docs/internals/14_i18n.md).
- **Docs.** Check whether the change makes existing guidance inaccurate. Follow [Documentation](#documentation).

## Dev servers and test data

See [00_development.md](docs/operations/00_development.md) for setup, ports, seeding (`vp run migrate-dev-db`), and [reusable dev auth](docs/operations/00_development.md#reusable-dev-credential). Agent-specific rules:

- **Worktree setup:** Wait while `.t3/setup-running` names a live PID; do not run `vp i` concurrently. If no `.t3/setup-*` marker exists, run `vp i` yourself.
- **Process lifecycle:** Start dev servers, Metro, and builds from your own shell so they exit with your session—never detach with `systemd-run`, `nohup`, `setsid`, or `tmux` unless asked. Stop background tasks with your harness's own stop (`vp` does not forward SIGTERM to child Vite/server processes).
- **Sharing (`vp run dev --share`):** Wait for `pairingUrl:` and hand the full URL to the user. Never wire `tailscale serve` by hand, open the URL yourself, or consume the user's one-time pairing link. Mint another with `node apps/server/src/bin.ts pair` if needed.
- **Test data:** Always copy in (never symlink) and refresh `statev2.sqlite`, not `state.sqlite`. Bring `secrets` / `settings.json` only if the flow under test needs them.
- **Extra checkouts:** Put `git worktree add` next to this worktree, not in `/tmp`, and remove it when done.

## Verifying

- Before you push, run `vp run check:changed`. **Do not run repo-wide checks** (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless asked—CI owns the full suite.
- Iterate with `vp test run <files>` (add `-t "<name>"` for large files) and `vp run typecheck` (`effect-tsgo tsrs --noEmit`). Run `node -e` snippets from the owning package (`effect` does not resolve from repo root).
- Follow [15_testing.md](docs/internals/15_testing.md) for what to test, bug-fix proof, draining async work (no sleeps/polling), web browser tests (`await using screen = await render(...)`), and real-app [Scenarios](docs/internals/15_testing.md#scenarios) (`vp run scenarios:prove`).
- Give user-visible frontend changes one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile (primary agent only; subagents do not launch dev servers). Inspect the rendered result and walk the flow as a user using the feature—checking layout, visual hierarchy, and ergonomics—and fix anything rough until you are satisfied before handing back. Use the free `Replay (dev)` provider unless the change depends on a real provider (then pick its cheapest model, e.g. Haiku or Luna). On mobile, run `vp run mobile:install <ios|android> [device-id]` before Metro rather than rebuilding from scratch.

## Evals

`evals/` checks how real models behave with T3 Code's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before changing that text, read [evals/README.md](evals/README.md) and run the evals it names. When fixing a model behavior bug, add a case that fails before the fix.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- `origin` is not always GitHub. Check `git remote get-url origin` before your first forge command and use that forge's CLI and skill. See [Forge mirror](docs/operations/00_development.md#forge-mirror-optional).
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images; motion or timing needs a short video. Upload PR evidence to GitHub—never commit PR-only screenshots or assets.
- One request is one PR. Split only when asked. Outside contributions follow [CONTRIBUTING.md](CONTRIBUTING.md#one-problem).
- When babysitting: call `watch_pull_request` and end your turn. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new; stop when bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields, methods, constants, timeouts, or migration numbers, narrate control flow, maintain file catalogs, or append PR summaries. Anything that can drift will drift; types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks in the shipped product's voice, without implementation details or contributor tooling. Focus on what a feature does, how to start, and anything unintuitive—not descriptions of buttons, layouts, or UI tweaks.
- `docs/operations/` holds maintainer setup, release, and debugging runbooks. Keep end-user server instructions in `docs/user/`.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files (keep temporary material outside the worktree).
- Track active maintainer work in its GitHub issue or project item; external proposals belong in Ideas discussions. A merged PR is the implementation record.

## Where code lives

- `apps/server` - WebSocket, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), providers, checkpointing. Read [02_effect-services.md](docs/internals/02_effect-services.md) and `.repos/effect/LLMS.md`.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it; `apps/mobile` is React Native; `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema wire contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client connection and domain state shared by web and mobile.
- `.repos/` - vendored read-only references. Never edit or import from them (`vpr sync:repos` updates them; if sparse-checked-out, read via `git show origin/main:.repos/<path>`).

### Internal docs by area

Read the matching doc before changing code in that area; code review enforces them.

| Area                                       | Read first                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture & orchestration               | [00_glossary.md](docs/internals/00_glossary.md), [01_architecture.md](docs/internals/01_architecture.md)                                                                                          |
| Server Effect services & errors            | [02_effect-services.md](docs/internals/02_effect-services.md)                                                                                                                                     |
| Providers & ACP                            | [03_providers.md](docs/internals/03_providers.md)                                                                                                                                                 |
| Auth, MCP, guest links, assets, security   | [04_environment-auth.md](docs/internals/04_environment-auth.md), [SECURITY.md](SECURITY.md)                                                                                                       |
| Remote routes, peer links, previews        | [05_remote.md](docs/internals/05_remote.md)                                                                                                                                                       |
| T3 Connect & relay                         | [06_t3-connect.md](docs/internals/06_t3-connect.md)                                                                                                                                               |
| Server updates & crash recovery            | [07_server-updates.md](docs/internals/07_server-updates.md)                                                                                                                                       |
| Telemetry & analytics                      | [08_product-analytics.md](docs/internals/08_product-analytics.md)                                                                                                                                 |
| Client connection & sync runtime           | [09_connection-runtime.md](docs/internals/09_connection-runtime.md)                                                                                                                               |
| Web UI primitives, styles & React Compiler | [10_web-ui.md](docs/internals/10_web-ui.md)                                                                                                                                                       |
| Mobile layout, navigation & dev lifecycle  | [11_mobile-layout.md](docs/internals/11_mobile-layout.md), [12_mobile-navigation.md](docs/internals/12_mobile-navigation.md), [13_mobile-development.md](docs/internals/13_mobile-development.md) |
| Translations & UI copy                     | [14_i18n.md](docs/internals/14_i18n.md)                                                                                                                                                           |
| Writing & reviewing tests                  | [15_testing.md](docs/internals/15_testing.md)                                                                                                                                                     |
| Wire budgets, server metrics & perf        | [16_performance-regressions.md](docs/internals/16_performance-regressions.md)                                                                                                                     |
| Repo & package scripts                     | [17_scripts.md](docs/internals/17_scripts.md)                                                                                                                                                     |

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`, declare protected methods in `CLIENT_GUARDED_RPC_SCOPES`, and gate UI with `permissionAtom` (server stays authoritative). Keep raw RPC clients inside `rpc/`.
- Server features are Effect services using `Effect.fn("Service.operation")` with thin transport handlers; see [02_effect-services.md](docs/internals/02_effect-services.md).
- `apps/web/src/components/ui` exports own their look (`shadcn/no-restyle` enforces this); see [10_web-ui.md](docs/internals/10_web-ui.md).
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, external quirk, or invariant the code can't show (1–4 lines max; `t3code/no-low-value-comments` enforces this).
- React effects are only for synchronizing with external systems. Derive in render and act in handlers; any remaining effect states its reason via `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- Security matters, but do not over-index on dev-mode or maintainer-only features. Read [SECURITY.md](SECURITY.md) before auditing or triaging reports.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## p2code: the owner's build

This checkout carries `p2code/custom` on the public GitHub fork `psv2522/t3code` of `pingdotgg/t3code`. The owner builds it themselves and runs it as their own T3 Code: custom server as the background service plus a custom desktop app. Changes made here are for the owner's own use.

### Branches and remotes

- `origin` is `git@github.com:pingdotgg/t3code.git`; `fork` is `git@github.com:psv2522/t3code.git`.
- Local `main` only mirrors `origin/main` (fast-forward only). Never commit to it.
- Branches for upstream PRs start from `main`, are pushed to `fork`, and never contain `p2code/custom` commits.
- All custom work lives on `p2code/custom`, always rebased onto `main`. It is pushed with `--force-with-lease`.
- Carried on top of upstream: lazy provider drivers and the p2code scripts. Drop a carried commit once upstream ships the equivalent.
- Dependency bumps live in one `build(deps): bump carried dependencies` commit at the top of the stack. Fold new bumps into it (`git commit --fixup` plus `git rebase -i --autosquash main`) instead of adding commits, so a sync hits at most one lockfile conflict. Majors are carried too; in its conflicts keep the higher version of each package.
- After the rebase, `scripts/p2code-deps-guard.py <pre-rebase> HEAD` compares lockfiles. A version the branch carried above upstream that the rebase lowered, or a second copy of any `prosemirror-*` package (two copies break the composer), stops the update, resets the branch to its pre-rebase head, and goes to the conflict thread like a conflict. Pin a duplicated package with an override in `pnpm-workspace.yaml`.
- GitHub Actions are disabled on the fork. Do not re-enable them.
- Keep custom changes small and local so rebasing stays cheap. The sync enables `rerere` and continues past a stop only when recorded resolutions cover every conflict or `pnpm-lock.yaml` is the only one, which it regenerates from upstream's copy; it prints each auto-resolution. Any other conflict aborts the sync and lists the files. Resolve by hand with `cd ~/Personal/Coding/t3code && git rebase main`; rerere records that resolution for the next sync.

### Commands

`p2code` is a zsh function in `~/.zshrc` that wraps the scripts. Open a new shell or `source ~/.zshrc` to pick it up.

- `p2code update`: sync, rebase, check, push, build, install. Installs without a confirmation prompt, since the sidebar flow cannot answer one. Flags: `--sync-only`, `--no-install`, `--no-push`, `--force`, `-v/--verbose`.
- `p2code build` / `p2code install [--yes]` / `p2code rollback [--yes]` / `p2code setup-signing` / `p2code prune [--dry-run]` / `p2code version` / `p2code cd` / `p2code help`.
- Output is one line per step. Full output goes to `~/.p2code/{sync,build,install,rollback}.log`; failures print the log tail and path. `-v` or `P2CODE_VERBOSE=1` shows everything.

Files:

- `scripts/p2code.sh` (build, install, rollback), `scripts/p2code-update.sh` (the sync driver) and `scripts/p2code-lib.sh` (step/log helpers) are tracked on `p2code/custom`.

### What `p2code update` does

1. Requires a clean tree and the `p2code/custom` and `main` branches. Adds the `origin` remote if missing.
2. Fetches upstream, fast-forwards `main`, rebases `p2code/custom` onto it. Warns if files under `apps/server/src/persistence/Migrations` changed since the installed build.
3. Runs the dependency guard, `vp i`, the `lazyDriver` test, carried tests and the workspace typecheck (cached per package). A failure in any of these hands off to a fix thread (see Failed steps below).
4. Pushes `main` and `p2code/custom` (skipped with `--no-push`).
5. Stops if `HEAD` equals `~/.p2code/installed-head` (override with `--force`).
6. Builds, then installs. Inside T3 Code it builds only and tells the owner to run `p2code install`.

### Check for updates

The web/desktop sidebar update button, Settings → About "Check for Updates", the native "Check for Updates…" menu item and the mobile environment settings "T3 Code" section all call the server RPC `server.p2codeUpdate` (`apps/server/src/p2code/P2codeUpdate.ts`, client side `packages/client-runtime/src/p2codeUpdate.ts`). The server advertises `capabilities.p2codeUpdate` on macOS when `~/.p2code/repo` names a checkout with `scripts/p2code-update.sh`; every `p2code build` writes it. Without the capability the stock upstream update flow shows. The RPC needs the environment maintain scope and runs the script on the server's machine, so a phone updates the Mac's server.

- `check` runs `scripts/p2code-update.sh --check`: fetches `origin/main` and prints JSON (`upstreamCommits`, `localChanges`, `dirty`). `localChanges` means `p2code/custom` differs from `~/.p2code/installed-head`. The check changes nothing but remote-tracking refs.
- Nothing pending: an "up to date" notice. Uncommitted changes in the repo: a notice asking to commit first.
- Something pending: a confirm dialog, then `start` runs `p2code-update.sh --launch`. That submits `--detached` to launchd as `com.p2code.update` (log `~/.p2code/update.log`), outside the server's process tree, so it survives the install restart. No Terminal window opens. It syncs, builds and installs, and the clients poll `status` every 2s, tolerating the gap while the server restarts.
- The install always quits the desktop app and reopens it only for `--launch --relaunch`. Only the desktop app (sidebar button, Settings → About, native menu item) sends `relaunchApp`; mobile, a plain browser and the CLI leave the app closed.
- Progress lives in `~/.p2code/run/update-status.json` (`phase`: idle, syncing, building, installing, conflict, done, failed; plus `message`, `threadId`, `version`). `--status` marks a running phase as failed when the lock pid is dead and the file is stale, and a `conflict` phase as failed once its thread is no longer active, no job is alive and the file is two minutes old. Clients treat `conflict` as running (`isP2codeUpdateRunning`): they keep polling through the fix thread and the resumed job, a second click attaches to the update instead of starting one, and a foreground `p2code update` is refused while the thread runs.
- Rebase conflicts: the update (the detached job, and a foreground `p2code update` in a terminal) aborts the rebase and starts exactly one thread with `t3 thread start` on `claudeAgent` / `claude-sonnet-5-5` (its default effort is high), recording its id in `~/.p2code/run/conflict-thread`. A new `--launch` is refused, and a job that conflicts again reuses the thread, while that thread is `running`. The thread resolves the conflicts, finishes the rebase, then carries the update as the failed-step thread below does (checks, build, `scripts/p2code-update.sh --launch --resume`, plus `--relaunch` when the update had it) and settles itself. A rebase failure without conflicts ends `failed` without a thread.
- Failed steps: the steps after the rebase (`vp i`, the `lazyDriver` test, carried tests, the workspace typecheck, the clean-tree check, push, build and install) all run through `handoff_failure` in `scripts/p2code-update.sh`. When one fails, the job keeps the rebased branch and starts one thread the same way (title "p2code update: fix failed step", same `conflict-thread` file and phase `conflict`) with the step's `error TS` lines or log tail. The thread owns the update end to end, so there is only ever one: it fixes the cause as fixups of the owning commits, reruns `vp i`, the `lazyDriver` test, carried tests, the typecheck and the dependency guard, runs `scripts/p2code.sh build` itself, then runs `--launch --resume` and settles. The resume job reuses a build whose `source-head` equals `HEAD` (not with `--force`), so it only pushes and installs. It skips the upstream fetch and fast-forward, so commits that land after the thread's rebase cannot conflict it and wait for the next update; the thread must not rebase onto a newer `main` after building. The thread checks `--status` for `failed` before it settles. A `--resume` job that still fails ends `failed` without a new thread, and every detached `failed` ending posts a macOS notification. Steps before the rebase (fetch, fast-forward) end `failed` without a thread.
- `p2code-update.sh` keeps a pid lock (`~/.p2code/update.lock`), so a second click cannot start a parallel update.
- The electron-updater flow stays disabled in this build.

### Build

- Version is `<core>-nightly.99<YYMMDD>.<seconds-of-day>`, for example `0.1.1-nightly.99261017.41007`. `<core>` is the base of the newest upstream `v*-nightly.*` tag (fallback `0.1.1`). The `99` prefix sorts above every upstream nightly (`2026xxxx`), so official clients never warn about a server mismatch. The identifier must not have a leading zero (`isExactServiceVersion` rejects it). Keep it a nightly so the app keeps the Nightly name and icon; the installed app is `/Applications/T3 Code (Nightly).app`.
- Output lands in `~/.p2code/builds/<version>/{cli,app,release,resource-monitor,source-head}`; `~/.p2code/current` names the latest build. The desktop app is packed as an unpacked `.app` (electron-builder `dir` target) and moved into `app/`, so there is no zip round trip.
- Package versions are aligned with `scripts/update-release-package-versions.ts` and restored afterwards.
- The server single-executable needs the Node version in `engines.node` of the root `package.json`. The script strips fnm's node from `PATH` because it shadows `VP_NODE_VERSION`. The executable runs with `--optimize-for-size` (about 16 MB less footprint) and is built without a V8 code cache: `--build-sea` generates the cache without the execArgv flags, so V8 would reject it at every start. That costs about 300 ms per `t3` launch. The script then runs `strip -x` on the executable before the archive step re-signs it.
- The server executable is built on a pointer-compressed Node when `~/.p2code/node-pc-system-icu/v<engines.node>/node` exists; `p2code build-node` compiles it (about an hour). It dynamically links Homebrew ICU, which must remain installed at the linked version; rebuild Node after an incompatible ICU upgrade. The build checks ICU date formatting and grapheme segmentation before packaging. Pointer compression roughly halves the JS heap and caps it at 4 GB. It is safe only because every runtime native addon (node-pty, keyring, ffi-rs, Cursor's tree-sitter) uses N-API; a non-N-API addon would crash. `--build-sea` embeds the Node that runs it, so the build puts a `vp` shim on `PATH` that runs vite-plus on that Node. Without the binary the build says so and uses stock Node. Rerun `p2code build-node` after upstream bumps `engines.node`.
- Provider drivers other than Claude load their modules on first use (`lazyProviderDriver` in `packages/provider-core/src/server/lazyDriver.ts`). `apps/server/src/provider/builtInDrivers.ts` repeats each driver's kind, metadata, config schema and usage reader, so a new or changed upstream driver must be mirrored there. A disabled instance never loads its module and shows a generic disabled snapshot without models; its adapter loads the real driver on first call. Keep the Codex protocol and ACP packages off the startup import graph: the Codex client factory lives in `CodexAppServerClientFactory.ts`, and `AntigravityInstallation.ts` imports its ACP helpers dynamically.
- The service launcher also copy-truncates `userdata/logs/boot-service.log` (the service's stdout and stderr) to `boot-service.log.1` once it passes 16 MB, at each child start and every 10 minutes.
- The desktop app is packed client-only (`T3CODE_DESKTOP_CLIENT_ONLY=true`): the asar carries the web client but not the server bundle or the server-only externals (Cursor SDK, fff, zod, undici). `localEnvironmentEnabled` defaults to false in `apps/desktop/src/settings/DesktopAppSettings.ts`, so the app connects to the background service instead of spawning its own backend, and the Settings toggle (`LocalEnvironmentSetting`) and its search entry are removed. `DesktopAppSettings` ignores a persisted `true` (and `setLocalEnvironmentEnabled(true)`) when the packaged app has no `apps/server/dist/bin.mjs`, so a settings file carried over from stock T3 Code cannot make the app try to spawn a missing server. The user docs under `docs/user` still describe the upstream toggle.
- The desktop build deletes Electron's `libvk_swiftshader.dylib` before signing. Apple silicon always has Metal, so the software Vulkan fallback is dead weight.
- Rust is not installed. The `t3-resource-monitor` binary is copied from the active installed runtime (`T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true`).
- The desktop app is built without a publish config (`GITHUB_REPOSITORY` and `T3CODE_DESKTOP_UPDATE_REPOSITORY` unset), so there is no `app-update.yml` and it never auto-updates to an official build. The build fails if one appears.
- The app is signed with a self-signed certificate (`P2CODE_SIGN_IDENTITY`, default `p2code Local Signing`), created once by `p2code setup-signing` in the login keychain. Ad hoc signing makes the designated requirement a `cdhash` that changes every build, so macOS rejects the app's `T3 Code (Nightly) Safe Storage` key, the desktop cannot decrypt `connection-catalog.json`, and T3 Connect needs a new sign-in after every update. A certificate leaf keeps the requirement stable. The build fails when the identity is missing; `P2CODE_SIGN_IDENTITY=-` signs ad hoc. Switching identity once costs one keychain prompt (Always Allow) and one sign-in; if the desktop shows no environment afterwards, move `~/.t3/userdata/connection-catalog.json` aside and sign in again. Passkeys stay unavailable.
- The repo-root `.env` (gitignored, copied from `.env.example`) bakes the T3 Connect values (`relay.t3.codes`, production Clerk) into the build. The build refuses to run without it, and checks the relay URL is present in the bundles.

### Android APK builds

For the owner's Android APK, build the committed `p2code/custom` branch, not an upstream tag. Use the standalone builder and keep its signing state between runs. It builds in this checkout, which must be clean with `p2code/custom` checked out, so commit first:

```sh
python3 scripts/build-android-apk.py \
  --source "$PWD" --ref p2code/custom \
  --sdk /opt/homebrew/share/android-commandlinetools \
  --java-home /opt/homebrew/opt/openjdk@21 \
  --confirm-arm64 'realme P3 Ultra 5G; Dimensity 8350 ARM64'
```

Build for arm64 only: pass `-PreactNativeArchitectures=arm64-v8a` to Gradle. The builder uses cached PDFium from `~/.cache/t3-android/pdfium` when present; see the Android APK guide. Run the build detached with `nohup` so a T3 server restart does not kill it.

Leave `--output` unset. After validation the builder sends the APK to the owner's realme phone through Taildrop and deletes it on success. If the transfer fails, it keeps one APK at the printed path for retry:

```sh
tailscale file cp "<APK path>" prathmesh-android: && rm -f -- "<APK path>"
```

Confirm the phone's current destination with `tailscale file cp --targets` if needed. Report transfer failures and keep the cached APK for retry; delete it after a successful retry. Do not copy or move build artifacts into the Mac's Downloads folder.

The realme P3 Ultra 5G supports ARM64. This method was verified on this 16 GiB Mac with two Gradle workers, a 3 GiB heap, in-process Kotlin, and Java 17 toolchains provisioned by Gradle. Preserve upstream minification, resource shrinking, the uncompressed Hermes bundle, compressed native libraries, disabled over-the-air updates, and the persistent signing identity under `~/.cache/t3-android/signing`. Do not substitute the former 8 GiB heap workaround or run Gradle clean routinely. Follow [Local Nightly Android APK](docs/operations/android-apk.md) for cache preservation, fresh Metro temp directories, revision selection, and validation. Send only the APK through Taildrop. Keep receipts under `~/.cache/t3-android/receipts`; disable v4 signing so no `.idsig` sidecar is generated. Phone installation and launch remain unverified until actually tested; never uninstall an app or erase data automatically.

### Install and rollback

- Install confirms, then backs up to `~/.p2code/backups/<timestamp>` (mode 700): `userdata/*.sqlite` via `sqlite3 .backup` (not `server-owner.sqlite`, the live server's lock), JSON files, `service-state.json`, the launchd plist, the `~/.local/bin/t3` symlink, the previous version, and the app as a tgz.
- It quits the app, serves the release directory on a loopback port, touches `~/.t3/runtime/desktop-update-restart` (so the old server keeps its tunnel), and runs `t3 update <version> --yes` with `T3CODE_RELEASE_BASE_URL` pointing at that port. That is the supported path and switches the launchd service `com.t3tools.t3code.service`, which runs `~/.t3/runtime/versions/<ver>/t3 __service-launcher` and spawns `t3 serve`. The launcher sets `MallocSpaceEfficient=1` only on the `t3 serve` it spawns, and `bin.ts` drops it at startup so the server's children (git, compilers, agents) run without the allocator mode's wall-time cost. Then it repoints `~/.local/bin/t3`, waits for the new server, replaces the app in `/Applications` with `ditto`, and leaves it closed.
- Install runs `p2code prune` twice: right after the backup and again after a successful install. It keeps the newest build, backup and downloaded server version, and always keeps the active version, the latest build, the latest backup's previous version (the rollback target), and any version a running process still uses. So a finished install leaves one build, one backup, and two server versions: the active one and the one rollback returns to. Run `p2code prune --dry-run` to see what it would delete.
- Rollback switches the server back with `t3 update <previous> --allow-downgrade --yes` and restores the app from the backup tgz. It does not restore databases; copy them from the backup with the server stopped if a migration ran.

### Rules for agents

- Never run `p2code install`, `p2code rollback`, `p2code update` (without `--no-install`), or `t3 update`/service restarts from inside T3 Code. Agent sessions run under the background server that those commands restart and the desktop app they quit. `scripts/p2code.sh in-t3` detects this. Build with `p2code update --no-install` and tell the owner to run `p2code install` in a plain terminal. The one exception is `scripts/p2code-update.sh --launch`, which hands the whole update to launchd outside T3's process tree; the conflict thread runs it as `--launch --resume`, and nothing else should.
- When the owner asks you to update, run `scripts/p2code-update.sh --launch` (add `--relaunch` to reopen the desktop app). It includes the install, so do not stop at a build. Check on it with `scripts/p2code-update.sh --status`.
- Never use `sudo`; the scripts refuse to run as root. A root run creates a second T3 installation and root-owned files.
- Commit before building. The build refuses a dirty tree. Do not run a build while rebasing or switching branches; the build reads the working tree.
- Do not edit `scripts/p2code*.sh` while a run is in flight. Bash reads scripts incrementally and a mid-run change causes bogus syntax errors. Keep `main "$@"; exit $?` at the end of `p2code.sh` and the outer brace group with `exit 0` in `p2code-update.sh`.
- Do not add database migrations or change relay contracts (`packages/contracts` relay surface, `infra/relay`) unless the owner asks. Migrations collide with upstream numbering, and the relay is T3's own service.
- Use `pnpm` and `vp`, not `npm`. Tooling matches upstream: vite-plus comes from upstream's catalog (do not bump it here) and pnpm from `packageManager`. The owner's shell sets `pnpm_config_pm_on_fail=ignore`, which runs the global pnpm 12; `scripts/p2code-lib.sh` exports `download` instead. Set the same before `vp i` or regenerating `pnpm-lock.yaml` by hand. Node stays ours: the pointer-compressed build.
- "Browser" means T3 Code's in-app browser (the `mcp__t3-code__preview_*` tools), not Chrome. Use Chrome only when the owner names it. Before giving up on a Chrome task because the extension looks disconnected, check whether Chrome is running (`pgrep -x "Google Chrome"`). If it is not, open it (`open -a "Google Chrome"`), wait a moment, and retry before stopping.
- To inspect T3's state, use the `t3` CLI first (for example `t3 auth session list`), before reading its SQLite or data files under `~/.t3`.
- Match the owner's commit style (Conventional Commits). Prefer no code comments unless a future editor would be misled without one.
