# 多实例分布式编排：结论、架构、边界与验证

> 本文只描述**已经实现并真实跑通**的部分，以及**明确没有实现、不宣称**的部分。
>  verdict 口径不变：`not-proven` / `L4 = not-achieved` 不因本次编排改造而变化。

## 一、结论：靠不靠谱要分层回答

**问：在 bro2 上实现多实例分布式编排靠谱吗？**

| 范围 | 判断 | 依据 |
| --- | --- | --- |
| 同主机多进程 worker 池，共享同一文件系统（本地磁盘） | **靠谱，已实现并真实验证** | 一致性锚定到单一可串行化提交点：`mkdir` 原子锁 + 只增账本 + 状态机投影。两个独立 Node 进程竞争同一 DAG，节点恰好执行一次 |
| 跨主机多实例、共识、网络分区容错、分布式时钟 | **不靠谱，未实现，不宣称** | 需要外部强一致存储（etcd/Postgres/SQLite WAL + 租约服务）或共识协议；本项目运行时依赖恒为 0、冻结预算 16500 行，硬做只会得到"多个进程各写各的文件"的假分布式 |
| 多实例下的全局白盒 trace | **靠谱，已实现** | 事件写入同一共享账本，`/api/events/stream` 对账本做增量 tail；浏览器连任一实例都能看到其他实例的事件，并标注来源实例 |

### 为什么改造前不能直接叫"分布式"

原 `src/maf/orchestrator.ts` 是单进程内存态实现，有四个硬伤（均可从代码复核）：

1. `private state: State` 在构造时 `load()` 一次进内存，`save()` 用 `rename` **整文件覆盖**。两个进程各自持有陈旧内存副本，后写者抹掉先写者的提交与状态。
2. `execute()` 直接 `n.status = "running"` 再保存，**没有原子的「读-检查-占」**。两个 worker 同时看到 `pending` 会重复执行同一节点。
3. **没有 fencing token**：租约过期后被接管的旧 worker 回来提交，会覆写新 owner 的结果。
4. `EventBus` 是进程内内存对象，`newId()` 是进程内计数器：SSE 全局流只含本进程事件，跨进程 ID 还可能碰撞。

所以"给原实现加个多进程启动脚本"必然是粉饰。本次是**替换状态模型**，不是包一层。

## 二、架构

```
              ┌──────────── 同一共享文件系统 ────────────┐
  process A ──┤  data/maf/cluster.jsonl   （只增事实源）  ├── process B
  process C ──┤  data/maf/cluster.lock/   （原子互斥）    ├── 浏览器/API
              └──────────────────────────────────────────┘
```

- **唯一事实源**：`cluster.jsonl`，每行一条 `Rec`（`seq/ts/by/op/...`），只增不改。状态、审计、成员、事件全部由 `fold()` 重放得出，不存在"整文件覆盖"。
- **原子互斥**：`mkdirSync(cluster.lock)` 是 POSIX 原子操作，同一文件系统上跨进程互斥。持锁者写 `owner` 标签，解锁前校验标签，绝不误删他人锁；锁超过 3s 视为陈旧可抢占；等待 300×2ms 仍失败则 **fail-closed 抛错，拒绝无锁写入**。
- **确定性投影**：`fold()` 里所有时间比较用**记录自身 `ts`**，不用 `Date.now()`。同一账本在任何进程、任何时刻重放得到完全相同的状态（有测试断言）。运行时判断（租约是否现在过期）只在 `sync()` 里做，并把结论追加成 `lease.recover` 记录。
- **乐观并发**：`claim` 带 `baseSeq`（领取前投影的节点版本）。两个 worker 同时竞争，只有第一个生效；第二个在锁内重放发现版本已变，写入 `claim.reject` 审计后退出。
- **fencing**：`claim` 生成唯一 `leaseToken`；`heartbeat` / `commit` / `lease.recover` / `node.error` 全部校验 `status + owner + token`。陈旧 worker 的迟到提交被记入 `rejects` 并拒绝，绝不覆盖状态。
- **幂等**：`idempotencyKey` → `commits` 由状态机写入；已 `succeeded` 的节点不会再被领取，重跑不重复执行。
- **成员视图**：`worker.join` / `worker.hb`（1s 节流）投影出实例列表、`pid`、最近心跳、是否在线。
- **跨进程事件**：`log()` 既回调本进程 `EventBus`，也把 `EventDraft`（含 `runId/rootRunId/correlationId/causationId`）追加为 `op:"event"` 记录。`seq` 用账本行号，全局唯一，不依赖进程内计数器。

## 三、保证与边界（不粉饰）

| 保证 | 机制 | 真实验证 |
| --- | --- | --- |
| 同一节点不重复执行 | claim 乐观锁 + 状态机 | 两个独立进程竞争 4 节点 DAG，`calls.jsonl` 中每节点恰好 1 次 |
| 陈旧写入不污染状态 | leaseToken fencing | 冻结进程 320ms（心跳停摆）→ 租约被接管 → 旧提交被 `fencing 拒绝陈旧提交` 记入 rejects |
| 崩溃可恢复 | 过期租约 `lease.recover` | 构造过期 claim 记录，新实例重放后节点回到 pending，已提交副作用不重跑 |
| 重放确定性 | fold 不读墙上时钟 | 两个不同实例对同一账本 `get()` 结果 JSON 完全相等 |
| 损坏不静默 | fail-closed | 追加非法 JSON 行后新实例抛 `账本第 N 行损坏` |
| 锁不会永久卡死 | 3s stale + owner 校验 | 手工放置过期锁目录，新实例成功抢占 |
| 跨实例取消 | 协作式 | 主实例取消后，另一进程在**下个提交点**被拒；不是抢占式 kill |
| 全局 trace | 共享账本 + SSE tail | `/api/maf/events` 合并集群事件；`/api/events/stream` 增量推送并标注来源实例 |

**明确不宣称：**

- 不是跨机集群。依赖单文件系统上 `mkdir` 的原子性；NFS/对象存储的缓存与锁语义不保证，未验证、不宣称。
- 没有共识协议、没有 leader election、没有分区容错（CAP 下的 P 未处理）。网络分区时不做仲裁。
- 没有分布式时钟/向量时钟；跨机时间偏差会导致租约判断错误，故不支持跨机。
- 取消是**协作式**（提交点生效），不是抢占式中止其他进程的执行体。
- 灰度仍是状态机 + 影子双跑 + 有限证据发布，**不是真实流量 10%/50% canary**。
- `fold()` 是 O(n) 全量重放，**尚无快照/压缩（compaction）**；账本长期增长后需补上，当前不宣称无限扩展。
- 单进程 `EventBus` 仍只覆盖本进程；跨进程可见性来自共享账本 tail，1s 轮询，不是跨进程内存总线。

## 四、如何运行多个实例

所有实例指向**同一个 root**（共享 `data/maf/`）：

```bash
# 实例 A
AGENTOS_ROOT=/path/to/shared node --experimental-strip-types --no-warnings bin/agentos.ts web --port 8787
# 实例 B（同一 root，端口不同）
AGENTOS_ROOT=/path/to/shared node --experimental-strip-types --no-warnings bin/agentos.ts web --port 8788
```

提交任务后，两个实例都会 `run()` 同一任务；`claim` 乐观锁让节点在实例间**分摊**，而不是各跑一遍。浏览器连 A 的 `/api/events/stream` 能看到 B 产生的事件（带 `实例 xxxxxxxx` 标签）；MAF 工作台「多实例集群」卡片显示活跃实例数、账本 seq、被拒绝的写入与作用域说明。

> 若两个实例使用不同 root，则各自拥有独立账本，**不构成集群**——这是配置约定，不是自动发现。

## 五、复现验证

```bash
npm test -- tests/maf-cluster.test.ts tests/maf-orchestrator.test.ts   # 真实 spawn 多进程
npm test                                                                # 全量
node --experimental-strip-types --no-warnings scripts/loc-budget.ts     # 冻结预算
```

`tests/maf-cluster.test.ts` 用 `spawn(process.execPath, ...)` 启动**真实独立进程**，不 mock、不模拟并发；断言落在磁盘上的 `calls.jsonl` 与共享账本投影上，不是进程内变量。
