# OCI Dash

面向个人多账号管理的自托管 OCI 面板，采用 Next.js App Router、TypeScript、官方 OCI TypeScript SDK 和 SQLite。默认 Docker 部署只运行一个 `app` 容器，由 Node 入口统一管理 Web 与后台 Worker。

导航包括总览、实例、流量统计、成本分析、账号、任务和设置。资源读取与有副作用的操作分开：页面提交操作后获得任务编号，Worker 执行任务并保存进度、结果和恢复检查点。

测试、Docker 联调、真实 OCI 只读核验及临时 VNC 控制台验收的结果见 [验证记录](docs/VERIFICATION.md)。实例生命周期、IP、磁盘和安全规则等资源变更尚未进行真实写操作验收。

## 功能范围

- 导入、验证多个 OCI API 账号，按已启用区域读取可访问区间内的资源。
- 查看实例、所有网卡、私网/公网 IP 绑定、IPv6、启动卷和可用的 OCI 原生指标。
- 创建实例及启动、停止、重启、重命名、终止；终止需要输入实例名称确认。
- 指定实例、VNIC、私网 IP 和预期旧公网 IP 进行轮换；拒绝轮换 Reserved 或带保护标记的公网 IP。
- 修改启动卷容量/VPU，增加或删除 NSG、安全列表规则，分配 IPv6。
- 持久任务、失败重试、取消请求、事件历史、检查点恢复和 Worker 状态。
- 浏览器 VNC 控制台：基于 OCI 原生控制台、noVNC 和 OpenSSH，支持连接、断开、全屏、缩放及 Ctrl+Alt+Del；全站同时一个会话。
- 流量统计：按账号、区域、实例及网卡查看完整小时的收发累计、趋势和明细，缺失数据明确标注。
- 成本分析：读取 OCI 官方费用，按币种独立汇总，支持日/月趋势及服务、区域、资源明细。
- 管理员登录、密码修改、TOTP MFA 和一次性恢复码。

本项目提供上述明确范围的 OCI 操作，不是完整的 OCI 控制台。复杂 IAM 管理、账单判定、完整 VCN 设计和未列出的资源功能仍需官方控制台。指标不可用时显示缺失状态；不将缺失数据伪装为零。IPv6 云端分配也不等于来宾系统、路由和访问规则已经配置完成。

本版本不包含 AI 对话、Telegram 交互管理、自动救援、地图，也没有实现 Telegram 通知或其他通知集成。

## 本地开发

需要符合 `package.json` 的 Node.js 版本：`>=24 <27`，以及 npm。Docker 镜像使用 Node.js 24。

```sh
npm ci
npm run bootstrap
npm run dev
```

在第二个终端、同一个项目目录中启动 Worker：

```sh
npm run worker
```

打开 `http://localhost:3000`。首次用户名默认是 `admin`，初始密码在本机 `.env` 的 `ADMIN_PASSWORD` 中；bootstrap 不会把密码打印到终端。

`npm run bootstrap` 只在 `.env` 不存在时生成随机管理员密码和 32 字节 Base64 主密钥，默认开启演示模式。**不要先把 `.env.example` 复制成空值 `.env` 再运行 bootstrap**：脚本会保留已存在文件，不替你补全空值。

`npm run worker` 使用 `tsx --env-file=.env`，与 Web 读取同一份环境配置。开发服务器脚本默认监听 `0.0.0.0`；仅本机开发时可明确选择本机监听地址。

## 演示与真实账号

默认 `DEMO_MODE=true`。演示页面使用明确标注的示例账号、实例、任务和指标，页面/API 不接受真实账号导入或云操作；Worker 只维持健康心跳，不领取数据库中原有的真实任务。

准备连接真实账号时：

1. 将 `.env` 的 `DEMO_MODE` 改为 `false`。
2. 确认 `APP_ORIGIN` 与浏览器实际访问地址一致，并保留原 `MASTER_KEY`。
3. 执行 `docker compose up -d --force-recreate app`，让容器重新读取环境变量。
4. 在“账号”页粘贴 OCI 配置文本、上传对应的 PEM 私钥文件并添加账号。应用自动在后台验证连接、同步资源，卡片状态随进度更新。

添加时自动解析配置中的 OCID、指纹和区域，名称默认取密钥文件名；需要自定义名称或同步多个区域时，展开“更多选项”。`key_file` 中的本地路径无需修改，应用使用你选择的文件。

连接失败会在账号卡片显示原因并提供重试。正常使用时可按需点击“刷新资源”；替换凭据或修改同步区域会自动重新连接，单纯修改名称不会触发云端请求。

总览、实例列表、实例详情和账号页在可见时每 60 秒检查资源是否过期，过期账号自动读取 OCI；回到页面时也会检查。手动点击资源“刷新”会请求 OCI 同步，等待完成后更新内容。同一账号的并发刷新合并，失败后逐步退避；页面隐藏或离开后停止浏览器轮询，已提交的同步继续在后台完成。

刷新期间保留当前表格和筛选、排序、分页，错误也不会清空已加载内容。实例列表展示配置与状态，CPU 等监控数据按需在详情中查看。自动同步不占用普通任务列表，只保留各账号最近一次自动同步结果；手动刷新与其他操作继续保留任务历史。

账号导入需要 OCI API 签名私钥，不是实例的 SSH 私钥。当前接收至少 2048 位、未加密 PEM 格式的 RSA API 私钥，并在保存前核对指纹。私钥只用于服务端签名，不通过账号读取 API 返回。

从真实环境切回演示时，先等待运行中的任务结束并执行 `docker compose stop app`，再修改配置；优先使用独立数据库/数据卷预览演示。改变演示开关不会删除原来的任务或撤销 OCI 已受理的操作；不要将该开关当作云操作的回滚按钮。

## Docker Compose

在已安装 Docker Engine 与 Compose 的主机上：

```sh
npm run bootstrap
# 按实际访问方式编辑 .env 的 APP_ORIGIN、DEMO_MODE 和 PORT。
docker compose up -d --build app
docker compose ps app
```

如果主机没有 npm、但有 Node.js，可直接执行 `node scripts/bootstrap.mjs`，效果相同。也可以按 `.env.example` 手动提供完整配置；Compose 会拒绝缺少 `ADMIN_PASSWORD` 或 `MASTER_KEY` 的启动请求。

只有 Docker 的 Linux 主机，可用一次性 Node 容器执行同一个 bootstrap 脚本，然后运行上述 Compose 启动命令：

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" -w /workspace node:24-bookworm-slim \
  node scripts/bootstrap.mjs
```

Compose 项目名为 `oci-dash`，唯一服务为 `app`，使用 `oci-dash:local` 镜像和 `app-data` 数据卷，数据库路径为 `/data/oci-dash.db`。宿主机默认只在 `127.0.0.1:3000` 暴露 Web；通过远程域名访问时，应在现有反向代理上配置 HTTPS，并让 `APP_ORIGIN` 使用该 HTTPS 源地址。

容器入口 `node dist/runtime.mjs` 同时启动 `server.js` 与 `dist/worker.mjs`。任一业务进程在正常停止流程之外退出时，入口停止另一个进程并以非零状态退出，由 Docker 的 `restart: unless-stopped` 策略重启容器。单容器简化了部署和日志管理，后台任务仍独立执行；它不意味着取消 Worker 或显著降低内存占用。开发时仍可在两个终端分别运行 Web 和 Worker。

```sh
docker compose logs --tail 100 app
docker compose exec app node dist/health.mjs
```

整体健康检查同时验证 Web、SQLite 与 Worker 心跳；HTTP `/api/health` 仅验证 Web 和 SQLite。详细部署、旧双容器迁移、备份、恢复和任务排错说明见 [运维说明](docs/OPERATIONS.md)。

## VNC 控制台

在实例详情点击“VNC 控制台”，打开独立页面后点击“连接”。应用使用已保存的 OCI 账号创建临时控制台连接，自动生成本次会话的 SSH 密钥；无需上传实例的 SSH 私钥，也不在实例系统里安装 VNC 服务。系统登录仍由实例操作系统处理，Ubuntu Server 通常显示启动信息或文本控制台。

控制台与面板共用登录和对外端口，部署域名时反向代理需要允许 WebSocket Upgrade。Node 网关将普通 HTTP 转给容器内的 Next.js standalone 服务，并处理经过认证的 VNC WebSocket；无需额外发布 5900 或 6080 端口。普通 `npm run dev` 仅启动 Next 页面，完整控制台联调使用 Docker 运行入口。

全站同时一个会话。退出页面、主动断开、登录失效、15 分钟无操作或达到 1 小时会话上限后，应用关闭隧道并清理自己创建的 OCI 控制台连接。清理失败时会保留记录并自动重试，页面也提供“重试断开”；完成前不能新建连接或移除该账号。其他客户端已经创建的 OCI 控制台连接会显示占用，不会被自动删除。

演示模式禁止创建真实控制台，也不会恢复或清理已有的真实控制台记录。默认 Compose 将临时 SSH 文件放在内存文件系统 `/tmp`，正常断开会删除文件，容器停止后也不会保留私钥。实际验证范围见 [验证记录](docs/VERIFICATION.md)。

## 数据与密钥

流量与成本的统计口径、时间范围、缓存和权限要求见 [分析功能说明](docs/ANALYTICS.md)。

SQLite 保存账号元数据、资源缓存、任务、审计和登录状态。OCI API 私钥及 MFA 秘密采用应用层 AES-256-GCM 加密；管理员密码使用 scrypt，登录令牌和恢复码以散列形式保存。**这不是整个 SQLite 文件的透明加密**，资源名称、IP 地址和任务事件仍是普通数据库数据。

必须同时保留数据库备份和原 `MASTER_KEY` 的安全副本。失去主密钥会使已有 OCI 凭据和 MFA 秘密无法解密；直接换一个新的 `MASTER_KEY` 不是密钥轮换。当前没有批量重加密或忘记管理员密码后的自动找回工具。

`ADMIN_USERNAME`、`ADMIN_PASSWORD` 只用于空数据库的首次管理员初始化。已有管理员创建后，修改 `.env` 的这两个值不会重置数据库中的账号或密码；应使用“设置”中的密码修改入口。

## 验证与项目结构

代码使用固定版本的 Prettier 格式化，统一为 2 空格缩进、约 100 字符行宽和 LF 换行。编辑器可读取 `.editorconfig`；配置 Prettier 扩展后可使用项目内的 `.prettierrc.json`。

```sh
npm run format        # 格式化源码、测试、配置与文档
npm run format:check  # 只检查，不修改文件
```

CI 会先检查格式，再执行类型检查、测试与构建。格式化排除生成文件、本地环境配置、私钥、数据库和测试产物，具体见 `.prettierignore`。

```sh
npm run format:check
npm run typecheck
npm test
npm run build
# 构建镜像后，验证独立测试容器的故障恢复和正常关机。
docker compose build app
npm run test:runtime
```

默认自动化测试使用模拟 OCI 客户端及临时 SQLite，不访问真实云账号。测试详情及尚待完成的验收项见 [验证记录](docs/VERIFICATION.md)。

```text
src/app/                 页面与 API 入口
src/components/          页面组件及操作确认界面
src/server/oci/          OCI SDK 适配与资源操作
src/server/jobs/         持久队列、租约、事件与 Worker
src/server/              账号、加密、认证、缓存与 API 逻辑
src/worker.ts            后台 Worker 入口，开发时可独立运行
src/worker-health.ts     独立 Worker 心跳诊断
dist/runtime.mjs         构建生成的容器进程管理入口
dist/health.mjs          构建生成的整体健康检查
tests/                  离线测试
docs/                   实现契约、验证与运维说明
```
