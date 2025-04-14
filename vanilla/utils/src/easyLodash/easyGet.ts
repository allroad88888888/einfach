import type { NamePath } from './type'
import { getObjProp } from './util'

type GetIndexedField<T, K> = K extends keyof T
  ? T[K]
  : K extends `${number}`
    ? '0' extends keyof T
      ? undefined
      : number extends keyof T
        ? T[number]
        : undefined
    : undefined

type FieldWithPossiblyUndefined<T, Key> =
  | GetFieldType<Exclude<T, undefined>, Key>
  | Extract<T, undefined>

type IndexedFieldWithPossiblyUndefined<T, Key> =
  | GetIndexedField<Exclude<T, undefined>, Key>
  | Extract<T, undefined>

export type GetFieldType<T, P> = P extends `${infer Left}.${infer Right}`
  ? Left extends keyof T
    ? FieldWithPossiblyUndefined<T[Left], Right>
    : Left extends `${infer FieldKey}[${infer IndexKey}]`
      ? FieldKey extends keyof T
        ? FieldWithPossiblyUndefined<
            IndexedFieldWithPossiblyUndefined<T[FieldKey], IndexKey>,
            Right
          >
        : undefined
      : undefined
  : P extends keyof T
    ? T[P]
    : P extends `${infer FieldKey}[${infer IndexKey}]`
      ? FieldKey extends keyof T
        ? IndexedFieldWithPossiblyUndefined<T[FieldKey], IndexKey>
        : undefined
      : undefined

export function easyGet<TData, TPath extends NamePath, TDefault = GetFieldType<TData, TPath>>(
  data: TData,
  path: TPath,
  defaultValue?: TDefault,
): GetFieldType<TData, TPath> | TDefault {
  let pathList: string[] = path as string[]
  if (!Array.isArray(path)) {
    pathList = path.toString().split(/[.[\]]/)
  }
  const val = pathList
    .filter((temp) => {
      return Boolean(temp.toString())
    })
    .reduce<GetFieldType<TData, TPath>>((value, key) => getObjProp(value, key), data as any)
  // .reduce<GetFieldType<TData, TPath>>((value, key) => (value as any)?.[key], data as any)

  return val !== undefined ? val : (defaultValue as TDefault)
}
