# @einfach/core

## 0.2.17

### Patch Changes

- fix: dependenciesChange 对 async atom 跳过递归，避免 O(N²) 无效遍历

  async atom 的 readAtom 每次返回新 Promise 引用，导致 Object.is 永远返回 false，
  dependenciesChange 递归遍历整个反向依赖图。改为由 flushPending while 循环 +
  Promise 链自然传播，getter 调用从 O(N²) 降到 O(N)。

## 0.2.16

### Patch Changes

- 修复版本

## 0.2.15

### Patch Changes

- 降级

## 0.2.15

### Patch Changes

- 暴露storeAtom

## 0.2.14

### Patch Changes

- easyset 如果prop为空 则直接返回value

## 0.2.13

### Patch Changes

- fixed:有些场景listenersMap.get(atomEntity) 为undeinfed

## 0.2.12

### Patch Changes

- 如果atom的setter方法是异步的，没有等待所有更新，再去更新flushPending

## 0.2.11

### Patch Changes

- 修复发版本 没有编译

## 0.2.10

### Patch Changes

- setter 自己设置自身时不应触发 getter 重算

## 0.2.9

### Patch Changes

- 对外暴露getGlobalSymbolForId

## 0.2.8

### Patch Changes

- 移除getFamilyAtomById的params缓存，创建对象修改为sysmbol 减少部分内存

## 0.2.7

### Patch Changes

- 类型更换

## 0.2.6

### Patch Changes

- createFamilyAtomById 添加Weakkey

## 0.2.5

### Patch Changes

- 移除开发模式下promise Object.frezz

## 0.2.4

### Patch Changes

- createGetFamilyAtomById的类型调整

## 0.2.3

### Patch Changes

- createGetFamilyAtomById 新增set方法
