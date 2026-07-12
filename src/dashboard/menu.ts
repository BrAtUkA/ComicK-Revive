/**
 * Lightweight context / dropdown menu for the dashboard. One menu at a
 * time; closes on pick, click-away, Esc, scroll, or resize. Positioned at
 * a screen point and clamped to the viewport.
 */

export interface MenuItem {
  label: string;
  icon?: string;       // inline SVG markup
  danger?: boolean;
  separator?: boolean; // renders a divider before this item
  action: () => void;
}

let activeClose: (() => void) | null = null;

export function closeMenu(): void {
  activeClose?.();
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();

  const menu = document.createElement('div');
  menu.className = 'crd-menu';

  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement('div');
      hr.className = 'crd-menu-sep';
      menu.appendChild(hr);
    }
    const btn = document.createElement('button');
    btn.className = `crd-menu-item${item.danger ? ' danger' : ''}`;
    if (item.icon) {
      const icon = document.createElement('span');
      icon.className = 'crd-menu-icon';
      icon.innerHTML = item.icon;
      btn.appendChild(icon);
    }
    btn.appendChild(document.createTextNode(item.label));
    btn.addEventListener('click', () => {
      close();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Clamp into the viewport once dimensions are known
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
    if (activeClose === close) activeClose = null;
  };
  const onAway = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  // Deferred so the opening click doesn't immediately close it
  setTimeout(() => {
    document.addEventListener('mousedown', onAway, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
  }, 0);

  activeClose = close;
}
