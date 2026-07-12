import { showMenu } from './menu';

/**
 * Custom dropdown: a select-shaped trigger that opens the shared dark menu
 * instead of the OS-drawn <select> list. Purely presentational; the value
 * lives with the caller via onChange.
 */

export interface DropdownOption {
  value: string;
  label: string;
}

const CHEVRON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
// Keeps labels aligned in the list when only the active row has a check
const BLANK_SVG = `<svg viewBox="0 0 24 24"></svg>`;

export function buildDropdown(opts: {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  title?: string;
  className?: string;
}): { el: HTMLButtonElement; setValue: (value: string) => void } {
  let current = opts.value;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = `crd-dd-trigger${opts.className ? ` ${opts.className}` : ''}`;
  if (opts.title) trigger.title = opts.title;

  const valueEl = document.createElement('span');
  valueEl.className = 'crd-dd-value';
  trigger.appendChild(valueEl);
  trigger.insertAdjacentHTML('beforeend', CHEVRON_SVG);

  const labelFor = (value: string) =>
    opts.options.find((o) => o.value === value)?.label ?? value;

  const setValue = (value: string) => {
    current = value;
    valueEl.textContent = labelFor(value);
  };
  setValue(current);

  trigger.addEventListener('click', () => {
    const rect = trigger.getBoundingClientRect();
    trigger.classList.add('open');
    showMenu(rect.left, rect.bottom + 4, opts.options.map((o) => ({
      label: o.label,
      icon: o.value === current ? CHECK_SVG : BLANK_SVG,
      action: () => {
        trigger.classList.remove('open');
        if (o.value === current) return;
        setValue(o.value);
        opts.onChange(o.value);
      },
    })));
    // The menu closes on any pick or click-away; drop the open style with it
    const clear = () => {
      trigger.classList.remove('open');
      document.removeEventListener('mousedown', clear, true);
      document.removeEventListener('keydown', clear, true);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', clear, true);
      document.addEventListener('keydown', clear, true);
    }, 0);
  });

  return { el: trigger, setValue };
}
