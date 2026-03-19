import { createIcons, icons } from 'lucide';

export function lucideIcon(name: string, className = ''): string {
  const classAttr = className ? ` class="${className}"` : '';
  return `<i data-lucide="${name}"${classAttr}></i>`;
}

export function initLucide(): void {
  createIcons({
    icons,
    nameAttr: 'data-lucide',
    attrs: {
      'stroke-width': '1.8'
    }
  });
}
