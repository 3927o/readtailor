**BottomNav** — the app's frosted bottom bar. Serif **word labels**, never icons; the active tab gets ink text + a 4px green dot above. Defaults to 书架 / 发现 / 我的.

```jsx
<BottomNav value={tab} onChange={setTab} />
<BottomNav fixed={false} items={[{value:'shelf',label:'书架'},{value:'notes',label:'批注'}]} />
```

Fixed by default with safe-area padding; give the page ~72px bottom padding so content clears it. Hide it inside the reader view — reading is chrome-free.
