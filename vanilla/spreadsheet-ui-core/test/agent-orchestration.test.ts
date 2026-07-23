/**
 * Agent Orchestration — Unit Tests
 */

import { createStore } from '@einfach/core'
import { describe, expect, test, beforeEach } from '@jest/globals'
import {
  agentRegistryAtom, agentFileLockAtom, registerAgentAtom, deregisterAgentAtom,
  acquireLocksAtom, releaseLocksAtom, assignTaskAtom,
  completeTaskAtom, approveResultAtom, spawnAgentAtom,
  MAX_TOTAL_AGENTS,
} from '../src/agent-orchestration'
import type { AgentIdentity, AgentTask } from '../src/agent-orchestration'

let store: ReturnType<typeof createStore>

beforeEach(() => { store = createStore() })

// ============================================================================
describe('Agent Registration', () => {
  test('registers a root agent', () => {
    const r = store.setter(registerAgentAtom, { agentId: 'root', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    expect(r.success).toBe(true)
    expect(store.getter(agentRegistryAtom).size).toBe(1)
  })

  test('register is idempotent', () => {
    const id: AgentIdentity = { agentId: 'root', parentId: null, role: 'orchestrator', spawnedAt: 1 }
    store.setter(registerAgentAtom, id)
    expect(store.setter(registerAgentAtom, id).success).toBe(true)
  })

  test('rejects when MAX_TOTAL_AGENTS reached', () => {
    for (let i = 0; i < MAX_TOTAL_AGENTS; i++)
      store.setter(registerAgentAtom, { agentId: `a-${i}`, parentId: 'root', role: 'core-engineer', spawnedAt: Date.now() })
    expect(store.setter(registerAgentAtom, { agentId: 'overflow', parentId: 'root', role: 'core-engineer', spawnedAt: Date.now() }).success).toBe(false)
  })

  test('deregister removes agent and its locks', () => {
    store.setter(registerAgentAtom, { agentId: 'root', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    store.setter(acquireLocksAtom, { agentId: 'root', paths: ['docs/*'] })
    store.setter(deregisterAgentAtom, 'root')
    expect(store.getter(agentRegistryAtom).size).toBe(0)
    expect(store.getter(agentFileLockAtom)).toHaveLength(0)
  })
})

// ============================================================================
describe('File Locks', () => {
  beforeEach(() => {
    store.setter(registerAgentAtom, { agentId: 'root', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
  })

  test('acquires locks', () => {
    expect(store.setter(acquireLocksAtom, { agentId: 'root', paths: ['src/foo/*', 'test/foo.test.ts'] }).success).toBe(true)
    expect(store.getter(agentFileLockAtom)).toHaveLength(2)
  })

  test('allows ancestor delegation', () => {
    store.setter(acquireLocksAtom, { agentId: 'root', paths: ['vanilla/spreadsheet-ui-core/src/*'] })
    store.setter(registerAgentAtom, { agentId: 'root:child', parentId: 'root', role: 'core-engineer', spawnedAt: Date.now() })
    expect(store.setter(acquireLocksAtom, { agentId: 'root:child', paths: ['vanilla/spreadsheet-ui-core/src/find-replace/*'] }).success).toBe(true)
  })

  test('rejects non-ancestor lock conflict', () => {
    store.setter(registerAgentAtom, { agentId: 'A', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    store.setter(registerAgentAtom, { agentId: 'B', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    store.setter(acquireLocksAtom, { agentId: 'A', paths: ['src/find-replace/*'] })
    const r = store.setter(acquireLocksAtom, { agentId: 'B', paths: ['src/find-replace/index.ts'] })
    expect(r.success).toBe(false)
    expect(r.conflicts[0].holderAgentId).toBe('A')
  })

  test('release removes all locks', () => {
    store.setter(acquireLocksAtom, { agentId: 'root', paths: ['src/a/*', 'src/b/*'] })
    store.setter(releaseLocksAtom, 'root')
    expect(store.getter(agentFileLockAtom)).toHaveLength(0)
  })
})

// ============================================================================
describe('Task Assignment', () => {
  beforeEach(() => {
    store.setter(registerAgentAtom, { agentId: 'root', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    store.setter(acquireLocksAtom, { agentId: 'root', paths: ['docs/*'] })
  })

  test('assigns task', () => {
    const a = store.setter(assignTaskAtom, { agentId: 'root', fileBoundaries: ['docs/foo.md'], task: mkTask('t1') })
    expect(a).not.toBeNull()
    expect(a!.status).toBe('assigned')
  })
})

// ============================================================================
describe('Complete & Approve', () => {
  beforeEach(() => {
    store.setter(registerAgentAtom, { agentId: 'root', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    store.setter(acquireLocksAtom, { agentId: 'root', paths: ['docs/*'] })
  })

  test('complete releases locks', () => {
    store.setter(completeTaskAtom, { agentId: 'root', taskId: 't1', result: okResult() })
    expect(store.getter(agentRegistryAtom).get('root')?.status).toBe('reviewing')
    expect(store.getter(agentFileLockAtom)).toHaveLength(0)
  })

  test('approve → done, reject → working', () => {
    store.setter(completeTaskAtom, { agentId: 'root', taskId: 't1', result: okResult() })
    expect(store.setter(approveResultAtom, { agentId: 'root', approved: true }).newStatus).toBe('done')
    // reset
    store.setter(registerAgentAtom, { agentId: 'r2', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    store.setter(acquireLocksAtom, { agentId: 'r2', paths: ['docs/*'] })
    store.setter(completeTaskAtom, { agentId: 'r2', taskId: 't1', result: okResult() })
    expect(store.setter(approveResultAtom, { agentId: 'r2', approved: false }).newStatus).toBe('working')
  })
})

// ============================================================================
describe('Spawn Agent', () => {
  beforeEach(() => {
    store.setter(registerAgentAtom, { agentId: 'root', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    store.setter(acquireLocksAtom, { agentId: 'root', paths: ['docs/*', 'vanilla/spreadsheet-ui-core/src/*', 'rust/*'] })
  })

  test('spawns child successfully', () => {
    const r = store.setter(spawnAgentAtom, { parentAgentId: 'root', request: { parentTaskId: 'rt', role: 'core-engineer', fileBoundaries: ['vanilla/spreadsheet-ui-core/src/find-replace/*'], task: mkTask('c1') } })
    expect(r.success).toBe(true)
    expect(r.agentId).toMatch(/^root:core-engineer-\d+$/)
    expect(store.getter(agentRegistryAtom).get(r.agentId!)?.status).toBe('working')
  })

  test('rejects idle parent', () => {
    store.setter(registerAgentAtom, { agentId: 'idle', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    const r = store.setter(spawnAgentAtom, { parentAgentId: 'idle', request: { parentTaskId: 'x', role: 'core-engineer', fileBoundaries: ['docs/*'], task: mkTask('c1') } })
    expect(r.error).toBe('parent_not_in_working_state')
  })

  test('rejects sibling overlap', () => {
    store.setter(spawnAgentAtom, { parentAgentId: 'root', request: { parentTaskId: 'rt', role: 'core-engineer', fileBoundaries: ['vanilla/spreadsheet-ui-core/src/find-replace/*'], task: mkTask('c1') } })
    const r2 = store.setter(spawnAgentAtom, { parentAgentId: 'root', request: { parentTaskId: 'rt', role: 'core-engineer', fileBoundaries: ['vanilla/spreadsheet-ui-core/src/find-replace/index.ts'], task: mkTask('c2') } })
    expect(r2.error).toBe('file_boundary_overlap_with_sibling')
  })

  test('rejects non-subset boundaries', () => {
    const r = store.setter(spawnAgentAtom, { parentAgentId: 'root', request: { parentTaskId: 'rt', role: 'core-engineer', fileBoundaries: ['solid/excel/src/grid.tsx'], task: mkTask('c1') } })
    expect(r.error).toBe('file_boundary_not_subset')
  })

  test('enforces MAX_DEPTH (root=1, blocks at depth 3 parent)', () => {
    const c1 = store.setter(spawnAgentAtom, { parentAgentId: 'root', request: { parentTaskId: 'rt', role: 'core-engineer', fileBoundaries: ['vanilla/spreadsheet-ui-core/src/find-replace/*'], task: mkTask('c1') } })
    expect(c1.success).toBe(true)
    const c2 = store.setter(spawnAgentAtom, { parentAgentId: c1.agentId!, request: { parentTaskId: 'rt', role: 'reviewer', fileBoundaries: ['vanilla/spreadsheet-ui-core/src/find-replace/index.ts'], task: mkTask('c2') } })
    expect(c2.success).toBe(true)
    const c3 = store.setter(spawnAgentAtom, { parentAgentId: c2.agentId!, request: { parentTaskId: 'rt', role: 'e2e-tester', fileBoundaries: ['vanilla/spreadsheet-ui-core/src/find-replace/index.ts'], task: mkTask('c3') } })
    expect(c3.success).toBe(false)
    expect(c3.error).toBe('max_depth_exceeded')
  })
})

// ============================================================================
describe('Full Orchestration Flow', () => {
  test('root spawns 3 children in parallel, aggregates all results', () => {
    store.setter(registerAgentAtom, { agentId: 'root', parentId: null, role: 'orchestrator', spawnedAt: Date.now() })
    store.setter(acquireLocksAtom, { agentId: 'root', paths: [
      'docs/*',
      'vanilla/spreadsheet-ui-core/src/*',
      'vanilla/spreadsheet-ui-core/test/*',
      'rust/*',
    ]})

    const boundaries = [
      ['vanilla/spreadsheet-ui-core/src/find-replace/*', 'vanilla/spreadsheet-ui-core/test/find-replace.test.ts'],
      ['vanilla/spreadsheet-ui-core/src/comments/*', 'vanilla/spreadsheet-ui-core/test/comments-notes.test.ts'],
      ['rust/excel-core/src/eval.rs'],
    ]

    const children: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = store.setter(spawnAgentAtom, {
        parentAgentId: 'root',
        request: { parentTaskId: 'rt', role: 'core-engineer', fileBoundaries: boundaries[i], task: mkTask(`c${i}`) },
      })
      expect(r.success).toBe(true)
      children.push(r.agentId!)
    }

    const childResults = children.map((id, i) =>
      store.setter(completeTaskAtom, { agentId: id, taskId: `c${i}`, result: {
        status: 'done', touchedFiles: boundaries[i],
        deliverables: [{ path: boundaries[i][0], kind: 'modified' }],
        testResults: [{ suite: `c${i}`, passed: 5, failed: 0, skipped: 0 }],
        knownRisks: [], childResults: [], durationMs: 1000 * (i + 1),
      }}),
    )

    const rootResult = store.setter(completeTaskAtom, { agentId: 'root', taskId: 'rt', result: {
      status: 'done', touchedFiles: ['docs/AGENT_ORCHESTRATION.md'],
      deliverables: [{ path: 'docs/AGENT_ORCHESTRATION.md', kind: 'created' }],
      testResults: [{ suite: 'orch', passed: 3, failed: 0, skipped: 0 }],
      knownRisks: [], childResults: childResults, durationMs: 5000,
    }})

    expect(rootResult.childResults).toHaveLength(3)
    expect(rootResult.status).toBe('done')
    children.forEach(id => expect(store.getter(agentRegistryAtom).get(id)?.status).toBe('reviewing'))
  })
})

// ============================================================================
// Helpers
// ============================================================================

function mkTask(id: string): AgentTask {
  return { taskId: id, title: id, description: '', acceptanceCriteria: [], dependencies: [], timeoutMs: 60000 }
}

function okResult() {
  return { status: 'done' as const, touchedFiles: [], deliverables: [], testResults: [], knownRisks: [], childResults: [], durationMs: 100 }
}
