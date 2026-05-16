export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  isStreaming?: boolean
}

export interface ModelOption {
  id: string
  label: string
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'gpt35', label: 'GPT-3.5' },
  { id: 'gpt4', label: 'GPT-4' },
  { id: 'claude', label: 'Claude' },
]
