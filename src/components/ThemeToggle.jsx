/**
 * Sun/moon button in the header. Switches between light and dark themes.
 * Theme state lives in App.jsx and is mirrored to localStorage so the
 * choice survives reloads. Default on first visit is 'light'.
 */
export default function ThemeToggle({ theme, onToggle }) {
  const next = theme === 'light' ? 'dark' : 'light'
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === 'light' ? '🌙' : '☀️'}
    </button>
  )
}
