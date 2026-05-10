export type ServerConfig = {
  host: string
  port: number
  username: string
  password: string
}

export type HealthResponse = {
  healthy: boolean
  version: string
}

export type Session = {
  id: string
  title: string
  directory: string
  agent?: string
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  time: {
    created: number
    updated: number
  }
  summary?: {
    additions: number
    deletions: number
    files: number
  }
}

export type SessionStatus = {
  type: string
  attempt?: number
  message?: string
  next?: number
}

export type ToolState = {
  status: "pending" | "running" | "completed" | "error"
  input: Record<string, unknown>
  output?: string
  title?: string
  error?: string
  metadata?: Record<string, unknown>
  time?: { start: number; end: number }
}

export type MessagePart = {
  id: string
  type: "text" | "reasoning" | "tool" | "step-start" | "step-finish" | "file" | "agent" | "subtask" | "snapshot" | "patch" | "compaction" | "retry"
  text?: string
  callID?: string
  tool?: string
  state?: ToolState
  snapshot?: string
  reason?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  mime?: string
  url?: string
  filename?: string
  name?: string
  error?: string
  time?: { start: number; end: number }
  metadata?: Record<string, unknown>
  synthetic?: boolean
}

export type MessageInfo = {
  id: string
  role: string
  sessionID: string
  time: {
    created: number
    completed?: number
  }
  error?: string
  modelID?: string
  providerID?: string
  agent?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

export type MessageEnvelope = {
  info: MessageInfo
  parts: MessagePart[]
}

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

export type PermissionReply = "once" | "always" | "reject"

export type TodoItem = {
  content: string
  status: string
  priority: string
  id: string
}

export type DiffFile = {
  file: string
  additions: number
  deletions: number
}

export type SessionView = {
  id: string
  title: string
  directory: string
  agent?: string
  updated: number
  status: string
  files: number
  additions: number
  deletions: number
  modelID?: string
  providerID?: string
  variant?: string
}

export type CommandInfo = {
  name: string
  description?: string
}
