# 发布指南

本文档说明如何构建 `flomo-bridge` 插件并发布到 GitHub Release 及 Obsidian 官方插件市场。

---

## 前置条件

- Node.js + npm
- GitHub CLI (`gh`) 已安装并登录：`gh auth status`

---

## 一键构建 + 发布

```bash
npm run release
```

这条命令会做三件事：
1. **Build** — 运行 `tsc` 类型检查 + `esbuild` 打包，生成 `main.js`
2. **校验** — 检查 `main.js`、`manifest.json`、`styles.css` 是否齐全
3. **发版** — 调用 `gh release create`，以 `manifest.json` 里的 `version` 为 tag，上传三个文件作为独立附件

Release 发布后会输出发版链接，例如：
```
https://github.com/giraffe-tree/flomo-bridge/releases/tag/1.0.3
```

> **注意**：Obsidian 市场要求 Release 必须以独立文件形式上传 `main.js`、`manifest.json`、`styles.css`，不能打包成 zip。

---

## 更新版本号

```bash
npm version patch   # 1.0.3 -> 1.0.4
npm version minor   # 1.0.3 -> 1.1.0
npm version major   # 1.0.3 -> 2.0.0
```

`npm version` 会自动触发 `version-bump.mjs`，完成以下操作：
- 把 `manifest.json` 的 `version` 同步为新版本号
- 在 `versions.json` 里追加新版本与 `minAppVersion` 的映射
- 自动 `git add manifest.json versions.json`

之后执行 `npm run release` 即可。

---

## 发布到 Obsidian 官方插件市场

### 首次提交（仅需一次）

1. 确保 GitHub Release 已创建（通过 `npm run release`）
2. Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)
3. 在 `community-plugins.json` 中按字母顺序插入：

```json
{
	"id": "flomo-bridge",
	"name": "Flomo Bridge",
	"author": "Ernest",
	"description": "Sync flomo memos into your Obsidian vault with incremental sync, attachment download, and backlink conversion.",
	"repo": "giraffe-tree/flomo-bridge"
}
```

4. 提交 PR，标题建议：`Add flomo-bridge to community plugins`

### 后续版本更新

合并进 `community-plugins.json` 后，**无需再提 PR**。只需：
1. `npm version patch`
2. `npm run release`

Obsidian 的更新机器人会在 10~30 分钟内自动检测到新的 GitHub Release。

---

## 手动构建（不发版）

如果只想本地打包，不创建 Release：

```bash
npm run build        # 生成 main.js
npm run package:all  # 生成 target/flomo-bridge-x.x.x.zip 和 .tar.gz
```

---

## 常见问题

### `HTTP 400: Bad Content-Length`
`styles.css` 不能为空文件（0 字节），否则 GitHub 上传会失败。当前文件里已放有一行 CSS 注释，满足上传要求。

### `gh release create` 提示已存在同名 tag
如果该版本 tag 已存在，可以先删除本地和远程 tag 再重试：
```bash
git tag -d 1.0.3
git push origin :refs/tags/1.0.3
npm run release
```

### `main.js` 没有更新
确保每次发版前执行的是 `npm run release`，它会强制重新 build。不要直接上传仓库里旧的 `main.js`。
