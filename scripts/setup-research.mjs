#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { updateStoredConfig } from "../server/config.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const wrapperEnvPath = path.join(repoRoot, ".runtime", "opencode-remote.env")

function quoteEnvironmentValue(value) {
  return JSON.stringify(String(value))
}

function promptHidden(query) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive TTY required to enter API keys")
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

function parseEnvironmentFile(source) {
  const values = new Map()
  for (const line of source.split("\n")) {
    const separator = line.indexOf("=")
    if (separator === -1) continue
    const key = line.slice(0, separator)
    const raw = line.slice(separator + 1)
    try {
      values.set(key, JSON.parse(raw))
    } catch {
      values.set(key, raw)
    }
  }
  return values
}

function formatEnvironmentFile(values) {
  return `${[...values.entries()].map(([key, value]) => `${key}=${quoteEnvironmentValue(value)}`).join("\n")}\n`
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

async function main() {
  const source = await readFile(wrapperEnvPath, "utf8")
  const values = parseEnvironmentFile(source)
  const currentTavily = values.get("TAVILY_API_KEY") || ""
  const currentBrave = values.get("BRAVE_API_KEY") || ""

  process.stdout.write("Leave a field blank to keep its current value.\n")
  const tavily = await promptHidden(`Tavily API key${currentTavily ? " [configured]" : ""}: `)
  const brave = await promptHidden(`Brave Search API key${currentBrave ? " [configured]" : ""}: `)

  if (tavily) values.set("TAVILY_API_KEY", tavily)
  else if (!values.has("TAVILY_API_KEY")) values.set("TAVILY_API_KEY", "")

  if (brave) values.set("BRAVE_API_KEY", brave)
  else if (!values.has("BRAVE_API_KEY")) values.set("BRAVE_API_KEY", "")

  await writeFile(wrapperEnvPath, formatEnvironmentFile(values), "utf8")
  await updateStoredConfig({
    tavilyApiKey: values.get("TAVILY_API_KEY") || "",
    braveApiKey: values.get("BRAVE_API_KEY") || ""
  })
  await runCommand("systemctl", ["--user", "restart", "opencode-remote.service"])

  process.stdout.write("Research API keys updated and wrapper restarted.\n")
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
