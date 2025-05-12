import { atom } from "../atom"
import type { AtomEntity, AtomSetParameters, AtomState, Getter } from "./../type"


type IdObj = {
    id: string;
};

function createIdObj(id: string): IdObj {
    const idObj = Object.create(null);
    idObj.id = id;
    return idObj;
}

const cacheBaseIdsAtom = atom(() => {
    return new Map<string, IdObj>();
});

/**
 * 终于解决了一个问题，就是家族式组件的缓存问题
 * @param id
 * @param options
 * @returns
 */
export function createGetFamilyAtomById<T extends AtomEntity<unknown>>() {


    const cacheAtomWeakMap = new WeakMap<WeakKey, T>();

    function getFamilyAtomById(id: string, options: {
        createAtom: (id: string) => T
    }): T
    function getFamilyAtomById(
        id: string,
        options: {
            defaultState: AtomState<T>;
        }
    ): T

    function getFamilyAtomById(
        id: string,
        options: {
            defaultState?: AtomState<T>;
            createAtom?: (id: string) => T;
        }
    ) {
        function getCacheAtom(getter: Getter, id: string) {
            const map = getter(cacheBaseIdsAtom);
            if (!map.has(id)) {
                const newIdObj = createIdObj(id);
                map.set(id, newIdObj);
            }
            const cacheKey = map.get(id)!;
            if (!cacheAtomWeakMap.has(cacheKey)) {
                let newAtom = options.createAtom ? options.createAtom(id) : atom(options.defaultState) as T;
                cacheAtomWeakMap.set(cacheKey, newAtom);
            }
            return cacheAtomWeakMap.get(cacheKey)!;
        }

        const realAtom = atom(
            (getter) => {
                const tempAtom = getCacheAtom(getter, id);
                return getter(tempAtom);
            },
            (getter, setter, ...args: AtomSetParameters<T>) => {
                const tempAtom = getCacheAtom(getter, id);
                setter.call(realAtom, tempAtom, ...args);
            }
        );

        return realAtom as T;
    };


    return getFamilyAtomById
}


