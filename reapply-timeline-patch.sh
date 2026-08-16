#!/bin/bash
# Re-apply the windowed-timeline patch to the installed bb app.
#
# This patches a build artifact inside /Applications/bb.app, so ANY bb update
# replaces it and the lag comes back. Run this after an update — but only while
# the installed version still matches what the patch was built against, because
# the bundle is a whole-directory swap, not a merge.
#
# Origin: PR get-bb/bb#1384 (timeline virtualization) grafted onto the
# desktop-v0.38.0 tag, minus the post-0.38.0 schema the upstream branch carried.
# Branch: mobile-timeline-on-0.38.0
set -euo pipefail

BUILT_FOR="0.38.0"
REPO="/Users/samberan/Code/bb-src"
SRC="$REPO/apps/app/dist"
INST="/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/app/dist"
PKG="/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/package.json"
BACKUP="/Users/samberan/Code/bb-app-dist-backup-$BUILT_FOR"

installed=$(grep -o '"version": *"[^"]*"' "$PKG" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
if [ "$installed" != "$BUILT_FOR" ]; then
  echo "REFUSING: bb is $installed but this patch was built against $BUILT_FOR."
  echo "Rebuild first:"
  echo "  cd $REPO && git checkout mobile-timeline-on-0.38.0"
  echo "  git rebase desktop-v$installed   # then resolve, and re-run pnpm build"
  exit 1
fi

if [ ! -d "$SRC/assets" ]; then
  echo "REFUSING: no build output at $SRC. Run 'pnpm build' in $REPO first."
  exit 1
fi

# Keep a pristine copy of whatever is installed right now, so restore is always
# one command away even after several updates.
if [ ! -d "$BACKUP" ]; then
  cp -R "$INST" "$BACKUP"
  echo "backed up stock bundle -> $BACKUP"
fi

rsync -a --delete "$SRC/" "$INST/"
entry=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$INST/index.html" | head -1)
echo "patched. serving entry: $entry"
echo "bb serves these from disk, so just force-quit and relaunch the PWA."
echo
echo "To undo:  rsync -a --delete $BACKUP/ $INST/"
