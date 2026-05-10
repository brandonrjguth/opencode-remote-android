import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "./api"
import type {
  MessageEnvelope,
  MessagePart,
  PermissionRequest,
  ServerConfig,
  SessionView,
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
  BackIcon
} from "./Icons"

const STORAGE_KEY = "opencode.remote.server"
const PENDING_RUN_TTL_MS = 20_000
const SILENT_RUNTIME_ERROR_PERSIST_MS = 10_000
const PRIMARY_AGENTS = ["build", "plan"] as const

type ThinkingLevel = string | null
type SelectedModel = { providerID: string; modelID: string; variant?: string } | null
type ModelOption = { id: string; name: string; providerID: string; variants: string[] }
type BasicModelRef = { providerID: string; modelID: string }
type PrimaryAgent = (typeof PRIMARY_AGENTS)[number]

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

function renderInline(text: string) {
  const codeChunks = text.split(/(`[^`]+`)/g)
  return codeChunks.map((chunk, index) => {
    if (chunk.startsWith("`") && chunk.endsWith("`")) {
      return <code key={`code-${index}`}>{chunk.slice(1, -1)}</code>
    }

    const nodes = []
    const boldPattern = /\*\*(.+?)\*\*/g
    let cursor = 0
    let match: RegExpExecArray | null = boldPattern.exec(chunk)

    while (match) {
      if (match.index > cursor) {
        nodes.push(<span key={`text-${index}-${cursor}`}>{chunk.slice(cursor, match.index)}</span>)
      }
      nodes.push(<strong key={`bold-${index}-${match.index}`}>{match[1]}</strong>)
      cursor = match.index + match[0].length
      match = boldPattern.exec(chunk)
    }

    if (cursor < chunk.length) {
      nodes.push(<span key={`tail-${index}-${cursor}`}>{chunk.slice(cursor)}</span>)
    }

    if (nodes.length === 0) {
      return <span key={`empty-${index}`}>{chunk}</span>
    }
    return <span key={`inline-${index}`}>{nodes}</span>
  })
}

function toDisplayLines(text: string): string[] {
  const normalized = text.includes("\n") ? text : text.replace(/\s-\s(?=\S)/g, "\n- ")
  return normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
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
  const [connectedVersion, setConnectedVersion] = useState<string>("")
  const [view, setView] = useState<"settings" | "sessions" | "detail">(() => {
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const completionAudioRef = useRef<HTMLAudioElement | null>(null)
  const wasRunningRef = useRef(false)
  const appVisibleRef = useRef(true)
  const resumeSuppressUntilRef = useRef(0)
  const delayedErrorTimerRef = useRef<number | null>(null)
  const silentRuntimeErrorRef = useRef<{ message: string; since: number } | null>(null)

  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [replyingPermID, setReplyingPermID] = useState<string | null>(null)
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
  const [renameDraft, setRenameDraft] = useState("")
  const [defaultModel, setDefaultModel] = useState<BasicModelRef | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<PrimaryAgent | null>(null)
  const [managedRootDir, setManagedRootDir] = useState("")
  const [managedFolders, setManagedFolders] = useState<string[]>([])
  const [managedSessionOpen, setManagedSessionOpen] = useState(false)
  const [managedSessionFolder, setManagedSessionFolder] = useState("")
  const [loadingManagedFolders, setLoadingManagedFolders] = useState(false)
  const [creatingManagedSession, setCreatingManagedSession] = useState(false)

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedID) ?? null,
    [sessions, selectedID]
  )

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
    if (!selectedSession) return
    setThinkingLevel(selectedSession.variant ?? null)
  }, [selectedSession?.id])

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
      setSessions(mapped)
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
      const list = await api.listPermissions(config, selectedSession?.directory)
      setPermissions(list)
    } catch {
      // silent
    }
  }

  async function loadManagedFolders() {
    if (!config.host || !config.password) return
    setLoadingManagedFolders(true)
    try {
      const data = await api.listManagedFolders(config)
      setManagedRootDir(data.rootDir)
      setManagedFolders(data.folders)
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setLoadingManagedFolders(false)
    }
  }

  function openManagedSessionPanel() {
    setManagedSessionOpen(true)
    setManagedSessionFolder("")
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
    try {
      const [msg, todo] = await Promise.all([
        api.loadMessages(config, sessionID, directory),
        api.loadTodo(config, sessionID)
      ])
      setMessages(msg)
      setTodos(todo)
      if (silent) clearSilentRuntimeError()
    } catch (err) {
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
        title: "Mobile session",
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
          const created = await api.createSession(
            config,
            "Mobile session",
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
        setSelectedID(null)
        setMessages([])
        setTodos([])
        setView("sessions")
      }
      setPendingRunSince((current) => {
        if (!current[sessionID]) return current
        const { [sessionID]: _removed, ...rest } = current
        return rest
      })
      await refreshSessions(true)
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  function beginRenameSession(session: SessionView) {
    setRenamingSessionID(session.id)
    setRenameDraft(session.title)
  }

  function cancelRenameSession() {
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
      await api.abort(config, selectedSession.id)
      setPendingRunSince((current) => {
        if (!current[selectedSession.id]) return current
        const { [selectedSession.id]: _removed, ...rest } = current
        return rest
      })
      await refreshSessions()
      await loadSelected(selectedSession.id, selectedSession.directory)
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  async function replyPermission(requestID: string, reply: string) {
    setReplyingPermID(requestID)
    try {
      await api.replyPermission(config, requestID, reply, undefined, selectedSession?.directory)
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

  function toggleThinking(partID: string) {
    setExpandedThinking((prev) => ({ ...prev, [partID]: !prev[partID] }))
  }

  function toggleToolOutput(partID: string) {
    setExpandedToolOutput((prev) => ({ ...prev, [partID]: !prev[partID] }))
  }

  useEffect(() => {
    if (!config.host || !config.password) return
    refreshSessions(true).catch(() => undefined)
    refreshPermissions().catch(() => undefined)
    const timer = setInterval(() => {
      refreshSessions(true).catch(() => undefined)
      refreshPermissions().catch(() => undefined)
      if (selectedSession) {
        loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
      }
    }, 3500)
    return () => clearInterval(timer)
  }, [config.host, config.password, selectedSession?.id])

  useEffect(() => {
    const markVisible = () => {
      appVisibleRef.current = true
      resumeSuppressUntilRef.current = Date.now() + 4000
      clearSilentRuntimeError()
      setTimeout(() => {
        refreshSessions(true).catch(() => undefined)
        refreshPermissions().catch(() => undefined)
        if (selectedSession) {
          loadSelected(selectedSession.id, selectedSession.directory, true).catch(() => undefined)
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
  }, [selectedSession?.id, config.host, config.password])

  useEffect(() => {
    if (!selectedSession) return
    if (["busy", "retry"].includes(selectedSession.status)) {
      setPendingRunSince((current) => {
        if (current[selectedSession.id]) return current
        return { ...current, [selectedSession.id]: Date.now() }
      })
      return
    }
    setPendingRunSince((current) => {
      if (!current[selectedSession.id]) return current
      const { [selectedSession.id]: _removed, ...rest } = current
      return rest
    })
  }, [selectedSession?.id, selectedSession?.status])

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
            <div className="thinking-content">
              {toDisplayLines(part.text).map((line, i) => (
                <p key={i}>{renderInline(line)}</p>
              ))}
            </div>
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
      const lines = toDisplayLines(part.text)
      return (
        <div key={part.id} className="message-text-content">
          {lines.map((line, index) => (
            <p key={index}>{renderInline(line)}</p>
          ))}
        </div>
      )
    }

    return null
  }

   return (
    <div className="app-shell">
        <header className="top-nav panel fade-in">
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
        </nav>

        <div className="top-nav-actions">
          {view === "detail" && (
            <button
              type="button"
              className="btn-back mobile-back-btn"
              onClick={() => {
                setView("sessions")
                setSelectedID(null)
                setMessages([])
                setTodos([])
                setModelPickerOpen(false)
                setThinkingPickerOpen(false)
              }}
              aria-label="Back to sessions"
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
      </header>

      {menuOpen && (
        <>
          <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
          <section className="panel menu-panel overlay fade-in">
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
        </>
      )}


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
              <label htmlFor="new-session-folder">
                Folder inside root
                <input
                  id="new-session-folder"
                  value={managedSessionFolder}
                  onChange={(event) => setManagedSessionFolder(event.target.value)}
                  placeholder="Leave blank to start in the root folder"
                />
              </label>
              {managedFolders.length > 0 && (
                <div className="folder-chip-row">
                  <button
                    type="button"
                    className={`util-chip${managedSessionFolder === "" ? " util-chip-active" : ""}`}
                    onClick={() => setManagedSessionFolder("")}
                  >
                    Root
                  </button>
                  {managedFolders.map((folder) => (
                    <button
                      key={folder}
                      type="button"
                      className={`util-chip${managedSessionFolder === folder ? " util-chip-active" : ""}`}
                      onClick={() => setManagedSessionFolder(folder)}
                    >
                      {folder}
                    </button>
                  ))}
                </div>
              )}
              {loadingManagedFolders && <p className="subtle">Loading folders...</p>}
              {!managedRootDir && !loadingManagedFolders && (
                <p className="subtle">Set the wrapper root directory on the server first with `npm run server:set-root -- /absolute/path`.</p>
              )}
              <div className="inline-actions">
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
                  className={`session-card ${selectedID === session.id ? "active" : ""} fade-in`}
                >
                  <div className="header-row">
                    <h3>{session.title}</h3>
                    <span className={`pill ${session.status}`}>{session.status}</span>
                  </div>
                  {renamingSessionID === session.id && (
                    <form
                      className="rename-form"
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
                  <p>{session.directory}</p>
                   <div className="inline-actions">
                     <button
                       onClick={() => openSession(session.id, session.directory).catch(() => undefined)}
                       className="btn-primary"
                     >
                       <PlayIcon size={16} />
                       Open
                     </button>
                     <button
                       onClick={() => {
                         if (renamingSessionID === session.id) cancelRenameSession()
                         else beginRenameSession(session)
                       }}
                       className="btn-secondary"
                     >
                       {renamingSessionID === session.id ? "Close Rename" : "Rename"}
                     </button>
                     <button 
                       className="btn-danger" 
                       onClick={() => deleteSession(session.id)}
                     >
                      <TrashIcon size={16} />
                      Delete
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
          
          {runtimeError && <div className="error fade-in">✗ {runtimeError}</div>}
        </section>
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
                    if (!isWorking) {
                      send().catch(() => undefined)
                    }
                  }
                }}
                disabled={!selectedSession || isWorking}
              />
              <button 
                onClick={isWorking ? abortSession : send}
                disabled={!selectedSession}
                className={isWorking ? "btn-secondary" : "btn-primary"}
              >
                {isWorking ? (
                  <>
                    <StopIcon size={18} />
                    Abort
                  </>
                ) : (
                  <>
                    <RocketIcon size={18} />
                    Send
                  </>
                )}
              </button>
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
