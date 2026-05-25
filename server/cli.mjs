import { getConfigPath, readRuntimeConfig, updateStoredConfig } from "./config.mjs"

async function main() {
  const [, , command, arg] = process.argv

  if (command === "set-root") {
    if (!arg) {
      throw new Error("Usage: npm run server:set-root -- /absolute/path")
    }
    const updated = await updateStoredConfig({ rootDir: arg })
    process.stdout.write(`Saved rootDir=${updated.rootDir} in ${getConfigPath()}\n`)
    return
  }

  if (command === "show-config") {
    const config = await readRuntimeConfig()
    process.stdout.write(`${JSON.stringify({
      ...config,
      upstreamPassword: config.upstreamPassword ? "***" : "",
      clientPassword: config.clientPassword ? "***" : "",
      tavilyApiKey: config.tavilyApiKey ? "***" : "",
      braveApiKey: config.braveApiKey ? "***" : ""
    }, null, 2)}\n`)
    return
  }

  throw new Error("Usage: npm run server:set-root -- /absolute/path | npm run server:show-config")
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
