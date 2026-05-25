import { createServer } from "node:http"
import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { readRuntimeConfig, resolveManagedDirectory, updateStoredConfig } from "./config.mjs"
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  listRuns
} from "./task-store.mjs"
import {
  initScheduler,
  recomputeSchedule,
  runTaskNow,
  recoverMissedTasks
} from "./scheduler.mjs"
import { searchWeb } from "./research.mjs"
import {
  discoverSessions as dbDiscoverSessions,
  loadSessionMessages as dbLoadMessages,
  loadMessageParts as dbLoadParts,
  loadSessionTodos as dbLoadTodos,
  getAllSessions as dbGetAllSessions
} from "./session-db.mjs"

function parseArgs(argv) {
  let hostname = process.env.OPENCODE_REMOTE_HOSTNAME ?? "0.0.0.0"
  let port = Number(process.env.OPENCODE_REMOTE_PORT ?? 4097)

  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--hostname") hostname = argv[index + 1] ?? hostname
    if (argv[index] === "--port") port = Number(argv[index + 1] ?? port)
  }

  return { hostname, port }
}

function json(res, status, body) {
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  })
  res.end(payload)
}

function unauthorized(res) {
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="OpenCode Remote"' })
  res.end("Unauthorized")
}

function parseBasicAuth(header) {
  if (!header?.startsWith("Basic ")) return null
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  if (separator === -1) return null
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1)
  }
}

function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function listFolders(rootDir) {
  if (!rootDir) return []
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function buildUpstreamHeaders(clientHeaders, config, body) {
  const headers = new Headers()
  const contentType = clientHeaders["content-type"]
  const accept = clientHeaders.accept
  if (contentType) headers.set("Content-Type", contentType)
  if (accept) headers.set("Accept", accept)
  if (body.length > 0) headers.set("Content-Length", String(body.length))
  if (config.upstreamUsername || config.upstreamPassword) {
    const basic = Buffer.from(`${config.upstreamUsername}:${config.upstreamPassword}`).toString("base64")
    headers.set("Authorization", `Basic ${basic}`)
  }
  return headers
}

async function proxyToUpstream(req, res, config, override) {
  const body = req.method === "GET" || req.method === "DELETE" ? Buffer.alloc(0) : await readBody(req)
  const target = override?.url ?? new URL(req.url ?? "/", config.upstreamUrl)
  const response = await fetch(target, {
    method: override?.method ?? req.method,
    headers: buildUpstreamHeaders(req.headers, config, body),
    body: body.length > 0 ? body : undefined
  })

  const responseBody = Buffer.from(await response.arrayBuffer())
  const headers = {}
  const contentType = response.headers.get("content-type")
  if (contentType) headers["Content-Type"] = contentType
  res.writeHead(response.status, headers)
  res.end(responseBody)
}

async function handleRemoteConfig(req, res, config) {
  if (req.method === "GET") {
    json(res, 200, { rootDir: config.rootDir, researchProviders: config.researchProviders })
    return
  }

  if (req.method === "PATCH") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
    if (typeof body.rootDir !== "string") {
      json(res, 400, { message: "rootDir must be a string" })
      return
    }
    const updated = await updateStoredConfig({ rootDir: body.rootDir })
    json(res, 200, { rootDir: updated.rootDir ?? "" })
    return
  }

  json(res, 405, { message: "Method not allowed" })
}

async function handleRemoteFolder(req, res, config) {
  if (!config.rootDir) {
    json(res, 200, { rootDir: "", folders: [] })
    return
  }
  const url = new URL(req.url ?? "/", "http://local")
  const subdir = url.searchParams.get("subdir") ?? ""
  const base = resolveManagedDirectory(config.rootDir, subdir)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
  json(res, 200, {
    rootDir: config.rootDir,
    folders
  })
}

async function handleRemoteWebSearch(req, res, config) {
  if (req.method !== "POST") {
    json(res, 405, { message: "Method not allowed" })
    return
  }

  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
  const results = await searchWeb({
    provider: typeof body.provider === "string" ? body.provider : undefined,
    query: typeof body.query === "string" ? body.query : "",
    count: body.count
  }, config)

  json(res, 200, { results })
}

async function handleRemoteSession(req, res, config) {
  if (req.method !== "POST") {
    json(res, 405, { message: "Method not allowed" })
    return
  }

  const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
  const directory = resolveManagedDirectory(config.rootDir, typeof body.folder === "string" ? body.folder : "")
  await mkdir(directory, { recursive: true })

  const upstream = new URL("/session", config.upstreamUrl)
  upstream.searchParams.set("directory", directory)
  const upstreamBody = {
    title: typeof body.title === "string" ? body.title : undefined,
    agent: typeof body.agent === "string" ? body.agent : undefined,
    model: body.model
      ? {
          id: body.model.modelID,
          providerID: body.model.providerID,
          ...(body.model.variant ? { variant: body.model.variant } : {})
        }
      : undefined
  }

  const fakeRequest = {
    ...req,
    method: "POST",
    headers: {
      ...req.headers,
      "content-type": "application/json"
    }
  }
  const bodyBuffer = Buffer.from(JSON.stringify(upstreamBody))

  const response = await fetch(upstream, {
    method: "POST",
    headers: buildUpstreamHeaders(fakeRequest.headers, config, bodyBuffer),
    body: bodyBuffer
  })
  const responseBody = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get("content-type") ?? "application/json"
  res.writeHead(response.status, { "Content-Type": contentType })
  res.end(responseBody)
}

async function handleDiscoverSessions(req, res, config) {
  if (req.method !== "GET") {
    json(res, 405, { message: "Method not allowed" })
    return
  }
  const url = new URL(req.url ?? "/", "http://local")
  const folder = url.searchParams.get("folder") ?? ""
  try {
    const sessions = dbDiscoverSessions(config.rootDir, folder)
    json(res, 200, sessions)
  } catch (err) {
    json(res, 200, [])
  }
}

async function handleSessionMessages(req, res, config, sessionID) {
  if (req.method !== "GET") {
    json(res, 405, { message: "Method not allowed" })
    return
  }
  try {
    const messages = dbLoadMessages(sessionID)
    const partsByMessage = dbLoadParts(sessionID)
    const envelopes = messages.map((msg) => ({
      ...msg,
      parts: partsByMessage[msg.info.id] || []
    }))
    json(res, 200, envelopes)
  } catch (err) {
    json(res, 200, [])
  }
}

async function handleSessionTodos(req, res, config, sessionID) {
  if (req.method !== "GET") {
    json(res, 405, { message: "Method not allowed" })
    return
  }
  try {
    const todos = dbLoadTodos(sessionID)
    json(res, 200, todos)
  } catch (err) {
    json(res, 200, [])
  }
}

async function handleRemoteTasks(req, res, config, url) {
  const match = url.pathname.match(/^\/remote\/tasks\/([\w-]+)(\/history)?$/)

  if (match) {
    const taskID = match[1]
    const isHistory = Boolean(match[2])

    if (isHistory) {
      if (req.method !== "GET") {
        json(res, 405, { message: "Method not allowed" })
        return
      }
      const runs = await listRuns(taskID)
      json(res, 200, runs)
      return
    }

    if (req.method === "GET") {
      const task = await getTask(taskID)
      if (!task) { json(res, 404, { message: "Task not found" }); return }
      json(res, 200, task)
      return
    }

    if (req.method === "PATCH") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      const updated = await updateTask(taskID, body)
      if (!updated) { json(res, 404, { message: "Task not found" }); return }
      recomputeSchedule().catch(() => undefined)
      json(res, 200, updated)
      return
    }

    if (req.method === "DELETE") {
      const deleted = await deleteTask(taskID)
      if (!deleted) { json(res, 404, { message: "Task not found" }); return }
      recomputeSchedule().catch(() => undefined)
      json(res, 200, { ok: true })
      return
    }

    json(res, 405, { message: "Method not allowed" })
    return
  }

  if (url.pathname.match(/^\/remote\/tasks\/([\w-]+)\/run$/)) {
    const taskID = url.pathname.split("/")[3]
    if (req.method !== "POST") {
      json(res, 405, { message: "Method not allowed" })
      return
    }
    try {
      runTaskNow(taskID).catch(() => undefined)
      json(res, 200, { ok: true, message: "Task started" })
    } catch (err) {
      json(res, 400, { message: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (url.pathname === "/remote/tasks") {
    if (req.method === "GET") {
      const tasks = await listTasks()
      json(res, 200, tasks)
      return
    }

    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}")
      const task = await createTask(body)
      recomputeSchedule().catch(() => undefined)
      json(res, 201, task)
      return
    }

    json(res, 405, { message: "Method not allowed" })
    return
  }
}

async function requestHandler(req, res) {
  const config = await readRuntimeConfig()
  const url = new URL(req.url ?? "/", "http://local")
  const localToolRequest = url.pathname === "/remote/tools/web-search" && isLoopbackRequest(req)
  const needsAuth = Boolean(config.clientPassword)
  if (needsAuth && !localToolRequest) {
    const auth = parseBasicAuth(req.headers.authorization)
    if (!auth || auth.username !== config.clientUsername || auth.password !== config.clientPassword) {
      unauthorized(res)
      return
    }
  }

  try {
    if (url.pathname === "/remote/config") {
      await handleRemoteConfig(req, res, config)
      return
    }

    if (url.pathname === "/remote/folder") {
      await handleRemoteFolder(req, res, config)
      return
    }

    if (url.pathname === "/remote/session") {
      await handleRemoteSession(req, res, config)
      return
    }

    if (url.pathname === "/remote/tools/web-search") {
      await handleRemoteWebSearch(req, res, config)
      return
    }

    if (url.pathname.startsWith("/remote/tasks")) {
      await handleRemoteTasks(req, res, config, url)
      return
    }

    if (url.pathname === "/remote/discover-sessions") {
      await handleDiscoverSessions(req, res, config)
      return
    }

    const msgMatch = url.pathname.match(/^\/remote\/session\/([\w-]+)\/message$/)
    if (msgMatch) {
      await handleSessionMessages(req, res, config, msgMatch[1])
      return
    }

    const todoMatch = url.pathname.match(/^\/remote\/session\/([\w-]+)\/todo$/)
    if (todoMatch) {
      await handleSessionTodos(req, res, config, todoMatch[1])
      return
    }

    await proxyToUpstream(req, res, config)
  } catch (error) {
    json(res, 500, {
      message: error instanceof Error ? error.message : "Unexpected server error"
    })
  }
}

const { hostname, port } = parseArgs(process.argv)
const server = createServer((req, res) => {
  requestHandler(req, res).catch((error) => {
    json(res, 500, { message: error instanceof Error ? error.message : "Unexpected server error" })
  })
})

server.listen(port, hostname, () => {
  process.stdout.write(`OpenCode Remote wrapper listening on http://${hostname}:${port}\n`)
  initScheduler(readRuntimeConfig)
  recoverMissedTasks().catch(() => undefined)
})
