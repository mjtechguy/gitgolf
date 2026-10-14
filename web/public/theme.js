const root = document.documentElement;
// Each appearance offers three layouts. A layout names its navigation, its content arrangement and optional features.
const layouts = {
  classic: { primer: 'top standard crumb headertabs finder create counts', workbench: 'top panes tree', reader: 'top standard reader' },
  golf: { refined: 'top standard', strokes: 'top standard keys band', tiles: 'rail panes contextnav split toptools counts' },
  flare: { kumo: 'sidebar standard contextnav', overview: 'sidebar standard band overview counts', console: 'rail standard crumb pagehead finder counts overview' },
};
const preferred = { classic: 'primer', golf: 'tiles', flare: 'console' };
const saved = key => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* The choice still applies in this tab. */ } };
// Operators may serve <html data-golf-default-appearance="appearance/layout">; a saved browser choice still wins.
const [operatorAppearance, operatorLayout] = (root.dataset.golfDefaultAppearance || '').split('/');
function apply(appearance, layout) {
  const options = layouts[appearance];
  const name = [layout, saved('golf.layout.' + appearance), appearance === operatorAppearance && operatorLayout, preferred[appearance]].find(value => Object.hasOwn(options, value));
  const [nav, content, ...features] = options[name].split(' ');
  Object.assign(root.dataset, { appearance, layout: name, nav, content, features: features.join(' ') });
}
apply([saved('golf.appearance'), operatorAppearance, root.dataset.golfRuntime === 'cloudflare-native' ? 'flare' : 'golf'].find(value => Object.hasOwn(layouts, value)));
root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
if (['dark', 'light'].includes(saved('golf.theme'))) root.dataset.theme = saved('golf.theme');
window.golfAppearance = {
  layouts,
  choose(key, value) {
    if (key === 'theme') root.dataset.theme = value;
    else if (key === 'appearance') apply(value);
    else apply(root.dataset.appearance, value);
    save(key === 'layout' ? 'golf.layout.' + root.dataset.appearance : 'golf.' + key, value);
    window.dispatchEvent(new Event('golf-appearance-change'));
  },
};
const icon = document.querySelector('link[rel="icon"]');
function colorIcon() {
  let href = '/golf.svg';
  if (root.dataset.appearance === 'classic') href = root.dataset.theme === 'dark' ? '/golf-classic-dark.svg' : '/golf-classic.svg';
  if (root.dataset.appearance === 'flare') href = '/golf-flare.svg';
  icon?.setAttribute('href', href);
}
colorIcon();
window.addEventListener('golf-appearance-change', colorIcon);
