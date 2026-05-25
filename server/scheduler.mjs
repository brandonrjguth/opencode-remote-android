import crypto from "node:crypto"
import { mkdir } from "node:fs/promises"
import {
  getTask,
  listTasks,
  updateTask,
  setTaskRunning,
  addRun,
  updateRun
} from "./task-store.mjs"
import { resolveManagedDirectory } from "./config.mjs"
import { buildScheduledPrompt, installScheduledSearchTool } from "./research.mjs"

let timerHandle = null
let getConfig = null

function computeNextRun(task, after = null) {
  if (!task.enabled) return null
  if (!task.scheduledTime) return null

  const base = after ? new Date(after) : new Date()
  const [hours, minutes] = task.scheduledTime.split(":").map(Number)
  if (isNaN(hours) || isNaN(minutes)) return null

  const candidate = new Date(base)
  candidate.setHours(hours, minutes, 0, 0)

  if (task.repeat === "daily") {
    if (candidate.getTime() <= base.getTime()) {
      candidate.setDate(candidate.getDate() + 1)
    }
    return candidate.getTime()
  }

  if (task.repeat === "weekly") {
    const target = task.dayOfWeek ?? candidate.getDay()
    let diff = target - candidate.getDay()
    if (diff < 0) diff += 7
    if (diff === 0 && candidate.getTime() <= base.getTime()) {
      diff = 7
    }
    candidate.setDate(candidate.getDate() + diff)
    return candidate.getTime()
  }

  if (task.repeat === "monthly") {
    const targetDay = task.dayOfMonth ?? candidate.getDate()
    candidate.setDate(targetDay)
    if (candidate.getTime() <= base.getTime()) {
      candidate.setMonth(candidate.getMonth() + 1)
      candidate.setDate(targetDay)
    }
    return candidate.getTime()
  }

  if (candidate.getTime() <= base.getTime()) return null
  return candidate.getTime()
}

export function initScheduler(configFn) {
  getConfig = configFn
  scheduleNextTick()
}

export async function recomputeSchedule() {
  const tasks = await listTasks()
  for (const task of tasks) {
    const next = computeNextRun(task)
    if (next !== task.nextRunAt) {
      await updateTask(task.id, { nextRunAt: next })
    }
  }
  scheduleNextTick()
}

async function scheduleNextTick() {
  if (timerHandle !== null) {
    clearTimeout(timerHandle)
    timerHandle = null
  }

  const tasks = await listTasks()
  const pending = tasks.filter((t) => t.enabled && !t.running && t.nextRunAt)

  if (pending.length === 0) return

  const nearest = pending.reduce((a, b) =>
    a.nextRunAt < b.nextRunAt ? a : b
  )

  const delay = nearest.nextRunAt - Date.now()
  if (delay <= 0) {
    executeTask(nearest.id).catch(() => undefined)
    return
  }

  timerHandle = setTimeout(() => {
    timerHandle = null
    executeTask(nearest.id).catch(() => undefined)
  }, delay)

  timerHandle.unref?.()
}

async function pollUntilComplete(config, sessionID, maxWaitMs = 600_000) {
  const deadline = Date.now() + maxWaitMs
  const interval = 3000

  while (Date.now() < deadline) {
    await sleep(interval)

    let statusRes
    try {
      const url = new URL(`/session/status`, config.upstreamUrl)
      statusRes = await fetch(url, {
        headers: buildUpstreamAuth(config)
      })
    } catch {
      continue
    }

    if (!statusRes.ok) continue
    const statuses = await statusRes.json()
    const entry = Array.isArray(statuses)
      ? statuses.find((e) => e.sessionID === sessionID || e.sessionId === sessionID || e.id === sessionID)
      : null

    const statusType = entry
      ? normalizeStatus(entry.status ?? entry)
      : "idle"

    if (statusType === "idle") {
      return true
    }
  }

  return false
}

function normalizeStatus(value) {
  if (typeof value === "string") {
    const t = value.trim().toLowerCase()
    if (["running", "working", "in_progress", "active", "pending", "queued"].includes(t)) return "busy"
    if (["retrying", "error", "failed"].includes(t)) return "retry"
    return "idle"
  }
  if (value && typeof value === "object") {
    const raw = value
    return normalizeStatus(raw.type ?? raw.status ?? raw.state ?? "idle")
  }
  return "idle"
}

function buildUpstreamAuth(config) {
  const headers = new Headers()
  headers.set("Accept", "application/json")
  if (config.upstreamUsername || config.upstreamPassword) {
    const basic = Buffer.from(`${config.upstreamUsername}:${config.upstreamPassword}`).toString("base64")
    headers.set("Authorization", `Basic ${basic}`)
  }
  return headers
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function executeTask(taskID) {
  const task = await getTask(taskID)
  if (!task || !task.enabled) return

  const config = await getConfig()
  const rootDir = config.rootDir
  if (!rootDir) return

  const directory = resolveManagedDirectory(rootDir, task.folder || "")
  await mkdir(directory, { recursive: true })

  await setTaskRunning(taskID, true)
  const runID = crypto.randomUUID()
  const run = {
    id: runID,
    taskID,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    prompt: task.prompt,
    model: task.model,
    variant: task.variant,
    folder: task.folder,
    responseText: null,
    error: null
  }
  await addRun(run)

  try {
    await installScheduledSearchTool(directory, task, config)
    const finalPrompt = buildScheduledPrompt(task)

    const sessionUrl = new URL("/session", config.upstreamUrl)
    sessionUrl.searchParams.set("directory", directory)

    const sessionBody = {
      title: `[cron] ${task.title}`,
      model: task.model
        ? {
            id: task.model.modelID,
            providerID: task.model.providerID,
            ...(task.variant ? { variant: task.variant } : {})
          }
        : undefined
    }

    const createRes = await fetch(sessionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...Object.fromEntries(buildUpstreamAuth(config).entries())
      },
      body: JSON.stringify(sessionBody)
    })

    if (!createRes.ok) {
      const errText = await createRes.text()
      throw new Error(`Create session failed (${createRes.status}): ${errText}`)
    }

    const session = await createRes.json()
    const sessionID = session.id

    const promptBody = {
      parts: [{ type: "text", text: finalPrompt }],
      ...(task.model ? { model: { providerID: task.model.providerID, modelID: task.model.modelID } } : {}),
      ...(task.variant ? { variant: task.variant } : {})
    }

    const promptUrl = new URL(`/session/${sessionID}/message`, config.upstreamUrl)
    promptUrl.searchParams.set("directory", directory)

    const promptRes = await fetch(promptUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...Object.fromEntries(buildUpstreamAuth(config).entries())
      },
      body: JSON.stringify(promptBody)
    })

    if (!promptRes.ok) {
      const errText = await promptRes.text()
      throw new Error(`Send prompt failed (${promptRes.status}): ${errText}`)
    }

    await pollUntilComplete(config, sessionID)

    const msgUrl = new URL(`/session/${sessionID}/message`, config.upstreamUrl)
    msgUrl.searchParams.set("limit", "50")
    msgUrl.searchParams.set("directory", directory)

    const msgRes = await fetch(msgUrl, {
      headers: buildUpstreamAuth(config)
    })

    let responseText = ""
    if (msgRes.ok) {
      const messages = await msgRes.json()
      const assistantMessages = (Array.isArray(messages) ? messages : [])
        .filter((m) => m.info?.role === "assistant" && m.info?.time?.completed)
        .sort((a, b) => (b.info?.time?.created ?? 0) - (a.info?.time?.created ?? 0))

      for (const msg of assistantMessages) {
        const text = (msg.parts ?? [])
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n")
          .trim()
        if (text) {
          responseText = text
          break
        }
      }
    }

    await updateRun(taskID, runID, {
      finishedAt: Date.now(),
      status: "completed",
      responseText: responseText || "(no text response)"
    })

    try {
      const delUrl = new URL(`/session/${sessionID}`, config.upstreamUrl)
      delUrl.searchParams.set("directory", directory)
      await fetch(delUrl, {
        method: "DELETE",
        headers: buildUpstreamAuth(config)
      })
    } catch {
      // best effort
    }
  } catch (err) {
    await updateRun(taskID, runID, {
      finishedAt: Date.now(),
      status: "error",
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    await setTaskRunning(taskID, false)
    const next = computeNextRun(task)
    await updateTask(taskID, { nextRunAt: next })
    scheduleNextTick()
  }
}

export async function runTaskNow(taskID) {
  const task = await getTask(taskID)
  if (!task) throw new Error("Task not found")
  if (task.running) throw new Error("Task is already running")
  return executeTask(taskID)
}

export async function recoverMissedTasks() {
  const tasks = await listTasks()
  const now = Date.now()

  for (const task of tasks) {
    if (!task.enabled || task.running) continue
    if (!task.nextRunAt || task.nextRunAt > now) continue

    if (task.repeat === "once") {
      if (task.lastRunAt == null) {
        await executeTask(task.id)
        return
      }
      await updateTask(task.id, { nextRunAt: null })
      continue
    }

    await executeTask(task.id)
    return
  }

  await recomputeSchedule()
}
