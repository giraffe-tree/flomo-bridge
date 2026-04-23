#!/bin/bash

# 一键部署 Flomo Bridge 插件到本地 Obsidian vault

VAULT_DIR="/Users/giraffetree/Documents/giraffetree/project/code/ideas/thinking-flomo"
PLUGIN_DIR="$VAULT_DIR/.obsidian/plugins/flomo-bridge"

echo "Deploying Flomo Bridge to local vault..."
echo "Vault: $VAULT_DIR"

if [ ! -d "$VAULT_DIR" ]; then
    echo "Error: Vault directory does not exist: $VAULT_DIR"
    exit 1
fi

# 创建插件目录
mkdir -p "$PLUGIN_DIR"

# 复制必要文件
cp main.js manifest.json versions.json styles.css "$PLUGIN_DIR/"

if [ -d "img" ]; then
    cp -r img "$PLUGIN_DIR/"
fi

echo "Deployment complete!"
echo "Plugin files copied to: $PLUGIN_DIR"
echo ""
echo "Next steps:"
echo "  1. In Obsidian, go to Settings → Community Plugins"
echo "  2. Turn off Safe Mode if it's on"
echo "  3. Find 'Flomo Bridge' and enable it"
echo "  4. If you updated an existing plugin, press Cmd+R (macOS) or Ctrl+R (Windows) to reload"
