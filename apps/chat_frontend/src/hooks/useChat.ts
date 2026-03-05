import { useState, useCallback, useRef } from 'react'
import type { Message } from '../types'

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  // Keep a ref to latest messages for use inside async callbacks
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages

  const sendMessage = useCallback(async (content: string, model: string = 'gpt35') => {
    if (!content.trim() || isLoading) return

    const userMsg: Message = { id: genId(), role: 'user', content }
    const assistantId = genId()
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      isStreaming: true,
    }

    setMessages(prev => [...prev, userMsg, assistantMsg])
    setIsLoading(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const history = messagesRef.current
      const response = await fetch('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...history, userMsg].map(m => ({
            role: m.role,
            content: m.content,
          })),
          model,
          stream: true,
        }),
        signal: controller.signal,
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!response.body) throw new Error('No response body')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') break

          try {
            const chunk = JSON.parse(data)
            const delta = chunk.choices?.[0]?.delta?.content
            if (delta) {
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantId ? { ...m, content: m.content + delta } : m
                )
              )
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? { ...m, content: '请求出错，请稍后重试。', isStreaming: false }
            : m
        )
      )
    } finally {
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId ? { ...m, isStreaming: false } : m
        )
      )
      setIsLoading(false)
    }
  }, [isLoading])

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { messages, sendMessage, isLoading, stopGeneration }
}
