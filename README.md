# kojo-market

`packs/<kind>/<id>/<version>/{pack.json, files/**}` → CI 出 `<id>-<version>.zip`（Release 资产，不可变）→ `index.json`（Pages）。
包内容明文入库：PR 审核 = 看 diff。索引 `https://poboking.github.io/kojo-market/index.json`。

## pack.json 字段（权威校验锚，同时是 zip 根部唯一元数据文件）

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `schema` | int | ✔ | 恒为 `1` |
| `kind` | string | ✔ | `kojo-pack` \| `dict-pack` \| `template-pack`，须等于所在目录 |
| `id` | string | ✔ | `^[a-z0-9][a-z0-9._-]{0,63}$`，须等于所在目录；**一个 id 只能属于一个 kind**（tag `<id>-v<version>` 会碰撞） |
| `version` | string | ✔ | `^\d+\.\d+\.\d+$`，须等于所在目录；已发布版本内容不可变，改内容请 bump |
| `name` | string | ✔ | 显示名 |
| `author` | string | ✔ | 署名 |
| `license` | string | ✔ | 许可标注（原文照录，不做解释） |
| `redistribute` | bool | ✔ | **唯一内容类硬闸**：必须 `true` 才进索引/出资产。二次配布允许；原作者不许可时不得代理分发 |
| `sourceUrl` | string | ✕ | 给了必须是 `https://` 绝对 URL |
| `summary` | string | ✕ | 简介 |
| `minAppVersion` | string | ✔ | `^\d+\.\d+\.\d+$` |
| `gameId` | string | ✕ | 由适配器解释，注册表不看内容 |
| `files` | array | ✔ | 元素 `{ path, bytes, sha256 }`；`path` posix 相对、以 `files/` 开头、无 `.`/`..`/绝对路径/盘符、深度 ≤ 12；`bytes` 非负整数；`sha256` 64 位小写 hex |

体积闸：zip ≤ 64 MiB、解压后 ≤ 128 MiB、条目 ≤ 5000、符号链接一律拒绝。契约外的键不许进 `pack.json`。

## 两条入库路径与分层校验

1. **人工 PR**：明文全树直接进 PR，validate 一次跑完。
2. **编辑器一键发布（kojo-market-worker 代理）**：Worker（CF 免费档，10ms CPU）只做结构级校验，开的 PR **只带 `pack.json`**（分支 `publish/<id>-<version>`），待审 zip 存 R2 `pending/`。CI 在 PR 阶段从 R2 拉回 zip（S3 API，只读 token），`market.mjs hydrate` 解包补全 `files/**` 明文树并做数据级对账——zip 内 pack.json 与树内逐字节一致 + 逐文件 bytes/sha256 重算对拍 + 容器 sha256 与 R2 meta 对拍——然后以 `github-actions[bot]` 推回 PR 分支（GITHUB_TOKEN 的提交不触发新 run，天然防循环）。validate 在完整树上照常跑；merge 后 master 自动完整，publish job 零特判。

R2 凭据走注册表仓 secrets：`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`（token 权限 Object Read Only、限定桶）。

## 上架示例

```bash
# 1. 放文件（明文）
mkdir -p packs/kojo-pack/my.pack/1.0.0/files && cp 我的口上.ERB packs/kojo-pack/my.pack/1.0.0/files/
# 2. 写元数据（files 先留空数组）
cat > packs/kojo-pack/my.pack/1.0.0/pack.json <<'JSON'
{ "schema": 1, "kind": "kojo-pack", "id": "my.pack", "version": "1.0.0",
  "name": "我的口上包", "author": "我", "license": "禁止无名转载",
  "redistribute": true, "minAppVersion": "0.4.0", "files": [] }
JSON
# 3. 重算散列填进 files[]，然后开 PR
node scripts/market.mjs stamp packs kojo-pack/my.pack/1.0.0
```
