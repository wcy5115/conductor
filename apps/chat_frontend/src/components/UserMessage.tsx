import { Copy, Pencil } from 'lucide-react'
import styles from './UserMessage.module.css'

interface UserMessageProps {
  content: string
}

export default function UserMessage({ content }: UserMessageProps) {
  const handleCopy = () => {
    navigator.clipboard.writeText(content)
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.actions}>
        <button className={styles.actionBtn} title="复制" onClick={handleCopy}>
          <Copy size={16} />
        </button>
        <button className={styles.actionBtn} title="编辑">
          <Pencil size={16} />
        </button>
      </div>
      <div className={styles.bubble}>{content}</div>
    </div>
  )
}
