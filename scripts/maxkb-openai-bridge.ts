import { setTimeout as delay } from 'node:timers/promises'

type ChatMessage = {
  role?: string
  content?: unknown
}

type ChatCompletionRequest = {
  model?: string
  messages?: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
}

type CcHahaServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'content_delta'; text?: string }
  | { type: 'message_complete'; usage?: TokenUsage }
  | { type: 'permission_request'; requestId: string; toolName: string; description?: string }
  | { type: 'computer_use_permission_request'; requestId: string }
  | { type: 'error'; message: string; code?: string }
  | { type: string; [key: string]: unknown }

type TokenUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

const bridgeHost = process.env.BRIDGE_HOST || '0.0.0.0'
const bridgePort = Number.parseInt(process.env.BRIDGE_PORT || '8000', 10)
const ccHahaBaseUrl = normalizeBaseUrl(process.env.CC_HAHA_BASE_URL || 'http://127.0.0.1:3456')
const ccHahaWsUrl = normalizeBaseUrl(
  process.env.CC_HAHA_WS_URL || ccHahaBaseUrl.replace(/^http/i, 'ws'),
)
const bridgeApiKey = process.env.OPENAI_API_KEY || process.env.BRIDGE_API_KEY || ''
const modelName = process.env.BRIDGE_MODEL || 'cc-haha-code'
const workDir = process.env.CC_HAHA_WORKDIR || process.cwd()
const permissionMode = process.env.CC_HAHA_PERMISSION_MODE || 'default'
const requestTimeoutMs = Number.parseInt(process.env.BRIDGE_REQUEST_TIMEOUT_MS || '600000', 10)

if (!Number.isFinite(bridgePort) || bridgePort <= 0) {
  throw new Error(`Invalid BRIDGE_PORT: ${process.env.BRIDGE_PORT}`)
}

const server = Bun.serve({
  hostname: bridgeHost,
  port: bridgePort,
  idleTimeout: Math.min(255, Math.ceil(requestTimeoutMs / 1000) + 30),
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return json({ ok: true, ccHahaBaseUrl, model: modelName })
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const auth = requireBearerAuth(req)
      if (auth) return auth

      return json({
        object: 'list',
        data: [{ id: modelName, object: 'model', created: 0, owned_by: 'cc-haha' }],
      })
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const auth = requireBearerAuth(req)
      if (auth) return auth
      return handleChatCompletion(req)
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    return json({ error: { message: 'Not found', type: 'not_found' } }, 404)
  },
})

console.log(`[maxkb-bridge] listening on http://${bridgeHost}:${server.port}`)
console.log(`[maxkb-bridge] cc-haha=${ccHahaBaseUrl}, workDir=${workDir}, model=${modelName}`)

async function handleChatCompletion(req: Request): Promise<Response> {
  let body: ChatCompletionRequest
  try {
    body = await req.json()
  } catch {
    return json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' } }, 400)
  }

  const prompt = messagesToPrompt(body.messages)
  if (!prompt.trim()) {
    return json({ error: { message: 'messages contain no text content', type: 'invalid_request_error' } }, 400)
  }

  try {
    const sessionId = await createSession()
    if (body.stream) {
      return streamChatCompletion(sessionId, prompt, body.model || modelName)
    }

    const result = await askCcHaha(sessionId, prompt)
    const created = Math.floor(Date.now() / 1000)
    const id = `chatcmpl-${crypto.randomUUID()}`

    return json({
      id,
      object: 'chat.completion',
      created,
      model: body.model || modelName,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.text },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: result.usage?.input_tokens ?? 0,
        completion_tokens: result.usage?.output_tokens ?? 0,
        total_tokens: (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[maxkb-bridge] chat completion failed:', message)
    return json({ error: { message, type: 'cc_haha_error' } }, 502)
  }
}


function streamChatCompletion(sessionId: string, prompt: string, model: string): Response {
  const id = `chatcmpl-${crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }
      const sendDone = () => {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      }
      const closeWithError = (message: string) => {
        send({ error: { message, type: 'cc_haha_error' } })
        sendDone()
        controller.close()
      }

      const ws = new WebSocket(`${ccHahaWsUrl}/ws/${encodeURIComponent(sessionId)}`)
      const timeout = setTimeout(() => {
        ws.close()
        closeWithError(`cc-haha response timed out after ${requestTimeoutMs}ms`)
      }, requestTimeoutMs)
      let settled = false
      let opened = false

      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        fn()
      }

      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })

      ws.onopen = () => {
        opened = true
        ws.send(JSON.stringify({ type: 'user_message', content: prompt }))
      }

      ws.onmessage = (event) => {
        let message: CcHahaServerMessage
        try {
          message = JSON.parse(String(event.data)) as CcHahaServerMessage
        } catch {
          return
        }

        if (message.type === 'content_delta' && typeof message.text === 'string' && message.text.length > 0) {
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: message.text }, finish_reason: null }],
          })
          return
        }

        if (message.type === 'permission_request' || message.type === 'computer_use_permission_request') {
          settle(() => {
            ws.close()
            closeWithError('cc-haha requested an interactive permission approval; use a non-interactive permission mode or ask a read-only question')
          })
          return
        }

        if (message.type === 'error') {
          settle(() => {
            ws.close()
            closeWithError(message.message)
          })
          return
        }

        if (message.type === 'message_complete') {
          settle(() => {
            ws.close()
            send({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })
            sendDone()
            controller.close()
          })
        }
      }

      ws.onerror = () => {
        settle(() => closeWithError('cc-haha websocket error'))
      }

      ws.onclose = () => {
        if (!settled && opened) {
          settle(() => closeWithError('cc-haha websocket closed before completion'))
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...corsHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}

async function createSession(): Promise<string> {
  const response = await fetch(`${ccHahaBaseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workDir, permissionMode }),
  })

  if (!response.ok) {
    throw new Error(`cc-haha create session failed: ${response.status} ${await response.text()}`)
  }

  const payload = await response.json() as { sessionId?: string }
  if (!payload.sessionId) {
    throw new Error('cc-haha create session returned no sessionId')
  }
  return payload.sessionId
}

async function askCcHaha(sessionId: string, prompt: string): Promise<{ text: string; usage?: TokenUsage }> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ccHahaWsUrl}/ws/${encodeURIComponent(sessionId)}`)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`cc-haha response timed out after ${requestTimeoutMs}ms`))
    }, requestTimeoutMs)

    let answer = ''
    let opened = false
    let settled = false

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      fn()
    }

    ws.onopen = () => {
      opened = true
      ws.send(JSON.stringify({ type: 'user_message', content: prompt }))
    }

    ws.onmessage = (event) => {
      let message: CcHahaServerMessage
      try {
        message = JSON.parse(String(event.data)) as CcHahaServerMessage
      } catch {
        return
      }

      if (message.type === 'content_delta' && typeof message.text === 'string') {
        answer += message.text
        return
      }

      if (message.type === 'permission_request' || message.type === 'computer_use_permission_request') {
        settle(() => {
          ws.close()
          reject(new Error('cc-haha requested an interactive permission approval; use a non-interactive permission mode or ask a read-only question'))
        })
        return
      }

      if (message.type === 'error') {
        settle(() => {
          ws.close()
          reject(new Error(message.message))
        })
        return
      }

      if (message.type === 'message_complete') {
        settle(() => {
          ws.close()
          resolve({ text: answer.trim(), usage: message.usage })
        })
      }
    }

    ws.onerror = () => {
      settle(() => reject(new Error('cc-haha websocket error')))
    }

    ws.onclose = () => {
      if (!settled && opened) {
        settle(() => reject(new Error('cc-haha websocket closed before completion')))
      }
    }
  })
}

function messagesToPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role || 'user'
      const content = extractTextContent(message.content)
      return content ? `${role}: ${content}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function requireBearerAuth(req: Request): Response | null {
  if (!bridgeApiKey) return null

  const authHeader = req.headers.get('authorization') || ''
  if (authHeader === `Bearer ${bridgeApiKey}`) return null

  return json({ error: { message: 'Unauthorized', type: 'authentication_error' } }, 401)
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: corsHeaders() })
}

function corsHeaders(): HeadersInit {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  }
}

process.on('SIGTERM', async () => {
  server.stop(true)
  await delay(10)
  process.exit(0)
})

process.on('SIGINT', async () => {
  server.stop(true)
  await delay(10)
  process.exit(0)
})
