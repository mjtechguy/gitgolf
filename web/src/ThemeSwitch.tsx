import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';

export function ThemeSwitch() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const next = theme === 'dark' ? 'light' : 'dark';
  const Icon = next === 'dark' ? Moon : Sun;
  function toggleTheme() {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('golf.theme', next); } catch { /* Theme still works when storage is unavailable. */ }
  }
  return <button className="theme-toggle" type="button" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={toggleTheme}><Icon size={18} aria-hidden="true" /></button>;
}
