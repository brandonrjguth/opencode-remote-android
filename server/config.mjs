import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const CONFIG_PATH = process.env.OPENCODE_REMOTE_CONFIG
  ? path.resolve(process.env.OPENCODE_REMOTE_CONFIG)
  : path.resolve(process.cwd(), "server-config.json")

const DEFAULT_CLIENT_USERNAME = process.env.OPENCODE_REMOTE_USERNAME ?? "opencode"
const DEFAULT_CLIENT_PASSWORD = process.env.OPENCODE_REMOTE_PASSWORD ?? ""

function toAbsolutePath(value) {
  if (!value) return ""
  return path.resolve(value)
}

async function readStoredConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed ? parsed : {}
  } catch {
    return {}
  }
}

export function getConfigPath() {
  return CONFIG_PATH
}

export async function readRuntimeConfig() {
  const stored = await readStoredConfig()
  return {
    rootDir: toAbsolutePath(process.env.OPENCODE_REMOTE_ROOT_DIR ?? stored.rootDir ?? ""),
    upstreamUrl: process.env.OPENCODE_UPSTREAM_URL ?? stored.upstreamUrl ?? "http://127.0.0.1:4096",
    upstreamUsername: process.env.OPENCODE_UPSTREAM_USERNAME ?? stored.upstreamUsername ?? "opencode",
    upstreamPassword: process.env.OPENCODE_UPSTREAM_PASSWORD ?? stored.upstreamPassword ?? "",
    clientUsername: process.env.OPENCODE_REMOTE_USERNAME ?? stored.clientUsername ?? DEFAULT_CLIENT_USERNAME,
    clientPassword: process.env.OPENCODE_REMOTE_PASSWORD ?? stored.clientPassword ?? DEFAULT_CLIENT_PASSWORD
  }
}

export async function updateStoredConfig(partial) {
  const current = await readStoredConfig()
  const next = {
    ...current,
    ...partial,
    rootDir: partial.rootDir === undefined ? current.rootDir : toAbsolutePath(partial.rootDir)
  }
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return next
}

export function resolveManagedDirectory(rootDir, folder = "") {
  const normalizedRoot = toAbsolutePath(rootDir)
  if (!normalizedRoot) {
    throw new Error("Root directory is not configured")
  }

  const trimmed = folder.trim()
  if (!trimmed) return normalizedRoot
  if (path.isAbsolute(trimmed)) {
    throw new Error("Folder must be relative to the configured root directory")
  }

  const target = path.resolve(normalizedRoot, trimmed)
  const relative = path.relative(normalizedRoot, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Folder must stay inside the configured root directory")
  }
  return target
}
