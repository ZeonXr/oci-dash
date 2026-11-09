# OCI Dash

用于管理多个 Oracle Cloud Infrastructure 账号的自托管面板。基于 Next.js、TypeScript、官方 OCI SDK 和 SQLite，默认使用一个 Docker 容器运行 Web、后台任务执行器和控制台网关。

## 功能

- 导入 OCI API 配置，查看多区域实例、网卡、IP、IPv6、启动卷和原生指标。
- 查看账号详情中的租户、API 用户、已订阅区域和已同步资源概况，复制完整 OCID 与区域标识。
- 创建实例，以及启动、停止、重启、重命名和终止；管理公网 IP、启动卷 VPU、安全规则和 IPv6。
- 用持久任务执行云操作，支持进度、取消、有限重试和检查点恢复。
- 查看流量、按币种区分的费用、CPU 热力图和用量总览。缺失数据保留为空，不当作零。
- 通过浏览器连接 OCI 原生 VNC 控制台，无需上传实例 SSH 私钥或安装来宾 VNC 服务。
- 管理员登录、TOTP MFA 和一次性恢复码。

账号管理位于“设置 → OCI 账号”；登录安全和外观分别位于另外两个设置分区。当前面向单管理员使用，不提供不同用户之间的云账号权限隔离。

## 快速部署

只需 Docker Engine、Docker Compose 和一份 [v0.5.0 的 compose.yaml](https://github.com/ZeonXr/oci-dash/releases/download/v0.5.0/compose.yaml)，无需克隆源码、安装 Node.js 或创建 `.env`。发布镜像为 `ghcr.io/zeonxr/oci-dash:v0.5.0`，目标平台为 Linux `amd64` 和 `arm64`；发布验收状态见[验证指南](docs/VERIFICATION.md#v050-发布验收)。

在准备好的部署目录中，用浏览器下载上述文件并命名为 `compose.yaml`，或执行：

```sh
curl -fL https://github.com/ZeonXr/oci-dash/releases/download/v0.5.0/compose.yaml -o compose.yaml
```

Linux 首次部署时，在同一目录准备可由容器用户读写的数据目录：

```sh
sudo install -d -o 1000 -g 1000 -m 0700 ./data
```

Windows Docker Desktop 用户在该目录创建 `data` 文件夹，并通过宿主机 ACL 限制访问、允许 Docker 读写，无需运行上面的 Linux 命令。然后启动：

```sh
docker compose pull
docker compose up -d --wait
```

打开 `http://localhost:3000`，在首次初始化页面填写管理员用户名、密码和确认密码，也可点击按钮生成并复制 32 位随机密码。创建成功后自动登录，初始化入口随即关闭；重启和升级不会重置已有管理员。

**首次能访问初始化页面的人可以创建管理员。** 默认端口只绑定 `127.0.0.1`；远程服务器应先通过 SSH 隧道完成初始化，再开放公共 HTTPS 反向代理，见[访问说明](docs/OPERATIONS.md#https-与访问)。不需要额外的初始化令牌或必填环境变量。

这份 Compose 不依赖其他仓库文件。镜像自带非 root 用户 `1000:1000`、Tini 和应用默认值；Compose 保留重启、35 秒停止期限、权限限制及 `local` 日志驱动。新面板没有示例资源，添加账号后才会同步云资源。

数据固定挂载为 `./data:/data`：宿主机的 `data` 位于 `compose.yaml` 所在目录，保存数据库和自动生成的 `.master-key`。移动 Compose 文件时必须一起迁移数据，不能把空目录当作原部署。日常只需按需在可选的 `.env` 中设置 `PORT=3001` 等宿主机端口；默认是 `3000`，容器内仍为 `3000`。

**从旧命名卷部署升级**：先在旧配置下停机并完整备份原 `/data`，恢复到新的空 `./data`，核对权限后再切换挂载。直接替换 Compose 并挂载空目录会显示首次初始化页面，不会自动搬迁旧账号。步骤见[数据迁移](docs/OPERATIONS.md#从旧命名卷迁移到-data)。

后续升级下载目标版本的发布 Compose，或修改其中的固定镜像版本，再执行 `docker compose pull` 和 `docker compose up -d --wait`。保留原项目名和实际数据目录，先完成[升级检查](docs/OPERATIONS.md#恢复与升级)。源码开发和本地构建使用独立的 `compose.build.yaml` 覆盖文件，见[贡献指南](CONTRIBUTING.md)。

## 连接 OCI 账号

在“设置 → OCI 账号”粘贴 OCI 配置文本并选择对应的 API 签名私钥。应用会核对指纹，保存后在后台连接和同步。连接账号无需修改环境变量或重新创建容器。

需要至少 2048 位、未加密 PEM 格式的 RSA API 私钥；这不是实例的 SSH 私钥。配置中的 `key_file` 路径不会被读取，应用使用你选择的文件。同一租户保存一份账号配置，多个区域在该配置内管理。

资源刷新按账号逐步显示结果，慢账号不会阻塞其他账号。详情读取失败时保留旧值，并标记“部分未更新”。云操作由后台任务执行，离开页面不会取消已提交的任务。

账号卡片的“详情”按需读取 OCI 租户、身份用户和区域订阅信息，可单独刷新。配置中的主区域与 OCI 租户实际主区域分别展示；资源概况只汇总当前配置区域内已同步的实例，不代表全租户资源配额。缺失指标显示为未知，某项信息无权读取时保留其他可用内容。区域代码、规格和 OCID 使用统一的文本标签，长标识可查看及复制完整值。

实例卡片、表格和网络页中的 IP 可点击打开统一详情，查看地址类型、所属网卡、主要或次要私网地址及完整资源标识。更换临时公网 IP 的操作集中在弹窗内；固定、受保护、私网、IPv6 或信息未确认的地址仍可查看，操作按钮会禁用并显示原因。提交前会核对选中的地址绑定，变化后需要重新打开详情。

## 数据与安全

OCI API 私钥和 MFA 秘密使用 AES-256-GCM 加密，管理员密码使用 scrypt，登录令牌和恢复码以散列形式保存。数据库中的资源名称、IP、任务和统计报告并非全库加密。

加密密钥在首次启动时自动生成，保存在 `/data` 对应的持久数据中的 `.master-key`，无需手动填写 `MASTER_KEY`。无论使用命名卷还是宿主目录，都应完整备份和恢复，不能只保留数据库或删除密钥文件。完整备份包含解密材料，应限制访问；它不能抵御整个数据目录泄露或主机失陷。备份、恢复和升级请按[运维说明](docs/OPERATIONS.md)操作。

**旧版本升级**：此前在 `.env` 中使用 `MASTER_KEY` 的部署，先按[旧密钥迁移步骤](docs/OPERATIONS.md#从环境变量主密钥迁移)保存原密钥，再采用简化后的 Compose。新 Compose 不会自动把 `.env` 中的应用变量传入容器。

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

本项目采用 [MIT License](LICENSE)，镜像内包含 `/app/LICENSE`。第三方依赖和素材保留各自的许可证与版权声明，包括采用 [MPL-2.0 的 noVNC](https://github.com/novnc/noVNC/blob/v1.7.0/LICENSE.txt)；其依赖源码与许可随镜像的 `node_modules/@novnc/novnc` 保留。旗帜素材的来源及许可见 [public/flags/README.md](public/flags/README.md)。
