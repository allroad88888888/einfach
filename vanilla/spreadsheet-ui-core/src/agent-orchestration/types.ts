/**
 * Agent Orchestration — Core Types
 *
 * 多 Agent 并发编排系统的共享类型定义。
 * 不依赖任何框架、DOM、Worker 或 WASM。
 *
 * @module agent-orchestration/types
 */

// --- Agent Identity ---

export interface AgentIdentity {
  /** 树内唯一 id，格式: {parentId}:{role} 或 "root" */
  agentId: string
  /** 父 agent 的 id，"root" 的 parentId 为 null */
  parentId: string | null
  /** 角色标签 */
  role: AgentRole
  /** spawn 时间戳 (ms) */
  spawnedAt: number
}

export type AgentRole =
  | 'orchestrator'
  | 'core-engineer'
  | 'ui-integrator'
  | 'formula-engineer'
  | 'render-engineer'
  | 'reviewer'
  | 'e2e-tester'
  | string

// --- Lifecycle ---

export type AgentStatus =
  | 'idle'
  | 'discovering'
  | 'acquiring_locks'
  | 'working'
  | 'reviewing'
  | 'done'
  | 'failed'

// --- File Locks ---

export interface FileLock {
  /** 锁定的路径（glob 字面量） */
  path: string
  /** 持有者 agentId */
  holderAgentId: string
  /** 获取时间戳 (ms) */
  acquiredAt: number
  /** 锁模式（当前仅支持排他写锁） */
  mode: 'exclusive'
}

export interface AcquireResult {
  success: boolean
  /** 成功时为空，失败时为冲突的 FileLock 数组 */
  conflicts: FileLock[]
}

// --- Tasks ---

export interface AgentTask {
  taskId: string
  title: string
  description: string
  acceptanceCriteria: string[]
  /** 依赖的其他 taskId */
  dependencies: string[]
  /** 超时 (ms)，默认 30 min */
  timeoutMs: number
}

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'done'
  | 'failed'

export interface TaskAssignment {
  task: AgentTask
  assigneeAgentId: string
  status: TaskStatus
  assignedAt: number
  fileBoundaries: string[]
}

// --- Spawn ---

export interface SpawnRequest {
  /** 父 agent 的任务 id */
  parentTaskId: string
  /** 子 agent 的 role */
  role: AgentRole
  /** 分配给子 agent 的文件边界 */
  fileBoundaries: string[]
  /** 任务描述 */
  task: AgentTask
}

export interface SpawnResult {
  success: boolean
  agentId?: string
  error?: SpawnError
}

export type SpawnError =
  | 'max_depth_exceeded'
  | 'max_children_exceeded'
  | 'max_total_agents_exceeded'
  | 'file_boundary_not_subset'
  | 'file_boundary_overlap_with_sibling'
  | 'lock_acquisition_failed'
  | 'parent_not_in_working_state'

// --- Results ---

export interface AgentResult {
  agentId: string
  taskId: string
  status: 'done' | 'failed'
  /** 创建/修改的文件列表 */
  touchedFiles: string[]
  /** 交付物描述 */
  deliverables: { path: string; kind: 'created' | 'modified' }[]
  /** 测试结果摘要 */
  testResults: { suite: string; passed: number; failed: number; skipped: number }[]
  /** 已知风险 */
  knownRisks: string[]
  /** 子 agent 的结果（递归） */
  childResults: AgentResult[]
  /** 耗时 (ms) */
  durationMs: number
  /** 失败时的错误信息 */
  errorMessage?: string
}

// --- Limits ---

export const MAX_DEPTH = 3
export const MAX_CHILDREN_PER_PARENT = 5
export const MAX_CHILDREN_PER_LEAF = 3
export const MAX_TOTAL_AGENTS = 20
export const LOCK_TIMEOUT_MS = 30 * 60 * 1000
export const DISCOVERING_TIMEOUT_MS = 60 * 1000
