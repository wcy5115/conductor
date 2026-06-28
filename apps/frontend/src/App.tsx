import { useState } from 'react';
function App() {
  const [draftMessage, setDraftMessage] = useState('');
  return (
    <div className="app-shell"> 
    <header className="app-header">
      <h1>Conductor</h1>
    </header>
      
    <main className="conversation">
      <p>No messages yet.</p>
    </main>

    <footer className="composer">
      <textarea placeholder="Ask conductor ..." 
      rows={1} 
      value = {draftMessage}
      onChange = {(event)=> setDraftMessage(event.target.value)}
      />
      <button type="button">Send</button>
    </footer>
    </div>
  )
}

export default App
