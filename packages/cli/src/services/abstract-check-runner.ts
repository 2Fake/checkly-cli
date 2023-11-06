import { assets, testSessions } from '../rest/api'
import { SocketClient } from './socket-client'
import PQueue from 'p-queue'
import * as uuid from 'uuid'
import { EventEmitter } from 'node:events'
import type { AsyncMqttClient } from 'async-mqtt'
import type { Region } from '..'
import { TestResultsShortLinks } from '../rest/test-sessions'

// eslint-disable-next-line no-restricted-syntax
export enum Events {
  CHECK_REGISTERED = 'CHECK_REGISTERED',
  CHECK_INPROGRESS = 'CHECK_INPROGRESS',
  CHECK_FAILED = 'CHECK_FAILED',
  CHECK_SUCCESSFUL = 'CHECK_SUCCESSFUL',
  CHECK_FINISHED = 'CHECK_FINISHED',
  RUN_STARTED = 'RUN_STARTED',
  RUN_FINISHED = 'RUN_FINISHED',
  ERROR = 'ERROR',
  MAX_SCHEDULING_DELAY_EXCEEDED = 'MAX_SCHEDULING_DELAY_EXCEEDED'
}

export type PrivateRunLocation = {
  type: 'PRIVATE',
  id: string,
  slugName: string,
}
export type PublicRunLocation = {
  type: 'PUBLIC',
  region: keyof Region,
}
export type RunLocation = PublicRunLocation | PrivateRunLocation

export type CheckRunId = string

export const DEFAULT_CHECK_RUN_TIMEOUT_SECONDS = 300

const DEFAULT_SCHEDULING_DELAY_EXCEEDED_MS = 20000

export default abstract class AbstractCheckRunner extends EventEmitter {
  checks: Map<CheckRunId, { check: any, testResultId?: string }>
  testSessionId?: string
  // If there's an error in the backend and no check result is sent, the check run could block indefinitely.
  // To avoid this case, we set a per-check timeout.
  timeouts: Map<CheckRunId, NodeJS.Timeout>
  schedulingDelayExceededTimeout?: NodeJS.Timeout
  accountId: string
  timeout: number
  verbose: boolean
  queue: PQueue

  constructor (
    accountId: string,
    timeout: number,
    verbose: boolean,
  ) {
    super()
    this.checks = new Map()
    this.timeouts = new Map()
    this.queue = new PQueue({ autoStart: false, concurrency: 1 })
    this.timeout = timeout
    this.verbose = verbose
    this.accountId = accountId
  }

  abstract scheduleChecks (checkRunSuiteId: string):
    Promise<{
      testSessionId?: string,
      checks: Array<{ check: any, checkRunId: CheckRunId, testResultId?: string }>,
    }>

  async run () {
    let socketClient = null
    try {
      socketClient = await SocketClient.connect()

      const checkRunSuiteId = uuid.v4()
      // Configure the socket listener and allChecksFinished listener before starting checks to avoid race conditions
      await this.configureResultListener(checkRunSuiteId, socketClient)

      const { testSessionId, checks } = await this.scheduleChecks(checkRunSuiteId)
      this.testSessionId = testSessionId
      this.checks = new Map(
        checks.map(({ check, checkRunId, testResultId }) => [checkRunId, { check, testResultId }]),
      )

      // `processMessage()` assumes that `this.timeouts` always has an entry for non-timed-out checks.
      // To ensure that this is the case, we call `setAllTimeouts()` before `queue.start()`.
      // Otherwise, we risk a race condition where check results are received before the timeout is set.
      // This would cause `processMessage()` to mistakenly skip check results and consider the checks timed-out.
      this.setAllTimeouts()
      // Add timeout to fire an event after DEFAULT_SCHEDULING_DELAY_EXCEEDED_MS to let reporters know it's time
      // to display a hint messages if some checks are still being scheduled.
      this.startSchedulingDelayTimeout()
      // `allChecksFinished` should be started before processing check results in `queue.start()`.
      // Otherwise, there could be a race condition causing check results to be missed by `allChecksFinished()`.
      const allChecksFinished = this.allChecksFinished()
      /// / Need to structure the checks depending on how it went
      this.emit(Events.RUN_STARTED, checks, testSessionId)
      // Start the queue after the test session run rest call is completed to avoid race conditions
      this.queue.start()

      await allChecksFinished
      this.emit(Events.RUN_FINISHED, testSessionId)
    } catch (err) {
      this.disableAllTimeouts()
      this.emit(Events.ERROR, err)
    } finally {
      if (socketClient) {
        await socketClient.end()
      }
    }
  }

  private async configureResultListener (checkRunSuiteId: string, socketClient: AsyncMqttClient): Promise<void> {
    socketClient.on('message', (topic: string, rawMessage: string|Buffer) => {
      const message = JSON.parse(rawMessage.toString('utf8'))
      const topicComponents = topic.split('/')
      const checkRunId = topicComponents[4]
      const subtopic = topicComponents[5]

      this.queue.add(() => this.processMessage(checkRunId, subtopic, message))
    })
    await socketClient.subscribe(`account/${this.accountId}/ad-hoc-check-results/${checkRunSuiteId}/+/+`)
  }

  private async processMessage (checkRunId: string, subtopic: string, message: any) {
    if (!this.timeouts.has(checkRunId)) {
      // The check has already timed out. We return early to avoid reporting a duplicate result.
      return
    }

    if (!this.checks.get(checkRunId)) {
      // The check has no checkRunId associated.
      return
    }

    const { check, testResultId } = this.checks.get(checkRunId)!
    if (subtopic === 'run-start') {
      this.emit(Events.CHECK_INPROGRESS, check, checkRunId)
    } else if (subtopic === 'run-end') {
      this.disableTimeout(checkRunId)
      const { result } = message
      await this.processCheckResult(result)
      const links = testResultId && result.hasFailures && await this.getShortLinks(testResultId)
      this.emit(Events.CHECK_SUCCESSFUL, checkRunId, check, result, links)
      this.emit(Events.CHECK_FINISHED, check)
    } else if (subtopic === 'error') {
      this.disableTimeout(checkRunId)
      this.emit(Events.CHECK_FAILED, checkRunId, check, message)
      this.emit(Events.CHECK_FINISHED, check)
    }
  }

  async processCheckResult (result: any) {
    const {
      region,
      logPath,
      checkRunDataPath,
    } = result.assets
    if (logPath && (this.verbose || result.hasFailures)) {
      result.logs = await assets.getLogs(region, logPath)
    }
    if (checkRunDataPath && (this.verbose || result.hasFailures)) {
      result.checkRunData = await assets.getCheckRunData(region, checkRunDataPath)
    }
  }

  private allChecksFinished (): Promise<void> {
    let finishedCheckCount = 0
    const numChecks = this.checks.size
    if (numChecks === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.on(Events.CHECK_FINISHED, () => {
        finishedCheckCount++
        if (finishedCheckCount === numChecks) resolve()
      })
    })
  }

  private setAllTimeouts () {
    Array.from(this.checks.entries()).forEach(([checkRunId, { check }]) =>
      this.timeouts.set(checkRunId, setTimeout(() => {
        this.timeouts.delete(checkRunId)
        let errorMessage = `Reached timeout of ${this.timeout} seconds waiting for check result.`
        // Checkly should always report a result within 240s.
        // If the default timeout was used, we should point the user to the status page and support email.
        if (this.timeout === DEFAULT_CHECK_RUN_TIMEOUT_SECONDS) {
          errorMessage += ' Checkly may be experiencing problems. Please check https://is.checkly.online or reach out to support@checklyhq.com.'
        }
        this.emit(Events.CHECK_FAILED, checkRunId, check, errorMessage)
        this.emit(Events.CHECK_FINISHED, check)
      }, this.timeout * 1000),
      ))
  }

  private disableAllTimeouts () {
    if (!this.checks) {
      return
    }
    Array.from(this.checks.entries()).forEach(([checkRunId]) => this.disableTimeout(checkRunId))

    if (this.schedulingDelayExceededTimeout) {
      clearTimeout(this.schedulingDelayExceededTimeout)
      this.schedulingDelayExceededTimeout = undefined
    }
  }

  private startSchedulingDelayTimeout () {
    let scheduledCheckCount = 0
    const numChecks = this.checks.size
    if (numChecks === 0) {
      return
    }
    this.schedulingDelayExceededTimeout = setTimeout(
      () => {
        this.emit(Events.MAX_SCHEDULING_DELAY_EXCEEDED)
        this.schedulingDelayExceededTimeout = undefined
      },
      DEFAULT_SCHEDULING_DELAY_EXCEEDED_MS,
    )
    this.on(Events.CHECK_INPROGRESS, () => {
      scheduledCheckCount++
      if (scheduledCheckCount === numChecks) clearTimeout(this.schedulingDelayExceededTimeout)
    })
  }

  private disableTimeout (timeoutKey: string) {
    const timeout = this.timeouts.get(timeoutKey)
    clearTimeout(timeout)
    this.timeouts.delete(timeoutKey)
  }

  private async getShortLinks (testResultId: string): Promise<TestResultsShortLinks|undefined> {
    try {
      if (!this.testSessionId) {
        return
      }
      const { data: links } = await testSessions.getResultShortLinks(this.testSessionId, testResultId)
      return links
    } catch {
    }
  }
}
