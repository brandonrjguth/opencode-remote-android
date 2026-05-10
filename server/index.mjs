import { createServer } from "node:http"
import { mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { readRuntimeConfig, resolveManagedDirectory, updateStoredConfig } from "./config.mjs"

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
    json(res, 200, { rootDir: config.rootDir })
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
  json(res, 200, {
    rootDir: config.rootDir,
    folders: await listFolders(config.rootDir)
  })
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

async function requestHandler(req, res) {
  const config = await readRuntimeConfig()
  const needsAuth = Boolean(config.clientPassword)
  if (needsAuth) {
    const auth = parseBasicAuth(req.headers.authorization)
    if (!auth || auth.username !== config.clientUsername || auth.password !== config.clientPassword) {
      unauthorized(res)
      return
    }
  }

  try {
    const url = new URL(req.url ?? "/", "http://local")

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
})
