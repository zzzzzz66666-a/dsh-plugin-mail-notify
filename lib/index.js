/**
 * Host half of `dsh-plugin-mail-notify`.
 *
 * The plugin emails a summary when a harness turn ends, and routes a verified
 * reply from that mail back into the same session. It is the harness-native
 * port of the Codex mail notification component: same queue, same one-time
 * code, same reply gate, same refusal to approve anything by mail.
 *
 * ## Why nothing is imported from `@deepseek-ai/*`
 *
 * A third-party plugin is installed into a profile as a `link:` dependency, so
 * it lives outside the profile's `node_modules` and the harness's own packages
 * are not resolvable from it. Every service is therefore reached through the
 * Cordis context. The same reason is why service availability is probed with
 * `ctx.get(...)` and awaited with `ctx.inject(...)` instead of a static
 * `inject` list: a composition without the agent registry must still load, and
 * simply report that continuation is unavailable.
 *
 * @module dsh-plugin-mail-notify
 */

import { HarnessBridge } from './bridge.js'
import { MailNotifyService } from './service.js'

/** Package identity, mirrored from `package.json`. */
export const PLUGIN_NAME = 'dsh-plugin-mail-notify'

/** The credential reference the authorization code is stored under. */
export const AUTH_CODE_REF = 'DSH_MAIL_NOTIFY_AUTH_CODE'

/**
 * Host plugin body.
 *
 * @param {object} ctx - Cordis context for this plugin's fiber.
 * @param {object} config - the row's `config` from the profile patch.
 */
export function apply(ctx, config = {}) {
  const logger = safeLogger(ctx)

  // The service is assigned before any event can be delivered, because the
  // bridge's callback closes over this binding rather than a snapshot value.
  let service = null

  const bridge = new HarnessBridge({
    ctx,
    logger,
    onTask: (task) => service?.handleTask(task),
  })

  const guard = (label, run) => {
    try {
      run()
    } catch (error) {
      // A listener that throws would be reported against the emitting session's
      // fiber; the harness must not fail because a notification could not be
      // prepared.
      logger?.warn?.(`mail-notify ${label} failed: ${error?.message ?? error}`)
    }
  }

  // `session/created` also fires for a resumed or forked session, and seed
  // events are not re-published on `session/event` — so this is the only place
  // where already-finished history can be recognised and left un-emailed.
  ctx.on('session/created', (session) => guard('session/created', () => bridge.indexSession(session)))
  ctx.on('session/event', (session, event) => guard('session/event', () => bridge.handleSessionEvent(session, event)))
  ctx.on('session/disposed', (session) => guard('session/disposed', () => bridge.forget(session?.id)))

  service = new MailNotifyService({ ctx, config, bridge, logger })

  // Every listener above is scoped to this fiber, which Cordis disposes with
  // the row. The timer is not, so it is released explicitly.
  ctx.effect(() => () => {
    void service.stop()
  }, 'mail-notify.lifecycle()')

  void service.start().catch((error) => {
    logger?.error?.(`mail-notify failed to start: ${error?.message ?? error}`)
  })

  return service
}

/**
 * Resolve a usable logger without requiring one.
 *
 * Cordis exposes `ctx.logger`; a plugin loaded in a bare test context does not
 * have it, and losing log lines must never be the reason a plugin fails.
 */
function safeLogger(ctx) {
  try {
    return ctx?.logger ?? null
  } catch {
    return null
  }
}
