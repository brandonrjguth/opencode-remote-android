import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "./api"
import type {
  MessageEnvelope,
  MessagePart,
  PermissionRequest,
  QuestionRequest,
  ScheduledTask,
  ServerConfig,
  SessionView,
  TaskRun,
  TodoItem
} from "./types"
import {
  SettingsIcon,
  FolderIcon,
  ChatIcon,
  PlusIcon,
  PlayIcon,
  TrashIcon,
  StopIcon,
  SaveIcon,
  TestIcon,
  LoadingIcon,
  RocketIcon,
  MenuIcon,
  BackIcon,
  ClockIcon
} from "./Icons"

const STORAGE_KEY = "opencode.remote.server"
const THEME_STORAGE_KEY = "opencode.remote.theme"
const PENDING_RUN_TTL_MS = 600_000
const SILENT_RUNTIME_ERROR_PERSIST_MS = 10_000
const PRIMARY_AGENTS = ["build", "plan"] as const

type ThinkingLevel = string | null
type SelectedModel = { providerID: string; modelID: string; variant?: string } | null
type ModelOption = { id: string; name: string; providerID: string; variants: string[] }
type BasicModelRef = { providerID: string; modelID: string }
type PrimaryAgent = (typeof PRIMARY_AGENTS)[number]
type ThemePreference = "system" | "dark" | "light"

const defaultConfig: ServerConfig = {
  host: "",
  port: 4097,
  username: "opencode",
  password: ""
}

function formatTime(epoch: number): string {
  if (!epoch) return "-"
  return new Date(epoch).toLocaleString()
}

function formatTaskSchedule(task: ScheduledTask): string {
  const time = task.scheduledTime ? ` at ${task.scheduledTime}` : ""
  if (task.repeat === "weekly") {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    return `Weekly on ${days[task.dayOfWeek ?? 0]}${time}`
  }
  if (task.repeat === "monthly") {
    return `Monthly on day ${task.dayOfMonth ?? 1}${time}`
  }
  if (task.repeat === "daily") {
    return `Daily${time}`
  }
  return `Once${time}`
}

function formatDirectoryLabel(directory: string, rootDirectory: string): string {
  const normalizedDirectory = directory.replace(/\/+$/g, "")
  const normalizedRoot = rootDirectory.replace(/\/+$/g, "")
  if (!normalizedDirectory || (normalizedRoot && normalizedDirectory === normalizedRoot)) return "Root"

  if (normalizedRoot && normalizedDirectory.startsWith(`${normalizedRoot}/`)) {
    return normalizedDirectory.slice(normalizedRoot.length + 1) || "Root"
  }

  const parts = normalizedDirectory.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? "Root"
}

function extractText(msg: MessageEnvelope): string {
  return msg.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function extractReasoning(msg: MessageEnvelope): string {
  return msg.parts
    .filter((part) => part.type === "reasoning" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function extractToolParts(msg: MessageEnvelope): MessagePart[] {
  return msg.parts.filter((p) => p.type === "tool" && p.state)
}

function hasRenderableContent(msg: MessageEnvelope): boolean {
  return msg.parts.some((p) => {
    if (p.type === "text" && p.text) return true
    if (p.type === "reasoning" && p.text) return true
    if (p.type === "tool" && p.state) return true
    return false
  })
}

function trimTrailingUrlPunctuation(value: string) {
  return value.replace(/[),.;!?]+$/g, "")
}

function renderInline(text: string, keyPrefix = "inline") {
  const pattern = /(\[[^\]]+\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<]+|`[^`]+`|\*\*[^*]+\*\*)/g
  const nodes = []
  let cursor = 0
  let match: RegExpExecArray | null = pattern.exec(text)

  while (match) {
    const token = match[0]
    if (match.index > cursor) {
      nodes.push(<span key={`${keyPrefix}-text-${cursor}`}>{text.slice(cursor, match.index)}</span>)
    }

    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-code-${match.index}`}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}-bold-${match.index}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith("[")) {
      const labelEnd = token.indexOf("](")
      const label = token.slice(1, labelEnd)
      const href = token.slice(labelEnd + 2, -1)
      nodes.push(
        <a key={`${keyPrefix}-link-${match.index}`} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      )
    } else {
      const href = trimTrailingUrlPunctuation(token)
      const trailing = token.slice(href.length)
      nodes.push(
        <a key={`${keyPrefix}-url-${match.index}`} href={href} target="_blank" rel="noreferrer">
          {href}
        </a>
      )
      if (trailing) {
        nodes.push(<span key={`${keyPrefix}-trail-${match.index}`}>{trailing}</span>)
      }
    }

    cursor = match.index + token.length
    match = pattern.exec(text)
  }

  if (cursor < text.length) {
    nodes.push(<span key={`${keyPrefix}-tail-${cursor}`}>{text.slice(cursor)}</span>)
  }

  if (nodes.length === 0) return <span key={`${keyPrefix}-empty`}>{text}</span>
  return nodes
}

function renderRichText(text: string, keyPrefix = "rich") {
  const normalized = text.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    if (trimmed.startsWith("```")) {
      const codeLines = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(<pre key={`${keyPrefix}-code-${blocks.length}`}><code>{codeLines.join("\n")}</code></pre>)
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      const Tag = headingMatch[1].length === 1 ? "h2" : headingMatch[1].length === 2 ? "h3" : "h4"
      blocks.push(<Tag key={`${keyPrefix}-heading-${blocks.length}`}>{renderInline(headingMatch[2], `${keyPrefix}-heading-${blocks.length}`)}</Tag>)
      index += 1
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items = []
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""))
        index += 1
      }
      blocks.push(
        <ul key={`${keyPrefix}-ul-${blocks.length}`}>
          {items.map((item, itemIndex) => <li key={`${keyPrefix}-ul-item-${itemIndex}`}>{renderInline(item, `${keyPrefix}-ul-${itemIndex}`)}</li>)}
        </ul>
      )
      continue
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = []
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""))
        index += 1
      }
      blocks.push(
        <ol key={`${keyPrefix}-ol-${blocks.length}`}>
          {items.map((item, itemIndex) => <li key={`${keyPrefix}-ol-item-${itemIndex}`}>{renderInline(item, `${keyPrefix}-ol-${itemIndex}`)}</li>)}
        </ol>
      )
      continue
    }

    const paragraphLines = [trimmed]
    index += 1
    while (index < lines.length) {
      const next = lines[index].trim()
      if (!next || next.startsWith("```") || /^(#{1,3})\s+/.test(next) || /^[-*]\s+/.test(next) || /^\d+\.\s+/.test(next)) {
        break
      }
      paragraphLines.push(next)
      index += 1
    }

    blocks.push(
      <p key={`${keyPrefix}-p-${blocks.length}`}>
        {renderInline(paragraphLines.join(" "), `${keyPrefix}-p-${blocks.length}`)}
      </p>
    )
  }

  return blocks
}

function toolStatusLabel(status: string) {
  switch (status) {
    case "pending": return "Pending"
    case "running": return "Running..."
    case "completed": return "Done"
    case "error": return "Error"
    default: return status
  }
}

function App() {
  type NoticeType = "info" | "success" | "error"

  const [config, setConfig] = useState<ServerConfig>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return defaultConfig
    try {
      return { ...defaultConfig, ...JSON.parse(saved) }
    } catch {
      return defaultConfig
    }
  })

  const [draftConfig, setDraftConfig] = useState<ServerConfig>(config)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return saved === "dark" || saved === "light" || saved === "system" ? saved : "system"
  })
  const [connectedVersion, setConnectedVersion] = useState<string>("")
  const [view, setView] = useState<"settings" | "sessions" | "detail" | "tasks">(() => {
    return config.host && config.port > 0 ? "sessions" : "settings"
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [sessionOpenCount, setSessionOpenCount] = useState(0)

  const [sessions, setSessions] = useState<SessionView[]>([])
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageEnvelope[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({})
  const [sendingSessionID, setSendingSessionID] = useState<string | null>(null)
  const [loadingSessionID, setLoadingSessionID] = useState<string | null>(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState<{ type: NoticeType; text: string } | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const taskMessagesRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const completionAudioRef = useRef<HTMLAudioElement | null>(null)
  const wasRunningRef = useRef(false)
  const appVisibleRef = useRef(true)
  const loadGenerationRef = useRef(0)
  const resumeSuppressUntilRef = useRef(0)
  const delayedErrorTimerRef = useRef<number | null>(null)
  const silentRuntimeErrorRef = useRef<{ message: string; since: number } | null>(null)

  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [replyingPermID, setReplyingPermID] = useState<string | null>(null)
  const [replyingQuestionID, setReplyingQuestionID] = useState<string | null>(null)
  const [questionAnswer, setQuestionAnswer] = useState("")
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({})
  const [expandedToolOutput, setExpandedToolOutput] = useState<Record<string, boolean>>({})
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [permsExpanded, setPermsExpanded] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [selectedModel, setSelectedModel] = useState<SelectedModel>(null)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(null)
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false)
  const [pendingRunSince, setPendingRunSince] = useState<Record<string, number>>({})
  const pendingRunSinceRef = useRef<Record<string, number>>({})
  const [renamingSessionID, setRenamingSessionID] = useState<string | null>(null)
  const [sessionMenuID, setSessionMenuID] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const [defaultModel, setDefaultModel] = useState<BasicModelRef | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<PrimaryAgent | null>(null)
  const [managedRootDir, setManagedRootDir] = useState("")
  const [managedFolders, setManagedFolders] = useState<string[]>([])
  const [managedSessionOpen, setManagedSessionOpen] = useState(false)
  const [managedSessionFolder, setManagedSessionFolder] = useState("")
  const [managedSessionTitle, setManagedSessionTitle] = useState("")
  const [managedFolderBrowsePath, setManagedFolderBrowsePath] = useState<string[]>([])
  const [selectedManagedSessionID, setSelectedManagedSessionID] = useState<string | null>(null)
  const [discoveredSessions, setDiscoveredSessions] = useState<SessionView[]>([])
  const [pinnedDiscoveredIDs, setPinnedDiscoveredIDs] = useState<Set<string>>(new Set())
  const [loadingManagedFolders, setLoadingManagedFolders] = useState(false)
  const [creatingManagedSession, setCreatingManagedSession] = useState(false)
  const [discoverExpanded, setDiscoverExpanded] = useState(false)

  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [taskHistory, setTaskHistory] = useState<TaskRun[]>([])
  const [taskFormOpen, setTaskFormOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null)
  const [viewingTaskID, setViewingTaskID] = useState<string | null>(null)
  const [taskFormTitle, setTaskFormTitle] = useState("")
  const [taskFormPrompt, setTaskFormPrompt] = useState("")
  const [taskFormFolder, setTaskFormFolder] = useState("")
  const [taskFormRepeat, setTaskFormRepeat] = useState<"once" | "daily" | "weekly" | "monthly">("daily")
  const [taskFormTime, setTaskFormTime] = useState("09:00")
  const [taskFormDayOfWeek, setTaskFormDayOfWeek] = useState<number>(1)
  const [taskFormDayOfMonth, setTaskFormDayOfMonth] = useState<number>(1)
  const [taskFormModel, setTaskFormModel] = useState<{ providerID: string; modelID: string } | null>(null)
  const [taskFormVariant, setTaskFormVariant] = useState<string | null>(null)
  const [taskFormLiveWebResearch, setTaskFormLiveWebResearch] = useState(false)
  const [taskFormSearchProvider, setTaskFormSearchProvider] = useState<"tavily" | "brave">("tavily")
  const [taskModels, setTaskModels] = useState<ModelOption[]>([])
  const [savingTask, setSavingTask] = useState(false)
  const [researchProviders, setResearchProviders] = useState({ tavily: false, brave: false })

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedID) ?? null,
    [sessions, selectedID]
  )

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === viewingTaskID) ?? null,
    [tasks, viewingTaskID]
  )

  const orderedTaskHistory = useMemo(
    () => [...taskHistory].sort((a, b) => a.startedAt - b.startedAt),
    [taskHistory]
  )

  const selectedTaskModelInfo = useMemo(() => {
    if (!taskFormModel) return null
    return taskModels.find((model) => model.id === taskFormModel.modelID && model.providerID === taskFormModel.providerID) ?? null
  }, [taskFormModel, taskModels])

  const filteredSessions = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return sessions
    return sessions.filter((session) => {
      return session.title.toLowerCase().includes(text) || session.directory.toLowerCase().includes(text)
    })
  }, [sessions, query])

  const renderedMessages = useMemo(() => {
    return messages.filter(hasRenderableContent)
  }, [messages])

  const messageStreamKey = useMemo(() => {
    return messages
      .map((message) => `${message.info.id}:${message.parts.length}:${message.info.time.completed ?? 0}`)
      .join("|")
  }, [messages])

  const sessionPermissions = useMemo(() => {
    if (!selectedSession) return []
    return permissions.filter((p) => p.sessionID === selectedSession.id)
  }, [permissions, selectedSession])

  const sessionQuestions = useMemo(() => {
    if (!selectedSession) return []
    return questions.filter((q) => q.sessionID === selectedSession.id)
  }, [questions, selectedSession])

  const lastUsedModel = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info
      if (info?.providerID && info?.modelID) {
        return {
          providerID: info.providerID,
          modelID: info.modelID
        }
      }
    }
    return null
  }, [messages])

  const lastUsedAgent = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const agent = messages[index]?.info.agent
      if (agent === "build" || agent === "plan") {
        return agent
      }
    }
    return null
  }, [messages])

  const activeModel = useMemo(() => {
    if (selectedModel) return selectedModel
    if (selectedSession?.modelID && selectedSession.providerID) {
      return {
        providerID: selectedSession.providerID,
        modelID: selectedSession.modelID,
        variant: selectedSession.variant
      }
    }
    if (lastUsedModel) {
      return {
        ...lastUsedModel,
        variant: selectedSession?.variant
      }
    }
    if (!defaultModel) return null
    return {
      ...defaultModel,
      variant: selectedSession?.variant
    }
  }, [defaultModel, lastUsedModel, selectedModel, selectedSession])

  const activeModelInfo = useMemo(() => {
    if (!activeModel) return null
    return models.find((model) => model.id === activeModel.modelID && model.providerID === activeModel.providerID) ?? null
  }, [activeModel, models])

  const supportedThinkingLevels = useMemo(() => {
    if (!activeModelInfo) return activeModel?.variant ? [activeModel.variant] : []
    if (activeModel?.variant && !activeModelInfo.variants.includes(activeModel.variant)) {
      return [activeModel.variant, ...activeModelInfo.variants]
    }
    return activeModelInfo.variants
  }, [activeModel, activeModelInfo])

  const activeAgent = useMemo<PrimaryAgent>(() => {
    if (selectedAgent) return selectedAgent
    if (selectedSession?.agent === "build" || selectedSession?.agent === "plan") return selectedSession.agent
    if (lastUsedAgent) return lastUsedAgent
    return "build"
  }, [lastUsedAgent, selectedAgent, selectedSession])

  const hasConfiguredServer = Boolean(config.host && config.port > 0)
  const isStatusRunning = Boolean(selectedSession && ["busy", "retry"].includes(selectedSession.status))
  const hasPendingRun = Boolean(selectedID && pendingRunSince[selectedID])
  const hasIncompleteAssistantMessage = messages.some((message) => message.info.role === "assistant" && !message.info.time.completed)
  const hasRunningTool = messages.some((message) =>
    message.parts.some((part) => part.type === "tool" && part.state && ["pending", "running"].includes(part.state.status))
  )
  const isSessionRunning = isStatusRunning || hasPendingRun || hasIncompleteAssistantMessage || hasRunningTool
  const composer = selectedID ? (composerDrafts[selectedID] ?? "") : ""
  const isSendingCurrentSession = Boolean(selectedID && sendingSessionID === selectedID)
  const isWorking = isSendingCurrentSession || isSessionRunning
  const displayedThinkingLevel = thinkingLevel ?? activeModel?.variant ?? (activeModel ? "default" : null)

  useEffect(() => {
    pendingRunSinceRef.current = pendingRunSince
  }, [pendingRunSince])

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia("(prefers-color-scheme: light)")

    const applyTheme = () => {
      const resolved = themePreference === "system"
        ? media.matches ? "light" : "dark"
        : themePreference
      root.dataset.theme = resolved
    }

    applyTheme()
    localStorage.setItem(THEME_STORAGE_KEY, themePreference)

    if (themePreference !== "system") return () => undefined
    media.addEventListener("change", applyTheme)
    return () => media.removeEventListener("change", applyTheme)
  }, [themePreference])

  useEffect(() => {
    if (!selectedSession) return
    setThinkingLevel(selectedSession.variant ?? null)
    setSelectedModel(null)
  }, [selectedSession?.id])

  useEffect(() => {
    if (!managedSessionOpen) return
    discoverSessions(managedSessionFolder).catch(() => undefined)
  }, [managedSessionOpen, managedSessionFolder])

  useEffect(() => {
    if (taskFormSearchProvider === "tavily" && researchProviders.tavily) return
    if (taskFormSearchProvider === "brave" && researchProviders.brave) return
    if (researchProviders.tavily) {
      setTaskFormSearchProvider("tavily")
      return
    }
    if (researchProviders.brave) {
      setTaskFormSearchProvider("brave")
    }
  }, [researchProviders.brave, researchProviders.tavily, taskFormSearchProvider])

  useEffect(() => {
    if (!selectedSession) return
    if (selectedSession.agent === "build" || selectedSession.agent === "plan") {
      setSelectedAgent(selectedSession.agent)
      return
    }
    setSelectedAgent(null)
  }, [selectedSession?.id])

  useEffect(() => {
    if (!config.host || !config.password) return
    api.getConfig(config)
      .then((data) => {
        const raw = data.model?.trim()
        if (!raw) {
          setDefaultModel(null)
          return
        }
        const [providerID, modelID] = raw.split("/")
        if (!providerID || !modelID) {
          setDefaultModel(null)
          return
        }
        setDefaultModel({ providerID, modelID })
      })
      .catch(() => undefined)
  }, [config.host, config.password, config.port, config.username])

  function setComposerForSession(value: string, sessionID = selectedID) {
    if (!sessionID) return
    setComposerDrafts((current) => ({ ...current, [sessionID]: value }))
  }

  function scrollMessagesToBottom(delays = [0]) {
    const el = messagesRef.current
    if (!el) return () => undefined
    const timers = delays.map((delay) =>
      window.setTimeout(() => {
        el.scrollTop = el.scrollHeight
      }, delay)
    )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }

  function shouldSuppressSilentErrors(silent: boolean) {
    return silent && (!appVisibleRef.current || Date.now() < resumeSuppressUntilRef.current)
  }

  function clearDelayedRuntimeError() {
    if (delayedErrorTimerRef.current !== null) {
      window.clearTimeout(delayedErrorTimerRef.current)
      delayedErrorTimerRef.current = null
    }
  }

  function clearSilentRuntimeError() {
    clearDelayedRuntimeError()
    silentRuntimeErrorRef.current = null
    setRuntimeError((current) => {
      if (!current) return current
      return null
    })
  }

  function setSilentRuntimeError(message: string) {
    const now = Date.now()
    const current = silentRuntimeErrorRef.current
    if (!current || current.message !== message) {
      clearDelayedRuntimeError()
      silentRuntimeErrorRef.current = { message, since: now }
    }

    const active = silentRuntimeErrorRef.current
    if (!active) return
    const remaining = SILENT_RUNTIME_ERROR_PERSIST_MS - (now - active.since)
    if (remaining <= 0) {
      clearDelayedRuntimeError()
      setRuntimeError(active.message)
      return
    }
    if (delayedErrorTimerRef.current !== null) return

    delayedErrorTimerRef.current = window.setTimeout(() => {
      const pending = silentRuntimeErrorRef.current
      if (pending) {
        setRuntimeError(pending.message)
      }
      delayedErrorTimerRef.current = null
    }, remaining)
  }

  async function openSession(sessionID: string, directory: string) {
    setSelectedID(sessionID)
    setMessages([])
    setTodos([])
    clearSilentRuntimeError()
    setModelPickerOpen(false)
    setThinkingPickerOpen(false)
    setSessionOpenCount((c) => c + 1)
    setView("detail")
    setLoadingSessionID(sessionID)
    await loadSelected(sessionID, directory)
    setLoadingSessionID((activeID) => (activeID === sessionID ? null : activeID))
  }

  function saveConfig() {
    setConfig(draftConfig)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draftConfig))
    setSettingsNotice({ type: "success", text: "Configuration saved. Press Test to validate connectivity." })
    clearSilentRuntimeError()
    if (draftConfig.host && draftConfig.port > 0) {
      setView("sessions")
    }
  }

  async function testConnection(configToTest: ServerConfig) {
    setTestingConnection(true)
    setSettingsNotice({ type: "info", text: "Testing connection..." })
    try {
      const health = await Promise.race([
        api.health(configToTest),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out")), 12000))
      ])
      setConnectedVersion(health.version)
      setSettingsNotice({ type: "success", text: `Connected to OpenCode ${health.version}` })
    } catch (err) {
      setSettingsNotice({ type: "error", text: `Connection failed: ${(err as Error).message}` })
    } finally {
      setTestingConnection(false)
    }
  }

  async function refreshSessions(silent = false) {
    if (!config.host || !config.password) return
    if (!silent) clearSilentRuntimeError()
    try {
      const [items, statuses] = await Promise.all([api.listSessions(config), api.listStatuses(config)])
      const now = Date.now()
      const pending = pendingRunSinceRef.current
      const mapped = items
        .map((session) => ({
          id: session.id,
          title: session.title,
          directory: session.directory,
          agent: session.agent,
          updated: session.time.updated,
          status: (() => {
            const status = statuses[session.id]?.type ?? "idle"
            const optimistic = pending[session.id] && now - pending[session.id] < PENDING_RUN_TTL_MS && status === "idle"
            return optimistic ? "busy" : status
          })(),
          files: session.summary?.files ?? 0,
          additions: session.summary?.additions ?? 0,
          deletions: session.summary?.deletions ?? 0,
          modelID: session.model?.id,
          providerID: session.model?.providerID,
          variant: session.model?.variant
        }))
        .sort((a, b) => b.updated - a.updated)
      setSessions((prev) => {
        const upstreamIDs = new Set(mapped.map((s) => s.id))
        const pinned = prev.filter((s) => pinnedDiscoveredIDs.has(s.id) && !upstreamIDs.has(s.id))
        return [...mapped, ...pinned]
      })
      setPendingRunSince((current) => {
        const next: Record<string, number> = {}
        const activeIDs = new Set(items.map((session) => session.id))
        for (const [id, startedAt] of Object.entries(current)) {
          if (!activeIDs.has(id)) continue
          const status = statuses[id]?.type ?? "idle"
          if (status === "busy" || status === "retry") continue
          if (now - startedAt < PENDING_RUN_TTL_MS) {
            next[id] = startedAt
          }
        }
        return next
      })
      if (silent) clearSilentRuntimeError()
    } catch (err) {
      if (!shouldSuppressSilentErrors(silent)) {
        if (silent) setSilentRuntimeError((err as Error).message)
        else setRuntimeError((err as Error).message)
      }
    }
  }

  async function refreshPermissions() {
    if (!config.host || !config.password) return
    try {
      const list = await api.listPermissions(config)
      setPermissions(list)
    } catch {
      // silent
    }
  }

  async function refreshQuestions() {
    if (!config.host || !config.password) return
    try {
      const list = await api.listQuestions(config)
      setQuestions(list)
    } catch {
      // silent
    }
  }

  async function loadRemoteConfig() {
    if (!config.host || !config.password) return
    try {
      const data = await api.getRemoteConfig(config)
      setManagedRootDir(data.rootDir)
      setResearchProviders({
        tavily: Boolean(data.researchProviders?.tavily),
        brave: Boolean(data.researchProviders?.brave)
      })
    } catch {
      // silent
    }
  }

  async function loadManagedFolders(subdir = "") {
    if (!config.host || !config.password) return
    setLoadingManagedFolders(true)
    try {
      const data = await api.listManagedFolders(config, subdir || undefined)
      setManagedRootDir(data.rootDir)
      setManagedFolders(data.folders)
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setLoadingManagedFolders(false)
    }
  }

  async function discoverSessions(folder = "") {
    if (!config.host || !config.password) return
    try {
      const items = await api.discoverSessions(config, folder || undefined)
      setDiscoveredSessions(
        items.map((s) => ({
          id: s.id,
          title: s.title,
          directory: s.directory,
          agent: s.agent,
          updated: s.time.updated,
          status: "idle",
          files: s.summary?.files ?? 0,
          additions: s.summary?.additions ?? 0,
          deletions: s.summary?.deletions ?? 0,
          modelID: s.model?.id,
          providerID: s.model?.providerID,
          variant: s.model?.variant
        }))
      )
    } catch {
      setDiscoveredSessions([])
    }
  }

  function openManagedSessionPanel() {
    setManagedSessionOpen(true)
    setManagedSessionFolder("")
    setManagedSessionTitle("")
    setManagedFolderBrowsePath([])
    setSelectedManagedSessionID(null)
    setDiscoveredSessions([])
    setDiscoverExpanded(false)
    loadManagedFolders().catch(() => undefined)
  }

  async function fetchAvailableModels(panel: "model" | "thinking") {
    if (!selectedSession || !config.host || !config.password) return
    setLoadingModels(true)
    setModelPickerOpen(panel === "model")
    setThinkingPickerOpen(panel === "thinking")
    try {
      const data = await api.listProviders(config)
      const connectedSet = new Set(data.connected as string[])
      const sessionProviderSet = new Set(sessions.map((session) => session.providerID).filter(Boolean))
      const modelList: ModelOption[] = []
      for (const provider of data.all) {
        if (!connectedSet.has(provider.id) && !sessionProviderSet.has(provider.id)) continue
        for (const model of Object.values(provider.models)) {
          modelList.push({
            id: model.id,
            name: model.name || model.id,
            providerID: model.providerID || provider.id,
            variants: Object.entries(model.variants ?? {})
              .filter(([, variant]) => !variant?.disabled)
              .map(([variant]) => variant)
          })
        }
      }
      setModels(modelList)
      if (!defaultModel) {
        const defaultEntry = Object.entries(data.default ?? {}).find(([, modelID]) => typeof modelID === "string" && modelID)
        if (defaultEntry) {
          setDefaultModel({ providerID: defaultEntry[0], modelID: defaultEntry[1] })
        }
      }
    } catch {
      // keep existing models
    } finally {
      setLoadingModels(false)
    }
  }

  function switchModel(modelID: string) {
    const model = models.find((m) => m.id === modelID)
    if (!model) return
    const nextVariant = thinkingLevel && model.variants.includes(thinkingLevel)
      ? thinkingLevel
      : model.variants[0] ?? null
    setSelectedModel({
      providerID: model.providerID,
      modelID: model.id,
      variant: nextVariant ?? undefined
    })
    setThinkingLevel(nextVariant)
    setModelPickerOpen(false)
  }

  function setThinking(nextLevel: ThinkingLevel) {
    setThinkingLevel(nextLevel)
    setThinkingPickerOpen(false)
    setSelectedModel((current) => {
      if (!current) return current
      return {
        ...current,
        variant: nextLevel ?? undefined
      }
    })
  }

  async function loadSelected(sessionID: string, directory: string, silent = false) {
    if (!silent) clearSilentRuntimeError()
    const gen = ++loadGenerationRef.current
    try {
      const [msg, todo] = await Promise.all([
        api.loadMessages(config, sessionID, directory),
        api.loadTodo(config, sessionID)
      ])
      if (loadGenerationRef.current !== gen) return
      setMessages(msg)
      setTodos(todo)
      if (silent) clearSilentRuntimeError()
    } catch (err) {
      if (loadGenerationRef.current !== gen) return
      if (!shouldSuppressSilentErrors(silent)) {
        if (silent) setSilentRuntimeError((err as Error).message)
        else setRuntimeError((err as Error).message)
      }
    }
  }

  async function createSession() {
    setCreatingManagedSession(true)
    try {
      const created = await api.createManagedSession(config, {
        title: managedSessionTitle.trim() || undefined,
        folder: managedSessionFolder.trim() || undefined,
        agent: activeAgent,
        model: activeModel ?? undefined
      })
      setManagedSessionOpen(false)
      setManagedSessionFolder("")
      await refreshSessions()
      setSelectedID(created.id)
      await loadSelected(created.id, created.directory)
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setCreatingManagedSession(false)
    }
  }

  async function send() {
    if (!selectedSession) return
    const text = composer.trim()
    if (!text) return
    setComposerForSession("", selectedSession.id)

    setSendingSessionID(selectedSession.id)
    setPendingRunSince((current) => ({ ...current, [selectedSession.id]: Date.now() }))
    clearSilentRuntimeError()
    try {
      if (text.startsWith("/")) {
        const normalized = text.startsWith("/") ? text.slice(1) : text
        const command = normalized.split(" ")[0]?.trim()
        const args = normalized.slice(command.length).trim()
        if (!command) return
        if (command === "new") {
          const title = args || undefined
          const created = await api.createSession(
            config,
            title,
            selectedSession.directory,
            activeAgent,
            activeModel ?? undefined
          )
          await refreshSessions(true)
          await openSession(created.id, created.directory)
          return
        }
        await api.sendCommand(config, selectedSession.id, command, args, selectedSession.directory, thinkingLevel ?? undefined, activeAgent)
      } else {
        await api.sendPrompt(
          config,
          selectedSession.id,
          text,
          selectedSession.directory,
          selectedModel ?? undefined,
          thinkingLevel ?? undefined,
          activeAgent
        )
      }
      await loadSelected(selectedSession.id, selectedSession.directory)
      await refreshSessions()
    } catch (err) {
      setPendingRunSince((current) => {
        if (!current[selectedSession.id]) return current
        const { [selectedSession.id]: _removed, ...rest } = current
        return rest
      })
      setRuntimeError((err as Error).message)
    } finally {
      setSendingSessionID((current) => (current === selectedSession.id ? null : current))
    }
  }

  async function deleteSession(sessionID: string) {
    try {
      await api.deleteSession(config, sessionID)
      if (selectedID === sessionID) {
        loadGenerationRef.current++
        setSelectedID(null)
        setMessages([])
        setTodos([])
        setView("sessions")
      }
      setPinnedDiscoveredIDs((prev) => {
        if (!prev.has(sessionID)) return prev
        const next = new Set(prev)
        next.delete(sessionID)
        return next
      })
      setSessions((current) => current.filter((s) => s.id !== sessionID))
      setPendingRunSince((current) => {
        if (!current[sessionID]) return current
        const { [sessionID]: _removed, ...rest } = current
        return rest
      })
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  function beginRenameSession(session: SessionView) {
    setSessionMenuID(null)
    setRenamingSessionID(session.id)
    setRenameDraft(session.title)
  }

  function cancelRenameSession() {
    setSessionMenuID(null)
    setRenamingSessionID(null)
    setRenameDraft("")
  }

  async function renameSession(session: SessionView) {
    const nextTitle = renameDraft.trim()
    if (!nextTitle || nextTitle === session.title) return

    try {
      await api.renameSession(config, session.id, nextTitle)
      setSessions((current) =>
        current.map((item) => (item.id === session.id ? { ...item, title: nextTitle } : item))
      )
      cancelRenameSession()
      await refreshSessions(true)
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  async function abortSession() {
    if (!selectedSession) return
    try {
      await api.abort(config, selectedSession.id, selectedSession.directory)
      setSendingSessionID(null)
      setPendingRunSince((current) => {
        if (!current[selectedSession.id]) return current
        const { [selectedSession.id]: _removed, ...rest } = current
        return rest
      })
      setSessions((current) =>
        current.map((s) => s.id === selectedSession.id ? { ...s, status: "idle" } : s)
      )
      await refreshSessions()
      await loadSelected(selectedSession.id, selectedSession.directory)
    } catch (err) {
      setSendingSessionID(null)
      setPendingRunSince((current) => {
        if (!current[selectedSession.id]) return current
        const { [selectedSession.id]: _removed, ...rest } = current
        return rest
      })
      setSessions((current) =>
        current.map((s) => s.id === selectedSession.id ? { ...s, status: "idle" } : s)
      )
      setRuntimeError((err as Error).message)
    }
  }

  async function replyPermission(requestID: string, reply: string) {
    setReplyingPermID(requestID)
    try {
      await api.replyPermission(config, requestID, reply)
      await refreshPermissions()
      if (selectedSession) {
        await loadSelected(selectedSession.id, selectedSession.directory)
        await refreshSessions(true)
      }
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setReplyingPermID(null)
    }
  }

  async function replyQuestion(requestID: string) {
    const answer = questionAnswer.trim()
    if (!answer) return
    setReplyingQuestionID(requestID)
    try {
      await api.replyQuestion(config, requestID, answer)
      setQuestionAnswer("")
      await refreshQuestions()
      if (selectedSession) {
        await loadSelected(selectedSession.id, selectedSession.directory)
        await refreshSessions(true)
      }
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setReplyingQuestionID(null)
    }
  }

  function toggleThinking(partID: string) {
    setExpandedThinking((prev) => ({ ...prev, [partID]: !prev[partID] }))
  }

  function toggleToolOutput(partID: string) {
    setExpandedToolOutput((prev) => ({ ...prev, [partID]: !prev[partID] }))
  }

  async function refreshTasks() {
    if (!config.host || !config.password) return
    try {
      const data = await api.listTasks(config)
      setTasks(data)
    } catch {
      // silent
    }
  }

  async function loadTaskHistory(taskID: string) {
    if (!config.host || !config.password) return
    try {
      const data = await api.listTaskHistory(config, taskID)
      setTaskHistory(data)
    } catch {
      // silent
    }
  }

  async function fetchTaskModels() {
    if (!config.host || !config.password) return
    try {
      const data = await api.listProviders(config)
      const connectedSet = new Set(data.connected as string[])
      const modelList: ModelOption[] = []
      for (const provider of data.all) {
        if (!connectedSet.has(provider.id)) continue
        for (const model of Object.values(provider.models)) {
          modelList.push({
            id: model.id,
            name: model.name || model.id,
            providerID: model.providerID || provider.id,
            variants: Object.entries(model.variants ?? {})
              .filter(([, variant]) => !variant?.disabled)
              .map(([variant]) => variant)
          })
        }
      }
      setTaskModels(modelList)
    } catch {
      // silent
    }
  }

  function openTaskForm(task?: ScheduledTask) {
    if (task) {
      setEditingTask(task)
      setTaskFormTitle(task.title)
      setTaskFormPrompt(task.prompt)
      setTaskFormFolder(task.folder)
      setTaskFormRepeat(task.repeat)
      setTaskFormTime(task.scheduledTime ?? "09:00")
      setTaskFormDayOfWeek(task.dayOfWeek ?? 1)
      setTaskFormDayOfMonth(task.dayOfMonth ?? 1)
      setTaskFormModel(task.model ? { providerID: task.model.providerID, modelID: task.model.modelID } : null)
      setTaskFormVariant(task.variant)
      setTaskFormLiveWebResearch(task.liveWebResearch)
      setTaskFormSearchProvider(task.searchProvider ?? (researchProviders.tavily ? "tavily" : "brave"))
      const browsePath = (task.folder ?? "").split("/").filter(Boolean)
      setManagedFolderBrowsePath(browsePath)
      setTaskFormOpen(true)
      fetchTaskModels().catch(() => undefined)
      loadManagedFolders(browsePath.slice(0, -1).join("/")).catch(() => undefined)
      loadRemoteConfig().catch(() => undefined)
    } else {
      setEditingTask(null)
      setTaskFormTitle("")
      setTaskFormPrompt("")
      setTaskFormFolder("")
      setTaskFormRepeat("daily")
      setTaskFormTime("09:00")
      setTaskFormDayOfWeek(1)
      setTaskFormDayOfMonth(1)
      setTaskFormModel(null)
      setTaskFormVariant(null)
      setTaskFormLiveWebResearch(false)
      setTaskFormSearchProvider(researchProviders.tavily ? "tavily" : "brave")
    }
    setTaskFormOpen(true)
    setManagedFolderBrowsePath([])
    fetchTaskModels().catch(() => undefined)
    loadManagedFolders().catch(() => undefined)
    loadRemoteConfig().catch(() => undefined)
  }

  async function saveTask() {
    setSavingTask(true)
    try {
      const body = {
        title: taskFormTitle.trim(),
        prompt: taskFormPrompt.trim(),
        folder: taskFormFolder.trim(),
        repeat: taskFormRepeat,
        scheduledTime: taskFormTime,
        dayOfWeek: taskFormRepeat === "weekly" ? taskFormDayOfWeek : null,
        dayOfMonth: taskFormRepeat === "monthly" ? taskFormDayOfMonth : null,
        model: taskFormModel ? { ...taskFormModel, variant: taskFormVariant ?? undefined } : null,
        variant: taskFormVariant,
        liveWebResearch: taskFormLiveWebResearch,
        searchProvider: taskFormLiveWebResearch ? taskFormSearchProvider : null,
        searchQuery: ""
      }
      if (editingTask) {
        await api.updateTask(config, editingTask.id, body)
      } else {
        await api.createTask(config, body)
      }
      setTaskFormOpen(false)
      setEditingTask(null)
      await refreshTasks()
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setSavingTask(false)
    }
  }

  async function deleteTaskAction(taskID: string) {
    try {
      await api.deleteTask(config, taskID)
      if (viewingTaskID === taskID) {
        setViewingTaskID(null)
        setTaskHistory([])
      }
      await refreshTasks()
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  async function toggleTaskEnabled(task: ScheduledTask) {
    try {
      await api.updateTask(config, task.id, { enabled: !task.enabled })
      await refreshTasks()
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  async function triggerTaskRun(taskID: string) {
    try {
      await api.runTaskNow(config, taskID)
      await refreshTasks()
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  async function openTaskHistory(taskID: string) {
    setViewingTaskID(taskID)
    setTaskHistory([])
    await loadTaskHistory(taskID)
  }

  useEffect(() => {
    if (!config.host || !config.password) return
    loadRemoteConfig().catch(() => undefined)
    refreshSessions(true).catch(() => undefined)
    refreshPermissions().catch(() => undefined)
    refreshQuestions().catch(() => undefined)
    refreshTasks().catch(() => undefined)
    const timer = setInterval(() => {
      refreshSessions(true).catch(() => undefined)
      refreshPermissions().catch(() => undefined)
      refreshQuestions().catch(() => undefined)
      refreshTasks().catch(() => undefined)
      if (selectedSession) {
        loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
      }
      if (viewingTaskID) {
        loadTaskHistory(viewingTaskID).catch(() => undefined)
      }
    }, 3500)
    return () => clearInterval(timer)
  }, [config.host, config.password, config.port, config.username, selectedSession?.id, viewingTaskID])

  useEffect(() => {
    const markVisible = () => {
      appVisibleRef.current = true
      resumeSuppressUntilRef.current = Date.now() + 4000
      clearSilentRuntimeError()
      setTimeout(() => {
        refreshSessions(true).catch(() => undefined)
        refreshPermissions().catch(() => undefined)
        refreshQuestions().catch(() => undefined)
        refreshTasks().catch(() => undefined)
        if (selectedSession) {
          loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
        }
        if (viewingTaskID) {
          loadTaskHistory(viewingTaskID).catch(() => undefined)
        }
      }, 500)
    }

    const markHidden = () => {
      appVisibleRef.current = false
    }

    const handleVisibility = () => {
      if (document.hidden) markHidden()
      else markVisible()
    }

    document.addEventListener("visibilitychange", handleVisibility)
    window.addEventListener("focus", markVisible)
    window.addEventListener("pageshow", markVisible)
    window.addEventListener("blur", markHidden)

    return () => {
      clearDelayedRuntimeError()
      document.removeEventListener("visibilitychange", handleVisibility)
      window.removeEventListener("focus", markVisible)
      window.removeEventListener("pageshow", markVisible)
      window.removeEventListener("blur", markHidden)
    }
  }, [selectedSession?.id, config.host, config.password, config.port, config.username, viewingTaskID])

  useEffect(() => {
    if (!selectedSession) return
    if (["busy", "retry"].includes(selectedSession.status)) {
      setPendingRunSince((current) => {
        if (current[selectedSession.id]) return current
        return { ...current, [selectedSession.id]: Date.now() }
      })
      return
    }
    if (isSessionRunning) return
    setPendingRunSince((current) => {
      if (!current[selectedSession.id]) return current
      const { [selectedSession.id]: _removed, ...rest } = current
      return rest
    })
  }, [selectedSession?.id, selectedSession?.status, isSessionRunning])

  useEffect(() => {
    if (!hasConfiguredServer) {
      setView("settings")
    }
  }, [hasConfiguredServer])

  useEffect(() => {
    if (sessionOpenCount === 0) return
    return scrollMessagesToBottom([50, 150, 400, 800])
  }, [sessionOpenCount])

  useEffect(() => {
    if (view !== "detail") return
    return scrollMessagesToBottom([0, 50])
  }, [messageStreamKey, view, selectedID])

  useEffect(() => {
    if (view !== "tasks" || !viewingTaskID || taskFormOpen) return
    const container = taskMessagesRef.current
    const latestRun = container?.lastElementChild as HTMLElement | null
    if (!container || !latestRun) return

    const scrollToLatestRunStart = () => {
      const containerTop = container.getBoundingClientRect().top
      const runTop = latestRun.getBoundingClientRect().top
      container.scrollTo({ top: Math.max(0, container.scrollTop + runTop - containerTop - 8), behavior: "auto" })
    }

    scrollToLatestRunStart()
    const timers = [50, 180].map((delay) => window.setTimeout(scrollToLatestRunStart, delay))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [orderedTaskHistory.length, taskFormOpen, view, viewingTaskID])

  useEffect(() => {
    if (view !== "detail") return
    const viewport = window.visualViewport
    if (!viewport) return

    const handleResize = () => {
      const focused = document.activeElement === composerRef.current
      if (!focused) return
      scrollMessagesToBottom([0, 80, 180])
    }

    viewport.addEventListener("resize", handleResize)
    return () => viewport.removeEventListener("resize", handleResize)
  }, [view, selectedID])

  useEffect(() => {
    completionAudioRef.current = new Audio("/audio/staplebops-01.aac")
    completionAudioRef.current.preload = "auto"
  }, [])


  useEffect(() => {
    if (!selectedSession) {
      wasRunningRef.current = false
      return
    }
    const runningNow = isSessionRunning
    if (wasRunningRef.current && !runningNow) {
      const audio = completionAudioRef.current
      if (audio) {
        audio.currentTime = 0
        audio.play().catch(() => undefined)
      }
    }
    wasRunningRef.current = runningNow
  }, [selectedSession?.id, isSessionRunning])

  function renderMessagePart(part: MessagePart) {
    if (part.type === "reasoning" && part.text) {
      const isExpanded = expandedThinking[part.id] ?? false
      return (
        <div key={part.id} className="thinking-block">
          <button
            className="thinking-toggle"
            onClick={() => toggleThinking(part.id)}
            aria-expanded={isExpanded}
          >
            <span className={`chevron ${isExpanded ? "expanded" : ""}`}>&#9654;</span>
            <span className="thinking-label">Thinking</span>
          </button>
          {isExpanded && (
            <div className="thinking-content message-richtext">{renderRichText(part.text, `thinking-${part.id}`)}</div>
          )}
        </div>
      )
    }

    if (part.type === "tool" && part.state) {
      const st = part.state
      const title = st.title || part.tool || "tool"
      const isExpanded = expandedToolOutput[part.id] ?? false
      const output = st.output || st.error || ""
      const hasOutput = output.length > 0
      return (
        <div key={part.id} className={`tool-block tool-${st.status}`}>
          <div className="tool-header">
            <span className="tool-icon">
              {st.status === "running" ? <LoadingIcon size={14} /> : st.status === "error" ? "✗" : st.status === "completed" ? "✓" : "○"}
            </span>
            <span className="tool-name">{title}</span>
            <span className={`tool-status-pill ${st.status}`}>{toolStatusLabel(st.status)}</span>
          </div>
          {hasOutput && (
            <div className="tool-output-section">
              <button className="tool-output-toggle" onClick={() => toggleToolOutput(part.id)}>
                <span className={`chevron ${isExpanded ? "expanded" : ""}`}>&#9654;</span>
                {isExpanded ? "Hide output" : "Show output"}
              </button>
              {isExpanded && (
                <pre className="tool-output">{output.length > 2000 ? output.slice(0, 2000) + "\n... (truncated)" : output}</pre>
              )}
            </div>
          )}
        </div>
      )
    }

    if (part.type === "text" && part.text) {
      return (
        <div key={part.id} className="message-text-content message-richtext">{renderRichText(part.text, `part-${part.id}`)}</div>
      )
    }

    return null
  }

   return (
    <div className="app-shell">
        <header className={menuOpen ? "top-nav panel menu-open" : "top-nav panel"}>
         <div className="brand-section">
           <div className="brand-title">
             <img src="/app-icon.png" alt="" className="app-icon" />
             <h1>OpenCode Remote</h1>
           </div>
         </div>
        
        <nav className="desktop-nav tab-row" role="navigation" aria-label="Main navigation">
          {view === "detail" && (
            <button
              type="button"
              className="btn-back"
              onClick={() => {
                loadGenerationRef.current++
                setView("sessions")
                setSelectedID(null)
                setMessages([])
                setTodos([])
                setModelPickerOpen(false)
                setThinkingPickerOpen(false)
              }}
              aria-label="Back to sessions"
            >
              <BackIcon size={18} /> <span>Sessions</span>
            </button>
          )}
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => {
              setView("settings")
              setModelPickerOpen(false)
              setThinkingPickerOpen(false)
            }}
            aria-label="Settings"
          >
            <SettingsIcon size={18} />
            <span>Settings</span>
          </button>
          <button
            className={view === "sessions" ? "active" : ""}
            onClick={() => {
              setView("sessions")
              setModelPickerOpen(false)
              setThinkingPickerOpen(false)
            }}
            disabled={!hasConfiguredServer}
            aria-label="Sessions"
          >
            <FolderIcon size={18} />
            <span>Sessions</span>
          </button>
          <button
            className={view === "tasks" ? "active" : ""}
            onClick={() => {
              setView("tasks")
              setViewingTaskID(null)
              setTaskFormOpen(false)
              refreshTasks().catch(() => undefined)
            }}
            disabled={!hasConfiguredServer}
            aria-label="Tasks"
          >
            <ClockIcon size={18} />
            <span>Tasks</span>
          </button>
        </nav>

        <div className="top-nav-actions">
          {(view === "detail" || viewingTaskID) && (
            <button
              type="button"
              className="btn-back mobile-back-btn"
              onClick={() => {
                if (view === "detail") {
                  loadGenerationRef.current++
                  setView("sessions")
                  setSelectedID(null)
                  setMessages([])
                  setTodos([])
                  setModelPickerOpen(false)
                  setThinkingPickerOpen(false)
                } else if (viewingTaskID) {
                  setViewingTaskID(null)
                  setTaskHistory([])
                }
              }}
              aria-label="Back"
            >
              <BackIcon size={20} />
            </button>
          )}
          <button
            className={menuOpen ? "mobile-menu-btn active" : "mobile-menu-btn"}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            <MenuIcon size={24} />
          </button>
        </div>
        {menuOpen && (
          <section className="menu-panel embedded">
            <div className="menu-grid">
              <button 
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  setView("sessions")
                  setModelPickerOpen(false)
                  setThinkingPickerOpen(false)
                }}
                disabled={!hasConfiguredServer}
                aria-label="Sessions"
              >
                <FolderIcon size={28} />
                <span>Sessions</span>
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  setView("tasks")
                  setViewingTaskID(null)
                  setTaskFormOpen(false)
                  refreshTasks().catch(() => undefined)
                }}
                disabled={!hasConfiguredServer}
                aria-label="Tasks"
              >
                <ClockIcon size={28} />
                <span>Tasks</span>
              </button>
              <button 
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  setView("settings")
                  setModelPickerOpen(false)
                  setThinkingPickerOpen(false)
                }}
                aria-label="Settings"
              >
                <SettingsIcon size={28} />
                <span>Settings</span>
              </button>
            </div>
          </section>
        )}
      </header>


      {view === "settings" && (
        <section className="panel settings fade-in">
          <h2>Server Configuration</h2>
          
          <label htmlFor="host">
            Host Address
            <input 
              id="host"
              value={draftConfig.host} 
              onChange={(event) => setDraftConfig({ ...draftConfig, host: event.target.value })} 
              placeholder="192.168.1.100 or localhost"
            />
          </label>
          
          <label htmlFor="port">
            Port
            <input
              id="port"
              type="number"
              value={draftConfig.port}
              onChange={(event) => setDraftConfig({ ...draftConfig, port: Number(event.target.value || 0) })}
              placeholder="4097"
            />
          </label>
          
          <label htmlFor="username">
            Username
            <input
              id="username"
              value={draftConfig.username}
              onChange={(event) => setDraftConfig({ ...draftConfig, username: event.target.value })}
              placeholder="opencode"
            />
          </label>
          
          <label htmlFor="password">
            Password
            <input
              id="password"
              type="password"
              value={draftConfig.password}
              onChange={(event) => setDraftConfig({ ...draftConfig, password: event.target.value })}
              placeholder="Your server password"
            />
          </label>

          <div className="settings-field">
            <span className="settings-field-label">Appearance</span>
            <div className="theme-toggle" role="radiogroup" aria-label="Theme">
              {(["system", "dark", "light"] as ThemePreference[]).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className={themePreference === theme ? "theme-choice active" : "theme-choice"}
                  onClick={() => setThemePreference(theme)}
                  role="radio"
                  aria-checked={themePreference === theme}
                >
                  {theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}
                </button>
              ))}
            </div>
            <p className="subtle">Light mode uses brighter surfaces and stronger text contrast for daytime reading.</p>
          </div>
          
          <div className="actions">
            <button 
              onClick={saveConfig} 
              disabled={testingConnection}
              className="btn-primary"
            >
              <SaveIcon size={18} />
              {testingConnection ? "Saving..." : "Save Configuration"}
            </button>
            <button 
              onClick={() => testConnection(draftConfig)} 
              className="btn-secondary"
              disabled={testingConnection}
            >
              {testingConnection ? (
                <>
                  <LoadingIcon size={18} />
                  Testing...
                </>
              ) : (
                <>
                  <TestIcon size={18} />
                  Test Connection
                </>
              )}
            </button>
          </div>
          
          {settingsNotice && (
            <div className={`notice ${settingsNotice.type} fade-in`}>
              {settingsNotice.type === 'success' && '✓ '}
              {settingsNotice.type === 'error' && '✗ '}
              {settingsNotice.type === 'info' && 'ℹ '}
              {settingsNotice.text}
            </div>
          )}
          
          {connectedVersion && (
            <div className="notice success fade-in">
              <TestIcon size={16} />
              Connected to OpenCode {connectedVersion}
            </div>
          )}
        </section>
      )}

      {view === "sessions" && (
        <section className="panel sessions fade-in">
          <div className="header-row">
            <h2>Sessions</h2>
            <div className="inline-actions">
              <button onClick={openManagedSessionPanel} className="btn-primary">
                <PlusIcon size={18} />
                New Session
              </button>
            </div>
          </div>

          {managedSessionOpen && (
            <div className="new-session-panel fade-in">
              <div className="header-row">
                <strong>Start New Session</strong>
                <span className="subtle">Mode: {activeAgent}</span>
              </div>
              <p className="subtle">Root directory</p>
              <code className="root-directory-code">{managedRootDir || "Not configured on wrapper server yet"}</code>
              <label htmlFor="new-session-title">
                Session name
                <input
                  id="new-session-title"
                  value={managedSessionTitle}
                  onChange={(event) => setManagedSessionTitle(event.target.value)}
                  placeholder="Leave blank for default"
                />
              </label>
              <label htmlFor="new-session-folder">
                Folder
                <input
                  id="new-session-folder"
                  value={managedSessionFolder}
                  onChange={(event) => {
                    setManagedSessionFolder(event.target.value)
                    setManagedFolderBrowsePath(event.target.value.split("/").filter(Boolean))
                  }}
                  placeholder="Leave blank to start in the root folder"
                />
              </label>
              {(managedFolders.length > 0 || managedFolderBrowsePath.length > 0) && (
                <div className="folder-browser">
                  {managedFolderBrowsePath.length > 0 && (
                    <p className="subtle folder-breadcrumb">
                      Browsing: {managedFolderBrowsePath.join(" / ")}
                    </p>
                  )}
                  <div className="folder-chip-row">
                    {managedFolderBrowsePath.length > 0 && (
                      <button
                        type="button"
                        className="util-chip"
                        onClick={() => {
                          const parentPath = managedFolderBrowsePath.slice(0, -1)
                          setManagedFolderBrowsePath(parentPath)
                          setManagedSessionFolder(parentPath.join("/"))
                          loadManagedFolders(parentPath.join("/")).catch(() => undefined)
                        }}
                      >
                        &larr; Back
                      </button>
                    )}
                    <button
                      type="button"
                      className={`util-chip${managedFolderBrowsePath.length === 0 ? " util-chip-active" : ""}`}
                      onClick={() => {
                        setManagedFolderBrowsePath([])
                        setManagedSessionFolder("")
                      }}
                    >
                      Root
                    </button>
                    {managedFolders.map((folder) => {
                      const fullPath = [...managedFolderBrowsePath, folder].join("/")
                      return (
                        <button
                          key={folder}
                          type="button"
                          className={`util-chip${managedSessionFolder === fullPath ? " util-chip-active" : ""}`}
                          onClick={() => {
                            setManagedFolderBrowsePath((current) => [...current, folder])
                            setManagedSessionFolder(fullPath)
                            loadManagedFolders(fullPath).catch(() => undefined)
                          }}
                        >
                          {folder}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {loadingManagedFolders && <p className="subtle">Loading folders...</p>}
              {!managedRootDir && !loadingManagedFolders && (
                <p className="subtle">Set the wrapper root directory on the server first with `npm run server:set-root -- /absolute/path`.</p>
              )}
              {discoveredSessions.length > 0 && (
                <div className="existing-sessions">
                  <button
                    type="button"
                    className="existing-sessions-toggle"
                    onClick={() => setDiscoverExpanded((v) => !v)}
                  >
                    <span>{discoverExpanded ? "Hide" : "Show"} existing sessions ({discoveredSessions.length})</span>
                    <span className={`chevron ${discoverExpanded ? "expanded" : ""}`}>&#9654;</span>
                  </button>
                  {discoverExpanded && (
                    <div className="existing-session-list">
                      {discoveredSessions.map((session) => (
                        <button
                          key={session.id}
                          type="button"
                          className={`existing-session-item${selectedManagedSessionID === session.id ? " existing-session-item-active" : ""}`}
                          onClick={() => setSelectedManagedSessionID(session.id === selectedManagedSessionID ? null : session.id)}
                        >
                          <span className="existing-session-title">{session.title}</span>
                          <span className={`pill ${session.status}`}>{session.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="inline-actions">
                {selectedManagedSessionID ? (
                  <>
                    <button
                      onClick={async () => {
                        const match = discoveredSessions.find((s) => s.id === selectedManagedSessionID)
                        if (!match) return
                        setManagedSessionOpen(false)
                        setSelectedManagedSessionID(null)
                        setPinnedDiscoveredIDs((prev) => new Set(prev).add(match.id))
                        setSessions((current) => {
                          if (current.some((s) => s.id === match.id)) return current
                          return [match, ...current]
                        })
                        setSelectedID(match.id)
                        setMessages([])
                        setTodos([])
                        setView("detail")
                        setLoadingSessionID(match.id)
                        loadGenerationRef.current++
                        try {
                          const [msg, todo] = await Promise.all([
                            api.loadDiscoveredMessages(config, match.id),
                            api.loadDiscoveredTodos(config, match.id)
                          ])
                          setMessages(msg)
                          setTodos(todo)
                        } catch {
                          try {
                            await loadSelected(match.id, match.directory)
                          } catch { /* silent */ }
                        }
                        setLoadingSessionID((id) => id === match.id ? null : id)
                      }}
                      className="btn-primary"
                    >
                      Open Session
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setSelectedManagedSessionID(null)}
                    >
                      Deselect
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => createSession().catch(() => undefined)}
                      className="btn-primary"
                      disabled={!managedRootDir || creatingManagedSession}
                    >
                      {creatingManagedSession ? "Creating..." : "Create Session"}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setManagedSessionOpen(false)}
                      disabled={creatingManagedSession}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          
          <input
            placeholder="Search sessions by title or directory..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="search"
          />
          
          <div className="session-list">
            {filteredSessions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--secondary-500)' }}>
                <FolderIcon size={48} className="icon-empty-state" />
                <p>No sessions found</p>
                <p className="subtle">Create a new session to get started</p>
              </div>
            ) : (
              filteredSessions.map((session) => (
                <article 
                  key={session.id} 
                  className={`session-card ${selectedID === session.id ? "active" : ""} ${sessionMenuID === session.id ? "menu-open" : ""} fade-in`}
                  onClick={() => {
                    if (renamingSessionID === session.id) return
                    setSessionMenuID(null)
                    openSession(session.id, session.directory).catch(() => undefined)
                  }}
                >
                  <div className="header-row">
                    <h3>{session.title}</h3>
                    <div className="session-card-top-actions">
                      <span className={`pill ${selectedID === session.id && isSessionRunning ? "busy" : session.status}`}>{selectedID === session.id && isSessionRunning ? "busy" : session.status}</span>
                      <button
                        type="button"
                        className="session-menu-trigger"
                        onClick={(event) => {
                          event.stopPropagation()
                          setSessionMenuID((current) => current === session.id ? null : session.id)
                        }}
                        aria-haspopup="menu"
                        aria-expanded={sessionMenuID === session.id}
                        aria-label={`Session actions for ${session.title}`}
                      >
                        ...
                      </button>
                    </div>
                  </div>
                  {renamingSessionID === session.id && (
                    <form
                      className="rename-form"
                      onClick={(event) => event.stopPropagation()}
                      onSubmit={(event) => {
                        event.preventDefault()
                        renameSession(session).catch(() => undefined)
                      }}
                    >
                      <input
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        placeholder="Enter a session title"
                        autoFocus
                      />
                      <div className="rename-actions">
                        <button type="submit" className="btn-primary btn-sm">Save</button>
                        <button type="button" className="btn-secondary btn-sm" onClick={cancelRenameSession}>Cancel</button>
                      </div>
                    </form>
                  )}
                  <p title={session.directory}>{formatDirectoryLabel(session.directory, managedRootDir)}</p>
                  {sessionMenuID === session.id && (
                    <div className="session-card-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          if (renamingSessionID === session.id) cancelRenameSession()
                          else beginRenameSession(session)
                        }}
                      >
                        {renamingSessionID === session.id ? "Close rename" : "Rename"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger-menu-item"
                        onClick={() => {
                          setSessionMenuID(null)
                          deleteSession(session.id)
                        }}
                      >
                        <TrashIcon size={15} />
                        Delete
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
          
          {runtimeError && <div className="error fade-in">✗ {runtimeError}</div>}
        </section>
      )}

      {view === "tasks" && (!viewingTaskID || taskFormOpen) && (
        <section className="panel sessions fade-in">
          {!taskFormOpen && (
            <>
              <div className="header-row">
                <h2>Scheduled Tasks</h2>
                <div className="inline-actions">
                  <button onClick={() => openTaskForm()} className="btn-primary">
                    <PlusIcon size={18} />
                    New Task
                  </button>
                </div>
              </div>

              {tasks.length === 0 ? (
                <div style={{ textAlign: "center", padding: "var(--space-8)", color: "var(--secondary-500)" }}>
                  <ClockIcon size={48} className="icon-empty-state" />
                  <p>No scheduled tasks</p>
                  <p className="subtle">Create a task to run prompts on a schedule</p>
                </div>
              ) : (
                <div className="session-list">
                  {tasks.map((task) => (
                    <article key={task.id} className="session-card fade-in task-card">
                      <button type="button" className="task-card-open" onClick={() => openTaskHistory(task.id)}>
                        <div className="task-card-title-row">
                          <strong className="session-title">{task.title}</strong>
                          <span className={`task-state-chip ${task.running ? "busy" : task.enabled ? "idle" : "paused"}`}>
                            <span className="task-state-dot" aria-hidden="true" />
                            {task.running ? "Running" : task.enabled ? "Active" : "Paused"}
                          </span>
                        </div>
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}

          {taskFormOpen && (
            <div className="new-session-panel fade-in">
              <div className="header-row">
                <strong>{editingTask ? "Edit Task" : "Create Scheduled Task"}</strong>
              </div>

              <label htmlFor="task-title">
                Task name
                <input
                  id="task-title"
                  value={taskFormTitle}
                  onChange={(e) => setTaskFormTitle(e.target.value)}
                  placeholder="e.g. Daily summary"
                />
              </label>

              <label htmlFor="task-prompt">
                Prompt
                <textarea
                  id="task-prompt"
                  value={taskFormPrompt}
                  onChange={(e) => setTaskFormPrompt(e.target.value)}
                  placeholder="Write the prompt to send..."
                  rows={4}
                />
              </label>

              <label htmlFor="task-folder">
                Folder
                <input
                  id="task-folder"
                  value={taskFormFolder}
                  onChange={(e) => {
                    setTaskFormFolder(e.target.value)
                    setManagedFolderBrowsePath(e.target.value.split("/").filter(Boolean))
                  }}
                  placeholder="Leave blank for root folder"
                />
              </label>
              {(managedFolders.length > 0 || managedFolderBrowsePath.length > 0) && (
                <div className="folder-browser">
                  {managedFolderBrowsePath.length > 0 && (
                    <p className="subtle folder-breadcrumb">Browsing: {managedFolderBrowsePath.join(" / ")}</p>
                  )}
                  <div className="folder-chip-row">
                    {managedFolderBrowsePath.length > 0 && (
                      <button
                        type="button"
                        className="util-chip"
                        onClick={() => {
                          const parentPath = managedFolderBrowsePath.slice(0, -1)
                          setManagedFolderBrowsePath(parentPath)
                          setTaskFormFolder(parentPath.join("/"))
                          loadManagedFolders(parentPath.join("/")).catch(() => undefined)
                        }}
                      >
                        &larr; Back
                      </button>
                    )}
                    <button
                      type="button"
                      className={`util-chip${managedFolderBrowsePath.length === 0 ? " util-chip-active" : ""}`}
                      onClick={() => {
                        setManagedFolderBrowsePath([])
                        setTaskFormFolder("")
                      }}
                    >
                      Root
                    </button>
                    {managedFolders.map((folder) => {
                      const fullPath = [...managedFolderBrowsePath, folder].join("/")
                      return (
                        <button
                          key={folder}
                          type="button"
                          className={`util-chip${taskFormFolder === fullPath ? " util-chip-active" : ""}`}
                          onClick={() => {
                            setManagedFolderBrowsePath((current) => [...current, folder])
                            setTaskFormFolder(fullPath)
                            loadManagedFolders(fullPath).catch(() => undefined)
                          }}
                        >
                          {folder}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="task-form-grid">
                <label htmlFor="task-time">
                  Time (server local)
                  <input
                    id="task-time"
                    type="time"
                    value={taskFormTime}
                    onChange={(e) => setTaskFormTime(e.target.value)}
                  />
                </label>

                <label htmlFor="task-repeat">
                  Repeat
                  <select
                    id="task-repeat"
                    value={taskFormRepeat}
                    onChange={(e) => setTaskFormRepeat(e.target.value as "once" | "daily" | "weekly" | "monthly")}
                  >
                    <option value="once">Once</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
              </div>

              {taskFormRepeat === "weekly" && (
                <label htmlFor="task-dow">
                  Day of week
                  <select
                    id="task-dow"
                    value={taskFormDayOfWeek}
                    onChange={(e) => setTaskFormDayOfWeek(Number(e.target.value))}
                  >
                    <option value={0}>Sunday</option>
                    <option value={1}>Monday</option>
                    <option value={2}>Tuesday</option>
                    <option value={3}>Wednesday</option>
                    <option value={4}>Thursday</option>
                    <option value={5}>Friday</option>
                    <option value={6}>Saturday</option>
                  </select>
                </label>
              )}

              {taskFormRepeat === "monthly" && (
                <label htmlFor="task-dom">
                  Day of month
                  <input
                    id="task-dom"
                    type="number"
                    min={1}
                    max={31}
                    value={taskFormDayOfMonth}
                    onChange={(e) => setTaskFormDayOfMonth(Number(e.target.value))}
                  />
                </label>
              )}

              <div className="task-form-grid">
                <label htmlFor="task-model">
                  Model
                  <select
                    id="task-model"
                    value={taskFormModel ? `${taskFormModel.providerID}/${taskFormModel.modelID}` : ""}
                    onChange={(e) => {
                      const nextValue = e.target.value
                      if (!nextValue) {
                        setTaskFormModel(null)
                        setTaskFormVariant(null)
                        return
                      }
                      const [providerID, modelID] = nextValue.split("/")
                      const nextModel = taskModels.find((model) => model.providerID === providerID && model.id === modelID)
                      setTaskFormModel({ providerID, modelID })
                      if (!nextModel?.variants.includes(taskFormVariant ?? "")) {
                        setTaskFormVariant(nextModel?.variants[0] ?? null)
                      }
                    }}
                  >
                    <option value="">Default model</option>
                    {taskModels.map((model) => (
                      <option key={`${model.providerID}/${model.id}`} value={`${model.providerID}/${model.id}`}>
                        {model.name} ({model.providerID})
                      </option>
                    ))}
                  </select>
                </label>

                <label htmlFor="task-thinking">
                  Thinking
                  <select
                    id="task-thinking"
                    value={taskFormVariant ?? ""}
                    onChange={(e) => setTaskFormVariant(e.target.value || null)}
                  >
                    <option value="">Default</option>
                    {(selectedTaskModelInfo?.variants ?? []).map((variant) => (
                      <option key={variant} value={variant}>{variant}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="task-research-panel">
                <label htmlFor="task-live-web" className="task-toggle-row">
                  <span>
                    <strong>Live Web Research</strong>
                    <span className="subtle">Expose Brave or Tavily as a search tool the AI can call when needed.</span>
                  </span>
                  <input
                    id="task-live-web"
                    type="checkbox"
                    checked={taskFormLiveWebResearch}
                    onChange={(e) => setTaskFormLiveWebResearch(e.target.checked)}
                  />
                </label>

                {taskFormLiveWebResearch && (
                  <div className="task-form-grid">
                    <label htmlFor="task-search-provider">
                      Search provider
                      <select
                        id="task-search-provider"
                        value={taskFormSearchProvider}
                        onChange={(e) => setTaskFormSearchProvider(e.target.value as "tavily" | "brave")}
                      >
                        <option value="tavily" disabled={!researchProviders.tavily}>Tavily{researchProviders.tavily ? "" : " (not configured)"}</option>
                        <option value="brave" disabled={!researchProviders.brave}>Brave{researchProviders.brave ? "" : " (not configured)"}</option>
                      </select>
                    </label>

                  </div>
                )}

                {taskFormLiveWebResearch && !researchProviders.tavily && !researchProviders.brave && (
                  <p className="subtle">No live research providers are configured on the wrapper server yet.</p>
                )}
              </div>

              <div className="inline-actions" style={{ marginTop: "var(--space-4)" }}>
                <button
                  onClick={() => saveTask()}
                  className="btn-primary"
                  disabled={
                    savingTask ||
                    !taskFormTitle.trim() ||
                    !taskFormPrompt.trim() ||
                    (taskFormLiveWebResearch && !(taskFormSearchProvider === "tavily" ? researchProviders.tavily : researchProviders.brave))
                  }
                >
                  {savingTask ? "Saving..." : editingTask ? "Update Task" : "Create Task"}
                </button>
                {editingTask && (
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => {
                      deleteTaskAction(editingTask.id).catch(() => undefined)
                      setTaskFormOpen(false)
                      setEditingTask(null)
                    }}
                    disabled={savingTask}
                  >
                    <TrashIcon size={16} />
                    Delete
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setTaskFormOpen(false); setEditingTask(null) }}
                  disabled={savingTask}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {view === "tasks" && viewingTaskID && !taskFormOpen && (
        <main className="panel detail fade-in task-channel-panel">
          <div className="task-channel-header">
            <div className="task-channel-title-row">
              <button className="btn-back" onClick={() => { setViewingTaskID(null); setTaskHistory([]) }}>
                <BackIcon size={18} />
                <span>Back to Tasks</span>
              </button>
              <div className="task-channel-meta">
                <h2>{selectedTask?.title ?? "Task"}</h2>
                <p className="subtle">
                  {selectedTask ? formatTaskSchedule(selectedTask) : ""}
                  {selectedTask?.folder ? ` • ${selectedTask.folder}` : ""}
                </p>
              </div>
            </div>

            {selectedTask && (
              <div className="inline-actions">
                <button className="btn-secondary btn-sm" onClick={() => openTaskForm(selectedTask)}>
                  Edit
                </button>
                <button
                  className={selectedTask.enabled ? "btn-secondary btn-sm" : "btn-primary btn-sm"}
                  onClick={() => toggleTaskEnabled(selectedTask)}
                >
                  {selectedTask.enabled ? "Pause" : "Resume"}
                </button>
                <button className="btn-primary btn-sm" onClick={() => triggerTaskRun(selectedTask.id)} disabled={selectedTask.running}>
                  {selectedTask.running ? <LoadingIcon size={14} /> : <PlayIcon size={14} />}
                  Run Now
                </button>
              </div>
            )}
          </div>

          <div className="messages task-channel-messages" ref={taskMessagesRef}>
            {orderedTaskHistory.length === 0 ? (
              <div style={{ textAlign: "center", padding: "var(--space-8)", color: "var(--secondary-500)" }}>
                <ClockIcon size={48} className="icon-empty-state" />
                <p>No runs yet</p>
                <p className="subtle">Run this task once to start the channel history.</p>
              </div>
            ) : (
              orderedTaskHistory.map((run) => (
                <div key={run.id} className="task-run-thread fade-in">
                  <div className="task-run-stamp">
                    {run.status !== "completed" && (
                      <span className={`pill ${run.status === "error" ? "retry" : "busy"}`}>
                        {run.status === "error" ? "Failed" : "Running"}
                      </span>
                    )}
                    <small>{formatTime(run.startedAt)}</small>
                  </div>

                  <article className="message assistant fade-in">
                    <header>
                      <strong>{selectedTask?.title ?? "Scheduled Task"}</strong>
                      <small>{formatTime(run.finishedAt ?? run.startedAt)}</small>
                    </header>
                    <div className="message-content message-richtext">
                      {run.error ? (
                        <div className="error">{run.error}</div>
                      ) : run.responseText ? (
                        renderRichText(run.responseText, `task-run-${run.id}`)
                      ) : (
                        <p className="subtle">Waiting for the response...</p>
                      )}
                    </div>
                  </article>
                </div>
              ))
            )}
          </div>
        </main>
      )}

      {view === "detail" && (
        <main className="panel detail fade-in">
          <div className="messages" ref={messagesRef}>
            {loadingSessionID === selectedID ? (
              <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--secondary-500)' }}>
                <LoadingIcon size={32} />
                <p>Loading session...</p>
              </div>
            ) : renderedMessages.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--secondary-500)' }}>
                <ChatIcon size={48} className="icon-empty-state" />
                <p>No messages yet</p>
                <p className="subtle">Start a conversation below</p>
              </div>
            ) : (
              renderedMessages.map((message) => {
                const text = extractText(message)
                const reasoning = extractReasoning(message)
                const tools = extractToolParts(message)
                const hasContent = text || reasoning || tools.length > 0
                if (!hasContent) return null
                return (
                  <article key={message.info.id} className={`message ${message.info.role} fade-in`}>
                    <header>
                      <strong>
                        {message.info.role === "user" ? "👤 You" : "🤖 OpenCode"}
                      </strong>
                      <small>{formatTime(message.info.time.created)}</small>
                    </header>
                    <div className="message-content">
                      {message.parts.map((part) => renderMessagePart(part))}
                    </div>
                  </article>
                )
              })
            )}
            {isSessionRunning && (
              <div className="session-status-banner running fade-in">
                <LoadingIcon size={14} /> Working...
              </div>
            )}
          </div>

          <div className="detail-footer">
            <div className="composer">
              <textarea
                ref={composerRef}
                value={composer}
                onChange={(event) => setComposerForSession(event.target.value)}
                placeholder="Type a prompt. Use /new to start a new session in this directory."
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    send().catch(() => undefined)
                  }
                }}
                disabled={!selectedSession}
              />
              <div className="composer-actions">
                {isWorking && (
                  <button 
                    onClick={abortSession}
                    disabled={!selectedSession}
                    className="btn-secondary btn-composer-abort"
                  >
                    <StopIcon size={18} />
                    Abort
                  </button>
                )}
                <button 
                  onClick={send}
                  disabled={!selectedSession}
                  className="btn-primary"
                >
                  <RocketIcon size={18} />
                  Send
                </button>
              </div>
            </div>

            {runtimeError && <div className="error fade-in">✗ {runtimeError}</div>}

            <div className="bottom-utils">
              {(permsExpanded && sessionPermissions.length > 0) && (
                <div className="util-panel util-panel-perm util-panel-sheet">
                  {sessionPermissions.map((perm) => (
                    <div key={perm.id} className="permission-request">
                      <div className="permission-details">
                        <span className="permission-name">{perm.permission}</span>
                        {perm.patterns.length > 0 && (
                          <div className="permission-patterns">
                            {perm.patterns.map((p, i) => (
                              <code key={i}>{p}</code>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="permission-actions">
                        <button
                          className="btn-primary btn-sm"
                          disabled={replyingPermID === perm.id}
                          onClick={() => replyPermission(perm.id, "once")}
                        >
                          Allow Once
                        </button>
                        <button
                          className="btn-secondary btn-sm"
                          disabled={replyingPermID === perm.id}
                          onClick={() => replyPermission(perm.id, "always")}
                        >
                          Always
                        </button>
                        <button
                          className="btn-danger btn-sm"
                          disabled={replyingPermID === perm.id}
                          onClick={() => replyPermission(perm.id, "reject")}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {sessionQuestions.length > 0 && (
                <div className="util-panel util-panel-perm util-panel-sheet">
                  {sessionQuestions.map((q) => (
                    <div key={q.id} className="permission-request">
                      <div className="permission-details">
                        <span className="permission-name">Question</span>
                        <p style={{ margin: "var(--space-1) 0 0", fontSize: "var(--text-sm)" }}>{q.question}</p>
                      </div>
                      <div className="permission-actions" style={{ flexWrap: "wrap" }}>
                        <input
                          type="text"
                          value={replyingQuestionID === q.id ? questionAnswer : ""}
                          onChange={(e) => {
                            setReplyingQuestionID(q.id)
                            setQuestionAnswer(e.target.value)
                          }}
                          placeholder="Type your answer..."
                          style={{ flex: "1 1 100%", marginBottom: "var(--space-2)" }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") replyQuestion(q.id)
                          }}
                        />
                        <button
                          className="btn-primary btn-sm"
                          disabled={replyingQuestionID === q.id && !questionAnswer.trim()}
                          onClick={() => replyQuestion(q.id)}
                        >
                          {replyingQuestionID === q.id ? "Sending..." : "Answer"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {todosExpanded && (
                <div className="util-panel util-panel-sheet">
                  {todos.length === 0 ? (
                    <p className="subtle">No todo items</p>
                  ) : (
                    todos.map((item) => (
                      <div key={item.id} className="todo-item">
                        <span className={`todo-status ${item.status}`}>
                          {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○'}
                        </span>
                        <span>{item.content}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {modelPickerOpen && (
                <div className="util-panel util-panel-sheet">
                  {loadingModels ? (
                    <div style={{ textAlign: 'center', padding: 'var(--space-3)', color: 'var(--secondary-500)' }}>
                      <LoadingIcon size={16} /> Loading models...
                    </div>
                  ) : models.length === 0 ? (
                    <p className="subtle">No models available</p>
                  ) : (
                    models.map((m) => (
                      <button
                        key={m.id}
                        className={`model-item-card${activeModel?.modelID === m.id && activeModel?.providerID === m.providerID ? " model-item-active" : ""}`}
                        onClick={() => switchModel(m.id)}
                      >
                        <span className="model-item-name">{m.name || m.id}</span>
                        <span className="model-item-provider">{m.providerID}</span>
                      </button>
                    ))
                  )}
                </div>
              )}

              {thinkingPickerOpen && (
                <div className="util-panel util-panel-sheet">
                  {loadingModels ? (
                    <div style={{ textAlign: 'center', padding: 'var(--space-3)', color: 'var(--secondary-500)' }}>
                      <LoadingIcon size={16} /> Loading variants...
                    </div>
                  ) : supportedThinkingLevels.length === 0 ? (
                    <p className="subtle">No variants advertised for the current model</p>
                  ) : (
                    supportedThinkingLevels.map((level) => (
                      <button
                        key={level}
                        className={`model-item-card${displayedThinkingLevel === level ? " model-item-active" : ""}`}
                        onClick={() => setThinking(level)}
                      >
                        <span className="model-item-name">{level}</span>
                        <span className="model-item-provider">supported</span>
                      </button>
                    ))
                  )}
                </div>
              )}

              <div className="bottom-util-bar">
              {sessionPermissions.length > 0 && (
                <button
                  type="button"
                  className={`util-chip util-chip-perm${permsExpanded ? " util-chip-active" : ""}`}
                  onClick={() => {
                    setPermsExpanded((v) => !v)
                    setTodosExpanded(false)
                    setModelPickerOpen(false)
                    setThinkingPickerOpen(false)
                  }}
                >
                  🔴 Permissions ({sessionPermissions.length})
                </button>
              )}
              {sessionQuestions.length > 0 && (
                <button
                  type="button"
                  className="util-chip util-chip-perm"
                  style={{ cursor: "default" }}
                >
                  ❓ Questions ({sessionQuestions.length})
                </button>
              )}
              <button
                type="button"
                className={`util-chip${todosExpanded ? " util-chip-active" : ""}`}
                onClick={() => {
                  setTodosExpanded((v) => !v)
                  setModelPickerOpen(false)
                  setThinkingPickerOpen(false)
                  setPermsExpanded(false)
                }}
              >
                📋 Todos{todos.length > 0 ? ` (${todos.length})` : ""}
              </button>
              <button
                type="button"
                className={`util-chip${modelPickerOpen ? " util-chip-active" : ""}`}
                onClick={() => {
                  if (!modelPickerOpen) fetchAvailableModels("model")
                  else setModelPickerOpen(false)
                  setTodosExpanded(false)
                  setThinkingPickerOpen(false)
                  setPermsExpanded(false)
                }}
              >
                🤖 Model{activeModel ? `: ${activeModel.modelID}` : ""}
              </button>
              <button
                type="button"
                className={`util-chip${thinkingPickerOpen ? " util-chip-active" : ""}`}
                onClick={() => {
                  if (!thinkingPickerOpen) fetchAvailableModels("thinking")
                  else setThinkingPickerOpen(false)
                  setTodosExpanded(false)
                  setModelPickerOpen(false)
                  setPermsExpanded(false)
                }}
              >
                🧠 Thinking: {displayedThinkingLevel ?? "n/a"}
              </button>
              <button
                type="button"
                className={`util-chip${activeAgent === "plan" ? " util-chip-active" : ""}`}
                onClick={() => setSelectedAgent(activeAgent === "build" ? "plan" : "build")}
              >
                🧭 Mode: {activeAgent}
              </button>
              {selectedModel && (
                <button
                  type="button"
                  className="util-chip util-chip-clear"
                  onClick={() => {
                    setSelectedModel(null)
                    setThinkingLevel(selectedSession?.variant ?? null)
                  }}
                >
                  ✕ Reset
                </button>
              )}
            </div>
            </div>
          </div>
        </main>
      )}

    </div>
  )
}

export default App
