


`npm i einfach-state`


### 第一步 创建一个 atom实例
```jsx
import { atom } from 'einfach-state'

const helloWorldAtom = atom('Hello World')
const objAtom = atom({})
```

### 第二步 在组件中调用
```jsx
import { useAtom, atom } from 'einfach-state';

const countAtom = atom(0)

function Counter() {
  const [count, setCount] = useAtom(countAtom);
  return (
    <h1>
      {count}
      <button onClick={() => setCount((c) => c + 1)}>one up</button>
    </h1>
  );
}

```

### 从状态A衍生状态B
```jsx
import { atom } from 'einfach-state';

const countAtom = atom(0)
const doubleCountAtom = atom((get)=>{
    return get(countAtom) * 2
})

```
### 创建多个store数据仓 

```jsx
import { createStore } from 'einfach-state'

const store = createStore()
const countAtom = atom(0)

function Counter() {
  const [count, setCount] = useAtom(countAtom , { store });
  return (
    <h1>
      {count}
      <button onClick={() => setCount((c) => c + 1)}>one up</button>
    </h1>
  );
}

```




### 工具类

#### 撤销 

```jsx
    const numberAtom = atom(0);
    const stringAtom = atom('');
    const store = createStore();
    const { undoAtom, redoAtom, watchAtom, undo, redo } = createUndoRedo(store);
    watchAtom(numberAtom);
    watchAtom(stringAtom);

    store.setter(numberAtom, 1);
    store.setter(stringAtom, 'init');
    store.setter(numberAtom, 2);
    undo();
    redo();
   
```

### 一个状态，受多个事件影响

比如： 按钮触发了一个操作，更改某个样式， 然后需要撤销这个动作。然后有多个事件修改这个值，每个事件有取消修改这个值

```jsx
  const styleAtom = incrementAtom({})

  function useEventA(){
    const store = useStore()

    const clearRef = useRef()    
    
    const onOk = useCallback(()=>{
        /**
         * 给styleAtom 添加一个新值
         * prev styleAtom最新值
         * @ return 清除这个值
         * */
        clearRef.current = store.setter(styleAtom,(_getter,prev)=>{
          return {
            ...prev,
            color:"red"
          }
       })
    },[])

    const onCancel = useCallback(()=>{
        clearRef.current?.()
    },[])
  }

  function useEventB(){
    const store = useStore()
    useEffect(()=>{
       return store.setter(styleAtom,(_getter,prev)=>{
          return {
            ...prev,
            color:"blue",
            border:"1px solid red"
          }
       })
    },[])
  }
 
  const style = useAtomValue(styleAtom)
  style = {
     color:"blue",
     border:"1px solid red"
  }

```