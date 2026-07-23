/**
 * Agent Orchestration — Atoms
 *
 * 多 Agent 并发编排系统的状态管理 atoms。
 * 全部基于 @einfach/core，不引入任何外部状态库。
 *
 * 核心特性: 父子锁委托 — 子 agent 获取祖先已持有的锁视为委派，允许。
 * 深度定义: root 自身深度 = 1，每 spawn 一层 +1，MAX_DEPTH=3 即最多 root→parent→leaf。
 *
 * @module agent-orchestration/atoms
 */

import { atom } from '@einfach/core'
import type {
  AgentIdentity, AgentResult, AgentStatus, AgentTask,
  AcquireResult, FileLock, SpawnRequest, SpawnResult, TaskAssignment,
} from './types'
import {
  MAX_DEPTH, MAX_CHILDREN_PER_PARENT, MAX_CHILDREN_PER_LEAF, MAX_TOTAL_AGENTS,
} from './types'

const NS = 'spreadsheet.agentOrchestration'

// ============================================================================
// Source Atoms
// ============================================================================

interface AgentRecord {
  identity: AgentIdentity
  status: AgentStatus
  statusSince: number
  fileBoundaries: string[]
  tasks: Map<string, TaskAssignment>
}

export const agentRegistryAtom = atom<Map<string, AgentRecord>>(new Map())
agentRegistryAtom.debugLabel = `${NS}.registry`

export const agentFileLockAtom = atom<FileLock[]>([])
agentFileLockAtom.debugLabel = `${NS}.fileLocks`

export const agentResultMapAtom = atom<Map<string, AgentResult>>(new Map())
agentResultMapAtom.debugLabel = `${NS}.resultMap`

// ============================================================================
// Utilities
// ============================================================================

function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const aDir = a.endsWith('/*') ? a.slice(0, -2) : null
  const bDir = b.endsWith('/*') ? b.slice(0, -2) : null
  if (aDir && b.startsWith(aDir + '/')) return true
  if (bDir && a.startsWith(bDir + '/')) return true
  return false
}

/** 从 agentId 向上追溯到 root 的所有祖先 id（含自身） */
function ancestorIds(registry: Map<string, AgentRecord>, agentId: string): Set<string> {
  const ids = new Set<string>()
  let cur: string | null = agentId
  while (cur) {
    ids.add(cur)
    const r = registry.get(cur)
    cur = r?.identity.parentId ?? null
  }
  return ids
}

/** 树深度（root=1, 每向下 spawn 一层 +1） */
function agentDepth(registry: Map<string, AgentRecord>, agentId: string): number {
  let depth = 0
  let cur: string | null = agentId
  while (cur) {
    depth++
    const r = registry.get(cur)
    cur = r?.identity.parentId ?? null
  }
  return depth
}

// ============================================================================
// Command Atoms
// ============================================================================

export const registerAgentAtom = atom<AgentIdentity | null, [AgentIdentity], SpawnResult>(
  null,
  (getter, setter, identity: AgentIdentity): SpawnResult => {
    const registry = new Map(getter(agentRegistryAtom))
    if (registry.size >= MAX_TOTAL_AGENTS)
      return { success: false, error: 'max_total_agents_exceeded' }
    if (registry.has(identity.agentId))
      return { success: true, agentId: identity.agentId }
    registry.set(identity.agentId, {
      identity, status: 'idle', statusSince: Date.now(),
      fileBoundaries: [], tasks: new Map(),
    })
    setter(agentRegistryAtom, registry)
    return { success: true, agentId: identity.agentId }
  },
)
registerAgentAtom.debugLabel = `${NS}.registerAgent`

export const deregisterAgentAtom = atom<null, [string], void>(
  null, (getter, setter, agentId) => {
    const registry = new Map(getter(agentRegistryAtom))
    registry.delete(agentId)
    setter(agentRegistryAtom, registry)
    setter(agentFileLockAtom, getter(agentFileLockAtom).filter(l => l.holderAgentId !== agentId))
  },
)
deregisterAgentAtom.debugLabel = `${NS}.deregisterAgent`

/** 获取文件锁（全或无）。祖先已持有的锁允许委派给后代。 */
export const acquireLocksAtom = atom<
  AcquireResult | null, [{ agentId: string; paths: string[] }], AcquireResult
>(
  null, (getter, setter, { agentId, paths }): AcquireResult => {
    const locks = getter(agentFileLockAtom)
    const registry = getter(agentRegistryAtom)
    const record = registry.get(agentId)
    if (!record) return { success: false, conflicts: [] }

    const ancestors = ancestorIds(registry, agentId)
    const conflicts: FileLock[] = []
    for (const lock of locks) {
      if (lock.holderAgentId === agentId || ancestors.has(lock.holderAgentId)) continue
      for (const path of paths) {
        if (pathsOverlap(path, lock.path)) { conflicts.push(lock); break }
      }
    }
    if (conflicts.length > 0) return { success: false, conflicts }

    const now = Date.now()
    setter(agentFileLockAtom, [
      ...locks,
      ...paths.map(p => ({ path: p, holderAgentId: agentId, acquiredAt: now, mode: 'exclusive' as const })),
    ])
    const newReg = new Map(registry)
    const u = newReg.get(agentId)!
    newReg.set(agentId, { ...u, status: 'working', statusSince: now, fileBoundaries: paths })
    setter(agentRegistryAtom, newReg)
    return { success: true, conflicts: [] }
  },
)
acquireLocksAtom.debugLabel = `${NS}.acquireLocks`

export const releaseLocksAtom = atom<null, [string], void>(
  null, (getter, setter, agentId) => {
    setter(agentFileLockAtom, getter(agentFileLockAtom).filter(l => l.holderAgentId !== agentId))
  },
)
releaseLocksAtom.debugLabel = `${NS}.releaseLocks`

export const assignTaskAtom = atom<
  TaskAssignment | null, [{ agentId: string; task: AgentTask; fileBoundaries: string[] }], TaskAssignment | null
>(
  null, (getter, setter, { agentId, task, fileBoundaries }) => {
    const registry = new Map(getter(agentRegistryAtom))
    const record = registry.get(agentId)
    if (!record) return null
    const assignment: TaskAssignment = {
      task, assigneeAgentId: agentId, status: 'assigned',
      assignedAt: Date.now(), fileBoundaries,
    }
    const tasks = new Map(record.tasks)
    tasks.set(task.taskId, assignment)
    registry.set(agentId, {
      ...record, tasks,
      status: record.status === 'idle' ? 'discovering' : record.status,
      statusSince: Date.now(), fileBoundaries,
    })
    setter(agentRegistryAtom, registry)
    return assignment
  },
)
assignTaskAtom.debugLabel = `${NS}.assignTask`

export const completeTaskAtom = atom<
  AgentResult | null,
  [{ agentId: string; taskId: string; result: Omit<AgentResult, 'agentId' | 'taskId'> }],
  AgentResult
>(
  null, (getter, setter, { agentId, taskId, result }) => {
    const full: AgentResult = { ...result, agentId, taskId }
    const resultMap = new Map(getter(agentResultMapAtom))
    resultMap.set(agentId, full)
    setter(agentResultMapAtom, resultMap)
    const registry = new Map(getter(agentRegistryAtom))
    const record = registry.get(agentId)
    if (record) {
      const tasks = new Map(record.tasks)
      const t = tasks.get(taskId)
      if (t) tasks.set(taskId, { ...t, status: 'done' })
      registry.set(agentId, { ...record, tasks, status: 'reviewing', statusSince: Date.now() })
      setter(agentRegistryAtom, registry)
    }
    setter(releaseLocksAtom, agentId)
    return full
  },
)
completeTaskAtom.debugLabel = `${NS}.completeTask`

/** 审批子 agent 结果。返回 newStatus 可能是 'done'、'working' 或 'reviewing'（无操作）。 */
export const approveResultAtom = atom<
  null,
  [{ agentId: string; approved: boolean }],
  { agentId: string; newStatus: AgentStatus }
>(
  null, (getter, setter, { agentId, approved }) => {
    const registry = new Map(getter(agentRegistryAtom))
    const record = registry.get(agentId)
    if (!record || record.status !== 'reviewing')
      return { agentId, newStatus: 'reviewing' as AgentStatus }
    const ns: AgentStatus = approved ? 'done' : 'working'
    registry.set(agentId, { ...record, status: ns, statusSince: Date.now() })
    setter(agentRegistryAtom, registry)
    return { agentId, newStatus: ns }
  },
)
approveResultAtom.debugLabel = `${NS}.approveResult`

/** Spawn 子 agent。前置条件全检查 + 注册 + 分配 + 锁。祖先锁委托允许。 */
export const spawnAgentAtom = atom<
  SpawnResult | null, [{ parentAgentId: string; request: SpawnRequest }], SpawnResult
>(
  null, (getter, setter, { parentAgentId, request }): SpawnResult => {
    const registry = getter(agentRegistryAtom)
    const parent = registry.get(parentAgentId)
    if (!parent || parent.status !== 'working')
      return { success: false, error: 'parent_not_in_working_state' }

    const parentDepth = agentDepth(registry, parentAgentId)
    if (parentDepth >= MAX_DEPTH)
      return { success: false, error: 'max_depth_exceeded' }

    if (registry.size >= MAX_TOTAL_AGENTS)
      return { success: false, error: 'max_total_agents_exceeded' }

    const sibCount = countActiveChildren(registry, parentAgentId)
    const maxC = parentAgentId === 'root' ? MAX_CHILDREN_PER_PARENT : MAX_CHILDREN_PER_LEAF
    if (sibCount >= maxC)
      return { success: false, error: 'max_children_exceeded' }

    if (!isSubsetOf(request.fileBoundaries, parent.fileBoundaries))
      return { success: false, error: 'file_boundary_not_subset' }

    if (overlapsWithActiveSiblings(registry, parentAgentId, request.fileBoundaries))
      return { success: false, error: 'file_boundary_overlap_with_sibling' }

    const agentId = `${parentAgentId}:${request.role}-${Date.now()}`
    const identity: AgentIdentity = { agentId, parentId: parentAgentId, role: request.role, spawnedAt: Date.now() }

    const r1 = setter(registerAgentAtom, identity)
    if (!r1.success) return r1

    setter(assignTaskAtom, { agentId, task: request.task, fileBoundaries: request.fileBoundaries })

    const r2 = setter(acquireLocksAtom, { agentId, paths: request.fileBoundaries })
    if (!r2.success) { setter(deregisterAgentAtom, agentId); return { success: false, error: 'lock_acquisition_failed' } }

    return { success: true, agentId }
  },
)
spawnAgentAtom.debugLabel = `${NS}.spawnAgent`

// ============================================================================
// Helpers
// ============================================================================

function countActiveChildren(registry: Map<string, AgentRecord>, pid: string): number {
  let n = 0
  for (const [, r] of registry)
    if (r.identity.parentId === pid && r.status !== 'done' && r.status !== 'failed') n++
  return n
}

function isSubsetOf(child: string[], parent: string[]): boolean {
  for (const cp of child) {
    let ok = false
    for (const pp of parent) {
      if (pathsOverlap(cp, pp) || cp.startsWith(pp.replace('/*', '/'))) { ok = true; break }
    }
    if (!ok) return false
  }
  return true
}

function overlapsWithActiveSiblings(
  registry: Map<string, AgentRecord>, pid: string, childPaths: string[],
): boolean {
  for (const [, r] of registry) {
    if (r.identity.parentId !== pid || r.status === 'done' || r.status === 'failed') continue
    for (const sp of r.fileBoundaries)
      for (const cp of childPaths)
        if (pathsOverlap(cp, sp)) return true
  }
  return false
}
