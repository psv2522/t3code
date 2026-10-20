# The owner's shell exports pnpm_config_pm_on_fail=ignore; p2code must run upstream's
# packageManager pnpm, or pnpm 12 rewrites every peer suffix in pnpm-lock.yaml.
export pnpm_config_pm_on_fail=download

VERBOSE="${P2CODE_VERBOSE:-0}"
STEP_LOG=/dev/null
STEP_LABEL=""
STEP_START=0

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

init_step_log() {
  mkdir -p "$(dirname "$1")"
  : > "$1"
  STEP_LOG="$1"
}

begin() {
  STEP_LABEL="$1"
  STEP_START=$SECONDS
  printf '\n### %s\n' "$1" >>"$STEP_LOG"
  if [[ "$VERBOSE" == "1" ]]; then
    log "$1"
  else
    printf '  %s ... ' "$1"
  fi
}

end() {
  [[ "$VERBOSE" == "1" ]] || printf 'done (%ds)\n' "$((SECONDS - STEP_START))"
}

run() {
  if [[ "$VERBOSE" == "1" ]]; then
    "$@"
  else
    "$@" >>"$STEP_LOG" 2>&1
  fi
}

must() {
  local message="$1"
  shift
  if ! run "$@"; then
    if [[ "$VERBOSE" != "1" ]]; then
      printf 'FAILED\n' >&2
      tail -n 40 "$STEP_LOG" >&2
    fi
    die "$message Log: $STEP_LOG"
  fi
}

step() {
  local label="$1"
  shift
  begin "$label"
  must "$label failed." "$@"
  end
}
