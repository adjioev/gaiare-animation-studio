# 003 — Re-adopt race: in-flight flag for lock acquisition

**Status:** Open
**Effort:** ~15min
**Priority:** Low (low-likelihood)
**Trigger:** Если в логах увидим double-acquired lock symptoms

## Контекст

Wave 4 fixed lock cleanup через `lockRef` (ref tracking current `{folderName, externalRef, contractorId}` identity). Wave 5+ ввёл re-adopt effect: когда `contractorId` перепрыгивает `null → "anna"` (settings modal save), мы заново adopt'им lock для workspace, который уже открыт.

**Edge case**: пользователь быстро жмёт Save в Settings modal два раза подряд (или открывает workspace + меняет contractor одновременно). React batched re-renders могут запустить две `adoptLock(...)` concurrently. Первый ещё не записал `workspace.lock.anna`, второй уже стартанул — оба создадут файл, оба запустят heartbeat. Дальше cleanup сбросит один lockRef, но heartbeat от второго пройдёт мимо.

## Симптомы (если случится)

- Два timer'а `setInterval` параллельно пишут в `workspace.lock.anna`
- Foreign lock detection может ложно сработать в течение race window
- В worst case: workspace.lock.anna каждые ~10ms обновляется вместо 5min (вряд ли заметят, но шум в логах)

## Решение

Простой in-flight bool ref:

```ts
const adoptingRef = useRef(false);

async function adoptLock(folder: string, ref: string, contractor: string) {
  if (adoptingRef.current) {
    console.warn("[lock] adoptLock already in flight, skipping");
    return;
  }
  adoptingRef.current = true;
  try {
    // existing logic — acquireLock, listForeignFreshLocks, start heartbeat
  } finally {
    adoptingRef.current = false;
  }
}
```

## Acceptance criteria

- [ ] `adoptingRef` добавлен в `src/App.tsx`
- [ ] `adoptLock` early-return если flag уже true
- [ ] Manual stress test: открыть workspace → 5× быстро Save в Settings → один `workspace.lock.*` файл, один heartbeat interval (проверка через `ls -la <Documents>/gaiare-animation-studio/<workspace>/ | grep lock`)

## Связанные файлы

- `src/App.tsx` — `adoptLock` function, `lockRef` declarations
- `src/lib/lock.ts` — `acquireLock`, `listForeignFreshLocks`

## Почему откладываем

- Race требует точного timing — модель user behavior (жена, брат) предполагает один-два клика, не stress test
- Worst case урон — лишний disk I/O, не data corruption (heartbeat overwrite один и тот же файл)
- 15-минутный fix можно сделать в любой момент, когда дойдут руки

## Tests (если решим закрывать)

- [ ] React Testing Library: render App → simulate two parallel `setContractorId` → assert один `acquireLock` call (mock'нуть)
- [ ] Integration: запустить две копии Studio с одним contractorId на одном workspace → assert foreign lock detected правильно
