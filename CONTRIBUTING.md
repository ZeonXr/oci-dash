# 贡献指南

感谢帮助改进 OCI Dash。开始前请阅读 [README](README.md)、[架构与 API](docs/IMPLEMENTATION.md) 和仓库中的 [AGENTS.md](AGENTS.md)。安全漏洞按 [SECURITY.md](SECURITY.md) 处理，不在普通 Issue 或 PR 中公开敏感细节。

## 开发环境

需要 Node.js `>=26.13 <27` 和 npm，开发、Docker 镜像和 CI 统一使用 Node.js `26.13.0`。原生依赖在没有对应预编译包的平台上可能需要本机编译工具。

可选使用 [mise](https://mise.jdx.dev/) 管理项目环境。仓库的 `mise.toml` 固定 Node.js `26.13.0`；安装 mise 后，在项目目录执行：

```sh
mise trust
mise install node@26.13.0
mise exec -- npm ci
mise exec -- npm run dev
```

版本选择只作用于本项目，不修改全局默认版本。第二个终端可用 `mise exec -- npm run worker` 启动 Worker；下文的检查命令也可加上 `mise exec --` 前缀。已有符合要求的 Node.js 时，可直接使用下面的 npm 命令。

使用独立的开发检出目录和空数据库：

```sh
npm ci
npm run dev
```

在第二个终端、同一目录启动 Worker：

```sh
npm run worker
```

打开 `http://localhost:6240`。首次在浏览器中填写用户名、密码和确认密码，或生成并复制 32 位随机密码；创建成功后自动登录并关闭初始化入口。主密钥自动保存到 `data/.master-key`，不生成默认管理员、初始密码文件或示例账号。项目不再提供 `.env.example`，Worker 启动不加载 `.env`；高级配置通过终端环境变量传入，见[运维说明](docs/OPERATIONS.md#高级应用变量)。不要把生产配置复制到开发目录，也不要把密码放进提交或截图。

开发服务器默认只监听 `127.0.0.1:6240`；需要其他端口时运行 `npm run dev -- --port 6241`，远程调试时显式指定监听地址。Next.js 本身仍会读取检出目录中的 `.env*`，请将旧文件移出开发目录，避免 Web 与 Worker 使用不同配置；无需为此修改框架的加载逻辑。

普通 Next.js 开发服务器不包含完整 VNC 网关。需要检查容器入口、WebSocket 或 OpenSSH 流程时，使用隔离 Docker 测试。

发布用 `compose.yaml` 只拉取固定版本镜像，不包含构建配置。确需从源码启动开发容器时，在独立开发检出目录使用专用覆盖文件：

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

该命令构建 `oci-dash:local`，数据挂载为 Compose 所在目录的 `./data:/data`。Linux 首次运行前，用 `sudo install -d -o 1000 -g 1000 -m 0700 ./data` 创建空目录；Windows Docker Desktop 通过宿主 ACL 允许 Docker 访问。不要在生产部署目录运行它，也不要把开发数据目录混用为生产数据；默认自动化验证仍使用下方的隔离入口。公开发布只需要单份 `compose.yaml`，不要求使用者取得 `compose.build.yaml` 或其他源码文件。

`scripts/` 中的工具脚本使用 TypeScript，由 Node.js `26.13.0` 原生移除类型后直接运行，无需额外的 TypeScript 运行器。脚本只使用可移除的类型语法和显式 `.ts` 导入路径，不依赖应用的路径别名；不能把原生执行视为支持全部 TypeScript 语法。

PostCSS 插件列表使用静态 `postcss.config.json`，不需要可执行的 JavaScript 配置。

## 变更与测试

先用最小复现说明问题，再围绕最终行为提交变更。代码修改应保持公共 DTO、服务端校验和页面行为一致；涉及接口或运行方式时同步更新文档。

```sh
npm run format:check
node scripts/check-docs.ts
npm run typecheck
npm test
npm run build
```

`npm run typecheck` 分别检查应用和工具脚本：应用使用 `tsconfig.json`，工具脚本使用独立的严格配置 `scripts/tsconfig.json`。脚本目录中的配置也供编辑器自动识别 NodeNext 和可擦除语法约束。Node.js 执行脚本时不进行类型检查，提交前应运行该命令。`dist/*.mjs` 是运行时 TypeScript 的构建产物，部署命令保留这些文件名。

使用 `npm run format` 修正格式。项目的 Prettier、EditorConfig 和忽略规则决定格式与扫描范围，不要格式化环境文件、私钥、数据库或构建产物。

页面复用 `src/components/ui.tsx` 中的交互组件。刷新入口使用 `RefreshButton`，通过 `loading` 控制统一动画、禁用和 busy 状态；普通异步按钮使用 `Button` 的 `icon` 与 `loading`，由组件替换图标。初始加载使用 `LoadingState` 或 `Spinner`，不要在页面另写旋转动画。

区域使用 `RegionTag`，仅在同一标签内展示国旗与 OCI 区域代码；规格、OCID 等标识使用 `CodeTag`。这些标签不承担按钮行为。长标识允许换行，提供复制时始终复制完整原值；连接和任务状态继续使用 `Status` 或 `Badge`。

按改动范围补充有意义的回归：

- 队列和云写入：覆盖租约、取消、幂等恢复、账号/资源范围及不确定结果。
- 数据库升级：用固定的旧版表结构构造迁移输入，不通过删除最新结构中的列来模拟旧库，避免新索引改变测试前提。
- 库存：区分成功空集合与读取失败，保持 SQL 归属，验证部分同步的清理边界。
- 统计：覆盖 UTC 边界、缺失与零、十进制金额、多币种及缓存版本。
- 并发：验证实际在途请求上限、取消后不再派发、请求结束后再释放槽和客户端。
- 页面：验证用户可观察结果、迟到响应、键盘操作及窄屏布局；不要用真实账号数据作 fixture。

正式自动化测试使用可替换 OCI 客户端、临时 SQLite 和合成密钥。浏览器 UI 样例仅由 `tests/` 中的请求拦截提供，不向应用数据库注入示例资源，也不由生产代码导入。临时目录使用独立名称，结束后关闭连接并清理；删除前校验路径边界。不要让测试读取个人 `.env` 或真实密钥，也不要在默认测试中调用真实 OCI。

暂停浏览器时钟的测试应等待实际响应和页面状态。不要将 fixture 已记录请求视为浏览器已处理响应；需要轮询时，持续推进时钟至预期结果，同时保留请求数量和重复操作的断言。

## 隔离集成检查

浏览器回归入口会创建独立环境、全新空数据库和随机管理员凭据，并在退出后清理：

```sh
npm run test:e2e:isolated
```

默认构建专用临时镜像。脚本将发布 Compose 单独复制到测试目录，再显式覆盖测试镜像与随机配置，验证它没有其他仓库文件依赖。若刚完成 `docker build -t oci-dash:local .`，可用 `npm run test:e2e:isolated -- --no-build` 测试已有的 `oci-dash:local` 镜像。不要用过期镜像验证新源码。

运行时和备份检查需要先构建本地镜像。直接调用 Docker，不解析部署用 Compose 环境，也不要求存在 `.env`：

```sh
docker build -t oci-dash:local .
npm run test:runtime
npm run test:backup
```

浏览器安装、平台差异、已知基线和验收限制见[验证指南](docs/VERIFICATION.md)。真实 OCI 验收不属于上述自动化测试，必须另行选择隔离账号或资源，并记录操作范围与清理结果。

## CI 与发布

普通推送和 PR 中，纯 Markdown、许可证及静态文档附件变更只执行格式和本地链接检查；代码、运行脚本、配置、依赖和部署文件变更执行完整验证。无法确定变更范围时执行完整验证。发布流程调用 CI 时始终执行完整检查，不受文档范围判断影响。

完整 CI 先执行类型检查和单元测试，再通过 Docker 构建一次生产应用，随后检查容器生命周期、备份恢复和隔离浏览器流程。`Dockerfile` 负责构建，不再重复运行完整单测和独立工具脚本的类型检查；直接构建镜像不能替代源码检查。`node scripts/check-docs.ts` 只检查仓库内文件和 Markdown 标题链接，不联网检查历史版本或其他远程地址。

发布以源码 tag 对应固定版本镜像和同版本的独立 `compose.yaml` 资产。先验证版本与源码标签，分别构建并运行 Linux `amd64`、`arm64`，再组合已验证的镜像摘要。固定版本镜像和 Compose 附件发布成功后进行匿名部署验收，验收通过才推广 Docker 与 GitHub 的 `latest`；版本比较同时防止两个渠道回退。

发布中断后可以重跑失败任务：相同镜像摘要和相同 Compose 内容会复用，缺少的 Release 或附件会补齐；不同摘要或内容会拒绝覆盖。候选镜像可能被正式索引引用，不自动删除。实际执行结果见[发布验收](docs/VERIFICATION.md#v057-发布验收)。

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
