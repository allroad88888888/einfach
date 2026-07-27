import { describe, expect, test } from '@jest/globals'
import {
  snapshotAcknowledgement,
  runBoundedOperation,
  type AcknowledgementSnapshot,
  type BoundedOperationResult,
} from '../src/internal/ack-hardening'

// ---------------------------------------------------------------------------
// snapshotAcknowledgement
// ---------------------------------------------------------------------------

interface TestTicket {
  readonly requestId: number
  readonly timeoutMs: number
}

function extractIdentity(ack: Record<string, unknown>): { readonly id: number } | null {
  if (typeof ack.revision === 'number') {
    return { id: ack.revision as number }
  }
  return null
}

describe('snapshotAcknowledgement', () => {
  const ticket: TestTicket = { requestId: 42, timeoutMs: 15_000 }

  test('null or non-object → malformed', () => {
    expect(snapshotAcknowledgement(null, ticket, extractIdentity)).toEqual({
      kind: 'malformed',
      spec: null,
    })
    expect(snapshotAcknowledgement(undefined, ticket, extractIdentity)).toEqual({
      kind: 'malformed',
      spec: null,
    })
    expect(snapshotAcknowledgement('string', ticket, extractIdentity)).toEqual({
      kind: 'malformed',
      spec: null,
    })
    expect(snapshotAcknowledgement(42, ticket, extractIdentity)).toEqual({
      kind: 'malformed',
      spec: null,
    })
  })

  test('applied: true with matching requestId → applied', () => {
    const ack = { applied: true, requestId: 42, revision: 7 }
    const result = snapshotAcknowledgement(ack, ticket, extractIdentity)
    expect(result.kind).toBe('applied')
    expect(result.spec).toEqual({ id: 7 })
  })

  test('applied: false with matching requestId → not-applied', () => {
    const ack = { applied: false, requestId: 42 }
    const result = snapshotAcknowledgement(ack, ticket, extractIdentity)
    expect(result.kind).toBe('not-applied')
    expect(result.spec).toBeNull()
  })

  test('applied: true with mismatched requestId → malformed', () => {
    const ack = { applied: true, requestId: 99 }
    const result = snapshotAcknowledgement(ack, ticket, extractIdentity)
    expect(result.kind).toBe('malformed')
  })

  test('applied: false with mismatched requestId → malformed', () => {
    const ack = { applied: false, requestId: 99 }
    const result = snapshotAcknowledgement(ack, ticket, extractIdentity)
    expect(result.kind).toBe('malformed')
  })

  test('missing applied field → malformed', () => {
    const ack = { requestId: 42 }
    const result = snapshotAcknowledgement(ack, ticket, extractIdentity)
    expect(result.kind).toBe('malformed')
  })

  test('requestId as string that parses to matching number → applied', () => {
    const ack = { applied: true, requestId: '42', revision: 1 }
    const result = snapshotAcknowledgement(ack, ticket, extractIdentity)
    expect(result.kind).toBe('applied')
  })

  test('extractSpec returning null → malformed (even when applied: true)', () => {
    const ack = { applied: true, requestId: 42, revision: undefined }
    const result = snapshotAcknowledgement(ack, ticket, (_ack) => null)
    expect(result.kind).toBe('malformed')
  })

  test('result objects are frozen', () => {
    const ack = { applied: true, requestId: 42, revision: 7 }
    const result = snapshotAcknowledgement(ack, ticket, extractIdentity)
    expect(Object.isFrozen(result)).toBe(true)
    expect(() => {
      ;(result as { kind: string }).kind = 'hacked'
    }).toThrow()
  })
})

// ---------------------------------------------------------------------------
// runBoundedOperation
// ---------------------------------------------------------------------------

describe('runBoundedOperation', () => {
  test('fulfilled when operation settles before timeout', async () => {
    const result = await runBoundedOperation(
      () => Promise.resolve(42),
      1000,
      'test',
    )
    expect(result).toEqual({ kind: 'fulfilled', value: 42 })
  })

  test('rejected when operation throws', async () => {
    const error = new Error('boom')
    const result = await runBoundedOperation(
      () => Promise.reject(error),
      1000,
      'test',
    )
    expect(result).toEqual({ kind: 'rejected', error })
  })

  test('timeout when operation takes too long', async () => {
    jest.useFakeTimers()
    const promise = runBoundedOperation(
      () => new Promise<number>(() => {}), // never resolves
      100,
      'test',
    )

    jest.advanceTimersByTime(200)
    const result = await promise
    jest.useRealTimers()

    expect(result).toEqual({ kind: 'timeout' })
  })

  test('non-timeout result wins when both settle simultaneously (sync resolve)', async () => {
    // With fake timers disabled and a sync resolve, the operation's resolve
    // fires before setTimeout(0) can.
    const result = await runBoundedOperation(
      () => Promise.resolve('fast'),
      10_000,
      'test',
    )
    expect(result).toEqual({ kind: 'fulfilled', value: 'fast' })
  })
})
