const root = document.documentElement;
root.dataset.appearance = root.dataset.golfRuntime === 'cloudflare-native' ? 'flare' : 'golf';
root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
try {
  const appearance = localStorage.getItem('golf.appearance');
  const theme = localStorage.getItem('golf.theme');
  if (['classic', 'golf', 'flare'].includes(appearance)) root.dataset.appearance = appearance;
  if (['dark', 'light'].includes(theme)) root.dataset.theme = theme;
} catch { /* Browser storage is optional; deployment and system defaults remain usable. */ }
const icon = document.querySelector('link[rel="icon"]');
function colorIcon() {
  let href = '/golf.svg';
  if (root.dataset.appearance === 'classic') href = root.dataset.theme === 'dark' ? '/golf-classic-dark.svg' : '/golf-classic.svg';
  if (root.dataset.appearance === 'flare') href = '/golf-flare.svg';
  icon?.setAttribute('href', href);
}
colorIcon();
window.addEventListener('golf-appearance-change', colorIcon);
