


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


