`npm i @einfach/state`

### 第一步 创建一个 atom实例

```jsx
import { atom } from '@einfach/state'

const helloWorldAtom = atom('Hello World')
const objAtom = atom({})
```

### 第二步 在组件中调用

```jsx
import { useAtom, atom } from '@einfach/state'

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
import { atom } from '@einfach/state'

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
import { atom } from '@einfach/state'

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
import { atom } from '@einfach/state'
```

### 创建多个store数据仓

```jsx
import { createStore } from '@einfach/state'

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

```tsx
const countIncrementAtom = incrementAtom<{
  count: number
}>
{
  count: 1
}

const aCountAtom = atom(0)
function A() {
  const { setter } = useStore()
  const setACount = useSetAtom(aCountAtom)

  const [cancel] = useState(() => {
    return setter(countIncrementAtom, (_getter, prevReturn) => {
      const aCount = _getter(aCountAtom)
      return {
        ...prevReturn,
        count: prevReturn.count + aCount,
      }
    })
  })

  return (
    <div>
      <button
        data-testid="btn-a-add"
        onClick={() => {
          setACount((prevACount) => {
            return prevACount + 1
          })
        }}
      >
        + 1
      </button>
      <button data-testid="btn-a-cancel" onClick={cancel}>
        cancel A count
      </button>
    </div>
  )
}

function B() {
  const { setter } = useStore()

  useLayoutEffect(() => {
    return setter(countIncrementAtom, (_getter, prevReturn) => {
      return {
        count: prevReturn.count + 99,
      }
    })
  }, [])

  const { count } = useAtomValue(countIncrementAtom)

  return <div data-testid="result">{count}</div>
}

function App() {
  return (
    <div data-testid="app">
      <A />
      <B />
    </div>
  )
}

const { baseElement } = render(<App />)
await screen.findByTestId('app')
expect(queryByTestId(baseElement, 'result')).toBeInTheDocument()
expect(queryByTestId(baseElement, 'result')?.textContent).toBe('100')

await userEvent.click(screen.getByTestId('btn-a-add'))
expect(queryByTestId(baseElement, 'result')?.textContent).toBe('101')
await userEvent.click(screen.getByTestId('btn-a-add'))
expect(queryByTestId(baseElement, 'result')?.textContent).toBe('102')
await userEvent.click(screen.getByTestId('btn-a-cancel'))
expect(queryByTestId(baseElement, 'result')?.textContent).toBe('100')
```

### async

```jsx
 const serverInfoAtom = atom(function () {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve([{ id: 1 }, { id: 2 }])
        }, 1000)
      }) as Promise<{ id: number }[]>
    })

    const firstItemAtom = atom(async (getter) => {
      const serverInfo = await getter(serverInfoAtom)
      return serverInfo[0]
    })

    function FirstItem() {
      const firstItemInfo = useAtomValue(firstItemAtom)

      return <div data-testid="firstItem">{firstItemInfo.id}</div>
    }
    function App() {
      return (
        <div data-testid="app">
          <Suspense fallback={<div data-testid="loading">loading</div>}>
            <FirstItem />
          </Suspense>

          <div data-testid="otherComponents">other components</div>
        </div>
      )
    }

    const { baseElement } = render(<App />)
    await screen.findByTestId('app')
    expect(queryByTestId(baseElement, 'firstItem')).not.toBeInTheDocument()
    expect(queryByTestId(baseElement, 'loading')).toBeInTheDocument()
    await screen.findByTestId('firstItem')
    expect(queryByTestId(baseElement, 'firstItem')).toBeInTheDocument()


```

### loadable

```jsx
 const serverInfoAtom = atom((getter)=>{
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
    const {data,state} = useAtomValue(loadable(serverInfoAtom))
    if(state==='loading'){
      return <Loading/>
    }
    return <div></div>
  }


```

### createFamilyEasy 多个相同类型的atom

```tsx
const { createAtomFamily, clear } = createAtomFamilyEntity()

/**
 * 子节点详情
 */
const getNodeInfoAtomById = createAtomFamily<NodeInfo | null>({
  debuggerKey: 'getNodeInfoAtomById',
  defaultValue: null,
})

/**
 * 界面树形关系 父-子
 */
const getChildrenIdsAtomById = createAtomFamily<string[] | undefined>({
  defaultValue: [] as string[],
  debuggerKey: 'getChildrenIdsAtomById',
})
```
