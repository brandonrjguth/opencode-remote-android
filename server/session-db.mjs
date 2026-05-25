import Database from "better-sqlite3"
import path from "node:path"
import os from "node:os"

const DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")

function openDB() {
  return new Database(DB_PATH, { readonly: true })
}

export function discoverSessions(rootDir, folder = "") {
  const normalizedRoot = rootDir.replace(/\/+$/g, "")
  const target = folder.trim()
    ? `${normalizedRoot}/${folder.trim()}`
    : normalizedRoot

  const db = openDB()
  try {
    const rows = db.prepare(`
      SELECT id, title, directory, agent, model,
             summary_files, summary_additions, summary_deletions,
             time_created, time_updated, time_archived
      FROM session
      WHERE directory = ?
        AND time_archived IS NULL
      ORDER BY time_updated DESC
    `).all(target)
    return rows.map((row) => {
      let modelObj = null
      if (row.model) {
        try { modelObj = JSON.parse(row.model) } catch { /* skip */ }
      }
      return {
        id: row.id,
        title: row.title,
        directory: row.directory,
        agent: row.agent || undefined,
        model: modelObj,
        time: {
          created: row.time_created,
          updated: row.time_updated
        },
        summary: {
          files: row.summary_files ?? 0,
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0
        }
      }
    })
  } finally {
    db.close()
  }
}

export function loadSessionMessages(sessionID) {
  const db = openDB()
  try {
    const messages = db.prepare(`
      SELECT id, session_id, data, time_created, time_updated
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC
    `).all(sessionID)

    return messages.map((msg) => {
      let data = {}
      try { data = JSON.parse(msg.data) } catch { /* skip */ }
      return {
        info: {
          id: msg.id,
          role: data.role || "user",
          sessionID: msg.session_id,
          time: {
            created: data.time?.created ?? msg.time_created,
            completed: data.time?.completed ?? undefined
          },
          agent: data.agent,
          modelID: data.model?.modelID,
          providerID: data.model?.providerID,
          cost: data.cost,
          tokens: data.tokens,
          error: data.error
        },
        parts: []
      }
    })
  } finally {
    db.close()
  }
}

export function loadMessageParts(sessionID) {
  const db = openDB()
  try {
    const parts = db.prepare(`
      SELECT id, message_id, session_id, data, time_created, time_updated
      FROM part
      WHERE session_id = ?
      ORDER BY time_created ASC
    `).all(sessionID)

    const byMessage = {}
    for (const part of parts) {
      let data = {}
      try { data = JSON.parse(part.data) } catch { /* skip */ }
      const entry = {
        id: part.id,
        type: data.type || "text",
        text: data.text,
        callID: data.callID,
        tool: data.tool,
        state: data.state,
        snapshot: data.snapshot,
        reason: data.reason,
        cost: data.cost,
        tokens: data.tokens,
        mime: data.mime,
        url: data.url,
        filename: data.filename,
        name: data.name,
        error: data.error,
        time: data.time,
        metadata: data.metadata,
        synthetic: data.synthetic
      }
      if (!byMessage[part.message_id]) byMessage[part.message_id] = []
      byMessage[part.message_id].push(entry)
    }
    return byMessage
  } finally {
    db.close()
  }
}

export function loadSessionTodos(sessionID) {
  const db = openDB()
  try {
    const rows = db.prepare(`
      SELECT content, status, priority
      FROM todo
      WHERE session_id = ?
      ORDER BY position ASC
    `).all(sessionID)
    return rows.map((row, i) => ({
      id: `todo-${i}`,
      content: row.content,
      status: row.status,
      priority: row.priority
    }))
  } finally {
    db.close()
  }
}

export function getAllSessions() {
  const db = openDB()
  try {
    const rows = db.prepare(`
      SELECT id, title, directory, agent, model,
             summary_files, summary_additions, summary_deletions,
             time_created, time_updated, time_archived
      FROM session
      WHERE time_archived IS NULL
      ORDER BY time_updated DESC
    `).all()
    return rows.map((row) => {
      let modelObj = null
      if (row.model) {
        try { modelObj = JSON.parse(row.model) } catch { /* skip */ }
      }
      return {
        id: row.id,
        title: row.title,
        directory: row.directory,
        agent: row.agent || undefined,
        model: modelObj,
        time: {
          created: row.time_created,
          updated: row.time_updated
        },
        summary: {
          files: row.summary_files ?? 0,
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0
        }
      }
    })
  } finally {
    db.close()
  }
}
