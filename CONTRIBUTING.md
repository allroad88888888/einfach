# 贡献指南

感谢你对 Einfach 的关注！欢迎提交 issue 和 pull request。

## 环境要求

- Node.js >= 14.18.0
- [pnpm](https://pnpm.io/)

## 开始

```bash
git clone https://github.com/allroad88888888/einfach.git
cd einfach
pnpm install
```

## 开发流程

1. Fork 并克隆仓库
2. 创建特性分支：`git checkout -b feat/my-feature`
3. 构建：`npm run build`
4. 运行测试：`npm test`
5. 提交变更并创建 Pull Request

## 项目结构

```
vanilla/core/     → @einfach/core         # 核心 atom 引擎（框架无关）
vanilla/utils/    → @einfach/utils         # 工具函数
react/react/      → @einfach/react         # React hooks 绑定
react/utils/      → @einfach/react-utils   # React 工具 hooks
react/form/       → @einfach/react-form    # React 表单处理
solid/solid/      → @einfach/solid         # Solid.js 绑定
solid/form/       → @einfach/solid-form    # Solid.js 表单处理
```

## 代码风格

- 无分号，单引号，100 字符行宽（Prettier）
- 严格 TypeScript（`strict: true`）
- 禁止 `console` 语句（ESLint）
- 类型导入使用 `type` 关键字

```bash
# 格式化检查与修复
npm run eslint
```

## 版本管理

使用 [Changesets](https://github.com/changesets/changesets) 管理版本：

```bash
# 创建变更集（描述你的改动）
npx changeset

# 更新版本号
npx changeset version

# 发布到 npm
npx changeset publish
```

## 测试

```bash
# 运行全部测试（含覆盖率）
npm test

# 运行单个测试文件
npx jest path/to/test.test.ts
```

## 许可证

MIT
