import { atom } from 'einfach-state';
import type { Obj } from 'einfach-utils';
import type { FieldInfo } from './type';

// 所有值
export const valuesAtom = atom<Obj>({});

export type Message = {
  warn?: string[] | undefined
  error?: string[] | undefined
};

// 校验结果
export const messageMappingAtom = atom(new Map<string | number, Message>());

// 校验规则
// export const rulesMappingAtom = atom(new Map<string | number, Set<Rule>>())

export const fieldOptionMappingAtom = atom(new Map<string | number, FieldInfo>());
