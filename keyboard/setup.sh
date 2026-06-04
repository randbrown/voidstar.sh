#!/usr/bin/env bash
# voidstar-keyboard setup: clone a FUTO Keyboard fork, apply the voidstar
# personalization patch, and drop in the custom layout. Run on a machine that has the
# Android SDK + NDK + Java 21, and network access to github.com AND gitlab.futo.org
# (FUTO keeps several build-critical submodules on their GitLab).
#
# Usage:
#   ./setup.sh [git-url]
# Defaults to your fork; falls back to upstream FUTO if you haven't forked yet.
set -euo pipefail

REPO_URL="${1:-https://github.com/randbrown/voidstar-keyboard.git}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${DEST:-voidstar-keyboard}"

echo ">> Cloning $REPO_URL (with submodules) into $DEST"
if ! git clone --recurse-submodules "$REPO_URL" "$DEST"; then
  echo "!! Clone failed. If you haven't forked yet, fork futo-org/android-keyboard on"
  echo "!! GitHub -> randbrown/voidstar-keyboard, or run: ./setup.sh https://github.com/futo-org/android-keyboard.git"
  exit 1
fi

cd "$DEST"

echo ">> Applying voidstar personalization patch (3-way fallback if context drifted)"
git apply --3way "$HERE/patches/0001-voidstar-personalization-defaults.patch" \
  || { echo "!! Patch did not apply cleanly. The four anchor strings are listed in"
       echo "!! keyboard/README.md -> 'What this fork changes'. Reapply by hand."; exit 1; }

echo ">> Installing custom layout canvas"
mkdir -p java/assets/layouts/Voidstar
cp "$HERE/layouts/voidstar.yaml" java/assets/layouts/Voidstar/voidstar.yaml

cat <<'EOF'

>> Done. Next:
   ./gradlew tasks | grep -i assemble        # find the right APK variant for your checkout
   ./gradlew :assembleUnstableDebug          # (example) build a debug APK
   adb install -r java/build/outputs/apk/**/futo-keyboard-*.apk

   Then on the S26U: Settings -> General management -> Keyboard list and default ->
   enable "voidstar" / FUTO, set as default. Arrow row + personal-LM learning are
   already on. Fine-tune autocorrect under the keyboard's own Settings -> Typing.
EOF
