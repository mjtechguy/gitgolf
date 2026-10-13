import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

type Choice = 'appearance' | 'layout' | 'theme';
declare global { interface Window { golfAppearance: { layouts: Record<string, Record<string, string>>; choose(key: Choice, value: string): void } } }

const change = 'golf-appearance-change';
const snapshot = () => { const { appearance = 'golf', layout = '', nav = 'top', content = 'standard', features = '', theme } = document.documentElement.dataset; return [appearance, layout, nav, content, features, theme === 'light' ? 'light' : 'dark'].join(':'); };
const subscribe = (callback: () => void) => { window.addEventListener(change, callback); return () => window.removeEventListener(change, callback); };
// Layout parts are read from the document, so components follow the same choice the stylesheet does.
export function useAppearance() {
  const [appearance = 'golf', layout, nav, content, features = '', theme] = useSyncExternalStore(subscribe, snapshot).split(':');
  return { appearance, layout, nav, content, theme, feature: (name: string) => features.split(' ').includes(name) };
}
const choose = (key: Choice, value: string) => window.golfAppearance.choose(key, value);

export function ThemeSwitch() {
  const { theme } = useAppearance();
  const next = theme === 'dark' ? 'light' : 'dark';
  const Icon = next === 'dark' ? Moon : Sun;
  return <button className="theme-toggle" type="button" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => choose('theme', next)}><Icon size={18} aria-hidden="true" /></button>;
}

const layoutDetails: Record<string, [string, string]> = {
  primer: ['Primer', 'Header tabs with an About rail'], workbench: ['Workbench', 'Dense, with a file tree pane'], reader: ['Reader', 'README beside the file list'],
  refined: ['Refined', 'Top bar with an About rail'], strokes: ['Fewer strokes', 'Keyboard hints and a scorecard'], tiles: ['Tiles', 'Side rail and edge-to-edge panes'],
  kumo: ['Kumo', 'Full sidebar navigation'], overview: ['Overview', 'Sidebar with a status band'], console: ['Console', 'Icon rail and the widest content'],
};

export function AppearanceSettings() {
  const { appearance, layout, theme } = useAppearance();
  const options = [{ name: 'classic', label: 'Classic', detail: 'Familiar forge' }, { name: 'golf', label: 'Golf', detail: 'Original Golf' }, { name: 'flare', label: 'Flare', detail: 'Cloudflare inspired' }] as const;
  return <section className="browser-panel appearance-settings" id="appearance" aria-labelledby="appearance-title">
    <div className="browser-panel-heading"><h2 id="appearance-title">Appearance</h2></div>
    <div className="appearance-settings-content">
      <p>Choose an appearance, a layout and a color mode for this browser.</p>
      <div className="appearance-choices" role="group" aria-label="Appearance">
        {options.map(option => <button key={option.name} type="button" aria-label={`${option.label} appearance`} aria-pressed={appearance === option.name} onClick={() => choose('appearance', option.name)}><span className={`appearance-swatch appearance-swatch-${option.name}`} aria-hidden="true"><i /><i /><i /></span><strong>{option.label}</strong><small>{option.detail}</small></button>)}
      </div>
      <div className="appearance-choices appearance-layouts" role="group" aria-label="Layout">
        {Object.keys(window.golfAppearance.layouts[appearance] ?? {}).map(name => <button key={name} type="button" aria-label={`${layoutDetails[name]![0]} layout`} aria-pressed={layout === name} onClick={() => choose('layout', name)}><span className={`layout-sketch layout-sketch-${name}`} aria-hidden="true"><i /><i /><i /></span><strong>{layoutDetails[name]![0]}</strong><small>{layoutDetails[name]![1]}</small></button>)}
      </div>
      <div className="appearance-modes" role="group" aria-label="Color mode"><span>Color mode</span><button type="button" aria-pressed={theme === 'light'} onClick={() => choose('theme', 'light')}>Light</button><button type="button" aria-pressed={theme === 'dark'} onClick={() => choose('theme', 'dark')}>Dark</button></div>
      <p className="field-help">These choices are saved in this browser, and each appearance remembers its own layout. New Cloudflare-native installs start with Flare; other installs start with Golf.</p>
    </div>
  </section>;
}
