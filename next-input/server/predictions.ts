// 每个会话只缓存当前 token 的 Promise，进行中、成功和失败都不重复调用。
export class Predictions<T> {
  private entries = new Map<string, { token: string; promise: Promise<T> }>();
  get(agentId: string, token: string, current: () => boolean, work: () => Promise<T>, expired: T): Promise<T> {
    if (!current()) return Promise.resolve(expired);
    const cached = this.entries.get(agentId);
    if (cached?.token === token) return cached.promise;
    const promise = Promise.resolve().then(() => current() ? work() : expired)
      .then(result => current() ? result : expired);
    this.entries.set(agentId, { token, promise });
    return promise;
  }
  remove(agentId: string): void { this.entries.delete(agentId); }
  clear(): void { this.entries.clear(); }
}
