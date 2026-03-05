import { ThumbsUp, ThumbsDown, RotateCcw, Copy, MoreHorizontal } from 'lucide-react'
import styles from './AssistantMessage.module.css'

interface AssistantMessageProps {
  content: string
  isStreaming?: boolean
}

function StarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 1 L11.3 8.7 L19 10 L11.3 11.3 L10 19 L8.7 11.3 L1 10 L8.7 8.7 Z"
        fill="#4fc3f7"
      />
    </svg>
  )
}

function StreamingDots() {
  return (
    <span className={styles.dots}>
      <span />
      <span />
      <span />
    </span>
  )
}

export default function AssistantMessage({ content, isStreaming }: AssistantMessageProps) {
  const handleCopy = () => {
    navigator.clipboard.writeText(content)
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.starRow}>
        <StarIcon />
      </div>

      <div className={styles.body}>
        {content ? (
          <p className={styles.content}>{content}</p>
        ) : (
          <StreamingDots />
        )}

        {!isStreaming && content && (
          <div className={styles.actions}>
            <button className={styles.actionBtn} title="赞">
              <ThumbsUp size={17} />
            </button>
            <button className={styles.actionBtn} title="踩">
              <ThumbsDown size={17} />
            </button>
            <button className={styles.actionBtn} title="重新生成">
              <RotateCcw size={17} />
            </button>
            <button className={styles.actionBtn} title="复制" onClick={handleCopy}>
              <Copy size={17} />
            </button>
            <button className={styles.actionBtn} title="更多">
              <MoreHorizontal size={17} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
