// Applies visual settings (theme, accent, brightness, wallpaper) to the screen.
import { State } from '../core/state.js';

const WALLPAPERS = {
  nebula: 'radial-gradient(120% 90% at 78% 12%, #1c3a52 0%, transparent 55%), radial-gradient(120% 90% at 12% 88%, #2a1c52 0%, transparent 55%), linear-gradient(160deg, #0c1424, #0a0d16)',
  aurora: 'radial-gradient(120% 90% at 20% 10%, #12463f 0%, transparent 55%), radial-gradient(120% 90% at 90% 90%, #1c3a52 0%, transparent 55%), linear-gradient(160deg, #0b1a1a, #0a0d16)',
  void: 'radial-gradient(120% 120% at 50% 0%, #12151f 0%, #06070c 70%)',
  dawn: 'radial-gradient(120% 90% at 80% 10%, #5a2a3a 0%, transparent 55%), radial-gradient(120% 90% at 10% 90%, #3a2a5a 0%, transparent 55%), linear-gradient(160deg, #1a0f18, #0d0a12)',
  forest: 'radial-gradient(120% 90% at 30% 15%, #1c3a24 0%, transparent 55%), radial-gradient(120% 90% at 85% 85%, #16303a 0%, transparent 55%), linear-gradient(160deg, #0b160f, #0a0d0c)',
};

export function resolveTheme(theme) {
  if (theme === 'light') return 'light';
  if (theme === 'dark') return 'dark';
  // system
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme() {
  const screen = document.getElementById('screen');
  if (!screen) return;
  const s = State.get('settings', {}) || {};
  const theme = resolveTheme(s.theme || 'dark');
  screen.setAttribute('data-theme', theme);

  const accent = s.accent || '#6ee7d0';
  screen.style.setProperty('--accent', accent);

  const wp = WALLPAPERS[s.wallpaper] || WALLPAPERS.nebula;
  screen.style.setProperty('--wallpaper', wp);

  const brightness = s.brightness == null ? 1 : s.brightness;
  screen.style.filter = `brightness(${(0.55 + 0.45 * brightness).toFixed(3)})`;

  // Keep the browser chrome color in step with the theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f8fc' : '#0b0e14');
}
