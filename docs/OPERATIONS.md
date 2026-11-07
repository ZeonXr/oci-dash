# OCI Dash 运维说明

本文说明默认的单主机 Docker 部署。Compose 项目为 `oci-dash`，唯一服务 `app` 使用 `oci-dash:local` 镜像，在同一容器内运行 Web 和后台 Worker，共享数据库及加密密钥。实际 OCI 验收范围与各项部署验证结果以 [验证记录](VERIFICATION.md) 为准。

## 环境配置

| 变量                      | 作用与默认值                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ADMIN_USERNAME`          | 空数据库首次管理员用户名；默认 `admin`。                                                                       |
| `ADMIN_PASSWORD`          | 首次管理员密码，至少 12 个字符；bootstrap 生成随机值。已存在管理员时不会覆盖其密码。                           |
| `MASTER_KEY`              | 32 字节 Base64 主密钥，用于 OCI 私钥与 MFA 秘密加密。Compose 必填，必须长期保留原值。                          |
| `APP_ORIGIN`              | 浏览器访问源地址，例如 `https://oci.example.com`；默认 `http://localhost:3000`。写请求的 Origin 与其严格匹配。 |
| `DEMO_MODE`               | 字符串 `true` 启用演示；bootstrap 与 Compose 默认开启。真实账号管理使用 `false`。                              |
| `DATABASE_PATH`           | 本地默认为 `data/oci-dash.db`；Compose 固定 `/data/oci-dash.db`。                                              |
| `PORT`                    | Compose 宿主机映射端口，默认 `3000`；容器服务仍使用 3000。                                                     |
| `NEXT_TELEMETRY_DISABLED` | 示例配置设为 `1`。                                                                                             |

所有进程应读取同一份配置。修改 `.env` 后，容器需要重新创建以获取新环境变量：

```sh
docker compose up -d --force-recreate app
```

修改管理员密码后，数据库中的密码散列更新，已有登录会话全部退出；环境变量中原来的初始化密码不会覆盖这次修改。MFA 的恢复码只显示一次，使用过的恢复码不能再次使用。

非 Compose 的本地运行若没有 `MASTER_KEY`，加密模块会在数据库目录生成原始 32 字节 `.master-key` 文件。该文件同样属于必要恢复材料。迁移到 Compose 时不能用新随机密钥替代已有数据库对应的密钥。

## 首次启动

先运行 `npm run bootstrap` 或 `node scripts/bootstrap.mjs`。如果 `.env` 已存在，脚本会原样保留；需要自行确认必填项不是空值。

```sh
docker compose up -d --build app
docker compose ps app
docker compose logs --tail 100 app
```

镜像构建会运行依赖安装、类型检查、离线测试、Next.js 构建，以及运行入口、Worker 和健康检查的打包。运行阶段使用非 root 的 `node` 用户；镜像构建阶段有编译 `better-sqlite3` 所需的工具。

`app-data` 为持久数据卷。正常更新或 `docker compose down` 不删除它；`docker compose down -v` 会删除数据库和任务记录，不属于日常重启步骤。

Web 和 Worker 使用 SQLite WAL 与 `busy_timeout`。数据卷应放在支持本地文件锁的文件系统上，不应将本版本作为多主机共享 NFS 数据库服务部署。默认只启动一个 `app` 容器；其中仍有 Web 和 Worker 两个业务进程，合并容器并不取消后台队列，也不承诺显著降低内存占用。

## 运行入口与停止

默认入口 `node dist/runtime.mjs` 管理 Next.js standalone `server.js` 和后台 `dist/worker.mjs`，同时提供统一 HTTP/WebSocket 网关。Next.js 仅监听容器内部动态分配的 loopback 端口，网关提供对外的 3000 端口。任何一个业务进程退出，包括意外以状态 0 退出，入口都会停止另一个并以非零状态退出。Docker 的 `restart: unless-stopped` 策略随后重启整个容器，避免只剩页面可访问或只剩后台执行的状态。

```sh
docker compose stop app
docker compose up -d app
```

入口收到 `SIGTERM` 或 `SIGINT` 后会转发信号并等待子进程退出。Worker 的硬停止上限为 25 秒，运行入口的等待上限为 30 秒，Compose 的停止宽限期为 35 秒。优先等待正在执行的任务结束后停止；进程退出不会撤销 OCI 已接受的操作，恢复时仍需依靠任务检查点核对远端状态。手动 `docker compose stop app` 后，容器保持停止，直到再次显式启动。

本地开发仍可分别运行 `npm run dev` 和 `npm run worker`；这不改变默认 Docker 单容器方式。

## HTTPS 与反向代理

Compose 仅绑定宿主机 `127.0.0.1:${PORT}`。反向代理需要把域名转发至该监听地址，并配置证书与 HTTPS。若代理自身运行在另一个容器中，其 `127.0.0.1` 指向代理容器本身，需使用合适的容器网络或宿主机访问方式。

`APP_ORIGIN` 必须包含实际协议、主机名及非默认端口。例如浏览器使用 `https://oci.example.com` 时，应配置该值，不要保留 `http://localhost:3000`。否则登录和其他写请求会返回 `ORIGIN_MISMATCH`。HTTPS 配置还决定会话 Cookie 的 Secure 属性。

任务页面通过 HTTP API 读取状态。VNC 控制台使用同域 `/api/console/sessions/:id/socket` WebSocket；同一个站点代理需要支持 Upgrade，并保留正确的 Host/Origin。无需额外映射 VNC 端口或配置独立的 `/myvnc/` 服务。例如在现有代理 location 中启用：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

VNC 页面和 WebSocket 都经过面板登录校验。不要为控制台创建绕过网关的公开转发。面板主机需能通过 SSH 协议访问所属区域的 OCI 控制台服务 TCP 443；仅允许 HTTPS 的出口代理可能无法承载 SSH。

## 控制台会话与清理

OCI 账号需要允许读取实例、创建/读取/删除实例控制台连接。此功能不要求来宾系统的 SSH 服务可用，也不依赖实例公网 IP；已有的外部 OCI 控制台连接会阻止新建，应用不会删除其他客户端的连接。

每次连接生成临时 SSH 密钥，所有 SSH 参数由服务端按已验证的 OCI 连接信息构造。外层主机密钥与 OCI API 返回指纹严格匹配；内层只通过已认证的外层通道连接，在同一次 SSH 握手中取得主机密钥并保存到本次会话的 known_hosts。内层不另开密钥扫描连接，避免超过 OCI 的并发连接限制。Compose 的 `/tmp` 使用 tmpfs，密钥与 known_hosts 不写入持久数据卷；直接运行镜像时也应挂载临时 `/tmp`。

全站同时一个会话；15 分钟无操作或到达 1 小时上限会断开。关闭页面、登出或重启时触发清理。清理异常的会话保留全局占用与所属账号锁，后台定时重试，也可在控制台页点击“重试断开”。不要通过删除数据库记录或修改账号密钥绕过清理；应先核对 OCI 控制台连接状态与权限。

会话仅删除带有本应用账号及会话标签、并与记录实例相符的 OCI 控制台连接。进程异常退出后，下一次启动会根据持久记录恢复清理。创建请求超时且云端结果仍不明确时，暂时查不到连接不会释放占用；应用继续按会话标签核对，直到确认并清理。切到演示模式不会执行这些云端清理，记录保留到恢复真实模式后处理。

## 演示模式切换

演示页面不展示真实账号数据，并在 API 层拒绝账号导入、资源操作和设置变更。Worker 在演示模式下只维持心跳，不领取已有的真实队列任务。示例指标不代表任何真实服务器状态。

连接真实账号前，将 `DEMO_MODE=false` 后执行 `docker compose up -d --force-recreate app`。添加账号后会自动排队验证连接并同步资源，失败时可在卡片上重试。不要在真实数据库上用演示开关代替任务取消。若要从真实模式切回演示，先等待正在执行的任务结束并停止 `app`，最好使用单独的数据卷/数据库预览；已有队列记录不会因模式切换自动消失。

## 任务状态与恢复

任务提交后先写入 SQLite，再由 Worker 原子领取；任务历史不会因为执行成功而删除。同一账号的目标实例以及共享安全组、磁盘、私网 IP 写操作使用资源锁。

| 状态                   | 含义                                                |
| ---------------------- | --------------------------------------------------- |
| `queued`               | 已保存，等待 Worker。                               |
| `running`              | Worker 已领取并持有租约。                           |
| `retrying`             | 可重试错误，等待下次执行时间。                      |
| `cancel_requested`     | 已请求取消，等待执行器在安全边界停止。              |
| `cancelled`            | 不再继续后续执行；已经被 OCI 接受的云变更不会回滚。 |
| `interrupted`          | Worker 退出或租约过期，远端结果尚需核对。           |
| `succeeded` / `failed` | 已确认成功，或本轮重试预算耗尽/遇到永久错误。       |

自动重试默认最多 4 次，采用有上限的指数退避和抖动。手动重试保留原任务编号、检查点、事件及累计执行次数，扩展下一轮重试预算。不要把任务的“重试”当作创建一条无关联的新操作。

Worker 重启后会读取保存的检查点，并由 OCI 适配层先核对远端状态。创建请求丢失响应等结果不明确的情况，不应盲目再创建。API 没有可靠幂等机制、令牌接近失效或远端状态无法确认时，任务会停下并记录原因。

某次云操作已经成功、但之后资源同步失败时，原操作保留成功结果，并新增独立同步任务；无需为了刷新列表重复执行原来的写操作。

## 健康检查与排错

```sh
docker compose ps app
docker compose logs --tail 200 app
docker compose exec app node dist/health.mjs
```

Compose 的整体健康检查执行 `node dist/health.mjs`，同时验证 Web、SQLite 与 Worker 最近心跳。HTTP `/api/health` 的语义仍是 Web 与 SQLite 可用，单独收到 HTTP 200 不代表后台正在工作。`node dist/worker-health.mjs` 仍可用于开发时的独立 Worker 诊断，但不能替代整体健康检查。

健康检查失败会让 Docker 标记容器为 `unhealthy`；该标记本身不会触发普通 Docker Compose 的重启策略。业务进程退出则由运行入口停止整个容器，再触发重启。检查不代表 OCI 凭据有效、所有区域可达或任务已经成功；账号连接任务与事件提供这些结果。

| 现象                              | 优先检查                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| 页面可打开，任务一直排队          | `app` 的整体健康状态、日志中的 Worker 启动与心跳、演示开关，以及任务状态。          |
| 登录或写请求提示来源不匹配        | 浏览器地址与 `APP_ORIGIN` 是否完全一致，修改环境后是否重建容器。                    |
| 导入账号后解密失败                | Web/Worker 的 `MASTER_KEY` 是否一致，是否误换了原密钥，恢复的数据库与密钥是否配套。 |
| 修改 `.env` 密码后仍不能登录      | 初始化变量不会重置已有管理员；正常改密请用设置入口。                                |
| 资源同步只返回部分区域            | 查看同步任务 warnings 和账号错误信息；不完整同步不会据此删除旧缓存。                |
| 任务停在 interrupted / 结果不确定 | 先核对 OCI 真实资源状态与检查点/请求标识，再决定手动重试或取消。                    |
| CPU/流量指标缺失                  | OCI 指标权限、监控插件、命名空间及时间范围是否有数据；本面板没有通过 SSH 补采指标。 |

## 备份

备份应包括完整数据卷，以及单独保存的原主密钥/环境配置。应用层加密不意味着数据库中的账号名称、IP 和任务事件都是密文；备份本身仍需受控存放。

如果曾使用回退的 `.master-key` 文件，完整目录归档也可能包含这份原始密钥。此时不能把归档当作只有密文的数据库备份，应对整个归档加密或把恢复密钥另外保管。

不要仅复制运行中数据库的 `.db` 文件而遗漏 WAL。最直接的一致性备份方式是先等待正在执行的任务结束，然后停止 `app`，再打包整个 `/data`。以下为部署主机上的 Bash 示例：

```sh
mkdir -p backups
backup_name="oci-dash-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose stop app
docker compose run --rm --no-deps --user 0:0 \
  --entrypoint tar -v "$PWD/backups:/backup" app \
  -C /data -czf "/backup/$backup_name" .
chmod 600 "backups/$backup_name"
docker compose up -d app
```

该命令只打包数据卷，不替你保存 `.env`。请另行保留 `MASTER_KEY`、管理员恢复材料和相关环境配置，并与数据库备份分开、受控地保存。没有原密钥时，无法恢复加密的 OCI API 私钥和 MFA 秘密。

## 恢复与升级

先在隔离的新 Compose 项目与空数据卷恢复，使用与备份匹配的镜像版本、原 `MASTER_KEY` 和正确的 `APP_ORIGIN`。将归档完整解压到 `/data` 并确保 `node` 用户有读写权限；隔离项目使用不同的宿主机端口，避免覆盖生产数据卷或占用生产端口。

**默认启动 `app` 会同时启动 Worker，并可能继续数据库中的非终态任务。** 若恢复核对阶段需要临时仅运行 Web，在隔离项目中覆盖默认启动命令：

```sh
docker compose run --service-ports --rm --no-deps app node server.js
```

该命令不运行默认入口，也不启动 Worker。只用此临时 Web 核对登录、账号和任务记录；Web 仍可接收操作请求，并非只读模式。缺少 Worker 心跳时整体健康检查不通过是预期现象，可用 HTTP `/api/health` 检查这次 Web 诊断。结束诊断后停止该临时容器。

包含非终态任务的备份可能早于 OCI 上的实际完成时间。在隔离环境核对 OCI 的实际资源状态、任务检查点及请求标识，决定如何处理这些任务后，再执行 `docker compose up -d app` 恢复完整运行。恢复不是云资源回滚，重新执行也不能假定云端还停留在备份时刻。

升级前保留镜像版本和一致性数据库备份，再构建、启动新版本。当前数据库迁移由应用启动执行，未提供通用降级迁移；回退应使用匹配的旧镜像与备份数据。直接更换 `MASTER_KEY` 不会重加密已有数据，本版本没有自动密钥轮换工具。

```sh
docker compose up -d --build app
docker compose exec app node dist/health.mjs
```

## 从旧双容器部署迁移一次

本节的 `web`、`worker` 名称仅用于旧版本迁移，日常命令均使用 `app`。迁移保留 Compose 项目名 `oci-dash`、`app-data` 数据卷、`.env` 与原 `MASTER_KEY`；不需要改数据库格式或重新导入账号。默认卷的完整名称通常为 `oci-dash_app-data`，若曾使用自定义项目名，应沿用原项目和实际数据卷，避免误连空卷。

1. 等待正在执行的任务结束，确认排队或等待重试的任务是否应在迁移后继续，并完成一致性备份。
2. **仍使用旧 Compose 文件时**执行 `docker compose stop web worker`，确认旧服务已停止，再更新代码和 Compose 文件。
3. 保留上述数据与配置，执行 `docker compose up -d --build app`，随后运行 `docker compose exec app node dist/health.mjs` 并检查登录、账号和任务记录。
4. 新 `app` 正常运行后，执行 `docker compose up -d --remove-orphans app`，清理同一项目中已停止的旧 `web`、`worker` 容器。不要使用 `down -v` 删除数据卷。
