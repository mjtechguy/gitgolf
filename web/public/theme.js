try {
  const theme = localStorage.getItem('golf.theme');
  document.documentElement.dataset.theme = ['dark', 'light'].includes(theme) ? theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = 'dark';
}
