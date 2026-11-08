# 贡献指南

感谢帮助改进 OCI Dash。开始前请阅读 [README](README.md)、[架构与 API](docs/IMPLEMENTATION.md) 和仓库中的 [AGENTS.md](AGENTS.md)。安全漏洞按 [SECURITY.md](SECURITY.md) 处理，不在普通 Issue 或 PR 中公开敏感细节。

## 开发环境

需要 Node.js `>=26.13 <27` 和 npm，开发、Docker 镜像和 CI 统一使用 Node.js `26.13.0`。原生依赖在没有对应预编译包的平台上可能需要本机编译工具。

可选使用 [mise](https://mise.jdx.dev/) 管理项目环境。仓库的 `mise.toml` 固定 Node.js `26.13.0`；安装 mise 后，在项目目录执行：

```sh
mise trust
mise install node@26.13.0
mise exec -- npm ci
mise exec -- npm run bootstrap
mise exec -- npm run dev
```

版本选择只作用于本项目，不修改全局默认版本。第二个终端可用 `mise exec -- npm run worker` 启动 Worker；下文的检查命令也可加上 `mise exec --` 前缀。已有符合要求的 Node.js 时，可直接使用下面的 npm 命令。

使用独立的开发检出目录和空数据库：

```sh
npm ci
npm run bootstrap
npm run dev
```

在第二个终端、同一目录启动 Worker：

```sh
npm run worker
```

bootstrap 不覆盖已有 `.env`。新数据库只初始化管理员，启动的是普通空面板；应用不读取旧 `DEMO_MODE` 变量，也不生成示例账号。不要把生产环境配置复制到开发目录；初始管理员密码只从本地生成文件读取，不应出现在提交或截图中。开发脚本默认监听 `0.0.0.0`；仅本机使用时可运行 `npx --no-install next dev --hostname 127.0.0.1`。

普通 Next.js 开发服务器不包含完整 VNC 网关。需要检查容器入口、WebSocket 或 OpenSSH 流程时，使用隔离 Docker 测试。

`scripts/` 中的工具脚本使用 TypeScript，由 Node.js `26.13.0` 原生移除类型后直接运行。初始化可在安装依赖前执行 `node scripts/bootstrap.ts`，无需额外的 TypeScript 运行器。脚本只使用可移除的类型语法和显式 `.ts` 导入路径，不依赖应用的路径别名；不能把原生执行视为支持全部 TypeScript 语法。

PostCSS 插件列表使用静态 `postcss.config.json`，不需要可执行的 JavaScript 配置。

## 变更与测试

先用最小复现说明问题，再围绕最终行为提交变更。代码修改应保持公共 DTO、服务端校验和页面行为一致；涉及接口或运行方式时同步更新文档。

```sh
npm run format:check
npm run typecheck
npm test
npm run build
```

`npm run typecheck` 分别检查应用和工具脚本：应用使用 `tsconfig.json`，工具脚本使用独立的严格配置 `tsconfig.scripts.json`。Node.js 执行脚本时不进行类型检查，提交前应运行该命令。`dist/*.mjs` 是运行时 TypeScript 的构建产物，部署命令保留这些文件名。

使用 `npm run format` 修正格式。项目的 Prettier、EditorConfig 和忽略规则决定格式与扫描范围，不要格式化环境文件、私钥、数据库或构建产物。

按改动范围补充有意义的回归：

- 队列和云写入：覆盖租约、取消、幂等恢复、账号/资源范围及不确定结果。
- 库存：区分成功空集合与读取失败，保持 SQL 归属，验证部分同步的清理边界。
- 统计：覆盖 UTC 边界、缺失与零、十进制金额、多币种及缓存版本。
- 并发：验证实际在途请求上限、取消后不再派发、请求结束后再释放槽和客户端。
- 页面：验证用户可观察结果、迟到响应、键盘操作及窄屏布局；不要用真实账号数据作 fixture。

正式自动化测试使用可替换 OCI 客户端、临时 SQLite 和合成密钥。浏览器 UI 样例仅由 `tests/` 中的请求拦截提供，不向应用数据库注入示例资源，也不由生产代码导入。临时目录使用独立名称，结束后关闭连接并清理；删除前校验路径边界。不要让测试读取个人 `.env` 或真实密钥，也不要在默认测试中调用真实 OCI。

## 隔离集成检查

浏览器回归入口会创建独立环境、全新空数据库和随机管理员凭据，并在退出后清理：

```sh
npm run test:e2e:isolated
```

默认构建专用临时镜像。若刚完成 `docker build -t oci-dash:local .`，可用 `npm run test:e2e:isolated -- --no-build` 测试已有的 `oci-dash:local` 镜像。不要用过期镜像验证新源码。

运行时和备份检查需要先构建本地镜像。直接调用 Docker，不解析部署用 Compose 环境，也不要求存在 `.env`：

```sh
docker build -t oci-dash:local .
npm run test:runtime
npm run test:backup
```

浏览器安装、平台差异、已知基线和验收限制见[验证指南](docs/VERIFICATION.md)。真实 OCI 验收不属于上述自动化测试，必须另行选择隔离账号或资源，并记录操作范围与清理结果。

## 提交与评审

- 一个 PR 聚焦一项可以独立说明和验证的改动。
- 描述原问题、最终行为、验证方式，以及迁移、兼容性或未完成验证的限制。
- 数据库迁移需要说明已有数据的处理方式；不要自动删除旧账号、未确认的云操作或未完成的控制台清理记录。
- 不提交 `.env`、私钥、数据库、备份、日志、截图中的凭据或临时测试脚本。
- 引入第三方代码或素材时保留来源和许可证，确认其授权与项目许可证兼容。

提交前使用 `git diff --check` 和 `git status --short` 检查范围。验证记录应带日期、提交号或可识别的版本和执行环境；不要把本地运行结果描述成未执行的 CI 或云端验收。

## 文档约定

README 面向安装和使用；运维命令集中在 `docs/OPERATIONS.md`；统计口径在 `docs/ANALYTICS.md`；模块和接口在 `docs/IMPLEMENTATION.md`；复跑方法与验收边界在 `docs/VERIFICATION.md`。

使用通用示例，不写入个人环境信息或真实资源标识；以模块职责描述项目结构。可以保留有版本和方法说明的匿名性能样本，但不能把单次实测当作性能保证。

## 贡献许可

本项目采用 [MIT License](LICENSE)。提交贡献表示你有权提供相应内容，并同意按项目的 MIT 许可证分发你的贡献。引入上游代码或第三方素材时，必须另行核对其原许可证并保留要求的版权和许可声明；项目许可证不会替代第三方原有授权。
