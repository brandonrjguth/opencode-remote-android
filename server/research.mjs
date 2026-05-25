import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

function cleanSnippet(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function normalizeProvider(provider, config) {
  if (provider === "tavily" || provider === "brave") return provider
  if (config.researchProviders.tavily) return "tavily"
  if (config.researchProviders.brave) return "brave"
  return null
}

function normalizeQuery(query) {
  const value = String(query ?? "").replace(/\s+/g, " ").trim()
  if (!value) throw new Error("Search query is required")
  if (value.length < 3) throw new Error("Search query is too short")
  return value
}

function normalizeCount(count) {
  const value = Number(count)
  if (!Number.isFinite(value)) return 5
  return Math.min(Math.max(Math.floor(value), 1), 10)
}

async function fetchTavily({ query, count }, config) {
  if (!config.tavilyApiKey) {
    throw new Error("Tavily is not configured on the wrapper server")
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      search_depth: "advanced",
      max_results: count,
      include_answer: false,
      include_raw_content: false
    })
  })

  if (!response.ok) {
    throw new Error(`Tavily search failed (${response.status})`)
  }

  const payload = await response.json()
  return (payload.results ?? []).map((result) => ({
    title: cleanSnippet(result.title || result.url || "Untitled result"),
    url: cleanSnippet(result.url),
    snippet: cleanSnippet(result.content || result.snippet || "")
  }))
}

async function fetchBrave({ query, count }, config) {
  if (!config.braveApiKey) {
    throw new Error("Brave Search is not configured on the wrapper server")
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search")
  url.searchParams.set("q", query)
  url.searchParams.set("count", String(count))

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": config.braveApiKey
    }
  })

  if (!response.ok) {
    throw new Error(`Brave search failed (${response.status})`)
  }

  const payload = await response.json()
  return (payload.web?.results ?? []).map((result) => ({
    title: cleanSnippet(result.title || result.url || "Untitled result"),
    url: cleanSnippet(result.url),
    snippet: cleanSnippet(result.description || result.snippet || "")
  }))
}

export async function searchWeb({ provider, query, count }, config) {
  const selectedProvider = normalizeProvider(provider, config)
  const selectedQuery = normalizeQuery(query)
  const selectedCount = normalizeCount(count)

  if (!selectedProvider) {
    throw new Error("Live web research is enabled, but no search provider is configured")
  }

  const results = selectedProvider === "tavily"
    ? await fetchTavily({ query: selectedQuery, count: selectedCount }, config)
    : await fetchBrave({ query: selectedQuery, count: selectedCount }, config)

  return results.filter((result) => result.url || result.snippet)
}

function buildToolSource(defaultProvider, wrapperPort) {
  return `import { tool } from "@opencode-ai/plugin"

const endpoint = "http://127.0.0.1:${wrapperPort}/remote/tools/web-search"
const defaultProvider = ${JSON.stringify(defaultProvider)}

export default tool({
  description: "Search the live web using the OpenCode Remote scheduled-task search provider. Use focused search queries; do not pass an entire user prompt as the query.",
  args: {
    query: tool.schema.string().describe("Focused web search query to run."),
    provider: tool.schema.enum(["tavily", "brave"]).optional().describe("Optional provider override."),
    count: tool.schema.number().optional().describe("Maximum number of results, from 1 to 10.")
  },
  async execute(args) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        query: args.query,
        provider: args.provider || defaultProvider,
        count: args.count
      })
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(payload?.message || \`Search failed (\${response.status})\`)
    }

    return JSON.stringify(payload.results ?? [], null, 2)
  }
})
`
}

export async function installScheduledSearchTool(directory, task, config) {
  if (!task.liveWebResearch) return

  const provider = normalizeProvider(task.searchProvider, config)
  if (!provider) {
    throw new Error("Live web research is enabled, but no search provider is configured")
  }

  const wrapperPort = Number(process.env.OPENCODE_REMOTE_PORT ?? 4097)
  const toolDir = path.join(directory, ".opencode", "tools")
  await mkdir(toolDir, { recursive: true })
  await writeFile(path.join(toolDir, "remote_web_search.js"), buildToolSource(provider, wrapperPort), "utf8")
}

export function buildScheduledPrompt(task) {
  const sections = [
    "You are executing an automated scheduled task.",
    "Return only the final answer in readable markdown.",
    "Do not mention internal tooling, search providers, source collection, or implementation details.",
    "If facts are uncertain, say so clearly instead of inventing details."
  ]

  if (task.liveWebResearch) {
    sections.push(
      "You have access to the remote_web_search tool for live web research.",
      "Use remote_web_search only when current or external information is needed.",
      "Choose focused search queries yourself; do not search the entire task prompt."
    )

    if (task.searchQuery.trim()) {
      sections.push(`Optional research hint from the user:\n${task.searchQuery.trim()}`)
    }
  }

  sections.push(`Task:\n${task.prompt.trim()}`)

  return sections.join("\n\n")
}
