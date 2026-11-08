# OCI Dash

用于管理多个 Oracle Cloud Infrastructure 账号的自托管面板。基于 Next.js、TypeScript、官方 OCI SDK 和 SQLite，默认使用一个 Docker 容器运行 Web、后台任务执行器和控制台网关。

## 功能

- 导入 OCI API 配置，查看多区域实例、网卡、IP、IPv6、启动卷和原生指标。
- 创建实例，以及启动、停止、重启、重命名和终止；管理公网 IP、启动卷 VPU、安全规则和 IPv6。
- 用持久任务执行云操作，支持进度、取消、有限重试和检查点恢复。
- 查看流量、按币种区分的费用、CPU 热力图和用量总览。缺失数据保留为空，不当作零。
- 通过浏览器连接 OCI 原生 VNC 控制台，无需上传实例 SSH 私钥或安装来宾 VNC 服务。
- 管理员登录、TOTP MFA 和一次性恢复码。

账号管理位于“设置 → OCI 账号”；登录安全和外观分别位于另外两个设置分区。当前面向单管理员使用，不提供不同用户之间的云账号权限隔离。

## 快速部署

需要 Docker Engine 和 Docker Compose。在项目目录中生成初始配置：

```sh
node scripts/bootstrap.ts
```

项目要求 Node.js `>=26.13 <27`，开发与镜像统一使用 `26.13.0`。该脚本由 Node.js 原生移除类型后运行，无需先安装项目依赖。只有 Docker 的 Linux 主机可以改用：

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" -w /workspace node:26.13.0-bookworm-slim \
  node scripts/bootstrap.ts
```

脚本只在 `.env` 不存在时生成随机管理员密码和主密钥，不会打印秘密或覆盖已有配置。不要先复制一个必填项为空的 `.env`；已有文件需要自行补全。

检查 `.env` 中的 `APP_ORIGIN` 和 `PORT`，然后启动：

```sh
docker compose up -d --build app
docker compose ps app
docker compose exec app node dist/health.mjs
```

默认访问地址为 `http://localhost:3000`，用户名为 `admin`，初始密码保存在 `.env` 的 `ADMIN_PASSWORD` 中。新数据库启动后是普通空面板，添加账号后才会同步云资源。宿主机端口只绑定 `127.0.0.1`；远程访问应通过 HTTPS 反向代理，`APP_ORIGIN` 必须与浏览器使用的源地址一致。VNC 还需要代理支持 WebSocket Upgrade。

Compose 服务为 `app`，数据库保存在 `app-data` 卷内的 `/data/oci-dash.db`。不要用 `docker compose down -v` 进行日常重启。

## 连接 OCI 账号

在“设置 → OCI 账号”粘贴 OCI 配置文本并选择对应的 API 签名私钥。应用会核对指纹，保存后在后台连接和同步。连接账号无需修改环境变量或重新创建容器。

需要至少 2048 位、未加密 PEM 格式的 RSA API 私钥；这不是实例的 SSH 私钥。配置中的 `key_file` 路径不会被读取，应用使用你选择的文件。同一租户保存一份账号配置，多个区域在该配置内管理。

资源刷新按账号逐步显示结果，慢账号不会阻塞其他账号。详情读取失败时保留旧值，并标记“部分未更新”。云操作由后台任务执行，离开页面不会取消已提交的任务。

## 数据与安全

OCI API 私钥和 MFA 秘密使用 AES-256-GCM 加密，管理员密码使用 scrypt，登录令牌和恢复码以散列形式保存。数据库中的资源名称、IP、任务和统计报告并非全库加密。

必须同时保留数据库备份和对应的原 `MASTER_KEY`，并分别受控存放。更换主密钥不会自动重加密数据；修改 `.env` 中的初始化密码也不会重置已有管理员。备份、恢复和升级请按[运维说明](docs/OPERATIONS.md)操作。

旧 `DEMO_MODE` 配置已不再读取。曾用 `DEMO_MODE=true` 暂停任务或控制台恢复的部署，升级后会按正常规则继续处理已有记录；启动新版本前请按[升级检查流程](docs/OPERATIONS.md#从旧-demo_mode-配置升级)停止并核对。停止应用不会撤销 OCI 已接受的操作。

使用独立环境测试，不要把生产 `.env`、数据库、密钥、日志或备份放进提交和测试产物。

## 限制与验证范围

- 不是完整的 OCI 控制台；复杂 IAM、VCN 设计和未列出的资源功能仍需官方控制台。
- 流量包含内网通信，不等于服务商的公网计费流量；费用可能延迟补报。详见[统计说明](docs/ANALYTICS.md)。
- CPU 依赖实例已有的 OCI 监控代理与权限。应用不会安装代理，也不通过 SSH 补采指标。
- IPv6 分配不会自动完成来宾系统、路由和访问规则配置。
- VNC 全站同时一个会话；清理未完成时保留占用。普通 `npm run dev` 不包含完整 VNC 网关。
- 不包含 AI 对话、Telegram 管理或通知、地图、自动救援、长期统计归档、预算或代理用户计量。
- 真实实例、IP、磁盘和安全规则写入的完整验收仍未完成。已有测试范围及复跑方法见[验证指南](docs/VERIFICATION.md)。

## 文档

| 文档                                 | 内容                               |
| ------------------------------------ | ---------------------------------- |
| [运维说明](docs/OPERATIONS.md)       | 配置、HTTPS、备份恢复、升级和排错  |
| [架构与 API](docs/IMPLEMENTATION.md) | 模块职责、任务与库存流程、接口契约 |
| [统计说明](docs/ANALYTICS.md)        | 流量、费用、CPU 的口径、范围和缓存 |
| [验证指南](docs/VERIFICATION.md)     | 可复现测试、历史基线和验收边界     |
| [贡献指南](CONTRIBUTING.md)          | 开发环境、变更检查和提交要求       |
| [安全说明](SECURITY.md)              | 信任边界、秘密管理和漏洞报告       |

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖和素材保留各自的许可证与版权声明；旗帜素材的来源及许可见 [public/flags/README.md](public/flags/README.md)。
