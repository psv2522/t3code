#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T3_HOME="${T3CODE_HOME:-$HOME/.t3}"
OUT_ROOT="${P2CODE_OUT:-$HOME/.p2code}"
APPS_DIR="${P2CODE_APPS_DIR:-/Applications}"
INSTALLED_APP_NAME="${P2CODE_APP_NAME:-T3 Code (Nightly)}"
SIGN_IDENTITY="${P2CODE_SIGN_IDENTITY:-p2code Local Signing}"
TARGET_PLATFORM="mac"
TARGET_ARCH="arm64"
DESKTOP_TARGET="dir"
KEEP_BUILDS=1
KEEP_BACKUPS=1
KEEP_RUNTIME_VERSIONS=1
DRY_RUN=0
VERSION_FILES=(
  apps/server/package.json
  apps/desktop/package.json
  apps/web/package.json
  packages/contracts/package.json
)
GENERATED_FILES=(apps/web/src/routeTree.gen.ts)

source "$REPO/scripts/p2code-lib.sh"

usage() {
  cat <<EOF
Usage: scripts/p2code.sh <command> [options]

  build                 Build the CLI archive and desktop app, verify them, stage a local release
  install [--yes]       Back up, then switch the background server and desktop app to the latest build
  all [--yes]           build, then install
  rollback [--yes]      Restore the app and background server from the latest backup
  setup-signing         Create the self-signed certificate the desktop app is signed with (once)
  prune [--dry-run]     Delete old builds, backups and downloaded server versions (install runs it)
  build-node            Compile the pointer-compressed Node the server executable is built on (about an hour)
  version               Print the version the next build would use

Options:
  -v, --verbose         Show full command output instead of one line per step
  -y, --yes             Do not ask for confirmation
  -n, --dry-run         With prune: list what would be deleted

Logs for quiet runs: build.log, install.log, rollback.log under the output root.

Environment:
  P2CODE_VERSION        Override the computed version
  P2CODE_OUT            Output and backup root (default ~/.p2code)
  P2CODE_APPS_DIR       Where the desktop app lives (default /Applications)
  P2CODE_SIGN_IDENTITY  Keychain identity that signs the desktop app (default "p2code Local Signing"; "-" signs ad hoc)
  P2CODE_VERBOSE=1      Same as --verbose
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

signing_identity_present() {
  [[ "$SIGN_IDENTITY" != "-" ]] || return 0
  local identities
  identities="$(security find-identity -p codesigning)"
  [[ "$identities" == *"\"$SIGN_IDENTITY\""* ]]
}

app_requirement() {
  codesign -dr - "$1" 2>&1 | sed -n 's/^#* *designated => //p' || true
}

inside_t3_code() {
  [[ -z "${T3_SERVICE_LAUNCHER_CONTEXT:-}" && -z "${T3_BOOT_SERVICE_UNIT:-}" ]] || return 0
  local pid=$$ cmd
  while [[ "$pid" -gt 1 ]]; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *"T3 Code"*|*"__service-launcher"*|*"/t3-launcher"*|*"/t3 serve"*) return 0 ;;
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

sea_node_version() {
  node -p 'require(process.argv[1]).engines.node' "$REPO/package.json"
}

pointer_compressed_node() {
  printf '%s/node-pc/v%s/node' "$OUT_ROOT" "$1"
}

cmd_build_node() {
  require_cmd curl
  require_cmd make
  require_cmd shasum
  local python
  for python in python3.14 python3.13 python3.12 python3.11 python3.10; do
    command -v "$python" >/dev/null && break
    python=""
  done
  [[ -n "$python" ]] || die "Building Node needs Python 3.10 to 3.14 on PATH (brew install python)."

  local version dest work
  version="$(sea_node_version)"
  dest="$(pointer_compressed_node "$version")"
  [[ ! -x "$dest" ]] || { log "Pointer-compressed Node $version is already at $dest"; return 0; }
  work="$OUT_ROOT/node-pc/src"
  init_step_log "$OUT_ROOT/build-node.log"
  log "Building pointer-compressed Node $version"
  rm -rf "$work"
  mkdir -p "$work"
  cd "$work"
  step "Downloading source" curl -fsSL \
    -O "https://nodejs.org/dist/v$version/node-v$version.tar.xz" \
    -O "https://nodejs.org/dist/v$version/SHASUMS256.txt"
  step "Verifying checksum" sh -c "grep ' node-v$version.tar.xz\$' SHASUMS256.txt | shasum -a 256 -c -"
  step "Unpacking" tar -xJf "node-v$version.tar.xz"
  cd "node-v$version"
  step "Configuring" ./configure --experimental-enable-pointer-compression
  step "Compiling" make -j"$(sysctl -n hw.ncpu)"
  step "Checking pointer compression" sh -c "out/Release/node -p process.config.variables.v8_enable_pointer_compression | grep -qx 1"
  mkdir -p "$(dirname "$dest")"
  cp out/Release/node "$dest"
  cd "$REPO"
  rm -rf "$work"
  log "Built $dest"
}

restore_generated_files() {
  git -C "$REPO" checkout -- "${VERSION_FILES[@]}" "${GENERATED_FILES[@]}" 2>/dev/null || true
}

cmd_build() {
  [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] ||
    die "p2code builds for macOS Apple silicon only; this shell is $(uname -s) $(uname -m). Run it from a native arm64 terminal, not under Rosetta."
  require_cmd vp
  require_cmd node
  require_cmd git
  require_cmd shasum
  require_cmd ditto
  require_cmd codesign
  require_cmd lipo
  require_cmd strip
  require_cmd security
  signing_identity_present || die "No '$SIGN_IDENTITY' signing identity in the keychain. Run: p2code setup-signing"

  cd "$REPO"
  local clean_path sea_node
  clean_path="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '/fnm_multishells/' | paste -sd: -)"
  export PATH="$HOME/.local/share/vite-plus/bin:$clean_path"
  sea_node="$(sea_node_version)"
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
  init_step_log "$OUT_ROOT/build.log"
  printf '%s' "$REPO" > "$OUT_ROOT/repo"

  log "Building p2code $version (base $(git rev-parse --short HEAD))"
  trap restore_generated_files EXIT

  local rust_dir="$REPO/native/resource-monitor/target/aarch64-apple-darwin/release"
  mkdir -p "$rust_dir"
  cp "$monitor_src/darwin-arm64/t3-resource-monitor" "$rust_dir/t3-resource-monitor"
  chmod 755 "$rust_dir/t3-resource-monitor"
  mkdir -p "$build_dir/resource-monitor"
  cp -R "$monitor_src/." "$build_dir/resource-monitor/"

  step "Aligning package versions" node scripts/update-release-package-versions.ts "$version"
  step "Building server, web client and desktop bundle" vp run build:desktop
  # The executable embeds the Node that runs `--build-sea`, so a shim makes `vp pack` run on it.
  local exe_node="node" exe_label="Node $sea_node" exe_path="$PATH" pc_node vp_shim
  pc_node="$(pointer_compressed_node "$sea_node")"
  if [[ -x "$pc_node" ]]; then
    vp_shim="$(mktemp -d)"
    printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$pc_node" "$REPO/node_modules/vite-plus/bin/vp" >"$vp_shim/vp"
    chmod 755 "$vp_shim/vp"
    exe_node="$pc_node"
    exe_label+=", pointer compression"
    exe_path="$vp_shim:$PATH"
  else
    log "No pointer-compressed Node $sea_node at $pc_node; using stock Node. Run p2code build-node to build it."
  fi
  step "Building server executable ($exe_label)" env PATH="$exe_path" VP_NODE_VERSION="$sea_node" "$exe_node" apps/server/scripts/cli.ts build-exe --verbose
  step "Stripping server executable" strip -x apps/server/dist-exe/t3
  step "Building launcher executable ($exe_label)" env PATH="$exe_path" VP_NODE_VERSION="$sea_node" "$exe_node" apps/server/scripts/cli.ts build-exe --launcher --verbose
  step "Stripping launcher executable" strip -x apps/server/dist-launcher/t3-launcher
  step "Packaging CLI archive" node scripts/build-cli-archive.ts \
    --platform "$TARGET_PLATFORM" \
    --arch "$TARGET_ARCH" \
    --version "$version" \
    --resource-monitor-dir "$build_dir/resource-monitor" \
    --output-dir "$build_dir/cli"
  local archive="$build_dir/cli/t3-$version-darwin-arm64.tar.gz"
  [[ -f "$archive" ]] || die "Expected archive $archive was not produced."

  step "Smoke-testing CLI archive" node scripts/smoke-cli-archive.ts --archive "$archive" --expect-version "$version"

  step "Packaging desktop app" env T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true T3CODE_DESKTOP_CLIENT_ONLY=true vp run dist:desktop:artifact \
    --platform "$TARGET_PLATFORM" \
    --target "$DESKTOP_TARGET" \
    --arch "$TARGET_ARCH" \
    --build-version "$version" \
    --output-dir "$build_dir/desktop" \
    --skip-build \
    --verbose

  local built_app
  built_app="$(find "$build_dir/desktop" -maxdepth 1 -name '*.app' | head -n 1)"
  [[ -n "$built_app" ]] || die "No .app was produced in $build_dir/desktop."

  begin "Verifying and signing desktop app"
  local app_dir="$build_dir/app"
  mkdir -p "$app_dir"
  mv "$built_app" "$app_dir/"
  local app
  app="$(find "$app_dir" -maxdepth 1 -name '*.app' | head -n 1)"
  [[ -n "$app" ]] || die "No .app in $app_dir."
  [[ "$(basename "$app" .app)" == "$INSTALLED_APP_NAME" ]] ||
    die "Built app is '$(basename "$app")', not '$INSTALLED_APP_NAME.app'; installing would leave two apps."
  [[ ! -e "$app/Contents/Resources/app-update.yml" ]] || die "Built app has an update feed (app-update.yml); it would auto-update to official builds."
  local app_executable
  app_executable="$(defaults read "$app/Contents/Info" CFBundleExecutable)"
  [[ "$(lipo -archs "$app/Contents/MacOS/$app_executable")" == "$TARGET_ARCH" ]] ||
    die "App executable is not $TARGET_ARCH only."
  local plist_version
  plist_version="$(defaults read "$app/Contents/Info" CFBundleShortVersionString)"
  [[ "$plist_version" == "$version" ]] || die "App reports version $plist_version, expected $version."
  grep -aq 'relay.t3.codes' "$app/Contents/Resources/app.asar" || die "relay.t3.codes is not baked into the desktop bundle."
  grep -arqs 'relay.t3.codes' "$REPO/apps/server/dist" || die "relay.t3.codes is not baked into the server bundle."
  rm -f "$app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/"{libvk_swiftshader.dylib,vk_swiftshader_icd.json}
  run codesign --force --deep --timestamp=none --sign "$SIGN_IDENTITY" "$app" || die "Signing with '$SIGN_IDENTITY' failed."
  run codesign --verify --deep --strict "$app" || die "Built app failed codesign verification."
  [[ "$(codesign -dv "$app" 2>&1 | sed -n 's/^Identifier=//p')" == "com.t3tools.t3code" ]] ||
    die "Signed app has an unexpected bundle identifier."
  end

  begin "Staging local release"
  local release_dir="$build_dir/release/v$version"
  mkdir -p "$release_dir"
  cp "$archive" "$release_dir/"
  (cd "$release_dir" && shasum -a 256 "t3-$version-darwin-arm64.tar.gz" > SHA256SUMS)
  end

  git -C "$REPO" rev-parse HEAD > "$build_dir/source-head"
  printf '%s' "$version" > "$OUT_ROOT/current"
  trap - EXIT
  restore_generated_files

  log "Build complete: $version"
  printf 'artifacts: %s\n' "$build_dir"
  printf 'log:       %s\n' "$STEP_LOG"
}

pick_free_port() {
  python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}

quit_app() {
  local pattern
  pattern="$(printf '%s' "$APPS_DIR/$INSTALLED_APP_NAME.app/Contents/MacOS/" | sed 's/[()]/\\&/g')"
  pgrep -f "$pattern" >/dev/null 2>&1 || return 0
  begin "Quitting $INSTALLED_APP_NAME"
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
  end
}

# Without this marker the old server deletes its tunnel on shutdown and the new one waits 1-2 minutes for a replacement to route.
# The server ignores a marker older than a minute, so touch it right before switching.
keep_tunnel_across_restart() {
  mkdir -p "$T3_HOME/runtime"
  : > "$T3_HOME/runtime/desktop-update-restart"
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
  local db name
  for db in "$T3_HOME"/userdata/*.sqlite; do
    [[ -f "$db" ]] || continue
    name="$(basename "$db")"
    if [[ "$name" == "server-owner.sqlite" ]]; then
      continue
    fi
    run sqlite3 -cmd ".timeout 30000" "$db" ".backup '$backup/userdata/$name'" || die "Could not back up $name."
  done
  cp "$T3_HOME"/userdata/*.json "$backup/userdata/" 2>/dev/null || true
  cp "$T3_HOME/runtime/service-state.json" "$backup/" 2>/dev/null || true
  cp "$HOME/Library/LaunchAgents/com.t3tools.t3code.service.plist" "$backup/" 2>/dev/null || true
  readlink "$HOME/.local/bin/t3" > "$backup/t3-symlink" 2>/dev/null || true
  active_version > "$backup/previous-version"
  if [[ -d "$APPS_DIR/$INSTALLED_APP_NAME.app" ]]; then
    run tar -czf "$backup/$INSTALLED_APP_NAME.app.tgz" -C "$APPS_DIR" "$INSTALLED_APP_NAME.app" || die "Could not back up the app."
  fi
}

cmd_setup_signing() {
  require_cmd security
  [[ "$SIGN_IDENTITY" != "-" ]] || die "P2CODE_SIGN_IDENTITY is '-', which signs ad hoc. There is nothing to set up."
  if signing_identity_present; then
    log "Signing identity '$SIGN_IDENTITY' already exists"
    return 0
  fi
  local work
  work="$(mktemp -d)"
  trap "rm -rf '$work'" EXIT
  cat > "$work/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $SIGN_IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/openssl.cnf" \
    -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null || die "Could not create the certificate."
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$SIGN_IDENTITY" \
    -out "$work/identity.p12" -passout pass:p2code || die "Could not package the certificate."
  security import "$work/identity.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P p2code -T /usr/bin/codesign >/dev/null ||
    die "Could not import the identity into the login keychain."
  log "Created signing identity '$SIGN_IDENTITY' in the login keychain"
  printf 'The next build may ask whether codesign can use its key: choose Always Allow.\n'
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

  init_step_log "$OUT_ROOT/install.log"

  local previous
  previous="$(active_version)"
  [[ -n "$previous" ]] || die "Could not read the active server version from $T3_HOME/runtime/service-state.json."
  local previous_t3="$T3_HOME/runtime/versions/$previous/t3"
  [[ -x "$previous_t3" ]] || die "Current server binary $previous_t3 is missing."

  printf '\nThis will:\n'
  printf '  - back up databases, settings and %s.app to %s/backups\n' "$INSTALLED_APP_NAME" "$OUT_ROOT"
  printf '  - quit %s\n' "$INSTALLED_APP_NAME"
  printf '  - switch the background server %s -> %s (restarts it; running agent turns and terminals stop)\n' "$previous" "$version"
  printf '  - replace %s/%s.app with the new build (left closed)\n' "$APPS_DIR" "$INSTALLED_APP_NAME"
  if [[ "$(app_requirement "$built_app")" != "$(app_requirement "$APPS_DIR/$INSTALLED_APP_NAME.app")" ]]; then
    printf '  - expect a keychain prompt for "%s Safe Storage" (choose Always Allow) and a T3 Connect sign-in: the signing identity changed\n' "$INSTALLED_APP_NAME"
  fi
  printf '  - after the backup and again at the end, delete older builds, backups and downloaded server versions, keeping what rollback needs (p2code prune --dry-run lists them)\n\n'
  confirm "Continue?" || die "Cancelled."

  local backup="$OUT_ROOT/backups/$(date +%Y%m%d-%H%M%S)"
  begin "Backing up state"
  backup_state "$backup"
  printf '%s' "$version" > "$backup/installed-version"
  end
  prune_all || true

  quit_app

  begin "Switching background server to $version"
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
  keep_tunnel_across_restart
  must "t3 update failed. Nothing was replaced yet; reopen $INSTALLED_APP_NAME. Backup: $backup." \
    env T3CODE_RELEASE_BASE_URL="http://127.0.0.1:$port" "$previous_t3" update "$version" --yes
  kill "$HTTP_PID" 2>/dev/null || true
  trap - EXIT

  repoint_launcher "$version"

  tries=0
  until pgrep -f "runtime/versions/$version/t3" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [[ "$tries" -lt 60 ]] || die "Server $version is not running. Run: scripts/p2code.sh rollback"
    sleep 1
  done
  run "$T3_HOME/runtime/versions/$version/t3" service status || true
  end

  begin "Replacing $INSTALLED_APP_NAME"
  rm -rf "$APPS_DIR/$INSTALLED_APP_NAME.app"
  ditto "$built_app" "$APPS_DIR/$INSTALLED_APP_NAME.app"
  xattr -cr "$APPS_DIR/$INSTALLED_APP_NAME.app"
  end

  if [[ -f "$build_dir/source-head" ]]; then
    cp "$build_dir/source-head" "$OUT_ROOT/installed-head"
  fi

  log "Installed p2code $version"
  printf 'backup:   %s\n' "$backup"
  printf 'rollback: %s/scripts/p2code.sh rollback\n' "$REPO"

  DRY_RUN=0
  prune_all || true
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
  init_step_log "$OUT_ROOT/rollback.log"

  quit_app

  keep_tunnel_across_restart
  step "Switching background server back to $previous" "$T3_HOME/runtime/versions/$previous/t3" update "$previous" --allow-downgrade --yes
  repoint_launcher "$previous"

  if [[ -f "$backup/$INSTALLED_APP_NAME.app.tgz" ]]; then
    begin "Restoring $INSTALLED_APP_NAME"
    rm -rf "$APPS_DIR/$INSTALLED_APP_NAME.app"
    tar -xzf "$backup/$INSTALLED_APP_NAME.app.tgz" -C "$APPS_DIR"
    end
  fi

  log "Rolled back"
  printf 'Databases were not restored. If the new server changed them, copy from %s/userdata with the server stopped.\n' "$backup"
}

human_kb() {
  awk -v kb="$1" 'BEGIN { if (kb >= 1048576) printf "%.1f GB", kb / 1048576; else printf "%.0f MB", kb / 1024 }'
}

prune_old() {
  local dir="$1" keep="$2" running_check="$3"
  shift 3
  [[ -d "$dir" ]] || return 0
  local running="" name path kb seen=0
  [[ "$running_check" != "1" ]] || running="$(ps -axo command=)"
  while IFS= read -r name; do
    path="$dir/$name"
    [[ -n "$name" && -d "$path" ]] || continue
    seen=$((seen + 1))
    [[ "$seen" -gt "$keep" ]] || continue
    case " $* " in *" $name "*) continue ;; esac
    [[ -z "$running" || "$running" != *"/$name/"* ]] || continue
    kb="$(du -sk "$path" 2>/dev/null | cut -f1 || true)"
    kb="${kb:-0}"
    if [[ "$DRY_RUN" == "1" ]]; then
      printf '  would delete %s (%s)\n' "$path" "$(human_kb "$kb")"
    else
      rm -rf "$path"
    fi
    PRUNE_COUNT=$((PRUNE_COUNT + 1))
    PRUNE_KB=$((PRUNE_KB + kb))
  done < <(ls -1t "$dir")
}

prune_all() {
  PRUNE_COUNT=0
  PRUNE_KB=0
  local active current latest_backup previous=""
  active="$(active_version)"
  current="$(cat "$OUT_ROOT/current" 2>/dev/null || true)"
  latest_backup="$(find "$OUT_ROOT/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1)"
  [[ -z "$latest_backup" ]] || previous="$(cat "$latest_backup/previous-version" 2>/dev/null || true)"

  prune_old "$OUT_ROOT/builds" "$KEEP_BUILDS" 0 "$current" "$active"
  prune_old "$OUT_ROOT/backups" "$KEEP_BACKUPS" 0
  if [[ -n "$active" ]]; then
    prune_old "$T3_HOME/runtime/versions" "$KEEP_RUNTIME_VERSIONS" 1 "$active" "$previous" "$current"
  else
    printf 'Skipping server versions: could not read the active version from %s/runtime/service-state.json.\n' "$T3_HOME"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s items would be deleted, freeing %s.\n' "$PRUNE_COUNT" "$(human_kb "$PRUNE_KB")"
  else
    printf 'Deleted %s items, freed %s.\n' "$PRUNE_COUNT" "$(human_kb "$PRUNE_KB")"
  fi
}

cmd_prune() {
  DRY_RUN=1
  prune_all
  [[ "$PRUNE_COUNT" -gt 0 && "${REQUEST_DRY_RUN:-0}" != "1" ]] || return 0
  confirm "Delete these?" || die "Cancelled."
  DRY_RUN=0
  prune_all
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
      --verbose|-v) VERBOSE=1 ;;
      --dry-run|-n) REQUEST_DRY_RUN=1 ;;
      *) die "Unknown option: $arg" ;;
    esac
  done
  case "$command" in
    build) cmd_build ;;
    install) cmd_install ;;
    all) cmd_build; cmd_install ;;
    rollback) cmd_rollback ;;
    setup-signing) cmd_setup_signing ;;
    prune) cmd_prune ;;
    build-node) cmd_build_node ;;
    in-t3) inside_t3_code ;;
    version) compute_version; printf '\n' ;;
    *) usage; [[ -z "$command" || "$command" == "help" ]] || exit 1 ;;
  esac
}

main "$@"; exit $?
