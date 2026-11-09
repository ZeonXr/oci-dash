# 验证指南与历史基线

本文件区分可复现检查、已有运行记录和仍未完成的验收。测试通过只说明指定版本与环境的结果，不保证其他提交、OCI 权限或云端资源状态相同。

## 环境要求

- 使用 `package.json` 支持的 Node.js（`>=26.13 <27`）和 npm；开发、镜像及 CI 统一为 Node.js `26.13.0`。
- 容器检查需要可运行的 Docker Engine 与 Docker Compose。
- 浏览器检查使用 Playwright。Windows 默认使用已安装的 Edge，其他平台默认 Chromium；可用 `E2E_BROWSER_CHANNEL` 选择已安装的浏览器通道。
- Linux 首次使用 Playwright Chromium 时，可运行 `npx playwright install --with-deps chromium` 安装浏览器及系统依赖；使用已有 Chrome 的 CI 无需额外下载 Chromium。

不要连接生产数据库或把生产 `.env` 用作测试配置。测试文件使用模拟 OCI、临时 SQLite、合成密钥或独立空数据库服务。

## 源码检查

在项目目录执行：

```sh
npm ci
npm run format:check
node scripts/check-docs.ts
npm run typecheck
npm test
npm run build
```

`npm run typecheck` 使用 `tsc` 依次检查应用的 `tsconfig.json` 和工具脚本的严格配置 `scripts/tsconfig.json`。脚本由 Node.js `26.13.0` 原生移除类型后运行，只使用可移除的类型语法；运行时不做类型检查，也不代替上述静态检查。`dist/*.mjs` 是构建生成的运行文件，验证命令继续使用这些产物。

类型检查和单元测试无需真实 OCI 账号。Unix 信号相关测试在 Windows 可按平台条件跳过；需要 Linux 环境才能覆盖对应进程生命周期行为。

普通文档提交的 CI 只执行格式及本地链接检查。代码、脚本、配置、依赖或部署文件变化，以及发布流程调用的 CI，执行完整验证。完整 CI 的生产构建在 Docker 中完成一次；镜像构建不再重复执行完整单测，不能用一次成功的 `docker build` 代替上面的类型和单元测试检查。

## 容器与浏览器检查

测试镜像直接用 Docker 构建，不读取部署用 Compose 环境，因此干净克隆无需先生成 `.env`：

```sh
docker build -t oci-dash:local .
npm run test:runtime
npm run test:backup
npm run test:e2e:isolated -- --no-build
```

`test:runtime` 为已构建的本地镜像创建独立临时容器和持久数据，不发布端口、禁用外部网络、不注入环境配置，也不传 Docker 的 `--init` 或额外 `/tmp` 挂载。检查覆盖镜像自带的 Tini 作为 PID 1、`TMPDIR=/dev/shm` 与 tmpfs 文件系统、自动生成主密钥、默认无管理员及初始密码文件、首次设置与登录、文件权限、Web/Worker 故障后的整体重启、数据和密钥保留、失效心跳和正常停止，结束后清理本次资源。当前版本的实际执行结果在下方单独记录。

`test:backup` 使用合成数据库验证命名卷及宿主目录的备份恢复，包括隐藏密钥、权限保留、含空格和逗号的路径、归档目标边界、原运行状态恢复和失败清理，不读取生产数据库。它不代替真实环境的异机恢复演练。

`test:e2e:isolated` 将发布用 `compose.yaml` 单独复制到临时目录，验证它无需其他仓库文件及环境变量插值；只在测试副本中将默认宿主端口 `6240` 替换为随机 loopback 端口。测试再显式覆盖本地镜像和随机配置，使用独立 Compose 项目、临时目录内全新的 `data` 和随机测试凭据，不生成或加载 `.env`。浏览器 UI 样例只在 `tests/` 内拦截请求提供，不向运行中的应用数据库写入示例账号或资源。默认构建专用临时镜像；上例已构建 `oci-dash:local`，因此使用 `--no-build`。退出后清理本次容器、数据、临时配置和报告，以及脚本自行构建的镜像。它不复用部署目录中的生产配置或数据目录。

隔离检查需核对默认挂载确为测试 Compose 旁的 `./data:/data`，以及停止期限、容器安全限制、日志驱动和没有额外 init 或 tmpfs 挂载。Linux 测试目录须先为 UID/GID `1000:1000` 准备权限，Windows Docker Desktop 使用宿主 ACL。测试不挂载或改写个人的数据目录；只换 Compose 项目名不能隔离相同宿主目录。

清理失败时脚本返回非零并保留本次临时配置，便于根据输出的唯一项目名继续处理。不要用默认项目的 `down -v` 清理这些测试资源。

不要用默认 `docker compose up` 代替隔离测试：它可能重建真实部署并启动 Worker。

现有测试默认关闭 trace、video 和自动失败截图，避免把登录请求写进产物。隔离脚本会清理本次报告和截图。调试产物只允许包含测试拦截提供的合成数据；`E2E_SCREENSHOTS=1` 输出目录受 Git 忽略，不得为生产登录开启录制。浏览器检查应通过隔离脚本启动，不以个人部署作为测试目标。

## 覆盖范围

| 范围       | 主要检查                                                               |
| ---------- | ---------------------------------------------------------------------- |
| 认证与凭据 | 首次初始化、并发与恢复、旧密钥迁移、会话、Origin、MFA 与恢复码。       |
| 账号与库存 | 原子保存、重复租户、SQL 归属、失败字段保留、成功区间删除、旧值标记。   |
| 任务       | 租约、资源锁、取消、错误重试与完成期限、检查点恢复、并行同步和关机。   |
| OCI 适配器 | 分页、资源归属、保护标记、ETag、幂等恢复、并发限制、取消和客户端清理。 |
| 统计       | 空账号无云请求、UTC 边界、缺失与零、多币种、总期限、范围和缓存 TTL。   |
| 控制台     | 登录与票据、Origin、SSH 参数及指纹、会话占用、清理与重启恢复。         |
| 浏览器     | 路由和筛选、渐进刷新、迟到响应、错误保留、键盘交互和窄屏布局。         |

测试实现位于 `tests/`；接口与流程见[架构与 API](IMPLEMENTATION.md)。新增回归应覆盖用户可观察的行为或安全边界，不只重复内部实现。

## 发布基线

结果对应指定源码和执行环境。完整日志以链接的 GitHub Actions 为准，历史通过数不代表后续提交或任意 OCI 环境都已通过。

### v0.5.7 发布验收

变更与升级要求见[版本说明](releases/v0.5.7.md)。应用源码为 [`87f437e`](https://github.com/ZeonXr/oci-dash/commit/87f437ee4fce8bc7d549c8653f6a86b8953fa555)。

**2026-11-10**，[主分支 CI](https://github.com/ZeonXr/oci-dash/actions/runs/42658002223) 已通过格式、应用与脚本类型、文档链接、728 项 Linux 单元测试、115 项 Chrome 浏览器检查、5 项容器运行检查及 4 项备份恢复检查。Windows Edge 访问独立空数据库容器的 115 项浏览器检查也全部通过。

额外检查覆盖：旧 `PORT` 环境变量不会改变默认端口映射；Oracle 品牌素材与官方文件哈希一致，登录页、侧栏和 favicon 正常加载，浅色与深色主题下品牌区域均可读。全部浏览器及 OCI 回归使用隔离数据或模拟接口。

[发布流程](https://github.com/ZeonXr/oci-dash/actions/runs/42658385608) 的完整验证、AMD64 与 ARM64 原生构建及各 5 项运行检查、公开部署验收全部通过；推广结果为 `promoted: true`。发布说明工作流变更的[完整 CI](https://github.com/ZeonXr/oci-dash/actions/runs/42658958259) 也通过相同的源码、运行及浏览器检查。

[Compose 附件](https://github.com/ZeonXr/oci-dash/releases/download/v0.5.7/compose.yaml) 为 303 字节，按 LF 换行与源码一致；SHA-256 为 `642786ebbeed002fd4237b13d32e803993e0c3af964e4765b9e6f2a970e74d82`。正式多架构镜像索引为 `sha256:b9d4d6c6dbd34df61f935ba37695816dbf3bc534b336e8a342ccd7f3ffc8d2aa`。

Windows Docker Desktop 的保留数据升级检查通过：服务在 `127.0.0.1:6240` 健康运行，品牌素材与官方文件一致；管理员密码与 MFA、加密 OCI 凭据、主密钥和资源归属的升级前后合并哈希一致。

### v0.5.6 未发布基线

[验证流程](https://github.com/ZeonXr/oci-dash/actions/runs/42656546211) 在浏览器阶段停止：部分静态资源白名单仍引用旧图标，拒绝了新的本地图标请求。该标签没有公开正式镜像；修正已纳入 v0.5.7。

### v0.5.5 发布验收

源码 [`b4094c8`](https://github.com/ZeonXr/oci-dash/commit/b4094c8f7ff07286a7949ab42cbe3a94cc7f01c5) 的[CI](https://github.com/ZeonXr/oci-dash/actions/runs/42642141382) 和[发布流程](https://github.com/ZeonXr/oci-dash/actions/runs/42642218972) 通过 728 项 Linux 单元测试、115 项浏览器检查、双架构构建与运行、备份恢复及公开部署检查。Windows 单元测试为 722 项通过、6 项按平台跳过；两条停止轮询用例各重复 20 次，全部通过。

更早版本的详细证据保留在[版本化验证记录](https://github.com/ZeonXr/oci-dash/blob/v0.5.5/docs/VERIFICATION.md#已有基线)。版本发布资产与镜像状态以对应 [GitHub Release](https://github.com/ZeonXr/oci-dash/releases) 和具体工作流运行结果为准。

## 尚未完成的验收

- 实例创建、启停、重启、终止，以及实际 IP 轮换、磁盘和安全规则修改的完整真实写入验收。
- 完整备份归档到异机恢复的端到端演练。
- 任意 OCI 租户、区域、权限组合和镜像的兼容性验证。

真实写入验收应在明确指定的隔离资源上进行，并记录操作和清理结果。临时控制台验收只验证通道与画面，不证明来宾系统密码登录可用，也不代替其他云资源写操作验证。

返回[README](../README.md) · [运维说明](OPERATIONS.md)
