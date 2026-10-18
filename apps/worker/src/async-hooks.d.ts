// Cloudflare Workers 在 nodejs_compat 下提供 node:async_hooks，
// 但 worker 包只装了 @cloudflare/workers-types，这里补最小声明。
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
    exit<R>(callback: () => R): R;
    enterWith(store: T): void;
    disable(): void;
  }
}
