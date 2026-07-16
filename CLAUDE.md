## env api key

你绝对不能提交任何eval目录下的.env文件，不能够将它打包到npm，不能够泄漏api key

## 回复语言

必须采用中文回答用户

## 测试

```bash
npx vitest run test/domains/comet-classic/comet-scripts.test.ts   # comet 脚本契约 + 行为测试
npx vitest run                                   # 全量测试
```

## 提交前检查

仓库已配置 Git pre-commit 钩子（husky + lint-staged），每次 `git commit` 会自动对 `app/`、`domains/`、`platform/` 下的暂存源文件运行 `prettier --write`（与 CI `format:check` 范围一致），编辑器无关，所有贡献者生效。

提交前建议手动确认（CI 会强制检查）：

```bash
pnpm format:check   # Prettier 格式检查
pnpm lint           # ESLint
pnpm build          # TypeScript 构建
pnpm test           # 单元测试
```

注：本地 Windows 若 `core.autocrlf=true`，未改动的旧文件可能因 CRLF 被 `prettier --check` 误报；钩子只处理暂存文件，不受影响，旧文件下次编辑时会自动转为 LF。

## Commit 规范

提交信息必须使用类型前缀，格式为 `<type>: <summary>`，scope 可选：`<type>(<scope>): <summary>`。

常用类型包括：`feat`、`fix`、`docs`、`chore`、`refactor`、`test`、`build`、`ci`、`perf`。

示例：

- `feat: add eval report language switch`
- `fix(eval): prevent chart labels from overlapping`
- `docs: update contributor commit rules`

## 项目结构规范

当前源码目录按责任分层：

- `app/`：CLI 入口、命令编排和用户交互层。只能组合 domain/platform 能力，不承载领域规则。
- `domains/`：业务领域模块。每个子目录是一个可独立维护的领域模块，例如 `domains/bundle/`、`domains/comet-classic/`、`domains/dashboard/`、`domains/skill/`。
- `platform/`：文件系统、进程、安装平台、版本、路径等平台适配能力。domain 不应直接散落平台差异逻辑。
- `scripts/`：构建、发布、benchmark、lint 等仓库自动化脚本。可调用源码模块，但不要成为运行时业务入口。
- `assets/`：发布资产和内置 Skill 内容。修改 runtime 源码后必须通过构建同步生成资产，不要把业务逻辑只写在生成物里。

测试目录必须跟随被测对象归属：

- `test/app/` 覆盖 `app/` 命令和 CLI 行为。
- `test/domains/<domain>/` 覆盖对应 `domains/<domain>/` 模块；新增 domain 时同步新增同名测试目录。
- `test/platform/` 覆盖 `platform/` 适配层。
- `test/scripts/` 覆盖 `scripts/` 自动化脚本。
- `test/repository/` 覆盖 README、CI、仓库布局等跨层约束。
- `test/fixtures/` 和 `test/helpers/` 只放测试数据与测试工具。
- 禁止新增或恢复 `test/ts/` 这种横向桶；旧文件应迁移到上面对应目录。

架构约束由 `pnpm run lint:architecture` 校验，并已接入 `pnpm lint`。它会检查顶层目录白名单、活跃源码根、app/domain/platform 子模块、脚本模块、Classic runtime 入口/生成物、内置 Skill 根目录、测试归属和禁止旧目录回归。如果确实需要新增顶层目录、源码模块、测试根目录或例外，必须先更新 `config/repository-layout.json`、架构 linter 和本节说明。

## 脚本架构规范

脚本位于 `assets/skills/comet/scripts/`，全部是 **Node.js 启动器（`.mjs`）**，只依赖 Node.js（用户用 comet 必有 Node.js），**不依赖 bash / Git Bash / WSL**。

- 每个启动器（`comet-state.mjs`、`comet-guard.mjs`、`comet-handoff.mjs`、`comet-archive.mjs`、`comet-yaml-validate.mjs`、`comet-hook-guard.mjs`）是薄封装：`import { main } from './comet-runtime.mjs'` 后以 `main(['<command>', ...process.argv.slice(2)])` 分发。
- 所有真实逻辑在 `domains/comet-classic/*.ts`（TypeScript），由 `scripts/build/build-classic-runtime.mjs`（esbuild）打包成单个 `comet-runtime.mjs`。**修改 `domains/comet-classic/*` 后必须 `pnpm build` 重新生成 runtime**，否则测试用的是旧 bundle。
- `comet-env.mjs` 打印自身所在目录（scripts dir），供 skill 样板代码解析同级启动器路径。
- 跨平台由 Node 保证：hash 用 `node:crypto`，YAML 用 `yaml` 包，子进程用 `child_process`（构建/校验命令走 `spawnSync(cmd, { shell: true })`）。不再有 `sed -i` / `sha256sum` vs `shasum` / `pipefail` 等 shell 可移植性问题。
- 新增/重命名脚本必须同步：`assets/manifest.json` 的 `skills[]`（以及 `hooks` 里的 `comet-hook-guard.mjs`）、`test/domains/comet-classic/comet-scripts.test.ts` 的 `beforeEach` 拷贝列表、`.codex/skills/comet/scripts/` 镜像（该目录 gitignored，由 install 重新生成，本地保持一致即可）。
- skill 样板（boilerplate，当前版本 `v3`）在所有 SKILL.md / reference 中重复，改动需全量同步；样板通过 `find` 定位 `comet-env.mjs`，再用 `node "$COMET_ENV"` 解析路径，命令统一为 `node "$COMET_STATE" ...` 形式。

## 脚本依赖关系

```
comet-runtime.mjs  ←  所有 comet-*.mjs 启动器 import 它
  └─ domains/comet-classic/classic-cli.ts 分发：state / validate / guard / handoff / archive / hook-guard
comet-hook-guard.mjs ← PreToolUse hook（由 install 写入各平台 settings，命令形如 node <skillsDir>/.../comet-hook-guard.mjs）
```

打包入口 `domains/comet-classic/classic-cli.ts` 导出 `main` / `runClassicCli` / `CLASSIC_COMMANDS`；esbuild ESM bundle 保留这些 export，启动器直接 import 调用，单进程、无 bash、无二次 node 派生。

## .comet.yaml 状态机

每个 change 的状态文件，字段变更需要同步三处（全在 TypeScript 中）：

1. `domains/comet-classic/classic-state-command.ts` — `set` 白名单 + enum 验证（`SETTABLE_FIELDS` / `MACHINE_OWNED_FIELDS`）
2. `domains/comet-classic/classic-validate-command.ts` — schema 校验 + 已知字段
3. `test/domains/comet-classic/comet-scripts.test.ts` — 测试中的 yaml 字符串

改完 1/2 后 `pnpm build` 重新生成 `comet-runtime.mjs`，否则 `classic-runtime.test.ts` 的新鲜度检查会失败。

## 双语言 Skill

skill 优化时先写中文版本（`assets/skills-zh/`），用户确认后再修改英文版本（`assets/skills/`）。

## 中文术语翻译规范

中文文档不得把英文 “gate” 直译为“门”（如“压缩门”“调试门”“确认门”），这种译法在中文语境下不自然。应按实际含义翻译：

- `gate`（阶段性检查/阻塞点）→ 根据语境用“协议”“阶段”“检查”“阻塞点”等，如 `debug gate` → “异常调试协议”
- 修饰词性质的 `proactive/active` → “主动式”，如 `proactive context compression` → “主动式上下文压缩”，不写作“主动压缩门”
- 英文版保持原术语（如 Debug Gate），仅中文版需要遵循本规范

## Skill 触发表述规范

修改 skill 时，新增或调整依赖 skill 的触发方式必须和既有写法保持一致：

- 中文统一使用：`**立即执行：** 使用 Skill 工具加载 <skill-name> 技能。禁止跳过此步骤。`
- 英文统一使用：`**Immediately execute:** Use the Skill tool to load the <skill-name> skill. Skipping this step is prohibited.`
- 后续输入、上下文或执行要求写在“技能加载后 / After the skill loads”段落，不要把 `ARGUMENTS`、`fast-forward` 等另一套调用术语混入触发句。

## Changelog 规范

Changelog写英文

每次代码产生变更你都应该在完成后写Changelog，并确定是否需要升级版本号，版本号只会比master分支的版本号大一个版本，你需要确定一下当前master的版本号后做决定

如果当前已经有了一个比master大的版本Changelog，则应该追加到同一个版本的Changelog条目下

如果修改的是Skill内容，则需要等中英文完全同步之后再写Changelog

文件：`CHANGELOG.md`，新版本条目置顶。

```
## What's Changed [x.y.z] - YYYY-MM-DD

### Added / Changed / Fixed / Tests / Removed / Security

- **功能名**: 描述做了什么以及为什么
```

要点：

- 版本号与 `package.json` 的 `version` 字段一致
- 每条以 `- **粗体关键词**: ` 开头，后接具体变更内容
- 按类型分组：Added → Changed → Fixed → Tests → Removed → Security
- 描述侧重 **行为变更**（what + why），不是实现细节
- `### Tests` 条目汇总新增测试覆盖的场景，不逐条列出测试用例

写的Changelog应该是用户可视的版本，如果在一个分支上多次解决问题，但又不是master中的问题，而是开发中的问题，那这种内容不需要写入

### 常见错误：写偏问题

**核心规则：每个版本条目只描述与上一个 tag 之间的差异，不是开发过程记录。**

错误做法：

- 把开发分支上的所有迭代都写进 changelog
- 记录设计过程、文档迭代、重构历史
- 把已经在上一个 tag 中发布的内容重复写入
- 把开发中解决的内部问题（而非最终用户可见的改动）写入

正确做法：

- 先用 `git log <上一个tag>..HEAD --oneline` 确认实际改动范围
- 只写最终用户升级后能感知到的变化
- 如果一个功能经历了多轮迭代，只写最终形态，不写中间过程
- 如果一个改动在开发中解决了多个内部问题，合并为一条用户视角的描述
- 开发中的设计文档、重构、内部修复不需要出现在 changelog 中（除非它们改变了用户可见行为）

判断标准：**"一个从上个版本升级的用户，会注意到这个变化吗？"** 如果不会，不要写入。

### Changelog 发布视角检查

写 `CHANGELOG.md` 前必须先完成以下检查，不允许直接把 commit log 改写成 changelog：

1. **确定比较基线**
   - 确认 `package.json` 当前版本、`origin/master` 版本、上一个发布 tag。
   - 用 `git log <上一个tag>..HEAD --oneline` 只生成候选清单，不等于逐条写入。
   - 如果当前分支已有高于 master 的版本条目，只重写/追加到同一个版本条目，不新增流水账版本。

2. **先列候选，再筛选**
   每个候选变化都必须先判断：
   - 用户从上一个版本升级后是否会感知到？
   - 它是最终能力/行为，还是开发中间状态？
   - 它应该归类为 Added / Changed / Fixed / Removed / Security 中哪一类？
   - 是否有 issue / PR / 用户报告可追溯？

3. **禁止写入开发过程**
   不写：
   - 分支内反复修正、review follow-up、doc sync、coverage、test refactor
   - “修复刚新增功能里的问题”，除非该问题已经存在于 master / 已发布版本
   - 设计过程、重构过程、命名迁移过程
   - 预发布内部格式、未公开 CLI 别名、后端术语清理

   应合并为：
   - 一个最终用户可见能力
   - 一个从已发布版本继承来的用户可见修复
   - 一个安全/依赖风险修复

`### Tests` 只在测试/评估能力本身是用户可运行的发布能力时使用；普通回归测试、覆盖率补充、测试文件迁移不写入 changelog。

### Changelog 分类规则

- `Added`: 新命令、新平台、新 workflow、新用户可运行能力。
- `Changed`: 已有行为的用户可见语义变化，例如默认值、路由、升级判定、输出结构。
- `Fixed`: 修复已发布版本或 master 中用户会遇到的问题；新功能开发过程中发现并修掉的问题不算 Fixed。
- `Removed`: 移除用户曾经可见或可用的能力；未发布的内部别名/临时格式不要写。
- `Security`: 依赖漏洞、权限、路径穿越、敏感信息、执行安全相关修复。

## 修改Skill规范

不能够直接修改Superpowers和OpenSpec的原始Skill

## github规范

不能未经过同意直接在github上评论或者提交PR

## README改动

先写中文，再写英文，当feature更新后，更新README应该保持克制，确定是否是必要的需要列在READMD的内容，这部分要用户阅读友好，必要的亮点特性应该以文档引用的形式存在docs目录下
