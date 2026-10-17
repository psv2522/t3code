#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
OUT_ROOT="${P2CODE_OUT:-$HOME/.p2code}"
APPS_DIR="${P2CODE_APPS_DIR:-/Applications}"
INSTALLED_APP_NAME="${P2CODE_APP_NAME:-T3 Code (Nightly)}"
SEA_NODE_VERSION="26.8.2"
VERSION_FILES=(
  apps/server/package.json
  apps/desktop/package.json
  apps/web/package.json
  packages/contracts/package.json
)
GENERATED_FILES=(apps/web/src/routeTree.gen.ts)

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: scripts/p2code.sh <command> [options]

  build                 Build the CLI archive and desktop app, verify them, stage a local release
  install [--yes]       Back up, then switch the background server and desktop app to the latest build
  all [--yes]           build, then install
  rollback [--yes]      Restore the app and background server from the latest backup
  version               Print the version the next build would use

Environment:
  P2CODE_VERSION        Override the computed version
  P2CODE_OUT            Output and backup root (default ~/.p2code)
  P2CODE_APPS_DIR       Where the desktop app lives (default /Applications)
EOF
}

core_version() {
  local tag
  tag="$(git -C "$REPO" tag --list 'v[0-9]*-nightly.*' | sed 's/^v//' | sort -V | tail -n 1)"
  if [[ -n "$tag" ]]; then
    printf '%s' "${tag%%-*}"
  else
    printf '0.1.1'
  fi
}

compute_version() {
  if [[ -n "${P2CODE_VERSION:-}" ]]; then
    printf '%s' "$P2CODE_VERSION"
    return
  fi
  local seconds=$((10#$(date +%H) * 3600 + 10#$(date +%M) * 60 + 10#$(date +%S)))
  printf '%s-nightly.99%s.%d' "$(core_version)" "$(date +%y%m%d)" "$seconds"
}

validate_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[1-9][0-9]{7}\.(0|[1-9][0-9]*)$ ]] ||
    die "Version '$1' must look like 0.1.1-nightly.99261017.1234 (8 digits, no leading zero, then a counter)."
}

active_version() {
  sed -n 's/.*"activeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$T3_HOME/runtime/service-state.json" 2>/dev/null | head -n 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH."
}

inside_t3_code() {
  local pid=$$ cmd
  while [[ "$pid" -gt 1 ]]; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *"T3 Code"*|*"__service-launcher"*|*"/t3 serve"*) return 0 ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [[ -n "$pid" ]] || break
  done
  return 1
}

confirm() {
  [[ "${ASSUME_YES:-0}" == "1" ]] && return 0
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]]
}

restore_generated_files() {
  git -C "$REPO" checkout -- "${VERSION_FILES[@]}" "${GENERATED_FILES[@]}" 2>/dev/null || true
}

cmd_build() {
  require_cmd vp
  require_cmd node
  require_cmd git
  require_cmd shasum
  require_cmd ditto
  require_cmd codesign

  cd "$REPO"
  [[ -f .env ]] || die "Missing $REPO/.env. Run: cp .env.example .env"
  grep -q '^T3CODE_RELAY_URL=https://' .env || die ".env has no T3CODE_RELAY_URL, so T3 Connect would be disabled."
  grep -q '^T3CODE_CLERK_PUBLISHABLE_KEY=.' .env || die ".env has no T3CODE_CLERK_PUBLISHABLE_KEY, so T3 Connect would be disabled."
  git diff --quiet && git diff --cached --quiet || die "Working tree has uncommitted changes. Commit or stash them first."

  unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY

  local version
  version="$(compute_version)"
  validate_version "$version"

  local active monitor_src
  active="$(active_version)"
  monitor_src="$T3_HOME/runtime/versions/$active/resource-monitor"
  [[ -n "$active" && -x "$monitor_src/darwin-arm64/t3-resource-monitor" ]] ||
    die "No resource monitor to reuse under $T3_HOME/runtime/versions/. Install Rust or point at a release that has one."
  file "$monitor_src/darwin-arm64/t3-resource-monitor" | grep -q arm64 || die "Resource monitor is not an arm64 binary."

  local build_dir="$OUT_ROOT/builds/$version"
  [[ ! -e "$build_dir" ]] || die "$build_dir already exists."
  mkdir -p "$build_dir"

  log "Building p2code $version (base $(git rev-parse --short HEAD))"
  trap restore_generated_files EXIT

  local rust_dir="$REPO/native/resource-monitor/target/aarch64-apple-darwin/release"
  mkdir -p "$rust_dir"
  cp "$monitor_src/darwin-arm64/t3-resource-monitor" "$rust_dir/t3-resource-monitor"
  chmod 755 "$rust_dir/t3-resource-monitor"
  mkdir -p "$build_dir/resource-monitor"
  cp -R "$monitor_src/." "$build_dir/resource-monitor/"

  log "Aligning package versions"
  node scripts/update-release-package-versions.ts "$version"

  log "Building server, web client and desktop bundle"
  vp run build:desktop

  log "Building server single-executable (Node $SEA_NODE_VERSION)"
  VP_NODE_VERSION="$SEA_NODE_VERSION" node apps/server/scripts/cli.ts build-exe --verbose

  log "Packaging CLI archive"
  node scripts/build-cli-archive.ts \
    --platform mac \
    --arch arm64 \
    --version "$version" \
    --resource-monitor-dir "$build_dir/resource-monitor" \
    --output-dir "$build_dir/cli"
  local archive="$build_dir/cli/t3-$version-darwin-arm64.tar.gz"
  [[ -f "$archive" ]] || die "Expected archive $archive was not produced."

  log "Smoke-testing CLI archive"
  node scripts/smoke-cli-archive.ts --archive "$archive" --expect-version "$version"

  log "Packaging desktop app"
  T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true vp run dist:desktop:artifact \
    --platform mac \
    --target zip \
    --arch arm64 \
    --build-version "$version" \
    --output-dir "$build_dir/desktop" \
    --skip-build \
    --verbose

  local zip
  zip="$(find "$build_dir/desktop" -maxdepth 1 -name '*.zip' | head -n 1)"
  [[ -n "$zip" ]] || die "No desktop zip was produced in $build_dir/desktop."

  log "Verifying and ad hoc signing desktop app"
  local app_dir="$build_dir/app"
  mkdir -p "$app_dir"
  ditto -x -k "$zip" "$app_dir"
  local app
  app="$(find "$app_dir" -maxdepth 1 -name '*.app' | head -n 1)"
  [[ -n "$app" ]] || die "No .app inside $zip."
  printf 'app: %s\n' "$(basename "$app")"
  [[ "$(basename "$app" .app)" == "$INSTALLED_APP_NAME" ]] ||
    die "Built app is '$(basename "$app")', not '$INSTALLED_APP_NAME.app'; installing would leave two apps."
  [[ ! -e "$app/Contents/Resources/app-update.yml" ]] || die "Built app has an update feed (app-update.yml); it would auto-update to official builds."
  local plist_version
  plist_version="$(defaults read "$app/Contents/Info" CFBundleShortVersionString)"
  [[ "$plist_version" == "$version" ]] || die "App reports version $plist_version, expected $version."
  grep -aq 'relay.t3.codes' "$app/Contents/Resources/app.asar" || die "relay.t3.codes is not baked into the desktop bundle."
  grep -arqs 'relay.t3.codes' "$REPO/apps/server/dist" || die "relay.t3.codes is not baked into the server bundle."
  codesign --force --deep --sign - "$app" || die "Ad hoc signing failed."
  codesign --verify --deep --strict "$app" || die "Built app failed codesign verification."
  [[ "$(codesign -dv "$app" 2>&1 | sed -n 's/^Identifier=//p')" == "com.t3tools.t3code" ]] ||
    die "Signed app has an unexpected bundle identifier."

  log "Staging local release"
  local release_dir="$build_dir/release/v$version"
  mkdir -p "$release_dir"
  cp "$archive" "$release_dir/"
  (cd "$release_dir" && shasum -a 256 "t3-$version-darwin-arm64.tar.gz" > SHA256SUMS)

  printf '%s' "$version" > "$OUT_ROOT/current"
  trap - EXIT
  restore_generated_files

  log "Build complete: $version"
  printf 'artifacts: %s\n' "$build_dir"
}

pick_free_port() {
  python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}

quit_app() {
  local pattern
  pattern="$(printf '%s' "$APPS_DIR/$INSTALLED_APP_NAME.app/Contents/MacOS/" | sed 's/[()]/\\&/g')"
  pgrep -f "$pattern" >/dev/null 2>&1 || return 0
  log "Quitting $INSTALLED_APP_NAME"
  osascript -e "tell application \"$INSTALLED_APP_NAME\" to quit" >/dev/null 2>&1 || true
  local waited=0
  while pgrep -f "$pattern" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [[ "$waited" -eq 15 ]]; then
      pkill -TERM -f "$pattern" || true
    fi
    [[ "$waited" -lt 45 ]] || die "$INSTALLED_APP_NAME did not quit. Quit it by hand and rerun."
  done
}

repoint_launcher() {
  local target="$T3_HOME/runtime/versions/$1/t3"
  [[ -x "$target" ]] || die "Expected executable $target."
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$target" "$HOME/.local/bin/t3"
}

backup_state() {
  local backup="$1"
  mkdir -p "$backup/userdata"
  chmod 700 "$OUT_ROOT/backups" "$backup"
  log "Backing up state to $backup"
  local db name
  for db in "$T3_HOME"/userdata/*.sqlite; do
    [[ -f "$db" ]] || continue
    name="$(basename "$db")"
    if [[ "$name" == "server-owner.sqlite" ]]; then
      continue
    fi
    sqlite3 -cmd ".timeout 30000" "$db" ".backup '$backup/userdata/$name'" || die "Could not back up $name."
  done
  cp "$T3_HOME"/userdata/*.json "$backup/userdata/" 2>/dev/null || true
  cp "$T3_HOME/runtime/service-state.json" "$backup/" 2>/dev/null || true
  cp "$HOME/Library/LaunchAgents/com.t3tools.t3code.service.plist" "$backup/" 2>/dev/null || true
  readlink "$HOME/.local/bin/t3" > "$backup/t3-symlink" 2>/dev/null || true
  active_version > "$backup/previous-version"
  if [[ -d "$APPS_DIR/$INSTALLED_APP_NAME.app" ]]; then
    tar -czf "$backup/$INSTALLED_APP_NAME.app.tgz" -C "$APPS_DIR" "$INSTALLED_APP_NAME.app"
  fi
}

cmd_install() {
  inside_t3_code && die "Run this from a plain terminal (Terminal, Ghostty, iTerm), not from inside T3 Code. It restarts the background server and quits the desktop app, which would kill this shell halfway."
  require_cmd sqlite3
  require_cmd python3
  require_cmd curl
  require_cmd ditto
  require_cmd tar

  local version
  version="${P2CODE_VERSION:-$(cat "$OUT_ROOT/current" 2>/dev/null || true)}"
  [[ -n "$version" ]] || die "No build found. Run: scripts/p2code.sh build"
  validate_version "$version"
  local build_dir="$OUT_ROOT/builds/$version"
  local release_dir="$build_dir/release"
  local built_app="$build_dir/app/$INSTALLED_APP_NAME.app"
  [[ -f "$release_dir/v$version/SHA256SUMS" && -d "$built_app" ]] || die "Build $version is incomplete under $build_dir."
  codesign --verify --deep --strict "$built_app" || die "Built app failed codesign verification."
  (cd "$release_dir/v$version" && shasum -a 256 -c SHA256SUMS >/dev/null) || die "Release checksum mismatch."

  local previous
  previous="$(active_version)"
  [[ -n "$previous" ]] || die "Could not read the active server version from $T3_HOME/runtime/service-state.json."
  local previous_t3="$T3_HOME/runtime/versions/$previous/t3"
  [[ -x "$previous_t3" ]] || die "Current server binary $previous_t3 is missing."

  printf '\nThis will:\n'
  printf '  - back up databases, settings and %s.app to %s/backups\n' "$INSTALLED_APP_NAME" "$OUT_ROOT"
  printf '  - quit %s\n' "$INSTALLED_APP_NAME"
  printf '  - switch the background server %s -> %s (restarts it; running agent turns and terminals stop)\n' "$previous" "$version"
  printf '  - replace %s/%s.app with the new build and reopen it\n' "$APPS_DIR" "$INSTALLED_APP_NAME"
  printf '  - expect to sign in to T3 Connect again if macOS rejects the old keychain entry\n\n'
  confirm "Continue?" || die "Cancelled."

  local backup="$OUT_ROOT/backups/$(date +%Y%m%d-%H%M%S)"
  backup_state "$backup"
  printf '%s' "$version" > "$backup/installed-version"

  quit_app

  log "Switching background server to $version"
  local port
  port="$(pick_free_port)"
  python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$release_dir" >/dev/null 2>&1 &
  HTTP_PID=$!
  trap 'kill "$HTTP_PID" 2>/dev/null || true' EXIT
  local tries=0
  until curl -fsS "http://127.0.0.1:$port/v$version/SHA256SUMS" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [[ "$tries" -lt 25 ]] || die "Local release server did not start."
    sleep 0.2
  done
  T3CODE_RELEASE_BASE_URL="http://127.0.0.1:$port" "$previous_t3" update "$version" --yes ||
    die "t3 update failed. Nothing was replaced yet; reopen $INSTALLED_APP_NAME. Backup: $backup"
  kill "$HTTP_PID" 2>/dev/null || true
  trap - EXIT

  repoint_launcher "$version"

  log "Waiting for the new server"
  tries=0
  until pgrep -f "runtime/versions/$version/t3" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [[ "$tries" -lt 60 ]] || die "Server $version is not running. Run: scripts/p2code.sh rollback"
    sleep 1
  done
  "$T3_HOME/runtime/versions/$version/t3" service status || true

  log "Replacing $INSTALLED_APP_NAME"
  rm -rf "$APPS_DIR/$INSTALLED_APP_NAME.app"
  ditto "$built_app" "$APPS_DIR/$INSTALLED_APP_NAME.app"
  xattr -cr "$APPS_DIR/$INSTALLED_APP_NAME.app"

  log "Opening $INSTALLED_APP_NAME"
  open "$APPS_DIR/$INSTALLED_APP_NAME.app"

  log "Installed p2code $version"
  printf 'backup:   %s\n' "$backup"
  printf 'rollback: %s/scripts/p2code.sh rollback\n' "$REPO"
}

cmd_rollback() {
  inside_t3_code && die "Run this from a plain terminal, not from inside T3 Code."
  local backup
  backup="$(find "$OUT_ROOT/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)"
  [[ -n "$backup" ]] || die "No backups under $OUT_ROOT/backups."
  local previous
  previous="$(cat "$backup/previous-version")"
  [[ -x "$T3_HOME/runtime/versions/$previous/t3" ]] || die "Previous server $previous is no longer on disk."
  printf '\nRestoring from %s\n  server -> %s\n  app    -> %s.app\n\n' "$backup" "$previous" "$INSTALLED_APP_NAME"
  confirm "Continue?" || die "Cancelled."

  quit_app

  log "Switching background server back to $previous"
  "$T3_HOME/runtime/versions/$previous/t3" update "$previous" --allow-downgrade --yes
  repoint_launcher "$previous"

  if [[ -f "$backup/$INSTALLED_APP_NAME.app.tgz" ]]; then
    log "Restoring $INSTALLED_APP_NAME"
    rm -rf "$APPS_DIR/$INSTALLED_APP_NAME.app"
    tar -xzf "$backup/$INSTALLED_APP_NAME.app.tgz" -C "$APPS_DIR"
    open "$APPS_DIR/$INSTALLED_APP_NAME.app"
  fi

  log "Rolled back"
  printf 'Databases were not restored. If the new server changed them, copy from %s/userdata with the server stopped.\n' "$backup"
}

main() {
  [[ "$EUID" -ne 0 ]] || die "Do not run this with sudo. A root run creates a separate T3 installation and root-owned files. Run it as your normal user."
  local command="${1:-}"
  shift || true
  ASSUME_YES=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --yes|-y) ASSUME_YES=1 ;;
      *) die "Unknown option: $arg" ;;
    esac
  done
  case "$command" in
    build) cmd_build ;;
    install) cmd_install ;;
    all) cmd_build; cmd_install ;;
    rollback) cmd_rollback ;;
    version) compute_version; printf '\n' ;;
    *) usage; [[ -z "$command" || "$command" == "help" ]] || exit 1 ;;
  esac
}

main "$@"
