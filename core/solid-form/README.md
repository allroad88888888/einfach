# @einfach/solid-form

Einfach 表单处理库的 Solid.js 绑定。

## 项目说明

本项目不提供任何UI，旨在提供form的核心逻辑，然后根据公司的需求开发。

### 为什么有这个项目

有大量项目采用antd的form，antd form性能太差，急需替换。这个库提供了Solid.js版本的高性能表单解决方案。

## 优点

no css!!! no css!!! no css!!! 
no html!!! no html!!! no html!!! 
only hooks

## API

### useForm 创建一个表单实例

```jsx
const form = useForm({
  initialValues: {
    name: 'John',
    age: 30
  }
});
```

### useField 获取表单字段的值+设置方法

```jsx
const { value, onChange } = useField('name');
```

### useFieldValue 获取表单字段的值

```jsx
const name = useFieldValue('name');
```

### useSetField 获取设置字段的值函数

```jsx
const setName = useSetField('name');
setName('New Name');
```

### useGetFormInstance 获取表单实例

```jsx
const form = useGetFormInstance();
```

## 备注

FormItem 这些需要自行开发，仅作为样板。
