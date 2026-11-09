# OCI Dash

用于管理多个 Oracle Cloud Infrastructure 账号的自托管面板，面向单管理员使用。基于 Next.js、TypeScript、官方 OCI SDK 和 SQLite，一个 Docker 容器运行 Web、后台任务和控制台网关。

## 功能

- **账号与资源**：导入 OCI API 配置，查看账号详情，以及多个区域的实例、网卡、IP、IPv6 和启动卷。
- **实例管理**：创建、启停、重启、重命名和终止实例，管理公网 IP、启动卷 VPU、安全规则和 IPv6。
- **后台任务**：查看云操作进度与事件，支持取消、有限重试和检查点恢复。
- **数据统计**：查看流量、CPU 监控和按币种区分的费用；统计范围与口径见[统计说明](docs/ANALYTICS.md)。
- **浏览器控制台**：连接 OCI 原生 VNC 控制台，无需上传实例 SSH 私钥或安装来宾 VNC 服务。
- **登录安全**：管理员登录、TOTP MFA 和一次性恢复码。

## Docker 部署

需要 Docker Engine 和 Docker Compose。下载仓库的 [compose.yaml](https://raw.githubusercontent.com/ZeonXr/oci-dash/main/compose.yaml)，在独立部署目录执行：

```sh
curl -fL https://raw.githubusercontent.com/ZeonXr/oci-dash/main/compose.yaml -o compose.yaml

docker compose up -d --wait
```

默认镜像为 `ghcr.io/zeonxr/oci-dash:latest`，跟随最新通过发布验证的版本，支持 Linux `amd64` 和 `arm64`。无需克隆源码、安装 Node.js、创建 `.env`，也无需预先设置数据目录的 UID/GID 或执行 `chown`。容器默认以 root 运行，由 Docker 创建缺失的 `data` 目录；Docker Desktop 需允许 Docker 访问部署目录。

打开 **[http://localhost:6240](http://localhost:6240)**，创建管理员账号。页面可生成并复制 32 位随机密码，创建成功后自动登录；重启不会重置管理员。

默认端口仅绑定 `127.0.0.1`。远程部署时，先通过 SSH 隧道完成管理员初始化，再配置 HTTPS 反向代理，见[访问说明](docs/OPERATIONS.md#https-与访问)。

数据库和自动生成的 `.master-key` 保存在 Compose 同目录的 `./data`，完整备份时应包含整个目录。备份、恢复和升级步骤见[运维说明](docs/OPERATIONS.md)。

更新镜像需执行以下命令，正在运行的容器不会自动升级：

```sh
docker compose pull
docker compose up -d --wait
```

## 接入 OCI 账号

在“设置 → OCI 账号”中粘贴 OCI 配置文本，并选择对应的 API 签名私钥文件。私钥需为至少 2048 位、未加密的 RSA PEM，且与配置中的指纹一致；这是 OCI API 私钥，不是实例 SSH 私钥。

保存后，应用在后台验证连接并同步资源。同一租户保存一份配置，可在该账号内管理多个区域。点击账号名称可查看租户、API 用户、区域订阅和已同步资源概况。

## 自定义部署

在 `compose.yaml` 中直接修改端口和数据挂载：

```yaml
ports:
  - "127.0.0.1:6240:3000"
volumes:
  - "./data:/data"
```

端口映射中间的 `6240` 是宿主端口，容器内保留 `3000`；数据挂载左侧是宿主目录。修改后执行 `docker compose up -d --wait`。已有数据的移动方法及可选配置见[运维说明](docs/OPERATIONS.md#可选配置)。

## 文档

| 文档                                 | 内容                         |
| ------------------------------------ | ---------------------------- |
| [运维说明](docs/OPERATIONS.md)       | 部署、HTTPS、备份恢复与升级  |
| [架构与 API](docs/IMPLEMENTATION.md) | 模块职责、运行方式与接口契约 |
| [统计说明](docs/ANALYTICS.md)        | 流量、费用与 CPU 的统计口径  |
| [验证指南](docs/VERIFICATION.md)     | 测试方法、发布结果与验收边界 |
| [贡献指南](CONTRIBUTING.md)          | 开发环境、变更检查与发布流程 |
| [安全说明](SECURITY.md)              | 凭据、会话与漏洞报告         |

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖和素材保留各自的许可证与版权声明，包括 [MPL-2.0 的 noVNC](https://github.com/novnc/noVNC/blob/v1.7.0/LICENSE.txt) 和[旗帜素材](public/flags/README.md)。

应用标识使用 Oracle 椭圆环，来源与归属见[素材说明](public/README.md)。Oracle 名称与标识归 Oracle 所有；OCI Dash 是独立项目，与 Oracle 无隶属或背书关系。
