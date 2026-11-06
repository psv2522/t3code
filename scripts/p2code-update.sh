#!/usr/bin/env bash
set -euo pipefail

{

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ROOT="${P2CODE_OUT:-$HOME/.p2code}"
UPSTREAM_URL="git@github.com:pingdotgg/t3code.git"
UPSTREAM_REMOTE="origin"
PUSH_REMOTE="fork"
WORK_BRANCH="p2code/custom"
STATE_FILE="$OUT_ROOT/installed-head"
BUILD_SCRIPT="$REPO/scripts/p2code.sh"
LOCK_FILE="$OUT_ROOT/update.lock"
JOB_LABEL="com.p2code.update"
JOB_LOG="$OUT_ROOT/update.log"
CONFLICT_PROVIDER="claudeAgent"
CONFLICT_MODEL="claude-sonnet-5-5"
CONFLICT_THREAD_FILE="$OUT_ROOT/run/conflict-thread"

source "$REPO/scripts/p2code-lib.sh"

usage() {
  cat <<EOF
Usage: p2code update [options]

Sync the fork with pingdotgg/t3code main, rebase local changes, push, then build and install.

  --launch       Start the whole update as a background job that survives the server and app
                 restarting; progress is readable with --status
  --relaunch     With --launch: reopen the desktop app after the install (it is closed otherwise)
  --status       Print the background update's state as JSON
  --sync-only    Sync, rebase, push and check; do not build or install
  --no-install   Sync, push, check and build; do not install
  --no-push      Do not push main and $WORK_BRANCH to $PUSH_REMOTE
  --force        Rebuild even when nothing changed since the last install
  --check        Fetch upstream and print JSON saying whether an update is pending; changes nothing
  -v, --verbose  Show full command output instead of one line per step
  -h, --help     Show this help

Inside T3 Code the install step is skipped automatically; finish with: p2code install
Use --launch to update from inside T3 Code.
EOF
}

SYNC_ONLY=0
NO_INSTALL=0
PUSH=1
FORCE=0
CHECK=0
LAUNCH=0
STATUS=0
DETACHED=0
RELAUNCH=0
RESUME=0
for arg in "$@"; do
  case "$arg" in
    --sync-only) SYNC_ONLY=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --no-push) PUSH=0 ;;
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    --launch) LAUNCH=1 ;;
    --status) STATUS=1 ;;
    --detached) DETACHED=1 ;;
    --relaunch) RELAUNCH=1 ;;
    --resume) RESUME=1 ;;
    --verbose|-v) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $arg" ;;
  esac
done

[[ "$EUID" -ne 0 ]] || die "Do not run this with sudo."

job_alive() {
  if [[ -f "$LOCK_FILE" ]] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
    return 0
  fi
  case "$(status_field phase)" in
    syncing|building|installing)
      local updated
      updated="$(status_field updatedAt)"
      [[ $(( $(date +%s) - ${updated:-0} )) -ge 30 ]] || return 0
      ;;
  esac
  return 1
}

conflict_thread_running() {
  local id state
  id="$(cat "$CONFLICT_THREAD_FILE" 2>/dev/null || true)"
  [[ -n "$id" && -x "$HOME/.local/bin/t3" ]] || return 1
  state="$("$HOME/.local/bin/t3" thread show "$id" 2>/dev/null | sed -n 2p | awk '{print $2}')"
  [[ "$state" == "running" ]]
}

if [[ "$STATUS" -eq 1 ]]; then
  if [[ ! -f "$STATUS_FILE" ]]; then
    status_json idle ""
  else
    case "$(status_field phase)" in
      syncing|building|installing)
        if job_alive; then
          cat "$STATUS_FILE"
        else
          status_json failed "The update stopped unexpectedly. See $JOB_LOG."
        fi
        ;;
      *) cat "$STATUS_FILE" ;;
    esac
  fi
  printf '\n'
  exit 0
fi

if [[ "$LAUNCH" -eq 1 ]]; then
  cd "$REPO"
  job_alive && die "An update is already running."
  if [[ "$RESUME" -eq 0 ]] && conflict_thread_running; then
    die "Thread $(cat "$CONFLICT_THREAD_FILE") is still resolving rebase conflicts; it continues the update when it is done."
  fi
  [[ "$(uname -s)" == "Darwin" ]] || die "p2code updates are only supported on macOS."
  git diff --quiet && git diff --cached --quiet ||
    die "Working tree has uncommitted changes in $REPO. Commit or stash them first."
  mkdir -p "$OUT_ROOT"
  write_status syncing "Starting the update"
  launchctl remove "$JOB_LABEL" >/dev/null 2>&1 || true
  job_args="--detached"
  [[ "$RELAUNCH" -eq 0 ]] || job_args="$job_args --relaunch"
  [[ "$RESUME" -eq 0 ]] || job_args="$job_args --resume"
  launchctl submit -l "$JOB_LABEL" -o "$JOB_LOG" -e "$JOB_LOG" -- \
    /bin/zsh -ilc "exec $(printf '%q' "$REPO/scripts/p2code-update.sh") $job_args" ||
    { write_status failed "Could not start the background update job."; die "launchctl could not submit the update job."; }
  exit 0
fi

if [[ "$CHECK" -eq 1 ]]; then
  export GIT_TERMINAL_PROMPT=0
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o ConnectTimeout=15"
  cd "$REPO"
  git show-ref --verify --quiet "refs/heads/$WORK_BRANCH" || die "Branch $WORK_BRANCH does not exist."
  git show-ref --verify --quiet refs/heads/main || die "Local main branch does not exist."
  if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  fi
  git fetch "$UPSTREAM_REMOTE" main --quiet || die "Could not reach $UPSTREAM_URL."
  check_installed=""
  if [[ -f "$STATE_FILE" ]]; then
    check_installed="$(cat "$STATE_FILE")"
  fi
  check_local=false
  [[ "$(git rev-parse "$WORK_BRANCH")" == "$check_installed" ]] || check_local=true
  check_dirty=false
  git diff --quiet && git diff --cached --quiet || check_dirty=true
  printf '{"upstreamCommits":%s,"localChanges":%s,"dirty":%s}\n' \
    "$(git rev-list --count main..$UPSTREAM_REMOTE/main)" "$check_local" "$check_dirty"
  exit 0
fi

mkdir -p "$OUT_ROOT"
if [[ -f "$LOCK_FILE" ]] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
  die "Another p2code update is already running (pid $(cat "$LOCK_FILE"))."
fi
printf '%s' "$$" > "$LOCK_FILE"

TERMINAL_STATUS_WRITTEN=0
on_exit() {
  local code=$?
  rm -f "$LOCK_FILE"
  if [[ "$code" -ne 0 && "$TERMINAL_STATUS_WRITTEN" -eq 0 ]]; then
    local message=""
    if [[ "$DETACHED" -eq 1 ]]; then
      message="$(sed -n 's/^ERROR: //p' "$JOB_LOG" 2>/dev/null | tail -n 1)"
    fi
    write_status failed "${message:-The update failed. See $STEP_LOG.}" || true
  fi
}
trap on_exit EXIT

export P2CODE_VERBOSE="$VERBOSE"
init_step_log "$OUT_ROOT/sync.log"
write_status syncing "Syncing with upstream"

cd "$REPO"

git diff --quiet && git diff --cached --quiet ||
  die "Working tree has uncommitted changes in $REPO. Commit or stash them first."
git show-ref --verify --quiet "refs/heads/$WORK_BRANCH" || die "Branch $WORK_BRANCH does not exist."
git show-ref --verify --quiet refs/heads/main || die "Local main branch does not exist."

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

log "Syncing with upstream"
step "Fetching upstream" git fetch "$UPSTREAM_REMOTE" --tags --quiet

if [[ "$(git branch --show-current)" != "$WORK_BRANCH" ]]; then
  git switch --quiet "$WORK_BRANCH"
fi

old_main="$(git rev-parse main)"
git fetch "$UPSTREAM_REMOTE" main:main --quiet ||
  die "Local main cannot fast-forward to $UPSTREAM_REMOTE/main (it has its own commits). Fix it by hand in $REPO."
new_main="$(git rev-parse main)"
new_commits="$(git rev-list --count "$old_main..$new_main")"
printf '  main: %s new upstream commit(s), now at %s\n' "$new_commits" "$(git log --oneline -1 main)"

AUTO_RESOLVED=()

# Continues only past stops where rerere replayed every conflict or pnpm-lock.yaml is the
# sole conflict; the lockfile is then regenerated from upstream's copy.
rebase_onto_main() {
  local rebase_dir output commit path msgnum
  rebase_dir="$(git rev-parse --git-path rebase-merge)"
  if output="$(git rebase main 2>&1)"; then
    printf '%s\n' "$output" >>"$STEP_LOG"
    return 0
  fi
  printf '%s\n' "$output" >>"$STEP_LOG"
  while [[ -d "$rebase_dir" ]]; do
    [[ -z "$(git diff --name-only --diff-filter=U -- . ':!pnpm-lock.yaml')" ]] || return 1
    commit="$(git log -1 --format='%h %s' REBASE_HEAD)"
    while IFS= read -r path; do
      [[ -z "$path" || "$path" == pnpm-lock.yaml ]] || AUTO_RESOLVED+=("$commit: $path (recorded resolution)")
    done <<<"$(sed -n -E "s/^(Staged|Resolved) '(.*)' using previous resolution\.$/\2/p" <<<"$output")"
    if [[ -n "$(git diff --name-only --diff-filter=U -- pnpm-lock.yaml)" ]] ||
      grep -q "'pnpm-lock.yaml' using previous resolution" <<<"$output"; then
      git checkout HEAD -- pnpm-lock.yaml && run pnpm install --lockfile-only && git add pnpm-lock.yaml || return 1
      AUTO_RESOLVED+=("$commit: pnpm-lock.yaml (regenerated)")
    fi
    msgnum="$(cat "$rebase_dir/msgnum")"
    if output="$(GIT_EDITOR=true git rebase --continue 2>&1)"; then
      printf '%s\n' "$output" >>"$STEP_LOG"
      return 0
    fi
    printf '%s\n' "$output" >>"$STEP_LOG"
    [[ "$(cat "$rebase_dir/msgnum" 2>/dev/null)" != "$msgnum" ]] || return 1
  done
  return 1
}

conflict_prompt() {
  local RESUME_COMMAND="scripts/p2code-update.sh --launch --resume"
  [[ "$RELAUNCH" -eq 0 ]] || RESUME_COMMAND="$RESUME_COMMAND --relaunch"
  cat <<EOF
The p2code update stopped: rebasing $WORK_BRANCH onto main hit conflicts in:
$1

Resolve them and continue the update. This thread runs in the repo, $REPO.

1. Check \`git status\`. The tree should be clean on $WORK_BRANCH (the update aborted its rebase). If a rebase is somehow in progress, continue it instead of starting over.
2. Run \`git rebase main\`. For each conflict keep upstream's new behavior and re-apply what the carried commit was for: read \`git show REBASE_HEAD\` and the "p2code: the owner's build" section of AGENTS.md. Never drop a carried change just to make the conflict go away. If upstream shipped the equivalent of a carried commit, drop that commit instead.
3. For pnpm-lock.yaml take main's copy (\`git checkout HEAD -- pnpm-lock.yaml\`), run \`pnpm install --lockfile-only\` with \`pnpm_config_pm_on_fail=download\` in the environment, then \`git add\` it.
4. \`git add\` the resolved files and run \`GIT_EDITOR=true git rebase --continue\` until the rebase finishes. rerere is enabled, so the resolutions are recorded for next time.
5. Confirm \`git status\` is clean and you are on $WORK_BRANCH.
6. Run \`$RESUME_COMMAND\`. It starts the rest of the update (checks, push, build, install) as a separate background job. The install restarts the T3 Code server, which ends this session, so do not wait for it. Do not run \`p2code install\`, \`p2code update\`, \`p2code rollback\` or \`t3 update\` yourself. Do not start any other thread.
7. Your last action, once step 6 succeeded: settle this thread with the \`t3_thread_organize\` tool (\`action: "settle"\`).

If a conflict cannot be resolved safely, stop and explain what blocks you instead of guessing.
EOF
}

spawn_conflict_thread() {
  local t3_bin="$HOME/.local/bin/t3" id
  [[ -x "$t3_bin" ]] || return 1
  id="$(conflict_prompt "$1" | "$t3_bin" thread start "$REPO" - \
    --title "p2code update: resolve rebase conflicts" \
    --provider "$CONFLICT_PROVIDER" --model "$CONFLICT_MODEL" 2>>"$STEP_LOG" | tail -n 1)"
  [[ -n "$id" ]] || return 1
  mkdir -p "$(dirname "$CONFLICT_THREAD_FILE")"
  printf '%s' "$id" > "$CONFLICT_THREAD_FILE"
  printf '%s' "$id"
}

git config rerere.enabled true
git config rerere.autoUpdate true

begin "Rebasing $WORK_BRANCH onto main"
if ! rebase_onto_main; then
  printf 'FAILED\n'
  conflicts="$(git diff --name-only --diff-filter=U || true)"
  git rebase --abort || true
  printf '%s\n' "$conflicts" | sed 's/^/  conflict: /'
  if [[ "$DETACHED" -eq 1 ]]; then
    TERMINAL_STATUS_WRITTEN=1
    if [[ -z "$conflicts" ]]; then
      write_status failed "The rebase failed without conflicts. See $STEP_LOG."
      exit 1
    fi
    if [[ "$RESUME" -eq 1 ]]; then
      write_status failed "Conflicts remain after the resolver thread $(cat "$CONFLICT_THREAD_FILE" 2>/dev/null || true) finished: $(printf '%s' "$conflicts" | paste -sd, -)" "$(cat "$CONFLICT_THREAD_FILE" 2>/dev/null || true)"
      exit 1
    fi
    if conflict_thread_running; then
      thread_id="$(cat "$CONFLICT_THREAD_FILE")"
    else
      thread_id="$(spawn_conflict_thread "$conflicts" || true)"
    fi
    if [[ -n "$thread_id" ]]; then
      write_status conflict "Rebase conflicts in: $(printf '%s' "$conflicts" | paste -sd, -)" "$thread_id"
      printf 'Conflict thread %s is resolving the conflicts.\n' "$thread_id"
      exit 0
    fi
    write_status failed "Rebase conflicts, and the resolver thread could not start. Resolve by hand: cd $REPO && git rebase main"
    exit 1
  fi
  die "Rebase hit conflicts and was aborted; the repo is back where it was. Resolve by hand (recorded resolutions replay): cd $REPO && git rebase main. Log: $STEP_LOG"
fi
head="$(git rev-parse HEAD)"
end
printf '  head: %s (carrying %s local commit(s) on top of main)\n' "$(git log --oneline -1)" "$(git rev-list --count main..HEAD)"
for resolved in ${AUTO_RESOLVED[@]+"${AUTO_RESOLVED[@]}"}; do
  printf '  auto-resolved: %s\n' "$resolved"
done

installed=""
if [[ -f "$STATE_FILE" ]]; then
  installed="$(cat "$STATE_FILE")"
fi

if [[ -n "$installed" ]] && git cat-file -e "$installed^{commit}" 2>/dev/null; then
  migrations="$(git diff --name-only "$installed" HEAD -- apps/server/src/persistence/Migrations | wc -l | tr -d ' ')"
  if [[ "$migrations" -gt 0 ]]; then
    printf '\nWARNING: %s database migration file(s) changed since the installed build. Rolling back to the previous server may not work after the new one has run.\n' "$migrations"
  fi
fi

step "Installing dependencies" vp i
step "Checking local changes against the new base" bash -c 'cd packages/provider-core && vp test run src/server/lazyDriver.test.ts && vp run typecheck'
git diff --quiet || die "Dependency install or checks modified tracked files. Inspect with: git -C $REPO status"

push_all() {
  git push --quiet "$PUSH_REMOTE" main && git push --quiet --force-with-lease --set-upstream "$PUSH_REMOTE" "$WORK_BRANCH"
}

if [[ "$PUSH" -eq 1 ]]; then
  step "Pushing main and $WORK_BRANCH to $PUSH_REMOTE" push_all
fi

if [[ "$SYNC_ONLY" -eq 1 ]]; then
  log "Synced (sync-only)"
  TERMINAL_STATUS_WRITTEN=1
  write_status done "Synced; nothing was built." "" ""
  exit 0
fi

if [[ "$head" == "$installed" && "$FORCE" -eq 0 ]]; then
  log "Already up to date: the installed build is $(git log --oneline -1)"
  rm -f "$CONFLICT_THREAD_FILE"
  TERMINAL_STATUS_WRITTEN=1
  write_status done "Already up to date." "" ""
  exit 0
fi

install_after=1
if [[ "$NO_INSTALL" -eq 1 ]]; then
  install_after=0
elif [[ "$DETACHED" -eq 0 ]] && "$BUILD_SCRIPT" in-t3; then
  install_after=0
  printf '\nRunning inside T3 Code: building only. Installing restarts the server and app, so finish from a plain terminal with p2code install, or use the in-app update button.\n'
fi

write_status building "Building the server and desktop app"
"$BUILD_SCRIPT" build

if [[ "$install_after" -eq 0 ]]; then
  log "Built. To install: p2code install"
  TERMINAL_STATUS_WRITTEN=1
  write_status done "Built; run p2code install to finish." "" ""
  exit 0
fi

write_status installing "Installing; T3 Code restarts"
if [[ "$RELAUNCH" -eq 1 ]]; then
  "$BUILD_SCRIPT" install --yes --relaunch
else
  "$BUILD_SCRIPT" install --yes
fi
rm -f "$CONFLICT_THREAD_FILE"

printf '%s' "$head" > "$STATE_FILE"
TERMINAL_STATUS_WRITTEN=1
write_status done "Updated to $(git log --oneline -1)" "" "$(cat "$OUT_ROOT/current" 2>/dev/null || true)"
log "p2code is up to date at $(git log --oneline -1)"

exit 0
}
