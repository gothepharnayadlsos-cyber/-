/**
 * 直连 OpenAI 兼容接口（DeepSeek 官方、各家兼容网关都适用）。
 * 与 ctx.llm 版本保持同样的两个原语：streamText / json。
 */
import { LlmError, createJsonRunner } from './llm.js'

const RETRYABLE = new Set(['TRANSPORT', 'TIMEOUT'])

export function makeRemoteLlm({ baseUrl, apiKey, model, timeoutMs = 600000, log = () => {} }) {
  const endpoint = `${String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`

  const toMessages = (system, messages) => [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...(messages || []).map((m) => ({
      role: m.role || 'user',
      content: typeof m.content === 'string'
        ? m.content
        : (m.content || []).map((c) => c.text || '').join(''),
    })),
  ]

  async function streamOnce({ system, messages, temperature, maxTokens, signal, onDelta }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const started = Date.now()
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          ...(temperature === undefined ? {} : { temperature }),
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
          messages: toMessages(system, messages),
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        const code = `HTTP_${res.status}`
        throw new LlmError(
          `接口返回 ${res.status}${detail ? `：${detail.slice(0, 240)}` : ''}`,
          { code, retryable: res.status >= 500 || res.status === 429 },
        )
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let text = ''
      let usage = null
      let reason = 'stop'
      let deltaCount = 0
      let reasoningChars = 0

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          const s = line.trim()
          if (!s.startsWith('data:')) continue
          const payload = s.slice(5).trim()
          if (payload === '[DONE]') continue
          let json
          try {
            json = JSON.parse(payload)
          } catch {
            continue
          }
          const choice = json.choices?.[0]
          const delta = choice?.delta?.content
          if (delta) {
            deltaCount++
            text += delta
            if (onDelta) onDelta(delta)
          }
          if (choice?.delta?.reasoning_content) reasoningChars += choice.delta.reasoning_content.length
          if (choice?.finish_reason) reason = choice.finish_reason === 'length' ? 'max-tokens' : choice.finish_reason
          if (json.usage) usage = json.usage
        }
      }
      log('remote.call', { ms: Date.now() - started, chars: text.length, outTokens: usage?.completion_tokens, reason })
      return { text, usage, reason, reasoningChars, deltaCount, chunkTypes: {}, effort: 'n/a' }
    } catch (err) {
      if (err instanceof LlmError) throw err
      const aborted = controller.signal.aborted
      const timedOut = aborted && !(signal && signal.aborted)
      const e = new LlmError(
        timedOut ? `接口调用超时（${Math.round(timeoutMs / 1000)}s）` : `接口调用失败：${err?.message || err}`,
        { code: timedOut ? 'TIMEOUT' : 'TRANSPORT', retryable: true },
      )
      e.emitted = 0
      throw e
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  async function streamText(opts) {
    let lastErr
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) log('remote.retry', { attempt, code: lastErr?.code })
        return await streamOnce(opts)
      } catch (err) {
        lastErr = err
        const retryable = err.retryable || RETRYABLE.has(err.code)
        if (!retryable || opts.signal?.aborted || (Number(err.emitted) || 0) > 0) throw err
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
      }
    }
    throw lastErr
  }

  return {
    provider: 'custom',
    model,
    streamText,
    json: createJsonRunner(streamText, log),
  }
}
