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

处理顺序：

1. **立即吊销泄露的密钥**（GitHub → Settings → Developer settings → Personal access tokens）
2. **把仓库改为 Private**（Settings → General → 最底部 Danger Zone → Change visibility）
3. 清理历史（用 [git-filter-repo](https://github.com/newren/git-filter-repo) 或 BFG）：

   ```bash
   # 例：从全部历史中彻底移除某文件
   git filter-repo --invert-paths --path excel-analysis.md --path import-report.md
   git push --force --all
   ```

4. 涉及身份证号 / 银行卡号泄露的，按《个人信息保护法》要求评估是否需要
   向受影响员工告知并上报。

## 启用登录前

`AUTH_ENABLED=false`，登录功能已预留但未启用。
系统目前**任何人只要能访问端口就能看到全部员工档案**，
因此：

- 不要把服务直接暴露到公网
- 需要远程访问时，优先用 Tailscale 等私有网络，而不要用公网端口映射
- 启用登录前，先修改 `AppUser` 的密码哈希与角色
