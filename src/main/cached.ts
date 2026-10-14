/**
 * 「TTL 缓存 + 并发合流」采集器工厂。
 *
 * 这个应用有四处采集要起 PowerShell 或 COM 枚举（启动项、计划任务、系统体检、
 * 关注服务），每处都要处理同样的几件事：
 *
 *   1. 缓存命中就直接返回，别为了切一次页面重起一次进程；
 *   2. 同一时刻的第二个请求要**合流**到正在进行的那一次 —— 侧栏与页面几乎
 *      同时挂载，没有合流就会并发起两次，而这正是缓存想避免的事；
 *   3. 采集失败时给出一个「读不到」的降级结果，而不是把异常抛给渲染层；
 *   4. 结束后清掉 in-flight 标记。
 *
 * 这四份原来是各自手写的复制粘贴，已经分叉出一处真实缺陷：关注服务那条把
 * `collectServices` 的 `degraded` 丢掉了（只解构 `items`）。后果不是「少个字段」——
 * 采集失败与「没有关注项」在界面上下不去分，服务面板会对着空列表印出
 * 「N 个关注 · 全部在跑」，侧栏也把「读不到」显示成一切正常。
 * 抽成工厂后这类分叉不再可能：降级语义只有一套。
 */

export interface CachedCollectorOptions<T> {
  /** 缓存有效期（毫秒） */
  ttl: number
  /** 真正去采集。抛错即视为失败，交给 fallback */
  collect: () => Promise<T>
  /** 采集失败时的降级结果（应带 `degraded: true` 与原因） */
  fallback: (error: string) => T
  /**
   * 缓存的身份：结果依赖外部输入时给出它的指纹（如关注清单）。
   *
   * 指纹变了即视为缓存失效 —— 这比在每处改动输入的代码里手写一行
   * 「把缓存置空」可靠得多：漏一处就会出现「刚加的关注项迟迟不显示」，
   * 而那种缺陷只在特定操作顺序下复现。不依赖外部输入的采集可以不传。
   */
  key?: () => string
}

export interface CachedCollector<T> {
  /** 取一份数据；`force` 为真时绕开缓存（用户点「重新读取」走这条） */
  (force?: boolean): Promise<T>
}

export function createCachedCollector<T>(options: CachedCollectorOptions<T>): CachedCollector<T> {
  let cache: { at: number; key: string; value: T } | null = null
  let inflight: Promise<T> | null = null

  const start = (key: string): Promise<T> => {
    if (inflight) return inflight
    inflight = options
      .collect()
      .then((value) => {
        // 只在成功时写缓存：失败不缓存，下一次请求立刻重试（不把「读不到」留满 TTL）
        cache = { at: Date.now(), key, value }
        return value
      })
      .catch((error: unknown) =>
        options.fallback(error instanceof Error ? error.message : String(error))
      )
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return (force = false): Promise<T> => {
    const key = options.key?.() ?? ''
    if (
      !force &&
      cache !== null &&
      cache.key === key &&
      Date.now() - cache.at < options.ttl
    ) {
      return Promise.resolve(cache.value)
    }
    return start(key)
  }
}
