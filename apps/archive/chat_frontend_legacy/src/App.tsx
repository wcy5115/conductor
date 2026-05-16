import { useState } from 'react'
import Header from './components/Header'
import MessageList from './components/MessageList'
import InputArea from './components/InputArea'
import { useChat } from './hooks/useChat'

export default function App() {
  const { messages, sendMessage, isLoading, stopGeneration } = useChat()
  const [model, setModel] = useState('gpt35')

  return (
    <>
      <Header />
      <MessageList messages={messages} />
      <InputArea
        onSend={text => sendMessage(text, model)}
        isLoading={isLoading}
        onStop={stopGeneration}
        model={model}
        onModelChange={setModel}
      />
    </>
  )
}
