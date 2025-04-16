import { atom } from "../atom"


/**
 * 创建一个可接收参数的异步atom
 * 
 * 这个函数接收一个异步函数，并返回一个可写的atom。
 * 当向返回的atom写入参数时，会调用原始的异步函数并传入这些参数，
 * 然后atom的值会更新为异步函数的执行结果（Promise）。
 * 
 * @template T 异步函数类型
 * @param fn 需要包装的异步函数
 * @returns 一个可写的atom，可以接收参数并执行原始的异步函数
 * 
 * @example
 * const fetchUserAtom = createAsyncParamAtom(async (userId) => {
 *   const response = await fetch(`/api/users/${userId}`);
 *   return response.json();
 * });
 * 
 * // 触发异步函数执行，传入参数123
 * store.setter(fetchUserAtom, 123);
 * 
 * // 读取异步操作的结果（Promise）
 * const userPromise = store.getter(fetchUserAtom);
 */
export function createAsyncParamsAtom<T extends (...args: any[]) => Promise<unknown>>(fn: T) {

    // 获取原始函数的参数类型
    type Params = Parameters<T>

    // 创建一个唯一的标识符，用于表示初始状态
    const initparams = Symbol('initparams')

    // 创建一个atom存储函数参数，初始为未设置状态
    const paramsAtom = atom<typeof initparams | Params>(initparams)

    // 创建结果atom，其值取决于参数atom的值
    const resultAtom = atom((getter) => {
        // 获取当前参数
        const params = getter(paramsAtom)
        // 如果是初始状态，返回undefined
        if (params === initparams) {
            return undefined
        }
        // 否则，调用原始函数并传入参数，返回Promise
        return fn.call(null, ...params)
    }, (getter, setter, ...args: Params) => {
        // 当设置resultAtom时，实际上是更新paramsAtom的值
        setter(paramsAtom, args)
    })

    return resultAtom
}