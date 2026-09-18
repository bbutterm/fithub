import { api } from "./api";

/**
 * Данные вкладок подгружаются заранее, а не при первом открытии.
 *
 * Без этого каждая вкладка встречала человека спиннером: запрос уходил только
 * после тапа, а между Vercel и базой — сотня миллисекунд на каждый запрос.
 * Теперь сразу после входа все три запроса уходят параллельно, и вкладка
 * открывается мгновенно. Мутации сбрасывают кэш, следующий load идёт в сеть.
 */
type Key = "recipes" | "challenges";
type Loader = () => Promise<unknown>;

const LOADERS: Record<Key, Loader> = {
  recipes: () => api.recipes(),
  challenges: () => api.challenges()
};

const store = new Map<Key, unknown>();
const inflight = new Map<Key, Promise<unknown>>();

export function load<T>(key: Key, fresh = false): Promise<T> {
  if (fresh) store.delete(key);
  if (store.has(key)) return Promise.resolve(store.get(key) as T);
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = LOADERS[key]()
    .then((v) => {
      store.set(key, v);
      inflight.delete(key);
      return v as T;
    })
    .catch((e: unknown) => {
      inflight.delete(key);
      throw e;
    });
  inflight.set(key, p);
  return p as Promise<T>;
}

export function peek<T>(key: Key): T | undefined {
  return store.get(key) as T | undefined;
}

export function invalidate(key: Key): void {
  store.delete(key);
}

/** Запускается один раз после входа. Ошибки глотаем: это ускорение, не функция. */
export function warm(): void {
  for (const key of Object.keys(LOADERS) as Key[]) void load(key).catch(() => undefined);
}
