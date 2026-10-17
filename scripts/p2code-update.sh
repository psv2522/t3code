#!/usr/bin/env bash
set -euo pipefail

{

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ROOT="${P2CODE_OUT:-$HOME/.p2code}"
UPSTREAM_URL="git@github.com:pingdotgg/t3code.git"
WORK_BRANCH="p2code/custom"
STATE_FILE="$OUT_ROOT/installed-head"
BUILD_SCRIPT="$REPO/scripts/p2code.sh"

source "$REPO/scripts/p2code-lib.sh"

usage() {
  cat <<EOF
Usage: p2code update [options]

Sync the fork with pingdotgg/t3code main, rebase local changes, push, then build and install.

  --sync-only    Sync, rebase, push and check; do not build or install
  --no-install   Sync, push, check and build; do not install
  --no-push      Do not push main and $WORK_BRANCH to origin
  --force        Rebuild even when nothing changed since the last install
  --check        Fetch upstream and print JSON saying whether an update is pending; changes nothing
  -v, --verbose  Show full command output instead of one line per step
  -h, --help     Show this help

Inside T3 Code the install step is skipped automatically; finish with: p2code install
EOF
}

SYNC_ONLY=0
NO_INSTALL=0
PUSH=1
FORCE=0
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --sync-only) SYNC_ONLY=1 ;;
    --no-install) NO_INSTALL=1 ;;
    --no-push) PUSH=0 ;;
    --force) FORCE=1 ;;
    --check) CHECK=1 ;;
    --verbose|-v) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $arg" ;;
  esac
done

[[ "$EUID" -ne 0 ]] || die "Do not run this with sudo."

if [[ "$CHECK" -eq 1 ]]; then
  export GIT_TERMINAL_PROMPT=0
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes -o ConnectTimeout=15"
  cd "$REPO"
  git show-ref --verify --quiet "refs/heads/$WORK_BRANCH" || die "Branch $WORK_BRANCH does not exist."
  git show-ref --verify --quiet refs/heads/main || die "Local main branch does not exist."
  if ! git remote get-url upstream >/dev/null 2>&1; then
    git remote add upstream "$UPSTREAM_URL"
  fi
  git fetch upstream main --quiet || die "Could not reach $UPSTREAM_URL."
  check_installed=""
  if [[ -f "$STATE_FILE" ]]; then
    check_installed="$(cat "$STATE_FILE")"
  fi
  check_local=false
  [[ "$(git rev-parse "$WORK_BRANCH")" == "$check_installed" ]] || check_local=true
  check_dirty=false
  git diff --quiet && git diff --cached --quiet || check_dirty=true
  printf '{"upstreamCommits":%s,"localChanges":%s,"dirty":%s}\n' \
    "$(git rev-list --count main..upstream/main)" "$check_local" "$check_dirty"
  exit 0
fi

mkdir -p "$OUT_ROOT"
LOCK_FILE="$OUT_ROOT/update.lock"
if [[ -f "$LOCK_FILE" ]] && kill -0 "$(cat "$LOCK_FILE")" 2>/dev/null; then
  die "Another p2code update is already running (pid $(cat "$LOCK_FILE"))."
fi
printf '%s' "$$" > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

export P2CODE_VERBOSE="$VERBOSE"
init_step_log "$OUT_ROOT/sync.log"

cd "$REPO"

git diff --quiet && git diff --cached --quiet ||
  die "Working tree has uncommitted changes in $REPO. Commit or stash them first."
git show-ref --verify --quiet "refs/heads/$WORK_BRANCH" || die "Branch $WORK_BRANCH does not exist."
git show-ref --verify --quiet refs/heads/main || die "Local main branch does not exist."

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi

log "Syncing with upstream"
step "Fetching upstream" git fetch upstream --tags --quiet

if [[ "$(git branch --show-current)" != "$WORK_BRANCH" ]]; then
  git switch --quiet "$WORK_BRANCH"
fi

old_main="$(git rev-parse main)"
git fetch upstream main:main --quiet ||
  die "Local main cannot fast-forward to upstream/main (it has its own commits). Fix it by hand in $REPO."
new_main="$(git rev-parse main)"
new_commits="$(git rev-list --count "$old_main..$new_main")"
printf '  main: %s new upstream commit(s), now at %s\n' "$new_commits" "$(git log --oneline -1 main)"

begin "Rebasing $WORK_BRANCH onto main"
if ! git rebase main >>"$STEP_LOG" 2>&1; then
  printf 'FAILED\n'
  conflicts="$(git diff --name-only --diff-filter=U || true)"
  git rebase --abort || true
  printf '%s\n' "$conflicts" | sed 's/^/  conflict: /'
  die "Rebase hit conflicts and was aborted; the repo is back where it was. Resolve by hand: cd $REPO && git rebase main"
fi
head="$(git rev-parse HEAD)"
end
printf '  head: %s (carrying %s local commit(s) on top of main)\n' "$(git log --oneline -1)" "$(git rev-list --count main..HEAD)"

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
step "Checking local changes against the new base" bash -c 'cd packages/provider-cursor && vp test run && vp run typecheck'
git diff --quiet || die "Dependency install or checks modified tracked files. Inspect with: git -C $REPO status"

push_all() {
  git push --quiet origin main && git push --quiet --force-with-lease --set-upstream origin "$WORK_BRANCH"
}

if [[ "$PUSH" -eq 1 ]]; then
  step "Pushing main and $WORK_BRANCH to origin" push_all
fi

if [[ "$SYNC_ONLY" -eq 1 ]]; then
  log "Synced (sync-only)"
  exit 0
fi

if [[ "$head" == "$installed" && "$FORCE" -eq 0 ]]; then
  log "Already up to date: the installed build is $(git log --oneline -1)"
  exit 0
fi

install_after=1
if [[ "$NO_INSTALL" -eq 1 ]]; then
  install_after=0
elif "$BUILD_SCRIPT" in-t3; then
  install_after=0
  printf '\nRunning inside T3 Code: building only. Installing restarts the server and app, so finish from a plain terminal.\n'
fi

"$BUILD_SCRIPT" build

if [[ "$install_after" -eq 0 ]]; then
  log "Built. To install: p2code install"
  exit 0
fi

"$BUILD_SCRIPT" install --yes

printf '%s' "$head" > "$STATE_FILE"
log "p2code is up to date at $(git log --oneline -1)"

exit 0
}
