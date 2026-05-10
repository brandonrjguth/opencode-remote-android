import { Capacitor, CapacitorHttp } from "@capacitor/core"
import type {
  CommandInfo,
  DiffFile,
  HealthResponse,
  MessageEnvelope,
  PermissionRequest,
  ServerConfig,
  Session,
  SessionStatus,
  TodoItem
} from "./types"

function authHeader(config: ServerConfig): string {
  return `Basic ${btoa(`${config.username}:${config.password}`)}`
}

function baseUrl(config: ServerConfig): string {
  return `http://${config.host}:${config.port}`
}

function withDirectory(path: string, directory?: string): string {
  if (!directory) return path
  const joiner = path.includes("?") ? "&" : "?"
  return `${path}${joiner}directory=${encodeURIComponent(directory)}`
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: unknown
}

function normalizeStatusType(value: unknown): string {
  if (typeof value !== "string") return "idle"
  const type = value.trim().toLowerCase()
  if (!type) return "idle"
  if (["running", "working", "in_progress", "in-progress", "active", "pending", "queued"].includes(type)) return "busy"
  if (["retrying", "error", "failed"].includes(type)) return "retry"
  if (["done", "complete", "completed", "success", "succeeded", "ready", "aborted", "cancelled", "canceled"].includes(type)) return "idle"
  return type
}

function toSessionStatus(value: unknown): SessionStatus | null {
  if (typeof value === "string") {
    return { type: normalizeStatusType(value) }
  }
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const rawType = raw.type ?? raw.status ?? raw.state
  if (!rawType) return null
  const attempt = typeof raw.attempt === "number" ? raw.attempt : undefined
  const message = typeof raw.message === "string" ? raw.message : undefined
  const next = typeof raw.next === "number" ? raw.next : undefined
  return {
    type: normalizeStatusType(rawType),
    attempt,
    message,
    next
  }
}

function parseStatusMap(value: unknown): Record<string, SessionStatus> {
  const map: Record<string, SessionStatus> = {}
  if (!value || typeof value !== "object") return map

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue
      const row = item as Record<string, unknown>
      const sessionID = row.sessionID ?? row.sessionId ?? row.id
      if (typeof sessionID !== "string" || !sessionID) continue
      const status = toSessionStatus(row.status ?? row)
      if (!status) continue
      map[sessionID] = status
    }
    return map
  }

  const payload = value as Record<string, unknown>
  const nested = payload.statuses ?? payload.data
  if (nested && nested !== value) {
    const nestedMap = parseStatusMap(nested)
    if (Object.keys(nestedMap).length > 0) {
      return nestedMap
    }
  }

  for (const [sessionID, rawStatus] of Object.entries(payload)) {
    const status = toSessionStatus(rawStatus)
    if (!status) continue
    map[sessionID] = status
  }

  return map
}

async function request<T>(config: ServerConfig, path: string, options: RequestOptions = {}): Promise<T> {
  const target = `${baseUrl(config)}${path}`

  const headers: Record<string, string> = {
    Accept: "application/json"
  }
  if (config.username && config.password) {
    headers.Authorization = authHeader(config)
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

  const method = options.method ?? "GET"

  if (Capacitor.isNativePlatform()) {
    let response: { status: number; data: unknown }
    try {
      response = await CapacitorHttp.request({
        url: target,
        method,
        headers,
        data: options.body,
        connectTimeout: 12_000,
        readTimeout: 30_000
      })
    } catch (raw) {
      const err = raw as { status?: number; data?: unknown; message?: string }
      if (err.status) {
        const body = err.data
        const detail =
          (typeof body === "object" && body && (body as { data?: { message?: string } }).data?.message) ||
          (typeof body === "object" && body && (body as { message?: string }).message) ||
          (typeof body === "string" && body) ||
          err.message ||
          ""
        throw new Error(detail || `HTTP ${err.status}`)
      }
      throw new Error(`Network error: cannot reach ${target}. Check host, port, and firewall.`)
    }

    if (response.status >= 400) {
      const body = response.data
      const detail =
        (typeof body === "object" && body && (body as { data?: { message?: string } }).data?.message) ||
        (typeof body === "object" && body && (body as { message?: string }).message) ||
        (typeof body === "string" && body) ||
        ""
      throw new Error(detail || `HTTP ${response.status}`)
    }

    if (response.status === 204) return true as T
    return response.data as T
  }

  let response: Response
  try {
    response = await fetch(target, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
  } catch {
    const corsHint = config.username && config.password
      ? " Browser mode + Basic Auth may be blocked by CORS preflight; use APK/native mode or disable auth temporarily for browser debugging."
      : ""
    throw new Error(
      `Network error: cannot reach ${target}. Check server hostname/port, Windows firewall, and CORS (--cors).${corsHint}`
    )
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      detail = body?.data?.message ?? body?.message ?? JSON.stringify(body)
    } catch {
      const text = await response.text()
      if (text) detail = text
    }
    throw new Error(detail)
  }

  if (response.status === 204) return true as T
  return (await response.json()) as T
}

export const api = {
  health(config: ServerConfig) {
    return request<HealthResponse>(config, "/global/health")
  },

  getConfig(config: ServerConfig) {
    return request<{ model?: string }>(config, "/config")
  },

  getRemoteConfig(config: ServerConfig) {
    return request<{ rootDir: string }>(config, "/remote/config")
  },

  listManagedFolders(config: ServerConfig) {
    return request<{ rootDir: string; folders: string[] }>(config, "/remote/folder")
  },

  listSessions(config: ServerConfig) {
    return request<Session[]>(config, "/session")
  },

  async listStatuses(config: ServerConfig) {
    const payload = await request<unknown>(config, "/session/status")
    return parseStatusMap(payload)
  },

  listCommands(config: ServerConfig) {
    return request<CommandInfo[]>(config, "/command?limit=50")
  },

  createSession(
    config: ServerConfig,
    title?: string,
    directory?: string,
    agent?: string,
    model?: { providerID: string; modelID: string; variant?: string }
  ) {
    return request<Session>(config, withDirectory("/session", directory), {
      method: "POST",
      body: {
        title,
        ...(agent ? { agent } : {}),
        ...(model ? {
          model: {
            id: model.modelID,
            providerID: model.providerID,
            ...(model.variant ? { variant: model.variant } : {})
          }
        } : {})
      }
    })
  },

  createManagedSession(
    config: ServerConfig,
    body: { title?: string; folder?: string; agent?: string; model?: { providerID: string; modelID: string; variant?: string } }
  ) {
    return request<Session>(config, "/remote/session", { method: "POST", body })
  },

  createSessionWithModel(config: ServerConfig, title: string, model: { providerID: string; modelID: string; variant?: string }, directory?: string) {
    return request<Session>(config, withDirectory("/session", directory), {
      method: "POST",
      body: {
        title,
        model: {
          id: model.modelID,
          providerID: model.providerID,
          ...(model.variant ? { variant: model.variant } : {})
        }
      }
    })
  },

  renameSession(config: ServerConfig, id: string, title: string) {
    return request<Session>(config, `/session/${id}`, { method: "PATCH", body: { title } })
  },

  deleteSession(config: ServerConfig, id: string) {
    return request<boolean>(config, `/session/${id}`, { method: "DELETE" })
  },

  loadMessages(config: ServerConfig, sessionID: string, directory?: string) {
    return request<MessageEnvelope[]>(config, withDirectory(`/session/${sessionID}/message?limit=100`, directory))
  },

  loadTodo(config: ServerConfig, sessionID: string) {
    return request<TodoItem[]>(config, `/session/${sessionID}/todo`)
  },

  loadDiff(config: ServerConfig, sessionID: string) {
    return request<DiffFile[]>(config, `/session/${sessionID}/diff`)
  },

  sendPrompt(
    config: ServerConfig,
    sessionID: string,
    text: string,
    directory?: string,
    model?: { providerID: string; modelID: string; variant?: string },
    variant?: string,
    agent?: string
  ) {
    const body: Record<string, unknown> = { parts: [{ type: "text", text }] }
    if (model) body.model = { providerID: model.providerID, modelID: model.modelID }
    if (variant) body.variant = variant
    if (agent) body.agent = agent
    return request<MessageEnvelope>(config, withDirectory(`/session/${sessionID}/message`, directory), {
      method: "POST",
      body
    })
  },

  sendCommand(
    config: ServerConfig,
    sessionID: string,
    command: string,
    argumentsText: string,
    directory?: string,
    variant?: string,
    agent?: string
  ) {
    return request<MessageEnvelope>(config, withDirectory(`/session/${sessionID}/command`, directory), {
      method: "POST",
      body: { command, arguments: argumentsText, ...(variant ? { variant } : {}), ...(agent ? { agent } : {}) }
    })
  },

  abort(config: ServerConfig, sessionID: string) {
    return request<boolean>(config, `/session/${sessionID}/abort`, {
      method: "POST",
      body: {}
    })
  },

  listPermissions(config: ServerConfig, directory?: string) {
    return request<PermissionRequest[]>(config, withDirectory("/permission", directory))
  },

  replyPermission(config: ServerConfig, requestID: string, reply: string, message?: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/permission/${requestID}/reply`, directory), {
      method: "POST",
      body: { reply, message }
    })
  },

  listProviders(config: ServerConfig) {
    return request<{
      all: Array<{
        id: string
        name: string
        models: Record<string, {
          id: string
          name: string
          providerID: string
          variants?: Record<string, { disabled?: boolean }>
        }>
      }>
      default?: Record<string, string>
      connected: string[]
    }>(config, "/provider")
  }
}
