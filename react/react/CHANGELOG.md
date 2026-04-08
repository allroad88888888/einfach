# @einfach/react

## 0.3.25

### Patch Changes

- 341f8a7: Improve npm search discoverability: English descriptions and add einfach keyword
- Updated dependencies [341f8a7]
  - @einfach/core@0.2.18

## 0.3.24

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.17

## 0.3.23

### Patch Changes

- 修复已发布包中的依赖声明：npm 上的版本曾错误地包含 `workspace:*`，导致使用 pnpm 安装 `@einfach/react` 的消费者（例如依赖它的 `@deepfos/tree-help`）报错 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`。请始终使用 `pnpm publish` 或 `changeset publish`（在 monorepo 根目录）发布，以便将 workspace 依赖解析为 `@einfach/core` 的实际 semver。

## 0.3.22

### Patch Changes

- 添加Provider缓存

## 0.3.21

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.16

## 0.3.20

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.15

## 0.3.19

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.15

## 0.3.18

## 0.3.17

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.14

## 0.3.16

## 0.3.15

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.13

## 0.3.14

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.12

## 0.3.13

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.11

## 0.3.12

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.10

## 0.3.11

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.9

## 0.3.10

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.8

## 0.3.9

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.7

## 0.3.8

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.6

## 0.3.7

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.5

## 0.3.4

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.4

## 0.3.3

### Patch Changes

- Updated dependencies
  - @einfach/core@0.2.3

## 0.3.2

### Patch Changes

- 重新实现useAtomCallback支持watchParams 而不是watch方法本身

## 0.3.1

### Patch Changes

- 导出useAtomCallback
