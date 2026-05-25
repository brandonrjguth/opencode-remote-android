import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { getConfigPath } from "./config.mjs"

function getStorePath() {
  const configDir = path.dirname(getConfigPath())
  return path.resolve(configDir, "..", ".runtime", "scheduled-tasks.json")
}

function generateID() {
  return crypto.randomUUID()
}

function normalizeTask(task) {
  return {
    ...task,
    liveWebResearch: task.liveWebResearch === true,
    searchProvider: task.searchProvider ?? null,
    searchQuery: task.searchQuery || ""
  }
}

async function readStore() {
  try {
    const raw = await readFile(getStorePath(), "utf8")
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || !parsed) return { tasks: [], runs: [] }
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeTask) : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : []
    }
  } catch {
    return { tasks: [], runs: [] }
  }
}

async function writeStore(store) {
  const filePath = getStorePath()
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmpPath = filePath + ".tmp"
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8")
  await rename(tmpPath, filePath)
}

export async function listTasks() {
  const store = await readStore()
  return store.tasks
}

export async function getTask(taskID) {
  const store = await readStore()
  return store.tasks.find((t) => t.id === taskID) ?? null
}

export async function createTask(draft) {
  const store = await readStore()
  const task = {
    id: generateID(),
    title: draft.title || "Untitled task",
    prompt: draft.prompt || "",
    folder: draft.folder || "",
    repeat: draft.repeat || "once",
    scheduledTime: draft.scheduledTime ?? null,
    dayOfWeek: draft.dayOfWeek ?? null,
    dayOfMonth: draft.dayOfMonth ?? null,
    model: draft.model ?? null,
    variant: draft.variant ?? null,
    liveWebResearch: draft.liveWebResearch === true,
    searchProvider: draft.searchProvider ?? null,
    searchQuery: draft.searchQuery || "",
    enabled: draft.enabled !== false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastRunAt: null,
    nextRunAt: null,
    running: false
  }
  store.tasks.push(task)
  await writeStore(store)
  return task
}

export async function updateTask(taskID, patch) {
  const store = await readStore()
  const index = store.tasks.findIndex((t) => t.id === taskID)
  if (index === -1) return null
  const task = store.tasks[index]
  const updated = {
    ...task,
    ...patch,
    id: task.id,
    createdAt: task.createdAt,
    updatedAt: Date.now(),
    running: task.running
  }
  store.tasks[index] = updated
  await writeStore(store)
  return updated
}

export async function deleteTask(taskID) {
  const store = await readStore()
  const taskIndex = store.tasks.findIndex((t) => t.id === taskID)
  if (taskIndex === -1) return false
  store.tasks.splice(taskIndex, 1)
  store.runs = store.runs.filter((r) => r.taskID !== taskID)
  await writeStore(store)
  return true
}

export async function setTaskRunning(taskID, running) {
  const store = await readStore()
  const index = store.tasks.findIndex((t) => t.id === taskID)
  if (index === -1) return null
  store.tasks[index].running = running
  if (!running) store.tasks[index].updatedAt = Date.now()
  await writeStore(store)
  return store.tasks[index]
}

export async function addRun(run) {
  const store = await readStore()
  store.runs.push(run)
  const taskIndex = store.tasks.findIndex((t) => t.id === run.taskID)
  if (taskIndex !== -1) {
    store.tasks[taskIndex].lastRunAt = run.startedAt
    store.tasks[taskIndex].updatedAt = Date.now()
  }
  await writeStore(store)
  return run
}

export async function updateRun(taskID, runID, patch) {
  const store = await readStore()
  const index = store.runs.findIndex((r) => r.taskID === taskID && r.id === runID)
  if (index === -1) return null
  store.runs[index] = { ...store.runs[index], ...patch }
  await writeStore(store)
  return store.runs[index]
}

export async function listRuns(taskID) {
  const store = await readStore()
  return store.runs
    .filter((r) => r.taskID === taskID)
    .sort((a, b) => b.startedAt - a.startedAt)
}

export async function getLatestRun(taskID) {
  const store = await readStore()
  const runs = store.runs.filter((r) => r.taskID === taskID)
  if (runs.length === 0) return null
  return runs.reduce((a, b) => (a.startedAt > b.startedAt ? a : b))
}
