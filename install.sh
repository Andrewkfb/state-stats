#!/bin/zsh
#
# Copies the plugin into the Foundry vault. This repo is the source of truth;
# the copy under .obsidian/plugins is installed output.
#
# After running, use "Reload app without saving" in Obsidian to pick it up.

VAULT="${1:-$HOME/Documents/Foundry}"
DEST="$VAULT/.obsidian/plugins/state-stats"

if [ ! -d "$VAULT/.obsidian" ]; then
  echo "Not an Obsidian vault: $VAULT"
  echo "Usage: sh install.sh [path-to-vault]"
  exit 1
fi

mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/" || exit 1
echo "Installed to $DEST"
echo "Reload Obsidian to pick it up. Settings in data.json are left alone."
