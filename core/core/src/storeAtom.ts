import { atom } from './atom';
import type { Store } from './type';

export const storeAtom = atom<Store>(null as unknown as Store)
