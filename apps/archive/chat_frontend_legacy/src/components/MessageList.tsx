import { useEffect, useRef } from 'react'
import type { Message } from '../types'
import UserMessage from './UserMessage'
import AssistantMessage from './AssistantMessage'
import styles from './MessageList.module.css'

interface MessageListProps {
  messages: Message[]
}

export default function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className={styles.container}>
      <div className={styles.inner}>
        {messages.map(msg =>
          msg.role === 'user' ? (
            <UserMessage key={msg.id} content={msg.content} />
          ) : (
            <AssistantMessage
              key={msg.id}
              content={msg.content}
              isStreaming={msg.isStreaming}
            />
          )
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
