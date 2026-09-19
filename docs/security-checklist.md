# 仓库安全约定（务必阅读）

本仓库包含一套 **HR 人事管理系统**，其处理的数据属于**个人敏感信息**
（身份证号、银行卡号、手机号、住址、薪资）。

## 绝对不允许进入 Git 的内容

| 内容 | 路径 | 原因 |
| --- | --- | --- |
| SQLite 数据库 | `data/*.db`、`data/backup/` | 含全部员工个人数据 |
| 原始 Excel | `途虎HR人员登记.xlsx`、`data/import/*.xlsx` | 含全部员工个人数据 |
| 导入报告 | `docs/import-report.md` | 含真实员工姓名 |
| 环境变量 | `.env`、`.env.*`（`.env.example` 除外） | 含连接串 / 密钥 |
| 导出文件 | `data/export/`、`templates/*.xlsx` | 含个人数据 |

以上已全部写入 `.gitignore`。

## 提交前必须做一次体检

```bash
npm run check:sensitive
```

该脚本会扫描**将要提交的内容**，检出：

- 完整 18 位身份证号（用 GB 11643 校验位算法降低误报）
- 完整 19 位银行卡号 / 11 位手机号
- 明文密钥（GitHub token、`sk-` 开头的 API Key、私钥）
- 误入暂存区的数据文件

**发现 P0 问题时退出码为 1，必须先处理再提交。**

## 导入报告的安全用法

`docs/import-report.md` 默认包含**真实员工姓名**，仅供内部审计，已被 `.gitignore` 排除。

如需一份可以提交到远程仓库的版本：

```bash
# Windows PowerShell
$env:REPORT_MASK_NAMES="true"; npm run import:excel
# Git Bash / Linux / macOS
REPORT_MASK_NAMES=true npm run import:excel
```

此时姓名会被掩码为 `张**`，**原始 Excel 行号仍然保留**，
可据此在系统内定位到具体员工，信息不丢失。

## 代码里严禁出现真实个人数据

自动化测试、文档示例、注释里一律使用**合成数据**：

```
假身份证  110101199001011234
假手机号  13800138000 / 13900139000
假银行卡  0000123456789012
```

`scripts/acceptance-test.mjs` 已全部使用合成数据，可安全提交。
如需按真实数据自查，请通过系统界面筛选，不要把真实值写进代码。

## ⚠️ 如果敏感数据已经推送过

**只删除文件是不够的** —— 数据仍留在 Git 历史中，任何人 clone 都能看到。

### 实测结论：`git push --force` 也清不掉 GitHub 上的旧对象

本仓库实际验证过（2026-09）：

| 操作 | 结果 |
| --- | --- |
| 删除文件并推送 | 分支顶端 404，但旧提交的原始链接仍返回 200 |
| `git push --force` 重写历史 | 匿名 `commits` 列表里不再出现旧提交 ✅，但 `github.com/<owner>/<repo>/commit/<旧SHA>` 与 `raw.githubusercontent.com/<owner>/<repo>/<旧SHA>/<文件>` **仍然返回 200** ⚠️ |

也就是：**GitHub 会长期保留不可达（unreachable）的 commit 与 blob。**
只要有人知道那个 SHA，就能把内容下载下来。

### 真正彻底清除的两条路

**① 删除仓库 + 同名重建（推荐，30 秒解决）**

```bash
# 先确认本地有完整最新代码
git log --oneline -1 && git status --short

# 删除远程仓库（用 API 或网页 Settings → Danger Zone → Delete this repository）
curl -X DELETE -H "Authorization: Bearer <TOKEN>" \
  https://api.github.com/repos/<owner>/<repo>

# 同名重新创建后，把干净历史推上去
git push https://<owner>:<TOKEN>@github.com/<owner>/<repo>.git main:main
```

旧对象随仓库一起消失，不留任何残留。仓库地址不变，之前的提交历史会全部丢失
（本文场景下要丢掉的正是泄露提交，所以是好事）。

**② 提交 GitHub Support 工单（保留仓库与历史）**

访问 <https://support.github.com/contact>，选择 *Repository → Sensitive data*，
说明「请清除 <owner>/<repo> 中 SHA 为 <旧SHA> 的不可达对象」。
GitHub 可以服务端清除，但需要等待处理。

### 处理顺序

1. **立即吊销泄露的密钥**（GitHub → Settings → Developer settings → Personal access tokens）
2. 如果仓库是公开的，**先转私有**可立刻阻断公网访问（可随时改回公开）
3. 按上面 ① 或 ② 彻底清除历史
4. 涉及身份证号 / 银行卡号泄露的，按《个人信息保护法》要求评估是否需要
   向受影响员工告知并上报

> ⚠️ 本地若保留了含旧数据的 ref（如备份 tag / branch），**绝不要推送它们**，
> 否则会把已清除的数据重新带回远程。用 `git tag -l`、`git branch -a` 检查一遍。

## 启用登录前

`AUTH_ENABLED=false`，登录功能已预留但未启用。
系统目前**任何人只要能访问端口就能看到全部员工档案**，
因此：

- 不要把服务直接暴露到公网
- 需要远程访问时，优先用 Tailscale 等私有网络，而不要用公网端口映射
- 启用登录前，先修改 `AppUser` 的密码哈希与角色
