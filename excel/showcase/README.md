# Einfach Excel Showcase

独立的在线 Excel 产品展示包。它直接复用项目中的真实表格组件与计算后端，不依赖或改造任何已有 demo。

## 本地运行

```bash
corepack pnpm@10.15.1 --filter @einfach/excel-showcase dev
```

默认地址：<http://127.0.0.1:4173>

## 构建

```bash
CI=true corepack pnpm@10.15.1 --filter @einfach/excel-showcase build
```

## 展示内容

- 单元格公式与依赖联动
- 多工作表切换
- 单元格格式、条件样式与公式栏
- 选区聚合状态
- 虚拟化表格浏览
- 编辑、复制、撤销及常用表格工具
