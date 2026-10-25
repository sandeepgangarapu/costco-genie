#!/bin/sh

# Downloaded from the repository's raw URL; no account settings belong here.
set -eu

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [ "$(uname -s)" != Darwin ]; then
  fail 'Costco Genie currently requires macOS (Chrome, notifications, and launchd).'
fi

if ! command -v git >/dev/null 2>&1 || ! xcode-select -p >/dev/null 2>&1; then
  fail 'Install Apple Command Line Tools: run xcode-select --install, finish the installation, then run this installer again.'
fi

nvm_directory=${NVM_DIR:-"$HOME/.nvm"}
if [ ! -s "$nvm_directory/nvm.sh" ]; then
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! node -e '
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1);
  '; then
    fail 'Install Node.js 22.13.0 or newer with npm from https://nodejs.org/en/download, reopen Terminal, then run this installer again. Existing NVM installations are also supported.'
  fi
fi

if [ ! -x '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ] &&
   [ ! -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  fail 'Install Google Chrome from https://www.google.com/chrome/, then run this installer again. A signed-in Costco session in a dedicated Chrome profile is required.'
fi

repository_url=https://github.com/sandeepgangarapu/costco-genie.git
install_directory=${COSTCO_INSTALL_DIR:-"$HOME/costco-genie"}
case "$install_directory" in
  /*) ;;
  *) fail 'COSTCO_INSTALL_DIR must be an absolute path.' ;;
esac

# Recognize the old checkout without moving it or creating a second installation.
legacy_directory="$HOME/costco-price-matcher"
if [ -z "${COSTCO_INSTALL_DIR:-}" ] &&
   { [ -e "$legacy_directory" ] || [ -L "$legacy_directory" ]; }; then
  fail "A legacy Costco checkout already exists: $legacy_directory
Update that checkout to Costco Genie and run ./costco setup there, or move it yourself to ~/costco-genie first.
Reinstall the LaunchAgent after any move with ./costco install-agent.
For a separate checkout, set COSTCO_INSTALL_DIR to a new absolute path. No files were moved."
fi

# Refuse existing paths, including links. Updates use the checkout's own launcher.
if [ -e "$install_directory" ] || [ -L "$install_directory" ]; then
  fail "The destination already exists: $install_directory
To continue an existing installation, open that folder in Terminal and run ./costco setup.
For a separate checkout, set COSTCO_INSTALL_DIR to a new absolute path."
fi

printf 'Downloading Costco Genie to %s\n' "$install_directory"
git clone --depth 1 --branch main --single-branch -- "$repository_url" "$install_directory"
cd "$install_directory"
printf '%s\n' 'Installing dependencies and building the app. The first setup may take a few minutes.'

# curl | sh consumes stdin; the wizard needs the user's terminal instead.
if [ -t 1 ] && ( : </dev/tty ) 2>/dev/null; then
  ./costco setup </dev/tty
else
  ./costco setup --no-same-day
fi

printf '\n%s\n' \
  'Setup is ready. Your Costco login is the next step:' \
  "1. Open $install_directory in Terminal." \
  '2. Run ./costco login, sign in to Costco yourself (including MFA/CAPTCHA), then close the dedicated Chrome window.' \
  '3. Run ./costco run, then open ~/.costco-genie/reports/latest.html.' \
  '4. Optional: run ./costco install-agent for automatic daily checks.' \
  'Run ./costco setup any time to change your optional ZIP, address, or email.'
