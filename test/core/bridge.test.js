import test from 'node:test'
import assert from 'node:assert/strict'

import { HarnessBridge, parseQuestions, renderQuestions, taskIdFor, toMillis } from '../../lib/bridge.js'
import { TaskStatus } from '../../lib/domain.js'
import { ReplyRouter, sessionState } from '../../lib/routing.js'

/** Minimal Cordis-shaped context: only `get` is used by the bridge. */
function fakeCtx(agents = null) {
  return { get: (name) => (name === 'agents' ? agents : null) }
}

function fakeAgent(status = 'idle') {
  return {
    status,
    followups: [],
    followup(message) {
      this.followups.push(message)
    },
  }
}

function bridgeWith(agents = null) {
  const tasks = []
  const bridge = new HarnessBridge({ ctx: fakeCtx(agents), onTask: (task) => tasks.push(task) })
  return { bridge, tasks }
}

test('toMillis accepts epoch numbers, ISO strings and falls back to now', () => {
  assert.equal(toMillis(1000), 1000)
  assert.equal(toMillis('1970-01-01T00:00:01.000Z'), 1000)
  assert.ok(Number.isFinite(toMillis(undefined)))
})

test('taskIdFor is stable, distinct per session, and regex-safe', () => {
  const first = taskIdFor('session-aaa', 3)
  assert.equal(first, taskIdFor('session-aaa', 3))
  assert.notEqual(first, taskIdFor('session-bbb', 3))
  assert.notEqual(first, taskIdFor('session-aaa', 4))
  assert.match(first, /^[A-Za-z0-9_-]+$/)
})

test('a completed turn produces a task with timing and a reply summary', () => {
  const { bridge, tasks } = bridgeWith()
  const session = { id: 'session-1', log: [] }
  bridge.indexSession(session)
  bridge.handleSessionEvent(session, { type: 'session/title', data: { title: '部署服务' }, time: 0 })
  bridge.handleSessionEvent(session, { type: 'turn/start', data: { turn: 3 }, time: 1_000 })
  bridge.handleSessionEvent(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已经部署完成。' }] } },
    time: 2_000,
  })
  bridge.handleSessionEvent(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } }, time: 4_000 })

  assert.equal(tasks.length, 1)
  const task = tasks[0]
  assert.equal(task.status, TaskStatus.COMPLETED)
  assert.equal(task.title, '部署服务')
  assert.equal(task.sessionId, 'session-1')
  assert.equal(task.durationMs, 3000)
  assert.equal(task.startedAt, new Date(1000).toISOString())
  assert.equal(task.resultSummary, '已经部署完成。')
  assert.equal(task.errorSummary, null)
})

test('a failed turn carries the failure text', () => {
  const { bridge, tasks } = bridgeWith()
  const session = { id: 's', log: [] }
  bridge.indexSession(session)
  bridge.handleSessionEvent(session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: '模型返回 500' } } },
    time: 2_000,
  })
  assert.equal(tasks[0].status, TaskStatus.FAILED)
  assert.equal(tasks[0].errorSummary, '模型返回 500')
})

test('interrupted, aborted and forked turns are not notified', () => {
  for (const kind of ['interrupted', 'aborted', 'forked']) {
    const { bridge, tasks } = bridgeWith()
    const session = { id: `s-${kind}`, log: [] }
    bridge.indexSession(session)
    bridge.handleSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind } }, time: 1 })
    assert.equal(tasks.length, 0, `${kind} must not notify`)
  }
})

test('blocked and max-tokens turns are notified as failures', () => {
  for (const kind of ['blocked', 'max-tokens']) {
    const { bridge, tasks } = bridgeWith()
    const session = { id: `s-${kind}`, log: [] }
    bridge.indexSession(session)
    bridge.handleSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind } }, time: 1 })
    assert.equal(tasks[0].status, TaskStatus.FAILED)
    assert.ok(tasks[0].errorSummary.length > 0)
  }
})

test('an approval request notifies and a decision clears the state', () => {
  const { bridge, tasks } = bridgeWith()
  const session = { id: 's', log: [] }
  bridge.indexSession(session)
  bridge.handleSessionEvent(session, {
    type: 'approval/asked',
    data: { id: 'a1', toolName: 'pwsh', reason: '需要写入工作区外' },
    time: 1,
  })
  assert.equal(tasks[0].status, TaskStatus.WAITING_APPROVAL)
  assert.match(tasks[0].errorSummary, /需要写入工作区外/)
  assert.equal(bridge.sessionState('s').waitingApproval, true)

  bridge.handleSessionEvent(session, { type: 'approval/decided', data: { id: 'a1', outcome: 'approved' }, time: 2 })
  assert.equal(bridge.sessionState('s').waitingApproval, false)
})

test('a question tool call notifies with the options rendered', () => {
  const { bridge, tasks } = bridgeWith()
  const session = { id: 's', log: [] }
  bridge.indexSession(session)
  bridge.handleSessionEvent(session, {
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [
          {
            id: 'q1',
            header: '部署目标',
            question: '部署到哪个环境？',
            options: [{ label: '预发' }, { label: '生产', description: '会立即对外可见' }],
          },
        ],
      }),
    },
    time: 1,
  })
  assert.equal(tasks[0].status, TaskStatus.WAITING_USER_INPUT)
  assert.match(tasks[0].errorSummary, /部署到哪个环境？/)
  assert.match(tasks[0].errorSummary, /a\. 预发/)
  assert.match(tasks[0].errorSummary, /b\. 生产 — 会立即对外可见/)
  assert.match(tasks[0].errorSummary, /不会替你选择选项/)
  assert.equal(bridge.sessionState('s').waitingInput, true)

  bridge.handleSessionEvent(session, {
    type: 'user/message',
    data: { id: 'm1', role: 'user', content: [] },
    time: 2,
  })
  assert.equal(bridge.sessionState('s').waitingInput, false)
})

test('a non-question tool call is ignored', () => {
  const { bridge, tasks } = bridgeWith()
  const session = { id: 's', log: [] }
  bridge.indexSession(session)
  bridge.handleSessionEvent(session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' },
    time: 1,
  })
  assert.equal(tasks.length, 0)
})

test('indexSession folds history so a resumed session is not emailed', () => {
  const { bridge, tasks } = bridgeWith()
  const session = {
    id: 'resumed',
    log: [
      { type: 'session/title', data: { title: '旧会话' }, time: 0 },
      { type: 'turn/start', data: { turn: 1 }, time: 1 },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: 2 },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回复' }] } }, time: 2 },
    ],
  }
  bridge.indexSession(session)
  assert.equal(tasks.length, 0, 'folding history must not emit tasks')
  assert.equal(bridge.sessionTitle('resumed'), '旧会话')

  // A new turn on the same session still notifies.
  bridge.handleSessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, time: 3 })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].turnId, '2')
})

test('sessionState reports a missing session and forget drops bookkeeping', () => {
  const { bridge } = bridgeWith()
  assert.deepEqual(bridge.sessionState('nope'), {
    exists: false,
    running: false,
    waitingInput: false,
    waitingApproval: false,
    loaded: false,
  })
  const session = { id: 's', log: [] }
  bridge.indexSession(session)
  assert.equal(bridge.sessionState('s').exists, true)
  bridge.forget('s')
  assert.equal(bridge.sessionState('s').exists, false)
})

test('sendMessage submits a user message through followup', () => {
  const agent = fakeAgent('idle')
  const { bridge } = bridgeWith({ get: (id) => (id === 's' ? agent : undefined) })
  assert.equal(bridge.sendMessage('s', '继续做吧', '<m1>'), true)
  assert.equal(agent.followups.length, 1)
  assert.equal(agent.followups[0].role, 'user')
  assert.equal(agent.followups[0].content[0].text, '继续做吧')
  assert.deepEqual(agent.followups[0].source, { kind: 'user' })
  assert.ok(typeof agent.followups[0].id === 'string' && agent.followups[0].id.length > 0)
})

test('sendMessage reports failure for an unknown session instead of throwing', () => {
  const { bridge } = bridgeWith({ get: () => undefined })
  assert.equal(bridge.sendMessage('missing', 'hi', '<m1>'), false)
})

test('sendMessage survives a followup that throws', () => {
  const agent = {
    status: 'idle',
    followup() {
      throw new Error('agent is closed')
    },
  }
  const { bridge } = bridgeWith({ get: () => agent })
  assert.equal(bridge.sendMessage('s', 'hi', '<m1>'), false)
})

test('connected and continuationAvailable follow the agent registry', () => {
  const without = bridgeWith(null).bridge
  assert.equal(without.connected, false)
  assert.equal(without.continuationAvailable, false)
  assert.equal(without.capabilities.answerUserInput, false)

  const withAgents = bridgeWith({ get: () => fakeAgent() }).bridge
  assert.equal(withAgents.connected, true)
  assert.equal(withAgents.continuationAvailable, true)
})

test('parseQuestions tolerates absent, truncated and non-JSON arguments', () => {
  assert.deepEqual(parseQuestions(undefined), [])
  assert.deepEqual(parseQuestions(''), [])
  assert.deepEqual(parseQuestions('{"questions":'), [])
  assert.deepEqual(parseQuestions('{"other":1}'), [])
  assert.equal(parseQuestions('{"questions":[{"question":"q"}]}').length, 1)
})

test('renderQuestions handles a question with no options', () => {
  const text = renderQuestions([{ question: '继续吗？' }])
  assert.match(text, /1\. 继续吗？/)
})

test('the router submits an idle session immediately', () => {
  const agent = fakeAgent('idle')
  const bridge = bridgeWith({ get: () => agent }).bridge
  const router = new ReplyRouter(bridge, { clock: () => new Date(0) })
  const reply = { replyId: 'r1', sessionId: 's', body: '继续' }
  assert.equal(router.route(reply, sessionState()), 'submitted')
  assert.equal(agent.followups.length, 1)
})

test('the router reports a running session distinctly but still submits', () => {
  const agent = fakeAgent('running')
  const bridge = bridgeWith({ get: () => agent }).bridge
  const router = new ReplyRouter(bridge, { clock: () => new Date(0) })
  const reply = { replyId: 'r1', sessionId: 's', body: '继续' }
  assert.equal(router.route(reply, sessionState({ running: true })), 'submitted_running')
  assert.equal(agent.followups.length, 1)
})

test('the router never submits while an approval is pending', () => {
  const agent = fakeAgent('running')
  const bridge = bridgeWith({ get: () => agent }).bridge
  const router = new ReplyRouter(bridge, { clock: () => new Date(0) })
  const reply = { replyId: 'r1', sessionId: 's', body: '继续' }
  assert.equal(router.route(reply, sessionState({ waitingApproval: true })), 'queued_approval')
  assert.equal(agent.followups.length, 0)
  assert.equal(router.queue.length, 1)
})

test('the router queues for a paused bridge, a missing session and a rate limit', () => {
  const agent = fakeAgent('idle')
  const bridge = bridgeWith({ get: () => agent }).bridge

  const paused = new ReplyRouter(bridge, { clock: () => new Date(0) })
  paused.setPaused(true)
  assert.equal(paused.route({ replyId: 'r', sessionId: 's', body: 'x' }, sessionState()), 'paused')

  const missing = new ReplyRouter(bridge, { clock: () => new Date(0) })
  assert.equal(missing.route({ replyId: 'r', sessionId: 's', body: 'x' }, sessionState({ exists: false })), 'queued_missing_session')

  const limited = new ReplyRouter(bridge, { maxRepliesPerMinute: 1, clock: () => new Date(0) })
  assert.equal(limited.route({ replyId: 'r1', sessionId: 's', body: 'x' }, sessionState()), 'submitted')
  assert.equal(limited.route({ replyId: 'r2', sessionId: 's', body: 'y' }, sessionState()), 'rate_limited')
  assert.equal(limited.queue.length, 1)
})

test('the router queues everything when the bridge is disconnected', () => {
  const bridge = bridgeWith(null).bridge
  const router = new ReplyRouter(bridge, { clock: () => new Date(0) })
  assert.equal(router.route({ replyId: 'r', sessionId: 's', body: 'x' }, sessionState()), 'paused')
})

test('flush retries queued replies and keeps the ones still unroutable', () => {
  const agent = fakeAgent('idle')
  const agents = { get: (id) => (id === 'live' ? agent : undefined) }
  const bridge = bridgeWith(agents).bridge
  const router = new ReplyRouter(bridge, { clock: () => new Date(0) })
  router.queue.push({ replyId: 'r1', sessionId: 'live', body: 'a' })
  router.queue.push({ replyId: 'r2', sessionId: 'gone', body: 'b' })

  const results = router.flush((sessionId) =>
    sessionId === 'live' ? sessionState() : sessionState({ exists: false }),
  )
  assert.deepEqual(results, ['submitted'])
  assert.equal(router.queue.length, 1)
  assert.equal(router.queue[0].replyId, 'r2')
})
