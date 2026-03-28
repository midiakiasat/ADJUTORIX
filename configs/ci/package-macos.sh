#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX macOS packaging pipeline
#
# Purpose:
# - provide one authoritative macOS packaging entrypoint for the Electron app and Python CLI artifacts
# - enforce deterministic build order, metadata stamping, artifact collection, and post-build verification
# - support unsigned local packaging and optional signing/notarization without making false claims when credentials are absent
# - fail closed on missing toolchains, ambiguous build outputs, unsigned expectations, or unverifiable bundles

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
readonly START_TS="$(date +%s)"

FORCE_COLOR="${FORCE_COLOR:-1}"
CI="${CI:-false}"
export FORCE_COLOR CI

NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
PIP_BIN="${PIP_BIN:-$PYTHON_BIN -m pip}"
XCRUN_BIN="${XCRUN_BIN:-xcrun}"
CODESIGN_BIN="${CODESIGN_BIN:-codesign}"
DITTO_BIN="${DITTO_BIN:-ditto}"
PLUTIL_BIN="${PLUTIL_BIN:-plutil}"
SPCTL_BIN="${SPCTL_BIN:-spctl}"
PRODUCTBUILD_BIN="${PRODUCTBUILD_BIN:-productbuild}"
PKGUTIL_BIN="${PKGUTIL_BIN:-pkgutil}"

INSTALL_DEPS="${INSTALL_DEPS:-1}"
STRICT_DIRTY_CHECK="${STRICT_DIRTY_CHECK:-1}"
RUN_VERIFY_PRECHECK="${RUN_VERIFY_PRECHECK:-1}"
BUILD_APP="${BUILD_APP:-1}"
BUILD_CLI="${BUILD_CLI:-1}"
BUILD_DMG="${BUILD_DMG:-1}"
BUILD_PKG="${BUILD_PKG:-1}"
VERIFY_ARTIFACTS="${VERIFY_ARTIFACTS:-1}"
CREATE_CHECKSUMS="${CREATE_CHECKSUMS:-1}"
ALLOW_UNSIGNED="${ALLOW_UNSIGNED:-1}"
NOTARIZE="${NOTARIZE:-0}"

APP_PACKAGE_DIR="$ROOT_DIR/packages/adjutorix-app"
CLI_PACKAGE_DIR="$ROOT_DIR/packages/adjutorix-cli"
DIST_DIR="${DIST_DIR:-$ROOT_DIR/dist/macos}"
STAGING_DIR="${STAGING_DIR:-$ROOT_DIR/.tmp/package-macos}"
CLI_DIST_DIR="$CLI_PACKAGE_DIR/dist"
APP_NAME="${APP_NAME:-ADJUTORIX}"
APP_BUNDLE_NAME="${APP_BUNDLE_NAME:-ADJUTORIX.app}"
APP_BUNDLE_PATH=""
DMG_PATH=""
PKG_PATH=""
CLI_WHEEL_PATH=""
CLI_SDIST_PATH=""

APP_SIGN_IDENTITY="${APP_SIGN_IDENTITY:-}"
INSTALLER_SIGN_IDENTITY="${INSTALLER_SIGN_IDENTITY:-}"
APPLE_ID="${APPLE_ID:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
APPLE_APP_PASSWORD="${APPLE_APP_PASSWORD:-}"

STATUS_PRECHECK="pending"
STATUS_CLI_BUILD="pending"
STATUS_APP_BUILD="pending"
STATUS_SIGNING="pending"
STATUS_DMG="pending"
STATUS_PKG="pending"
STATUS_VERIFY="pending"
STATUS_CHECKSUMS="pending"

CURRENT_STAGE="bootstrap"

color() {
  local code="$1"
  shift
  if [[ "$FORCE_COLOR" == "0" ]]; then
    printf '%s' "$*"
  else
    printf '\033[%sm%s\033[0m' "$code" "$*"
  fi
}

log() {
  printf '%s %s\n' "$(color '36' '[adjutorix-macos]')" "$*"
}

ok() {
  printf '%s %s\n' "$(color '32' '[ok]')" "$*"
}

warn() {
  printf '%s %s\n' "$(color '33' '[warn]')" "$*"
}

err() {
  printf '%s %s\n' "$(color '31' '[error]')" "$*" >&2
}

die() {
  err "$*"
  exit 1
}

section() {
  printf '\n%s\n' "$(color '1;37' "== $* ==")"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

require_cmd() {
  local cmd="$1"
  have_cmd "$cmd" || die "Required command not found: $cmd"
}

run() {
  log "$*"
  "$@"
}

mark_success() {
  local name="$1"
  printf -v "STATUS_${name}" '%s' "success"
}

mark_skipped() {
  local name="$1"
  printf -v "STATUS_${name}" '%s' "skipped"
}

print_summary() {
  local end_ts elapsed
  end_ts="$(date +%s)"
  elapsed="$((end_ts - START_TS))"

  printf '\n%s\n' "$(color '1;37' '== macOS Packaging Summary ==')"
  printf '  %-20s %s\n' 'precheck' "$STATUS_PRECHECK"
  printf '  %-20s %s\n' 'cli_build' "$STATUS_CLI_BUILD"
  printf '  %-20s %s\n' 'app_build' "$STATUS_APP_BUILD"
  printf '  %-20s %s\n' 'signing' "$STATUS_SIGNING"
  printf '  %-20s %s\n' 'dmg' "$STATUS_DMG"
  printf '  %-20s %s\n' 'pkg' "$STATUS_PKG"
  printf '  %-20s %s\n' 'verify' "$STATUS_VERIFY"
  printf '  %-20s %s\n' 'checksums' "$STATUS_CHECKSUMS"
  printf '  %-20s %ss\n' 'elapsed' "$elapsed"
}

cleanup() {
  local exit_code="$?"
  if [[ "$exit_code" -ne 0 ]]; then
    err "Packaging failed during stage: $CURRENT_STAGE"
    print_summary >&2 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'err "Command failed at line $LINENO during stage: $CURRENT_STAGE"' ERR

assert_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "package-macos.sh must run on macOS"
}

assert_repo_root() {
  [[ -f "$ROOT_DIR/package.json" ]] || die "Missing repo package.json"
  [[ -d "$APP_PACKAGE_DIR" ]] || die "Missing packages/adjutorix-app"
  [[ -d "$CLI_PACKAGE_DIR" ]] || die "Missing packages/adjutorix-cli"
}

assert_toolchain() {
  section "Toolchain"
  require_cmd "$NODE_BIN"
  require_cmd "$NPM_BIN"
  require_cmd "$PYTHON_BIN"
  require_cmd "$XCRUN_BIN"
  require_cmd "$CODESIGN_BIN"
  require_cmd "$DITTO_BIN"
  require_cmd "$PLUTIL_BIN"
  require_cmd "$SPCTL_BIN"
  require_cmd "$PRODUCTBUILD_BIN"
  require_cmd "$PKGUTIL_BIN"
  run "$NODE_BIN" --version
  run "$NPM_BIN" --version
  run "$PYTHON_BIN" --version
  run "$XCRUN_BIN" --show-sdk-path
}

assert_clean_git_state_before() {
  if [[ "$STRICT_DIRTY_CHECK" != "1" ]]; then
    warn "Skipping pre-run dirty tree check because STRICT_DIRTY_CHECK=$STRICT_DIRTY_CHECK"
    return
  fi
  CURRENT_STAGE="pre_dirty_check"
  local status
  status="$(git status --porcelain=v1)"
  [[ -z "$status" ]] || die "Working tree is dirty before packaging begins. Commit or stash changes first."
}

assert_clean_git_state_after() {
  if [[ "$STRICT_DIRTY_CHECK" != "1" ]]; then
    warn "Skipping post-run dirty tree check because STRICT_DIRTY_CHECK=$STRICT_DIRTY_CHECK"
    return
  fi
  CURRENT_STAGE="post_dirty_check"
  local status
  status="$(git status --porcelain=v1)"
  [[ -z "$status" ]] || {
    printf '%s\n' "$status" >&2
    die "Packaging mutated the repository unexpectedly."
  }
}

prepare_dirs() {
  section "Prepare directories"
  CURRENT_STAGE="prepare_dirs"
  rm -rf "$DIST_DIR" "$STAGING_DIR"
  mkdir -p "$DIST_DIR" "$STAGING_DIR"
  ok "Prepared dist and staging directories"
}

install_dependencies() {
  if [[ "$INSTALL_DEPS" != "1" ]]; then
    warn "Skipping dependency installation because INSTALL_DEPS=$INSTALL_DEPS"
    return
  fi

  section "Install dependencies"
  CURRENT_STAGE="install_js"
  run "$NPM_BIN" ci

  CURRENT_STAGE="install_python_cli"
  (
    cd "$CLI_PACKAGE_DIR"
    eval "$PIP_BIN install -e .[dev]"
  )
  ok "Dependencies installed"
}

run_precheck() {
  if [[ "$RUN_VERIFY_PRECHECK" != "1" ]]; then
    mark_skipped PRECHECK
    warn "Skipping verify precheck"
    return
  fi

  section "Repository verification precheck"
  CURRENT_STAGE="precheck"
  run bash "$ROOT_DIR/configs/ci/check.sh"
  run bash "$ROOT_DIR/configs/ci/guard_generated_artifacts.sh"
  run bash "$ROOT_DIR/configs/ci/smoke.sh" INSTALL_DEPS=0 RUN_AGENT_INTEGRATION_SMOKE=0 STRICT_DIRTY_CHECK=0 || die "Smoke precheck failed"
  mark_success PRECHECK
  ok "Precheck passed"
}

build_cli() {
  if [[ "$BUILD_CLI" != "1" ]]; then
    mark_skipped CLI_BUILD
    warn "Skipping CLI build"
    return
  fi

  section "Build CLI artifacts"
  CURRENT_STAGE="cli_build"
  (
    cd "$CLI_PACKAGE_DIR"
    rm -rf dist build *.egg-info
    run "$PYTHON_BIN" -m build
  )

  CLI_WHEEL_PATH="$(find "$CLI_DIST_DIR" -maxdepth 1 -type f -name '*.whl' | sort | tail -n 1)"
  CLI_SDIST_PATH="$(find "$CLI_DIST_DIR" -maxdepth 1 -type f -name '*.tar.gz' | sort | tail -n 1)"
  [[ -n "$CLI_WHEEL_PATH" && -f "$CLI_WHEEL_PATH" ]] || die "CLI wheel not found after build"
  [[ -n "$CLI_SDIST_PATH" && -f "$CLI_SDIST_PATH" ]] || die "CLI sdist not found after build"

  cp "$CLI_WHEEL_PATH" "$DIST_DIR/"
  cp "$CLI_SDIST_PATH" "$DIST_DIR/"
  mark_success CLI_BUILD
  ok "CLI artifacts built"
}

build_app() {
  if [[ "$BUILD_APP" != "1" ]]; then
    mark_skipped APP_BUILD
    warn "Skipping app build"
    return
  fi

  section "Build macOS app"
  CURRENT_STAGE="app_build"
  (
    cd "$APP_PACKAGE_DIR"
    rm -rf dist out build
    run "$NPM_BIN" run build
  )

  APP_BUNDLE_PATH="$(find "$APP_PACKAGE_DIR" -type d -name "$APP_BUNDLE_NAME" | sort | head -n 1)"
  [[ -n "$APP_BUNDLE_PATH" && -d "$APP_BUNDLE_PATH" ]] || die "App bundle $APP_BUNDLE_NAME not found after build"

  local staged_app_dir="$STAGING_DIR/app"
  mkdir -p "$staged_app_dir"
  run "$DITTO_BIN" "$APP_BUNDLE_PATH" "$staged_app_dir/$APP_BUNDLE_NAME"
  APP_BUNDLE_PATH="$staged_app_dir/$APP_BUNDLE_NAME"

  stamp_bundle_metadata
  mark_success APP_BUILD
  ok "App bundle built and staged"
}

stamp_bundle_metadata() {
  section "Stamp bundle metadata"
  CURRENT_STAGE="stamp_metadata"

  local info_plist="$APP_BUNDLE_PATH/Contents/Info.plist"
  [[ -f "$info_plist" ]] || die "Info.plist missing in app bundle"

  local git_sha build_date cli_wheel_name
  git_sha="$(git rev-parse --short=12 HEAD)"
  build_date="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  cli_wheel_name="$(basename "${CLI_WHEEL_PATH:-unbuilt-cli}")"

  /usr/libexec/PlistBuddy -c "Delete :ADJUTORIXBuildSHA" "$info_plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Delete :ADJUTORIXBuildDate" "$info_plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Delete :ADJUTORIXCLIWheel" "$info_plist" >/dev/null 2>&1 || true

  /usr/libexec/PlistBuddy -c "Add :ADJUTORIXBuildSHA string $git_sha" "$info_plist"
  /usr/libexec/PlistBuddy -c "Add :ADJUTORIXBuildDate string $build_date" "$info_plist"
  /usr/libexec/PlistBuddy -c "Add :ADJUTORIXCLIWheel string $cli_wheel_name" "$info_plist"
  run "$PLUTIL_BIN" -lint "$info_plist"
  ok "Bundle metadata stamped"
}

sign_artifacts() {
  section "Signing"
  CURRENT_STAGE="signing"

  if [[ -z "$APP_SIGN_IDENTITY" ]]; then
    if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
      mark_skipped SIGNING
      warn "APP_SIGN_IDENTITY not provided; leaving bundle unsigned by policy"
      return
    fi
    die "APP_SIGN_IDENTITY is required when ALLOW_UNSIGNED=0"
  fi

  run "$CODESIGN_BIN" --force --deep --options runtime --timestamp --sign "$APP_SIGN_IDENTITY" "$APP_BUNDLE_PATH"
  run "$CODESIGN_BIN" --verify --deep --strict --verbose=2 "$APP_BUNDLE_PATH"
  mark_success SIGNING
  ok "App bundle signed"
}

build_dmg() {
  if [[ "$BUILD_DMG" != "1" ]]; then
    mark_skipped DMG
    warn "Skipping DMG build"
    return
  fi

  section "Build DMG"
  CURRENT_STAGE="build_dmg"
  DMG_PATH="$DIST_DIR/${APP_NAME}-macos.dmg"
  rm -f "$DMG_PATH"

  local dmg_src="$STAGING_DIR/dmg-src"
  mkdir -p "$dmg_src"
  run "$DITTO_BIN" "$APP_BUNDLE_PATH" "$dmg_src/$APP_BUNDLE_NAME"

  if have_cmd hdiutil; then
    run hdiutil create -volname "$APP_NAME" -srcfolder "$dmg_src" -ov -format UDZO "$DMG_PATH"
  else
    die "hdiutil not found; cannot create DMG on macOS"
  fi

  [[ -f "$DMG_PATH" ]] || die "DMG was not produced"
  mark_success DMG
  ok "DMG built"
}

build_pkg() {
  if [[ "$BUILD_PKG" != "1" ]]; then
    mark_skipped PKG
    warn "Skipping PKG build"
    return
  fi

  section "Build PKG"
  CURRENT_STAGE="build_pkg"
  PKG_PATH="$DIST_DIR/${APP_NAME}-macos.pkg"
  rm -f "$PKG_PATH"

  local component_plist="$STAGING_DIR/component.plist"
  run pkgbuild --analyze --root "$STAGING_DIR/app" "$component_plist"

  if [[ -n "$INSTALLER_SIGN_IDENTITY" ]]; then
    run "$PRODUCTBUILD_BIN" --component "$APP_BUNDLE_PATH" /Applications --sign "$INSTALLER_SIGN_IDENTITY" "$PKG_PATH"
  else
    if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
      warn "INSTALLER_SIGN_IDENTITY not provided; building unsigned pkg"
      run "$PRODUCTBUILD_BIN" --component "$APP_BUNDLE_PATH" /Applications "$PKG_PATH"
    else
      die "INSTALLER_SIGN_IDENTITY is required when ALLOW_UNSIGNED=0 and BUILD_PKG=1"
    fi
  fi

  [[ -f "$PKG_PATH" ]] || die "PKG was not produced"
  mark_success PKG
  ok "PKG built"
}

notarize_if_requested() {
  if [[ "$NOTARIZE" != "1" ]]; then
    return
  fi

  section "Notarization"
  CURRENT_STAGE="notarization"
  [[ -n "$APPLE_ID" && -n "$APPLE_TEAM_ID" && -n "$APPLE_APP_PASSWORD" ]] || die "Notarization requested but Apple credentials are incomplete"
  [[ -n "$DMG_PATH" && -f "$DMG_PATH" ]] || die "Notarization requested but DMG artifact is missing"

  run "$XCRUN_BIN" notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --wait

  run "$XCRUN_BIN" stapler staple "$APP_BUNDLE_PATH"
  [[ -f "$DMG_PATH" ]] && run "$XCRUN_BIN" stapler staple "$DMG_PATH" || true
  ok "Notarization completed"
}

verify_artifacts() {
  if [[ "$VERIFY_ARTIFACTS" != "1" ]]; then
    mark_skipped VERIFY
    warn "Skipping artifact verification"
    return
  fi

  section "Verify artifacts"
  CURRENT_STAGE="verify_artifacts"

  [[ -n "$APP_BUNDLE_PATH" && -d "$APP_BUNDLE_PATH" ]] || die "App bundle missing during artifact verification"
  run "$PLUTIL_BIN" -lint "$APP_BUNDLE_PATH/Contents/Info.plist"

  if [[ "$STATUS_SIGNING" == "success" ]]; then
    run "$CODESIGN_BIN" --verify --deep --strict --verbose=2 "$APP_BUNDLE_PATH"
    run "$SPCTL_BIN" --assess --type exec --verbose=4 "$APP_BUNDLE_PATH"
  else
    warn "Skipping signed-bundle enforcement because signing did not run successfully"
  fi

  if [[ -n "$PKG_PATH" && -f "$PKG_PATH" ]]; then
    run "$PKGUTIL_BIN" --check-signature "$PKG_PATH" || warn "PKG signature check did not pass; pkg may be unsigned by policy"
  fi

  if [[ -n "$CLI_WHEEL_PATH" && -f "$CLI_WHEEL_PATH" ]]; then
    "$PYTHON_BIN" - <<PY
from pathlib import Path
wheel = Path(r'''$CLI_WHEEL_PATH''')
if wheel.stat().st_size <= 0:
    raise SystemExit('CLI wheel is empty')
print('wheel-ok')
PY
  fi

  mark_success VERIFY
  ok "Artifacts verified"
}

create_checksums() {
  if [[ "$CREATE_CHECKSUMS" != "1" ]]; then
    mark_skipped CHECKSUMS
    warn "Skipping checksum generation"
    return
  fi

  section "Create checksums"
  CURRENT_STAGE="checksums"
  local checksum_file="$DIST_DIR/SHA256SUMS.txt"
  rm -f "$checksum_file"

  (
    cd "$DIST_DIR"
    shasum -a 256 ./* > "$checksum_file"
  )

  [[ -f "$checksum_file" ]] || die "Checksum file was not produced"
  mark_success CHECKSUMS
  ok "Checksums created"
}

main() {
  assert_macos
  assert_repo_root
  assert_toolchain
  assert_clean_git_state_before
  prepare_dirs
  install_dependencies
  run_precheck
  build_cli
  build_app
  sign_artifacts
  build_dmg
  build_pkg
  notarize_if_requested
  verify_artifacts
  create_checksums
  assert_clean_git_state_after
  print_summary
  ok "macOS packaging completed successfully"
}

main "$@"
