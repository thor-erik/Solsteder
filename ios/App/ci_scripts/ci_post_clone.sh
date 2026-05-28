#!/bin/sh

# Xcode Cloud post-clone hook.
#
# Xcode Cloud checks out only the git repo; node_modules is gitignored, so the
# Capacitor + Capgo SwiftPM packages (referenced via local paths under
# node_modules/) cannot resolve and the build fails at "Could not resolve
# package dependencies". Install Node + JS deps and run cap sync here, before
# Xcode resolves packages, so node_modules/ and www/ exist.

set -e

# Xcode Cloud images don't ship Node — install via the preinstalled Homebrew.
which node >/dev/null 2>&1 || brew install node
export PATH="/opt/homebrew/bin:$PATH"

# Repo root provided by Xcode Cloud.
cd "$CI_PRIMARY_REPOSITORY_PATH"

npm ci
npm run build          # builds www/ from the repo
npx cap sync ios       # copies www/ into the iOS project + resolves SPM
