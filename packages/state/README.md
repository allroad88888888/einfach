`npm i einfach-state`

### 第一步 创建一个 atom实例

```jsx
import { atom } from 'einfach-state'

const helloWorldAtom = atom('Hello World')
const objAtom = atom({})
```

### 第二步 在组件中调用

```jsx
import { useAtom, atom } from 'einfach-state'

const countAtom = atom(0)

function Counter() {
  const [count, setCount] = useAtom(countAtom)
  return (
    <h1>
      {count}
      <button onClick={() => setCount((c) => c + 1)}>one up</button>
    </h1>
  )
}
```

### 从状态A衍生状态B

```jsx
import { atom } from 'einfach-state'

const countAtom = atom(0)
const doubleCountAtom = atom((get) => {
  return get(countAtom) * 2
})

function A() {
  const setCount = useSetAtom(countAtom)
  return (
    <div
      onClick={() => {
        setCount(3)
      }}
    ></div>
  )
}

function B() {
  const double = useAtomValue(doubleCountAtom)
  return <div>{double}</div>
}
```

### BigObj

```jsx
import { atom } from 'einfach-state'

const bigObjAtom = atom({
  a: { b: 'c' },
  b: 'b',
  cc: 'c',
})
const aAtom = selectAtom(bigObjAtom, (prev) => {
  return prev.a
})
const a1Atom = atom((getter) => {
  return getter(bigObjAtom).a
})

function A() {
  const setCount = useSetAtom(bigObjAtom)
  return (
    <div
      onClick={() => {
        setCount((prev) => {
          return {
            ...prev,
            cc: 'f',
          }
        })
      }}
    ></div>
  )
}

function B() {
  const double = useAtomValue(aAtom)
  return <div>{double}</div>
}
import { atom } from 'einfach-state'
```

### 创建多个store数据仓

```jsx
import { createStore } from 'einfach-state'

const store = createStore()
const countAtom = atom(0)

function Counter() {
  const [count, setCount] = useAtom(countAtom, { store })
  return (
    <h1>
      {count}
      <button onClick={() => setCount((c) => c + 1)}>one up</button>
    </h1>
  )
}
```

### 工具类

#### 撤销

```jsx
const numberAtom = atom(0)
const stringAtom = atom('')
const store = createStore()
const { undoAtom, redoAtom, watchAtom, undo, redo } = createUndoRedo(store)
watchAtom(numberAtom)
watchAtom(stringAtom)

store.setter(numberAtom, 1)
store.setter(stringAtom, 'init')
store.setter(numberAtom, 2)
undo()
redo()
```

### 一个状态，受多个事件影响

比如： 按钮触发了一个操作，更改某个样式， 然后需要撤销这个动作。然后有多个事件修改这个值，每个事件有取消修改这个值

```jsx
  const styleAtom = incrementAtom({})  atom({}defalutValue ) Set<ReadFunction>()

  function useEventA(){
    const store = useStore()

    const clearRef = useRef()

   useInit(()=>{
        /**
         * 给styleAtom 添加一个新值
         * prev styleAtom最新值
         * @ return 清除这个值
         * */
        clearRef.current = store.setter(styleAtom,(_getter,prev)=>{
          return {
            ...prev,
            color:"red",
            border:"1px solid red"
            number:9
          }
       })
    },[])

    const onCancelA = useCallback(()=>{
        clearRef.current?.()
    },[])
  }

  function useEventB(){
    const atomEntity = atom(0)
    const store = useStore()
    const ref = useRef()


    useInit(()=>{
       ref.current =  store.setter(styleAtom,(_getter,prevReturn)=>{
        // 4
        const a = _getter(atomEntity)
          return {
            ...prev,
            color:"blue",
            number:prev+a

          }
       })
    },[])

    const onClickA =()=>{
      store.setter(atomEntity,(i)=>{
        return i+1
      })
    }
    const cancelB=()=>{
      ref.current?.()
    }



  }

  const style = useAtomValue(styleAtom)
  style = {
     color:"blue",
     border:"1px solid red"
  }

```

### async

```jsx
  const serverInfoAtom = atom(()=>{
    return new Promise((rev,rej)=>{
        setTimeout(()=>{
          rev([{
            id:1,name:"1"
          },{
            id:2,name:"2"
          }])
        },,3000)
    })
  })

  const cAtom = atom((getter)=>{
    const xx = getter(serverInfoAtom)
    return xx[1]
  })

  function C(){
    const c = useAtomValue(cAtom)
  }

  function A(){
    const serverInfo = useAtom(serverInfoAtom)
    return <C />
  }

  function App(){
    return <>
      <React.Supen fallback={<div>loadingg</div>}>
      <A >
        <B/>
      </A>
      </React.Supen>
      <D/>
      <F/>
    </>
  }

function App2(){
    return <>
      <React.Supen>
      <C/>
      </React.Supen>
      <D/>
      <F/>
    </>
  }


```

### loadable

```jsx
 const serverInfoAtom = atom((getter)=>{
  const a = getter(xxAtom)
    return new Promise((rev,rej)=>{
        setTimeout(()=>{
          rev([{
            id:1,name:"1"
          },{
            id:2,name:"2"
          }])
        },,3000)
    })
  })

  function A(){
    const {data,loading} = useAtomValue(loadable(serverInfoAtom))
    if(loading){
      return <Loading/>
    }
    return
  }


```
