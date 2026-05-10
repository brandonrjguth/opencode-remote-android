#!/usr/bin/env node

import { spawn } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { updateStoredConfig } from "../server/config.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const opencodeWorkDir = os.homedir()
const runtimeDir = path.join(repoRoot, ".runtime")
const opencodeEnvPath = path.join(runtimeDir, "opencode.env")
const wrapperEnvPath = path.join(runtimeDir, "opencode-remote.env")
const systemdUserDir = path.join(os.homedir(), ".config/systemd/user")
const opencodeServiceName = "opencode.service"
const wrapperServiceName = "opencode-remote.service"
const opencodePort = 4096
const wrapperPort = 4097

function fail(message) {
  throw new Error(message)
}

function quoteSystemdValue(value) {
  return JSON.stringify(String(value))
}

function escapeUnitPath(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(" ", "\\x20")
}

function formatEnvironmentFile(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${quoteSystemdValue(value)}`)
    .join("\n")}\n`
}

async function writeExecutableFile(filePath, content, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf8")
  await chmod(filePath, mode)
}

function promptHidden(query) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Interactive TTY required to enter the password")
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const stdout = process.stdout
    const previousRawMode = stdin.isRaw
    let value = ""

    stdout.write(query)
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding("utf8")

    const cleanup = () => {
      stdin.removeListener("data", onData)
      stdin.setRawMode?.(previousRawMode ?? false)
      stdin.pause()
      stdout.write("\n")
    }

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup()
          reject(new Error("Setup cancelled"))
          return
        }

        if (char === "\r" || char === "\n") {
          cleanup()
          resolve(value)
          return
        }

        if (char === "\u0008" || char === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1)
            stdout.write("\b \b")
          }
          continue
        }

        if (char >= " ") {
          value += char
          stdout.write("*")
        }
      }
    }

    stdin.on("data", onData)
  })
}

async function askQuestion(promptText) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(promptText)
  } finally {
    rl.close()
  }
}

async function promptRequired(label, defaultValue) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : ""
    const answer = (await askQuestion(`${label}${suffix}: `)).trim()
    const value = answer || defaultValue
    if (value) return value
  }
}

async function promptYesNo(label, defaultValue) {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]"
  while (true) {
    const answer = (await askQuestion(`${label}${suffix}: `)).trim().toLowerCase()
    if (!answer) return defaultValue
    if (["y", "yes"].includes(answer)) return true
    if (["n", "no"].includes(answer)) return false
  }
}

async function promptPasswordWithConfirmation() {
  while (true) {
    const password = await promptHidden("Shared password: ")
    if (!password) {
      process.stdout.write("Password cannot be empty.\n")
      continue
    }

    const confirmation = await promptHidden("Confirm password: ")
    if (password === confirmation) return password
    process.stdout.write("Passwords did not match. Try again.\n")
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    })

    let stdout = ""
    let stderr = ""
    if (options.capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8")
      })
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8")
      })
    }

    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ code: code ?? 0, stdout, stderr })
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
    })
  })
}

async function resolveCommand(name) {
  const { stdout } = await runCommand("which", [name], { capture: true })
  const resolved = stdout.trim()
  if (!resolved) fail(`Required command not found: ${name}`)
  return resolved
}

async function checkPortUsage(port) {
  try {
    const { stdout } = await runCommand("ss", ["-ltnp", `sport = :${port}`], { capture: true, allowFailure: true })
    return stdout.trim()
  } catch {
    return ""
  }
}

async function writeServiceFile(name, content) {
  await mkdir(systemdUserDir, { recursive: true })
  const filePath = path.join(systemdUserDir, name)
  await writeFile(filePath, `${content.trim()}\n`, "utf8")
  return filePath
}

function serviceUnit({ description, after = [], wants = [], environmentFile, workingDirectory, execStart }) {
  return `
[Unit]
Description=${description}
${after.length > 0 ? `After=${after.join(" ")}` : ""}
${wants.length > 0 ? `Wants=${wants.join(" ")}` : ""}

[Service]
Type=simple
EnvironmentFile=${escapeUnitPath(environmentFile)}
WorkingDirectory=${escapeUnitPath(workingDirectory)}
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

async function maybeEnableLinger(username) {
  const lingerCheck = await runCommand("loginctl", ["show-user", username, "-p", "Linger", "--value"], { capture: true, allowFailure: true })
  if (lingerCheck.stdout.trim() === "yes") return

  const shouldEnable = await promptYesNo("Enable linger so services start before login", true)
  if (!shouldEnable) return

  const command = process.getuid?.() === 0 ? "loginctl" : "sudo"
  const args = process.getuid?.() === 0 ? ["enable-linger", username] : ["loginctl", "enable-linger", username]

  try {
    await runCommand(command, args)
  } catch (error) {
    process.stdout.write(`Could not enable linger automatically: ${error instanceof Error ? error.message : String(error)}\n`)
    process.stdout.write("Services will still start on login.\n")
  }
}

async function main() {
  if (process.platform !== "linux") fail("This setup script currently supports Linux only")

  const nodePath = process.execPath
  const npxPath = await resolveCommand("npx")
  await resolveCommand("systemctl")
  await resolveCommand("loginctl")

  const defaultRootDir = path.join(os.homedir(), "Projects")
  const username = await promptRequired("Shared username", "opencode")
  const password = await promptPasswordWithConfirmation()
  const rootDir = path.resolve(await promptRequired("Managed root directory", defaultRootDir))

  const wrapperPortUsage = await checkPortUsage(wrapperPort)
  if (wrapperPortUsage) {
    process.stdout.write(`Port ${wrapperPort} is already in use:\n${wrapperPortUsage}\n`)
    fail(`Free port ${wrapperPort} and rerun setup. The installer does not stop unrelated processes for you.`)
  }

  const opencodePortUsage = await checkPortUsage(opencodePort)
  if (opencodePortUsage) {
    process.stdout.write(`Port ${opencodePort} is already in use:\n${opencodePortUsage}\n`)
    fail(`Free port ${opencodePort} and rerun setup. The installer does not stop unrelated processes for you.`)
  }

  await mkdir(rootDir, { recursive: true })
  await mkdir(runtimeDir, { recursive: true })

  await writeExecutableFile(opencodeEnvPath, formatEnvironmentFile({
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password
  }))

  await updateStoredConfig({
    rootDir,
    upstreamUrl: `http://127.0.0.1:${opencodePort}`,
    upstreamUsername: username,
    upstreamPassword: password,
    clientUsername: username,
    clientPassword: password
  })

  await writeExecutableFile(wrapperEnvPath, formatEnvironmentFile({
    OPENCODE_UPSTREAM_URL: `http://127.0.0.1:${opencodePort}`,
    OPENCODE_UPSTREAM_USERNAME: username,
    OPENCODE_UPSTREAM_PASSWORD: password,
    OPENCODE_REMOTE_USERNAME: username,
    OPENCODE_REMOTE_PASSWORD: password,
    OPENCODE_REMOTE_CONFIG: path.join(repoRoot, "server-config.json"),
    OPENCODE_REMOTE_HOSTNAME: "0.0.0.0",
    OPENCODE_REMOTE_PORT: String(wrapperPort)
  }))

  const opencodeServicePath = await writeServiceFile(opencodeServiceName, serviceUnit({
    description: "OpenCode upstream server",
    after: ["network-online.target"],
    wants: ["network-online.target"],
    environmentFile: opencodeEnvPath,
    workingDirectory: opencodeWorkDir,
    execStart: `${quoteSystemdValue(npxPath)} -y opencode-ai serve --hostname 127.0.0.1 --port ${opencodePort}`
  }))

  const wrapperServicePath = await writeServiceFile(wrapperServiceName, serviceUnit({
    description: "OpenCode Remote wrapper server",
    after: ["network-online.target", opencodeServiceName],
    wants: ["network-online.target", opencodeServiceName],
    environmentFile: wrapperEnvPath,
    workingDirectory: repoRoot,
    execStart: `${quoteSystemdValue(nodePath)} ${quoteSystemdValue(path.join(repoRoot, "server/index.mjs"))} --hostname 0.0.0.0 --port ${wrapperPort}`
  }))

  await maybeEnableLinger(os.userInfo().username)

  await runCommand("systemctl", ["--user", "daemon-reload"])
  await runCommand("systemctl", ["--user", "enable", "--now", opencodeServiceName])
  await runCommand("systemctl", ["--user", "enable", "--now", wrapperServiceName])

  const opencodeStatus = await runCommand("systemctl", ["--user", "is-active", opencodeServiceName], { capture: true, allowFailure: true })
  const wrapperStatus = await runCommand("systemctl", ["--user", "is-active", wrapperServiceName], { capture: true, allowFailure: true })

  process.stdout.write("\nSetup complete.\n")
  process.stdout.write(`- OpenCode service: ${opencodeStatus.stdout.trim() || "unknown"}\n`)
  process.stdout.write(`- Wrapper service: ${wrapperStatus.stdout.trim() || "unknown"}\n`)
  process.stdout.write(`- Managed root: ${rootDir}\n`)
  process.stdout.write(`- Service files: ${opencodeServicePath}, ${wrapperServicePath}\n`)
  process.stdout.write(`- App port: ${wrapperPort}\n`)
  process.stdout.write("\nUseful commands:\n")
  process.stdout.write(`  systemctl --user status ${opencodeServiceName}\n`)
  process.stdout.write(`  systemctl --user status ${wrapperServiceName}\n`)
  process.stdout.write(`  journalctl --user -u ${opencodeServiceName} -f\n`)
  process.stdout.write(`  journalctl --user -u ${wrapperServiceName} -f\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
