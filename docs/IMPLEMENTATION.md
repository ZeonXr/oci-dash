# 架构与 API

OCI Dash 采用 Next.js App Router、TypeScript、SQLite/Drizzle 和官方 OCI TypeScript SDK。面向单管理员管理多个云账号；不是带用户级云资源隔离的多租户服务。

## 模块

| 路径                                           | 职责                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| `src/app/`、`src/components/`                  | 页面、交互、筛选、渐进刷新和确认界面。           |
| `src/server/router.ts`、`auth.ts`、`http.ts`   | 业务 API、会话、MFA、同源检查和请求边界。        |
| `src/server/accounts.ts`、`inventory.ts`       | 加密凭据、账号版本、库存合并和资源归属。         |
| `src/server/master-key.ts`、`initial-admin.ts` | 原子持久化主密钥、旧密钥验证及首次管理员初始化。 |
| `src/server/oci/`                              | SDK 客户端、范围校验、库存读取和资源操作。       |
| `src/server/jobs/`                             | 持久队列、租约、资源锁、检查点和 Worker。        |
| `src/server/analytics/`                        | 流量、费用、CPU、查询期限与有界缓存。            |
| `src/server/console/`                          | VNC 会话、OCI 控制台、SSH 和 WebSocket。         |
| `src/runtime.ts`、`src/health.ts`              | 容器进程管理、统一网关和整体健康检查。           |
| `scripts/`                                     | 备份及隔离验证的 TypeScript 工具。               |

主导航为总览、实例、流量、成本和任务。设置有 `/settings/accounts`、`/settings/security`、`/settings/general` 三个分区；`/accounts` 和 `/settings` 重定向到账号分区。网络、安全规则和启动卷位于实例详情。

工具脚本通过 Node.js `26.13.0` 原生类型移除执行，只使用可移除的类型语法。Node.js 不执行类型检查；独立的严格配置 `scripts/tsconfig.json` 由 `tsc` 检查，`npm run typecheck` 同时覆盖应用与脚本。运行入口等服务端 TypeScript 经构建输出为 `dist/*.mjs`；这些是部署产物，不是单独维护的 JavaScript 源码。

## 运行与存储

默认 Compose 只有一个 `app` 容器。入口 `node dist/runtime.mjs` 启动独立的 Web 和 Worker 进程；Next standalone 监听私有 loopback 端口，入口提供对外 HTTP/WebSocket 网关。业务进程意外退出时停止整个应用，由 Docker 重启。

发布用 `compose.yaml` 独立使用固定版本镜像 `ghcr.io/zeonxr/oci-dash:v0.2.1`，没有构建或文件继承依赖。源码构建通过开发专用 `compose.build.yaml` 覆盖为本地镜像。两种方式保留相同的项目名与服务名，直接将 Compose 所在目录的 `./data` 挂载到 `/data`；仅保留可选的宿主端口 `PORT`，不读取旧 `DATA_PATH`。旧命名卷需要停机完整迁移后才能切换默认挂载。

镜像以 UID/GID `1000:1000` 的 `node` 用户运行，Tini 作为 PID 1；Compose 保留 35 秒停止期限、容器级 `no-new-privileges:true`、`cap_drop: ALL` 和 `local` 日志驱动。Linux 数据目录由部署者预先创建并赋权，Windows Docker Desktop 使用宿主 ACL；入口不以 root 运行或自动更改所有者。`TMPDIR=/dev/shm` 让运行状态与 SSH 临时文件使用 Docker 默认私有内存文件系统；健康检查与业务进程通过同一临时目录定位运行状态。

SQLite 使用 WAL。数据库保存账号、库存、任务、事件、会话及有界统计缓存；OCI API 私钥与 MFA 秘密在应用层加密。资源 JSON 的归属以 SQL 的账号、区域和资源 ID 为准，不能通过 JSON 覆盖其他账号的资源。

空数据库默认没有管理员，等待浏览器首次初始化，不生成账号、实例或指标样例。运行代码不读取旧 `DEMO_MODE`，不存在演示开关或假数据分支；测试样例仅保留在 `tests/`，通过模拟 OCI 读取或浏览器请求拦截提供。

默认启动无需 `.env`。主密钥自动生成并保存为数据库目录中的 `.master-key`；完整目录备份同时包含数据库与解密材料。主密钥初始化先原子发布文件，再提交对应绑定；旧环境密钥只有通过全部已有凭据及 MFA 的解密验证后才持久化，有加密数据或指纹绑定却缺少原密钥时拒绝生成替代密钥。

网页初始化接受管理员用户名、密码和确认密码，支持生成并复制 32 位随机密码。服务端用 SQLite 写事务串行化首次账号创建，将管理员、初始化完成标记和登录会话一起提交，成功后自动登录并关闭初始化入口；已有用户会阻止重新初始化，不重置旧密码。高级兼容入口 `ADMIN_PASSWORD` 仅在未初始化的空数据库中生效，用户名由 `ADMIN_USERNAME` 指定、默认 `admin`。新部署不生成 `.initial-admin-password`，旧文件仅保留兼容，成功改密时清理。

初始化没有额外令牌；默认仅发布 loopback，部署者先通过本机或 SSH 隧道完成设置，再开放公共反向代理。初始化请求与其他写请求一样校验 Origin，但来源校验不能阻止直接可访问页面的人抢先创建管理员。

正常读取使用服务端凭据；账号读取 API 不返回密钥。账号配置版本用于阻止异步读取结果或缓存跨越凭据和范围变化。部署、停止期限和恢复流程见[运维说明](OPERATIONS.md)。

## 账号与库存流程

保存账号和排入连接任务在同一事务内完成。新账号或租户变更会检查重复租户；旧重复配置保留供显式处理。凭据和区域变化会排队同步，单纯改名不会触发云请求。

账号未连接或没有同步记录时，Worker 先验证身份和区域订阅；正常已连接账号直接读取库存。同步只发布仍持有有效租约的结果。

库存读取共用四个 RPC 槽、两个区域生命周期槽，每区域最多处理两个实例。网络、启动卷和镜像详情并行，同一网卡的 IPv6 与 IPv4 链独立，公网绑定最多并行两个。取消后不派发新读取，已发请求结束后才释放槽和关闭客户端。

只有成功枚举的 `(region, compartmentId)` 范围允许删除缺失实例。详情失败不会阻断这个范围的清理，也不会用空值覆盖旧详情；`staleFields` 标记未更新字段。显式禁用区域在配置事务内清理其本地库存。

镜像系统信息有一小时、最多 256 项的身份隔离缓存；只保存成功的最小元数据。公网 IP、磁盘配置、创建选项和写操作校验使用新鲜读取。

## 任务与页面刷新

页面提交云操作后获得任务编号，Worker 持久执行并记录检查点。写任务全局串行；同账号的同步与写入互斥。单个 Worker 可并行同步两个账号。

库存自动检查由可见页面触发，同一账号的任务合并，失败退避。手动刷新按账号完成逐个读取快照，无需等待最慢账号。页面隐藏或等待超时只暂停浏览器检查，不撤销后台任务。自动同步隐藏于普通历史，只保留每个账号最近的终态记录；手动任务保留历史。

错误重试预算与 OCI 等待完成分开计数。重启后依据租约、完成期限和检查点恢复；取消不回滚已受理的云操作，手动重试也不是创建无关联的新操作。公共 pending 状态判定包含仍可自动恢复的 `interrupted`。

## HTTP API

业务 API 使用 JSON；错误通常为 `{error,code}`。除健康检查、首次初始化状态与提交、登录和允许清除过期会话的注销接口外，均要求登录。首次初始化提交仅在未初始化的空数据库中开放；非 GET/HEAD 请求还要求同源。响应不再包含 `demo` 字段；统计与指标的 `source` 只允许 `oci`。

| 方法与路径                                              | 请求或响应要点                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                       | Web 与 SQLite 可用性；不代替 Worker 健康检查。                                                                                                 |
| `GET /api/auth/status`                                  | `{setupRequired}`；只返回是否需要首次初始化，不返回账号或凭据。                                                                                |
| `POST /api/auth/setup`                                  | `{username,password}`；用户名 1–80 字符、密码 12–256 字符；成功返回 `{user}`、HTTP 201 并设置会话 Cookie。已初始化时拒绝，确认密码由页面校验。 |
| `POST /api/auth/login`                                  | `{username,password,code?}`；返回 `{user}` 并设置会话 Cookie。                                                                                 |
| `GET /api/auth/me`、`POST /api/auth/logout`             | 当前会话；注销会撤销 Cookie 对应会话。                                                                                                         |
| `GET /api/accounts`                                     | `{accounts,syncJobs}`；每账号当前或最近同步任务。                                                                                              |
| `POST /api/accounts`                                    | `{name,tenancyId,userId,fingerprint,homeRegion,regions,privateKey}`；原子保存并返回 `{account,job}`，HTTP 201。                                |
| `PATCH /api/accounts/:id`                               | 修改名称、区域或替换凭据；通常返回 `{account,job?}`。                                                                                          |
| `DELETE /api/accounts/:id`                              | 移除本地配置，不删除云资源；活动任务或控制台清理可阻止移除。                                                                                   |
| `POST /api/accounts/:id/sync`                           | 创建或复用持久同步，返回 `{job}`，HTTP 202。                                                                                                   |
| `POST /api/accounts/:id/verify`                         | 手动连接诊断，不扩大已配置的区域范围。                                                                                                         |
| `GET /api/accounts/:id/create-options`                  | `region`、可选 `compartmentId`；返回 `CreateOptions`。                                                                                         |
| `GET /api/instances`、`GET /api/instances/:id`          | `{instances}` 或 `{instance}`，ID 需要 URL 编码。                                                                                              |
| `POST /api/inventory/refresh`                           | `mode` 为 `auto` 或 `manual`，可附 `accountIds` 数组；返回任务和各账号的新鲜度/退避状态。                                                      |
| `GET /api/instances/:id/metrics`                        | `range` 可选 `1h`、`24h`、`7d`，返回 `MetricsResult`。                                                                                         |
| `GET /api/instances/:id/security`                       | `{groups}`。                                                                                                                                   |
| `GET /api/dashboard`                                    | 资源总量和近期活动的 `DashboardData`；图表总览使用下列统计接口。                                                                               |
| `GET/POST /api/analytics/traffic`                       | 流量报告；POST 刷新相同 URL 查询范围。                                                                                                         |
| `GET/POST /api/analytics/costs`                         | 费用报告；按币种分开。                                                                                                                         |
| `GET/POST /api/analytics/cpu`                           | 仅可选 `accountId`，固定最近 24 个完整 UTC 小时。                                                                                              |
| `POST /api/operations`                                  | `OperationRequest` → `{job}`，HTTP 202。                                                                                                       |
| `GET /api/jobs`、`GET /api/jobs/:id`                    | `{jobs}` 或 `{job,events}`。                                                                                                                   |
| `POST /api/jobs/:id/cancel`、`POST /api/jobs/:id/retry` | 请求取消或继续现有任务。                                                                                                                       |
| `GET /api/settings`                                     | `{username,mfaEnabled,version,worker}`。                                                                                                       |
| `POST /api/settings/password`                           | `{currentPassword,newPassword}`；成功后撤销全部登录会话。                                                                                      |
| `POST /api/settings/mfa/setup`                          | `{password}` → 临时验证器配置。                                                                                                                |
| `POST /api/settings/mfa/confirm`                        | `{code}` → 一次性展示恢复码，撤销其他登录会话。                                                                                                |
| `POST /api/settings/mfa/disable`                        | `{password,code}`；需验证密码及验证码/恢复码。                                                                                                 |

具体 DTO 与校验以 [contracts.ts](../src/lib/contracts.ts)、[validation.ts](../src/server/validation.ts)、[analytics-contracts.ts](../src/lib/analytics-contracts.ts) 和 [cpu-contracts.ts](../src/lib/cpu-contracts.ts) 为准。统计口径见[统计说明](ANALYTICS.md)。GET 可能更新本地读取缓存，但不会提交实例或网络写操作。

`PATCH /api/accounts/:id` 的控制台清理恢复模式接受 `recoverConsoleCleanup:true`、新 `privateKey` 和 `fingerprint`；如包含 `tenancyId`、`userId`，必须与原账号相同，区域也不得变化。仅在待清理失败会话已无在途工作、账号无未结束任务时允许，返回 `{account,consoleCleanupRecovery:true}`，不排自动同步。该操作保留控制台锁，由后续清理读取新凭据；详见[运维恢复流程](OPERATIONS.md#旧-api-密钥已失效时)。

## VNC 通道

页面位于 `/instances/[id]/console`。只有用户点击连接后才创建 OCI 控制台，临时 RSA 密钥不进入持久数据表。OpenSSH 使用结构化参数；OCI 命令仅作为数据解析，不交给 shell 执行。

| 接口                                                     | 行为                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/console/session`                               | `{session}`，查看全局占用。                                        |
| `POST /api/console/sessions`                             | `{instanceId}` → `{session}`，HTTP 202。                           |
| `GET /api/console/sessions/:id`                          | 登录会话所有者读取状态。                                           |
| `DELETE /api/console/sessions/:id`、`POST .../:id/close` | 关闭并清理，返回 `{session}`。                                     |
| `POST .../:id/touch`                                     | 记录用户操作。                                                     |
| `POST .../:id/ticket`                                    | `{ticket,expiresAt,path}`；票据单次使用、有效 30 秒。              |
| `GET .../:id/socket` 的 WebSocket Upgrade                | 使用 `oci-console` 和 `ticket.<value>` 协议，传输二进制 RFB 数据。 |

握手检查登录、Origin、所有者/登录会话绑定及标准 WebSocket 头；存活连接会再次验证登录。票据和私钥不放入 URL。全局唯一槽覆盖活动会话及未完成清理，不能借新会话绕过清理失败。

外层 SSH 主机密钥与 OCI API 指纹匹配；内层仅通过认证外层通道使用本次私有 known_hosts。清理只删除账号、实例和会话标签都匹配的连接。权限不足或创建结果不明确时保留记录和锁。完整应用启动后会按持久记录恢复和清理控制台。

控制台记录保留已验证的所属区间。对于缺少该信息且父实例已不可读的旧记录，清理要求 `accessLevel=ANY` 的完整区间枚举及每个区间的连接枚举；失败或权限不足不能作为资源已经消失的证据。

返回[README](../README.md) · [贡献指南](../CONTRIBUTING.md)
