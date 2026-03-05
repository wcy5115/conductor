
import styles from './Header.module.css'

interface HeaderProps {
  title?: string
}

export default function Header({ title = '开启对话与帮助' }: HeaderProps) {
  return (
    <header className={styles.header}>
      <span className={styles.appName}>AI Chat</span>

      <span className={styles.title}>{title}</span>

    </header>
  )
}
