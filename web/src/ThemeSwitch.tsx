import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

const change = 'golf-appearance-change';
const snapshot = () => `${document.documentElement.dataset.appearance || 'golf'}:${document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'}`;
const subscribe = (callback: () => void) => { window.addEventListener(change, callback); return () => window.removeEventListener(change, callback); };
function useAppearance() {
  const [appearance, theme] = useSyncExternalStore(subscribe, snapshot).split(':');
  return { appearance, theme };
}
function choose(key: 'appearance' | 'theme', value: string) {
  document.documentElement.dataset[key] = value;
  try { localStorage.setItem(`golf.${key}`, value); } catch { /* The selected appearance still works in this tab. */ }
  window.dispatchEvent(new Event(change));
}

export function ThemeSwitch() {
  const { theme } = useAppearance();
  const next = theme === 'dark' ? 'light' : 'dark';
  const Icon = next === 'dark' ? Moon : Sun;
  return <button className="theme-toggle" type="button" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => choose('theme', next)}><Icon size={18} aria-hidden="true" /></button>;
}

export function AppearanceSettings() {
  const { appearance, theme } = useAppearance();
  const options = [{ name: 'classic', label: 'Classic', detail: 'Familiar forge' }, { name: 'golf', label: 'Golf', detail: 'Original Golf' }, { name: 'flare', label: 'Flare', detail: 'Cloudflare inspired' }] as const;
  return <section className="browser-panel appearance-settings" id="appearance" aria-labelledby="appearance-title">
    <div className="browser-panel-heading"><h2 id="appearance-title">Appearance</h2></div>
    <div className="appearance-settings-content">
      <p>Choose a layout and color mode for this browser.</p>
      <div className="appearance-choices" role="group" aria-label="Appearance">
        {options.map(option => <button key={option.name} type="button" aria-label={`${option.label} appearance`} aria-pressed={appearance === option.name} onClick={() => choose('appearance', option.name)}><span className={`appearance-swatch appearance-swatch-${option.name}`} aria-hidden="true"><i /><i /><i /></span><strong>{option.label}</strong><small>{option.detail}</small></button>)}
      </div>
      <div className="appearance-modes" role="group" aria-label="Color mode"><span>Color mode</span><button type="button" aria-pressed={theme === 'light'} onClick={() => choose('theme', 'light')}>Light</button><button type="button" aria-pressed={theme === 'dark'} onClick={() => choose('theme', 'dark')}>Dark</button></div>
      <p className="field-help">This preference is saved in this browser. New Cloudflare-native installs start with Flare; other installs start with Golf.</p>
    </div>
  </section>;
}
