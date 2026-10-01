try {
  const theme = localStorage.getItem('golf.theme');
  document.documentElement.dataset.theme = ['dark', 'light'].includes(theme) ? theme : 'system';
} catch {
  document.documentElement.dataset.theme = 'system';
}
