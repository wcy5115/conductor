import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Plus, SlidersHorizontal, Send, ChevronDown, Square } from 'lucide-react'
import { MODEL_OPTIONS } from '../types'
import styles from './InputArea.module.css'

interface InputAreaProps {
  onSend: (text: string) => void
  isLoading: boolean
  onStop: () => void
  model: string
  onModelChange: (model: string) => void
}

export default function InputArea({
  onSend,
  isLoading,
  onStop,
  model,
  onModelChange,
}: InputAreaProps) {
  const [text, setText] = useState('')
  const [showModels, setShowModels] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSend = () => {
    if (!text.trim() || isLoading) return
    onSend(text.trim())
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const currentModel = MODEL_OPTIONS.find(m => m.id === model)

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        {/* Text input row */}
        <div className={styles.inputRow}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="请输入消息..."
            rows={1}
            disabled={isLoading}
          />
        </div>

        {/* Toolbar row */}
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <button className={styles.toolBtn} title="附件">
              <Plus size={29} />
            </button>
            <button className={styles.toolBtnPill} title="工具">
              <SlidersHorizontal size={23} />
              <span>工具</span>
            </button>
          </div>

          <div className={styles.toolbarRight}>
            {/* Model selector */}
            <div className={styles.modelSelector}>
              <button
                className={styles.modelBtn}
                onClick={() => setShowModels(v => !v)}
              >
                <span>{currentModel?.label ?? model}</span>
                <ChevronDown size={21} />
              </button>

              {showModels && (
                <div className={styles.modelDropdown}>
                  {MODEL_OPTIONS.map(opt => (
                    <button
                      key={opt.id}
                      className={`${styles.modelOption} ${opt.id === model ? styles.modelOptionActive : ''}`}
                      onClick={() => {
                        onModelChange(opt.id)
                        setShowModels(false)
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Send / Stop button */}
            {isLoading ? (
              <button className={styles.stopBtn} onClick={onStop} title="停止">
                <Square size={23} fill="currentColor" />
              </button>
            ) : (
              <button className={styles.micBtn} onClick={handleSend} title="发送">
                <Send size={26} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
