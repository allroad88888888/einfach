import { describe, test, expect, beforeEach } from '@jest/globals'
import { createStore } from '../../src'
import { createAsyncParamsAtom } from '../../src/utils/createAsyncParamsAtom'

describe('createAsyncParamsAtom', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  test('初始状态应该是undefined', () => {
    // 需要显式声明接收任意参数的异步函数类型
    const asyncFn = async (..._args: any[]) => 'result'
    const atom = createAsyncParamsAtom(asyncFn)
    expect(store.getter(atom)).toBe(undefined)
  })

  test('无参数调用', async () => {
    const asyncFn = async () => 'success'
    const atom = createAsyncParamsAtom(asyncFn)

    // 调用不传参数
    store.setter(atom)

    const result = await store.getter(atom)
    expect(result).toBe('success')
  })

  test('单参数调用', async () => {
    const asyncFn = async (id: number) => `User ${id}`
    const atom = createAsyncParamsAtom(asyncFn)

    // 传递单个参数
    store.setter(atom, 123)

    const result = await store.getter(atom)
    expect(result).toBe('User 123')
  })

  test('多参数调用', async () => {
    const asyncFn = async (name: string, age: number) => ({
      name,
      age,
    })

    const atom = createAsyncParamsAtom(asyncFn)

    // 传递多个参数
    store.setter(atom, 'Alice', 30)

    const result = await store.getter(atom)
    expect(result).toEqual({
      name: 'Alice',
      age: 30,
    })
  })

  test('多次调用更新', async () => {
    let counter = 0
    const asyncFn = async () => ++counter

    const atom = createAsyncParamsAtom(asyncFn)

    // 第一次调用
    store.setter(atom)
    expect(await store.getter(atom)).toBe(1)

    // 第二次调用
    store.setter(atom)
    expect(await store.getter(atom)).toBe(2)
  })

  test('错误处理', async () => {
    const errorFn = async () => {
      throw new Error('测试错误')
    }

    const atom = createAsyncParamsAtom(errorFn)

    // 调用函数
    store.setter(atom)

    // 验证错误
    try {
      await store.getter(atom)
      // 如果没有抛出错误，测试应该失败
      expect(false).toBe(true) // 使用expect替代fail
    } catch (e) {
      if (e instanceof Error) {
        expect(e.message).toBe('测试错误')
      }
    }
  })

  test('订阅者通知', () => {
    const asyncFn = async (msg: string) => `Echo: ${msg}`
    const atom = createAsyncParamsAtom(asyncFn)

    // 监听更新
    let updateCount = 0
    store.sub(atom, () => {
      updateCount++
    })

    // 更新参数
    store.setter(atom, 'hello')
    expect(updateCount).toBe(1)

    store.setter(atom, 'world')
    expect(updateCount).toBe(2)
  })

  test('多参数多次调用', async () => {
    // 创建一个记录历史调用的辅助数组
    const callHistory: { name: string; age: number; city: string }[] = []

    // 创建一个接收多个参数的异步函数
    const userInfoFn = async (name: string, age: number, city: string) => {
      const userInfo = { name, age, city }
      callHistory.push(userInfo)
      return userInfo
    }

    const userAtom = createAsyncParamsAtom(userInfoFn)

    // 第一次调用，传递三个参数
    store.setter(userAtom, '张三', 25, '北京')
    const result1 = await store.getter(userAtom)
    expect(result1).toEqual({ name: '张三', age: 25, city: '北京' })

    // 第二次调用，传递不同的参数
    store.setter(userAtom, '李四', 30, '上海')
    const result2 = await store.getter(userAtom)
    expect(result2).toEqual({ name: '李四', age: 30, city: '上海' })

    // 第三次调用，再次更换参数
    store.setter(userAtom, '王五', 35, '广州')
    const result3 = await store.getter(userAtom)
    expect(result3).toEqual({ name: '王五', age: 35, city: '广州' })

    // 验证所有调用历史
    expect(callHistory).toEqual([
      { name: '张三', age: 25, city: '北京' },
      { name: '李四', age: 30, city: '上海' },
      { name: '王五', age: 35, city: '广州' },
    ])

    // 再次获取结果应该不会触发新的函数调用
    await store.getter(userAtom)
    expect(callHistory.length).toBe(3)
  })
})
