# 运维说明

本指南适用于单主机 Docker Compose 部署。服务为 `app`，发布镜像为 `ghcr.io/zeonxr/oci-dash:v0.1.1`，默认数据卷为 `app-data`；可用 `DATA_PATH` 改为宿主目录，容器内数据库始终为 `/data/oci-dash.db`。源码开发和本地镜像构建见[贡献指南](../CONTRIBUTING.md)。

## 默认部署

默认只需 Docker Engine、Docker Compose 和一份 [v0.1.1 发布 Compose](https://github.com/ZeonXr/oci-dash/releases/download/v0.1.1/compose.yaml)，无需源码、Node.js、`.env` 或其他仓库文件。它直接引用固定版本镜像，不包含 `build` 或 `extends`。

在独立部署目录，用浏览器下载并保存为 `compose.yaml`，或执行：

```sh
curl -fL https://github.com/ZeonXr/oci-dash/releases/download/v0.1.1/compose.yaml -o compose.yaml
docker compose pull
docker compose up -d --wait
```

发布目标平台为原生 Linux `amd64`、`arm64`，由 Docker 按主机架构选择镜像。镜像索引、匿名拉取及发布资产的验证状态见[发布验收](VERIFICATION.md#v011-发布验收)。重启策略、35 秒停止期限、容器权限限制和 `local` 日志驱动直接保留在这份 Compose 中；日常仅需按需调整端口和数据位置。

首次启动会生成管理员和加密密钥，后续启动复用已保存的数据：

- 管理员为 `admin`，初始密码位于 `/data/.initial-admin-password`，用 `docker compose exec app cat /data/.initial-admin-password` 查看。成功改密后自动删除该文件。
- OCI 凭据和 MFA 的加密密钥位于 `/data/.master-key`。不能删除或替换它；数据库会校验配对关系，缺失或不匹配时拒绝启动。
- 数据库位于 `/data/oci-dash.db`；完整备份 `/data` 对应的命名卷或宿主目录即可包含数据库和密钥。
- Docker 使用 `local` 日志驱动自动轮转，默认保留最多 5 个、每个 20 MB 的日志文件，并压缩已轮转的日志。

初始密码和密钥文件在 Linux 上使用 `0600` 权限。普通部署只需关注端口、数据位置及其备份。

## 可选配置

两个日常调整项位于主 `compose.yaml` 的端口和数据挂载映射中。也可在可选的 `.env` 中设置：

| 设置        | 默认值     | 含义                                                                        |
| ----------- | ---------- | --------------------------------------------------------------------------- |
| `PORT`      | `3000`     | 宿主机映射端口，例如 `PORT=3001`；仍只绑定 `127.0.0.1`。                    |
| `DATA_PATH` | `app-data` | 默认命名卷；可改为仓库之外的宿主目录，例如 `DATA_PATH=/opt/oci-dash-data`。 |

这两个值只供 Compose 解析映射，不注入容器；应用仍监听 3000，并使用 `/data`。保持默认 `DATA_PATH` 和原项目名即可继续使用已有命名卷。自定义目录应放在源码和构建目录之外，例如 `/opt/oci-dash-data` 或 `../oci-dash-data`，不要依赖构建忽略规则涵盖所有自有文件。推荐使用绝对路径，避免移动部署目录后相对路径改变；相对目录必须以 `./` 或 `../` 开头，裸名称会被 Compose 当作命名卷。

Linux 首次使用空宿主目录时，先由部署者创建并赋予容器用户 `1000:1000` 访问权限，例如：

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /opt/oci-dash-data
```

应用以非 root 用户运行，不会在入口自动更改宿主文件的所有者。已有数据应按下节迁移，不要直接指向空目录重新初始化；Windows/Docker Desktop 还需在宿主机允许该目录共享和读写。

### 更换数据位置

更改 `DATA_PATH` 只切换挂载，不会搬迁数据。切到空目录后出现新管理员或空面板，不代表原账号被删除。

1. 等待任务和控制台结束，在旧配置下执行 `docker compose stop app`，确认应用停止；记录旧挂载和项目名。
2. 按[备份流程](#备份)保存整个旧 `/data`。备份脚本会保持原本已停止的应用为停止状态。
3. 准备一个独立、空的新目录，将旧数据全量复制或解压进去，保留文件所有者及权限。包括隐藏的 `.master-key`、仍存在的 `.initial-admin-password`、数据库和配套 WAL/SHM 文件，不能只复制 `.db`。旧数据在命名卷时可使用完整备份归档恢复；旧数据在宿主目录时可用保留属性的复制工具，例如 Linux 的 `cp -a /旧目录/. /新目录/`。
4. 确认新目录及内部文件可由 UID/GID `1000:1000` 读写，且内容与停止后的旧数据一致，再修改 `DATA_PATH`。保留原目录或命名卷及备份。
5. 执行 `docker compose up -d --force-recreate --wait app`，确认原管理员、账号和资源均在，再恢复使用。若显示空面板，先停止应用并核对挂载，不要重新导入账号。

迁移到新的命名卷时同样需要先完整恢复数据，并在 Compose 中声明该卷。更换数据位置不需要修改容器内的 `DATABASE_PATH`。

### 高级应用变量

以下应用变量仅供高级部署或本地开发使用；Docker 中需显式加入 `compose.override.yaml` 的 `services.app.environment`。不要用 `env_file: .env` 把本地数据库路径或宿主机端口一起注入容器。

| 变量                      | 含义                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `ADMIN_USERNAME`          | 空数据库的首次管理员名称，默认 `admin`。                                                            |
| `ADMIN_PASSWORD`          | 指定首次管理员密码，12–256 个字符；默认自动生成。显式指定时不创建初始密码文件；已有管理员时不覆盖。 |
| `MASTER_KEY`              | 可选的 Base64 编码 32 字节密钥；验证成功后也持久化到 `.master-key`，必须与已有数据匹配。            |
| `APP_ORIGIN`              | 可选固定访问源，如 `https://oci.example.com`；默认按请求的 Host 和 Origin 校验。                    |
| `PORT`                    | 应用监听端口；镜像固定默认值 3000。Compose 的 `${PORT}` 仅控制宿主机映射。                          |
| `DATABASE_PATH`           | 本地默认 `data/oci-dash.db`；Compose 固定为 `/data/oci-dash.db`。                                   |
| `NEXT_TELEMETRY_DISABLED` | 镜像已设置为 `1`，关闭 Next.js 遥测。                                                               |

例如只允许从一个固定域名登录，可使用以下可选覆盖文件，通常不需要配置：

```yaml
services:
  app:
    environment:
      APP_ORIGIN: https://oci.example.com
```

开发及工具脚本要求 Node.js `>=26.13 <27`，与镜像一致的版本为 `26.13.0`；仅部署容器无需安装宿主机 Node.js。首次部署见 [README](../README.md#快速部署)。修改容器配置后需要重新创建：

```sh
docker compose up -d --force-recreate app
```

Web、网关和 Worker 使用同一数据库和密钥文件。本地运行默认将这些文件保存在 `data/`。

新数据库启动后是普通空面板。旧 `DEMO_MODE` 环境变量不再读取，也不能暂停任务或控制台恢复；已有部署升级前见[专项检查流程](#从旧-demo_mode-配置升级)。

## HTTPS 与访问

Compose 仅发布 `127.0.0.1:${PORT}`。反向代理应将 HTTPS 域名转发到该地址；代理若在另一个容器中，不能把自己的 `127.0.0.1` 当成宿主机。

默认根据浏览器 Origin 与请求 Host 校验来源，HTTPS 来源使用 `Secure` 会话 Cookie。反向代理必须保留公开域名和端口；应用不使用 `X-Forwarded-Host` 替代 Host。可选的 `APP_ORIGIN` 会进一步锁定完整访问源，配置后必须与实际访问地址一致。

VNC 与面板共用域名和端口，代理需支持 WebSocket Upgrade。以下设置可加入现有 Nginx/OpenResty 代理 location；它不是完整站点配置：

```nginx
proxy_http_version 1.1;
proxy_set_header Host $http_host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

保留正确的 Host/Origin。不要另外公开 5900、6080 或绕过网关转发控制台。应用主机需要能以 SSH 协议连接 OCI 控制台服务的 TCP 443，仅支持 HTTPS 的出口代理不一定能承载该连接。

## 运行、停止与健康检查

```sh
docker compose ps app
docker compose logs --tail 100 app
docker compose exec app node dist/health.mjs
```

镜像使用 Tini 作为进程入口，处理信号转发与子进程回收；`node dist/runtime.mjs` 管理独立的 Web 和 Worker 进程，并提供 HTTP/WebSocket 网关。业务进程意外退出时，运行入口停止另一个进程并非零退出，交由 Compose 中的 `restart: unless-stopped` 重启容器。

整体健康检查同时验证 Web、SQLite 和当前 Worker 心跳；`GET /api/health` 只检查 Web 与 SQLite。Docker 的 `unhealthy` 标记本身不会触发 Compose 重启策略。

```sh
docker compose stop app
docker compose up -d app
```

优先等待活动任务和控制台会话结束后停止。Worker、运行入口和 Compose 的停止期限分别为 25、30、35 秒。停止进程不会撤销 OCI 已受理的操作；手动停止后的容器不会自行重启。

数据卷或宿主目录应位于支持本地文件锁的文件系统。本部署不支持多主机通过 NFS 共享 SQLite。普通 `docker compose down` 保留命名卷；`down -v` 会删除声明的命名卷，不用于日常重启。

## 账号、同步与任务

同一租户保存一份配置。更新 API 密钥或增减区域时编辑已有账号；新增或更换租户时会拒绝重复配置。旧重复记录不会自动删除，资源归属冲突需要先在设置中处理。

首次连接、凭据变化、错误重连或没有同步记录时，Worker 先验证账号；正常已连接账号直接读取库存。可见资源页每 60 秒检查账号是否过期，同一账号的活动同步合并，失败逐步退避到最多 15 分钟。

手动刷新按各账号完成情况逐步读取快照。页面隐藏、离开或等待超时只停止浏览器轮询，后台任务继续。自动同步不进入普通任务列表；每个账号只保留最近的已结束自动记录，手动任务保留历史。

| 状态                                 | 运维含义                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `queued` / `running`                 | 已排队，或由 Worker 持有租约执行。                                           |
| `retrying`                           | 可重试错误，等待下次执行。                                                   |
| `cancel_requested`                   | 等待安全边界停止；不回滚已接受的云操作。                                     |
| `interrupted`                        | 执行器退出或租约失效，需要核对检查点；有剩余预算和下次执行时间时可自动恢复。 |
| `succeeded` / `failed` / `cancelled` | 已结束；失败或取消不代表云端从未发生变化。                                   |

请求错误默认最多尝试 4 次。OCI 已受理但尚未完成时，核对结果不消耗错误重试次数；每轮执行有自首次领取起的 30 分钟完成期限，重启不会延长期限。手动重试保留任务编号和检查点，增加预算并开启新的完成期限。

同一 Worker 最多同时同步两个账号并执行一个写任务。SQLite 约束写任务全局串行，以及同账号同步与写入互斥。写操作成功但随后库存刷新失败时会另排同步任务，不应为刷新页面而重复执行写操作。

## VNC 控制台

需要 OCI 实例读取和控制台连接创建、列举、读取、删除权限。应用使用临时 SSH 密钥，不要求实例 SSH 服务或公网 IP 可用，也不会安装来宾 VNC 服务。

全站同时一个会话，15 分钟无操作或达到 1 小时上限后断开。关闭页面、登出或服务重启会触发清理。应用仅删除与记录中的账号、实例和会话标签匹配的连接，已有外部控制台不会被删除。

SSH 外层服务密钥须匹配 OCI API 指纹；内层仅通过该认证通道记录本次主机密钥。镜像设置 `TMPDIR=/dev/shm`，使用 Docker 默认私有 tmpfs（默认 64 MiB）保存 SSH 临时文件和运行状态；正常断开删除临时密钥，停止容器后内存文件系统不保留。无需额外挂载 `/tmp`。

清理失败时保留全局会话占用和账号锁，并定时重试。404 仍需通过所属实例的连接列表确认消失；权限不足或创建结果不明时不能释放占用。先恢复 OCI 权限，再使用“重试断开”；不要通过删除数据库行绕过清理。

### 旧 API 密钥已失效时

如果清理因 API 密钥撤销而一直失败，可受控替换清理凭据：

1. 先断开控制台，等待已经发出的创建、清理请求真正结束，并结束或取消该账号未完成的任务。
2. 在“设置 → OCI 账号”编辑该账号，选择“替换连接凭据”和“恢复控制台清理（旧 API 密钥已失效）”。
3. 提供**同一 tenancy、同一 user** 的新 OCI API 配置及对应 RSA PEM。原 home region 和同步区域保持不变。
4. 保存后等待后台以新凭据重试清理。全局占用仍保留，清理成功后再手动连接和同步资源。

只有失败、待清理、本机隧道已关闭、没有在途创建/清理且账号没有未结束任务的会话接受该操作；不满足条件时会拒绝保存。此恢复不会自动排队同步，也不允许更换账号身份或区域。

新会话会持久化已验证的所属区间，清理不依赖实例仍然存在。旧记录缺少区间且实例也无法读取时，需要成功枚举完整区间范围和各区间的控制台连接；权限不足时继续保留清理锁。

## 备份

备份至少包括 `/data` 对应的完整命名卷或宿主目录、匹配版本的镜像或可重建源码，以及管理员恢复材料。持久数据包含 `.master-key`，应把归档视为可解密的敏感数据；加密存储不保护整个目录或卷泄露、主机失陷。数据库里的资源名称、IP、任务和统计报告不是全库加密。尚未迁移的旧部署还需单独保管原 `MASTER_KEY`。

只下载发布 Compose 的用户可以使用自己的 Docker 卷备份或宿主目录归档工具，不需要 Node.js。先结束活动任务和控制台会话，记录原运行状态，再执行 `docker compose stop app` 并确认已停止。完整归档挂载到 `/data` 的目录内容，包括数据库、WAL 等配套文件、隐藏的 `.master-key` 和仍存在的初始密码文件；保留所有者和权限。备份目标必须在源数据目录之外，同时保存对应版本的 Compose 及自己的可选配置。备份完成后，仅在原来运行时恢复 `docker compose start app`。

源码仓库另提供自动处理停止、归档及原状态恢复的工具；它不包含在单份发布 Compose 中，也不是普通部署的前置条件。额外取得对应版本源码、Node.js `26.13.0` 和 Docker CLI 后，可显式选择已有部署执行，例如：

```sh
COMPOSE_FILE=/opt/oci-dash/compose.yaml \
COMPOSE_PROJECT_NAME=oci-dash \
node /opt/oci-dash-source/scripts/backup.ts /opt/backups/oci-dash-data.tar.gz
```

将示例路径和项目名替换为实际部署；已有自定义项目名必须保留，不能指向开发项目。工具不需要重新构建或启动新镜像，也可在源码目录通过 `npm run backup -- <输出路径>` 调用，但仍须正确选择部署的 `COMPOSE_FILE`、`COMPOSE_PROJECT_NAME`。它读取现有 `app` 容器的不可变镜像，支持 `/data` 的命名卷和宿主目录；自定义容器内数据库路径不在此工具范围内。输出必须是项目及源数据目录之外、以 `.tar.gz` 结尾的新文件，不覆盖已有归档。

脚本停止应用后，以镜像内的 `node` 用户只读挂载原数据，将归档传给宿主机写入；宿主目录需要与应用运行时相同的读写权限，不通过 root 或自动修改所有者绕过权限。备份前应用正在运行才会在结束后恢复运行，原本停止的应用保持停止。

使用仅自己可访问的目标目录。Unix 上归档应为 `0600`；Windows 还需使用目录 ACL 限制访问。如果备份或恢复运行状态失败，应按错误信息检查容器状态，不要把失败过程当作成功备份。

归档不替你备份可选的外部配置。不要通过日志、聊天、Issue 或截图传递密钥。不要只复制运行中的 `.db` 而遗漏 WAL 和密钥，也不要把数据库归档存回仓库。

## 恢复与升级

恢复先在隔离环境演练：

1. 准备与备份匹配的镜像，以及包含原 `.master-key` 的完整归档。旧归档不含密钥时，还需按[环境密钥迁移流程](#从环境变量主密钥迁移)显式注入原 `MASTER_KEY`；仅把它写在 `.env` 中不会传入默认容器。
2. 使用新的 Compose 项目名、空数据卷或独立宿主目录和不同宿主机端口；如配置了 `APP_ORIGIN`，同步调整。使用 `DATA_PATH` 时显式改成恢复目录，不能沿用生产路径。
3. 将归档完整恢复到该项目的 `/data` 挂载，保留所有者和权限，确保镜像中的 `node` 用户可读写。保留生产数据不动。
4. 在启动 Worker 前核对数据库完整性、管理员登录、账号和非终态任务。

默认入口会启动 Worker，可能继续恢复的任务。只检查 Web 时，可在隔离项目中临时覆盖命令，并选择一个未使用的 loopback 端口（示例为 3001）：

```sh
docker compose -p oci-dash-restore run --publish 127.0.0.1:3001:3000 \
  --rm --no-deps app node server.js
```

该命令不启动 Worker 或 VNC 网关，但 Web API 仍能接收操作请求，并非只读模式。缺少 Worker 心跳时整体健康检查失败是预期现象；可用 HTTP `/api/health` 检查 Web/SQLite。结束检查后停止该临时容器。

备份可能早于云操作实际完成时间。核对 OCI 状态、任务检查点和请求标识后，才在对应隔离项目启动完整应用。恢复本地数据不是云资源回滚。完整异机恢复演练的验证状态见[验证指南](VERIFICATION.md)。

升级前完成一致性备份并保留旧镜像。原密钥只保存在环境变量中时，先完成[密钥迁移](#从环境变量主密钥迁移)；旧部署曾设置 `DEMO_MODE=true` 时，先完成[暂停状态检查](#从旧-demo_mode-配置升级)。

从目标版本的 GitHub Release 下载新的 `compose.yaml`，或将现有文件的 `image` 改为对应固定版本。替换文件前核对并保留原项目名、服务名 `app`、默认 `app-data` 卷，以及原 `PORT`、`DATA_PATH` 和必要的高级覆盖配置；直接覆盖曾手动修改映射的文件可能改挂空数据位置。默认项目名保持 `oci-dash`，升级不要求移动数据或删除卷。完成适用检查后，在原部署目录执行：

```sh
docker compose pull app
docker compose up -d --wait app
docker compose exec app node dist/health.mjs
```

数据库迁移在启动时执行，没有通用降级迁移。回退需匹配的旧镜像和旧备份，不能把旧程序直接指向已升级数据库。直接更换 `MASTER_KEY` 也不是密钥轮换。

### 从环境变量主密钥迁移

旧版本使用 `.env` 内的 `MASTER_KEY`，新默认 Compose 不再注入它。升级前先备份数据并保留原 `.env`；若数据卷尚无 `.master-key`，临时创建 `compose.key-migration.yaml`：

```yaml
services:
  app:
    environment:
      MASTER_KEY: ${MASTER_KEY:?Keep the original key in .env}
```

核对没有待执行任务或活动控制台后，先带原密钥启动新镜像：

```sh
docker compose -f compose.yaml -f compose.key-migration.yaml pull app
docker compose -f compose.yaml -f compose.key-migration.yaml up -d --wait app
docker compose exec app node dist/health.mjs
```

新版本校验现有凭据和 MFA 均能解密后，才持久保存原密钥；密钥不匹配时会拒绝启动。确认健康后，移除临时覆盖文件并运行 `docker compose up -d --force-recreate --wait app`，验证不注入环境密钥也能正常启动。最后重新备份完整卷。已有管理员不会重置或生成新的初始密码。

不要用随机新密钥修复解密错误，也不要在完成迁移前删除原 `.env` 或旧备份。若原来还有可选的域名限制，将 `APP_ORIGIN` 保留在自己的覆盖文件内。

### 从旧 DEMO_MODE 配置升级

新版本不读取 `DEMO_MODE`。旧 `.env` 中保留 `DEMO_MODE=true` 也不会暂停执行：完整入口启动后，已有未完成任务会按租约、重试和完成期限规则继续，控制台会话会恢复核对或清理。是否有旧账号与任务取决于数据库，不取决于环境变量；没有自动清空或替换已有数据的迁移。

若原部署依赖该变量暂停执行，在启动新镜像之前按以下路径检查：

1. 在原部署目录执行 `docker compose stop app`，再用 `docker compose ps -a app` 确认已经停止。旧双容器部署必须同时停止 `web` 和 `worker`。
2. 按备份流程保存一致性数据与原主密钥。当前备份脚本会保持原本已停止的应用为停止状态；不要为检查先启动完整应用。
3. 将归档解压到独立目录，用 SQLite 工具以**只读方式**打开该副本中的数据库。保留归档内的配套 WAL 文件；不要直接打开仍在运行的生产库。
4. 先检查表是否存在，再对存在的表执行下列只读查询。核对任务检查点、账号、实例、控制台连接和 OCI 实际状态。不要通过删除或改写数据库行取消任务或释放锁。

```sql
SELECT name FROM sqlite_master
WHERE type = 'table' AND name IN ('jobs', 'console_sessions');

SELECT id, kind, account_id, state, next_run_at, checkpoints_json, last_error
FROM jobs
WHERE state IN ('queued', 'running', 'retrying', 'cancel_requested', 'interrupted')
ORDER BY created_at;

SELECT id, account_id, instance_id, state, connection_id, cleanup_pending, last_error
FROM console_sessions
WHERE slot IS NOT NULL OR cleanup_pending = 1
ORDER BY created_at;
```

确认允许恢复后，移除过时的环境变量并按上方命令升级和启动。仍有不确定操作时保持应用停止，先核对云端状态；即使云请求是在停止前提交，也可能已经完成。只启动 `node server.js` 不会恢复控制台或启动 Worker，但网页仍可能读取 OCI、排队同步或接受修改，不能作为只读核对工具。

## 从旧版双容器部署迁移

仅适用于仍使用 `web`、`worker` 的旧 Compose 文件：

1. 先按旧版本支持的方式取得一致性备份；尚无 `app` 服务的旧配置不能直接运行当前备份脚本。
2. 在旧配置下执行 `docker compose stop web worker`，确认两个服务停止。
3. 采用对应版本的发布 Compose，保留原项目名、数据卷和主密钥；原环境密钥按[迁移流程](#从环境变量主密钥迁移)显式注入。保留需要的可选覆盖配置，再拉取镜像、启动并检查 `app`。
4. 验证成功后执行 `docker compose up -d --remove-orphans app`，移除已停止的旧容器。

默认卷通常名为 `oci-dash_app-data`。曾自定义项目名时必须确认实际卷，避免误连空卷；不要用 `down -v` 迁移。

## 常见问题

| 现象                       | 优先检查                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| 页面正常，任务不执行       | 整体健康检查、Worker 日志、任务状态、租约和重试时间。                                                |
| 登录或写请求来源不匹配     | 浏览器 Origin 与代理保留的 Host 是否一致，以及可选 `APP_ORIGIN` 限制。                               |
| 导入或恢复后无法解密       | 数据库与原 `.master-key` 是否配套；旧环境密钥是否按迁移流程传入。                                    |
| 修改初始化密码后仍无法登录 | 初始化变量不会重置已有管理员；默认 Compose 不注入 `.env` 中的应用变量，正常改密在“设置 → 登录安全”。 |
| 改数据位置后出现空面板     | 先停止应用，核对 `DATA_PATH`、项目名及旧数据是否完整迁移；不要重新导入账号。                         |
| 自定义数据目录无法启动     | Linux 目录及文件是否允许 UID/GID `1000:1000` 读写，是否保留密钥和文件权限。                          |
| 部分库存未更新             | 同步 warnings、OCI 权限与可见区间；旧详情会保留并标记。                                              |
| 指标或费用缺失             | Monitoring/Usage API 权限、时间范围和采集代理；详见[统计说明](ANALYTICS.md)。                        |
| 任务结果不确定             | 先核对远端状态和检查点，再决定重试或取消。                                                           |

当前没有忘记管理员密码后的自动找回工具，也没有批量主密钥重加密工具。请在需要恢复前保存管理员恢复码、主密钥和一致性备份。

返回[README](../README.md) · [安全说明](../SECURITY.md)
