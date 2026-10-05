'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

import { cx } from '@/lib/cx';
export { cx };

// ---------------------------------------------------------------- Button

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:opacity-90 shadow-sm',
  brand: 'bg-brand-solid text-brand-fg hover:opacity-90 shadow-sm',
  secondary: 'bg-surface text-text border border-border hover:bg-surface-2 hover:border-border-strong shadow-sm',
  ghost: 'text-muted hover:text-text hover:bg-bg-subtle',
  danger: 'bg-danger text-danger-fg hover:opacity-90 shadow-sm',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-[15px] gap-2 rounded-xl',
  icon: 'h-9 w-9 rounded-lg justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

/** Classes for a button-looking element (also used by ButtonLink). */
export function buttonClass(variant: Variant = 'primary', size: Size = 'md', className?: string) {
  return cx(
    'inline-flex shrink-0 select-none items-center justify-center font-medium transition-[background-color,border-color,color,opacity,transform,box-shadow] duration-150 enabled:active:scale-[0.97] aria-disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)} {...rest}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

/** A link styled as a button (instead of a <button> nested in a <Link>, which is invalid HTML). */
export function ButtonLink({ variant = 'primary', size = 'md', className, ...rest }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={cx(buttonClass(variant, size, className), 'active:scale-[0.97]')} {...rest} />;
}

// ---------------------------------------------------------------- Inputs

const field = 'w-full rounded-xl border border-border bg-surface px-3.5 text-[15px] text-text placeholder:text-faint shadow-sm transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--ring)] disabled:opacity-60 sm:text-sm';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(field, 'h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(field, 'min-h-24 py-2.5 leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(field, 'h-10 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9', className)} style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23948c84' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }} {...rest}>
      {children}
    </select>
  );
}

export function Label({ children, hint, htmlFor }: { children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block">
      <span className="text-sm font-medium text-text">{children}</span>
      {hint && <span className="mt-0.5 block text-[13px] text-muted">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50', checked ? 'bg-brand' : 'bg-border-strong')}
    >
      <span className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ease-out', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

// ---------------------------------------------------------------- Surfaces

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('rounded-2xl border border-border bg-surface shadow-card', className)} {...rest}>
      {children}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand'; children: ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-bg-subtle text-muted border-border',
    success: 'bg-success-soft text-success border-transparent',
    warning: 'bg-warning-soft text-warning border-transparent',
    danger: 'bg-danger-soft text-danger border-transparent',
    info: 'bg-info-soft text-info border-transparent',
    brand: 'bg-brand-soft text-brand-ink border-transparent',
  } as const;
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[12px] font-medium', tones[tone], className)}>{children}</span>;
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cx('inline-flex', className)}>
      <Loader2 className="h-4 w-4 animate-spin text-faint" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A placeholder block shown while content loads. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx('skeleton block rounded-md', className)} />;
}

/** Placeholder rows matching the shape of a list (avatar, two lines, a pill). */
export function SkeletonList({ rows = 4, avatar = true, className }: { rows?: number; avatar?: boolean; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cx('divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          {avatar && <Skeleton className="h-9 w-9 rounded-full" />}
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={cx('h-3.5', i % 2 ? 'w-2/5' : 'w-3/5')} />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, art, title, children, action, className }: { icon?: ReactNode; art?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('animate-in flex flex-col items-center px-6 py-14 text-center', className)}>
      {art && <div className="mb-4">{art}</div>}
      {icon && !art && <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-subtle text-muted">{icon}</div>}
      <h3 className="text-base font-semibold text-balance">{title}</h3>
      {children && <div className="mt-1.5 max-w-sm text-sm text-pretty text-muted">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-pretty text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Dialog

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby={titleId}
      className={cx('dialog-in m-auto w-[calc(100%-24px)] rounded-2xl border border-border bg-surface p-0 text-text shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[2px]', wide ? 'max-w-2xl' : 'max-w-lg')}
    >
      {open && (
        <div className="flex max-h-[85dvh] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold text-balance">
              {title}
            </h2>
            <button type="button" onClick={onClose} className="rounded-lg p-1 text-faint transition-colors hover:bg-bg-subtle hover:text-text" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3.5 sm:flex-row sm:justify-end">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- Tabs

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  // Arrow keys move between tabs (only the selected one is in the Tab order).
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((it) => it.value === value);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const it = items[(next + items.length) % items.length];
    onChange(it.value);
    (e.currentTarget.querySelector(`[data-tab="${it.value}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className={cx('flex gap-1 overflow-x-auto border-b border-border scrollbar-thin', className)} role="tablist" onKeyDown={onKeyDown}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          data-tab={it.value}
          aria-selected={value === it.value}
          tabIndex={value === it.value ? 0 : -1}
          onClick={() => onChange(it.value)}
          className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', value === it.value ? 'border-text text-text' : 'border-transparent text-muted hover:border-border-strong hover:text-text')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Menu

export interface MenuItem {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * A small action menu: opens from its trigger, closes on outside click, Escape or a choice,
 * and supports arrow keys. `trigger` receives the props its button needs.
 */
export function Menu({ trigger, items, align = 'right', className }: { trigger: (p: { onClick: () => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; 'aria-controls': string }) => ReactNode; items: MenuItem[]; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      (box.current?.querySelector('[aria-haspopup]') as HTMLElement | null)?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    (box.current?.querySelector('[role="menuitem"]') as HTMLElement | null)?.focus();
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const i = list.indexOf(document.activeElement as HTMLElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  };
  return (
    <div ref={box} className={cx('relative', className)}>
      {trigger({ onClick: () => setOpen((v) => !v), 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id })}
      {open && (
        <div id={id} role="menu" onKeyDown={onKeyDown} className={cx('pop-in absolute top-full z-40 mt-1.5 min-w-44 rounded-xl border border-border bg-surface p-1 shadow-pop', align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left')}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cx('flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors focus:outline-none', it.danger ? 'text-danger hover:bg-danger-soft focus-visible:bg-danger-soft' : 'hover:bg-bg-subtle focus-visible:bg-bg-subtle')}
            >
              {it.icon && <it.icon className="h-4 w-4 shrink-0" />}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Confirm

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** The user must type this word to confirm (for irreversible actions). */
  typeToConfirm?: string;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
/** `if (!(await confirm({ title: 'Delete…?' }))) return;`: an in-app replacement for window.confirm. */
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setReq({ ...o, resolve })), []);
  const done = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
    setTyped('');
  };
  const blocked = !!req?.typeToConfirm && typed !== req.typeToConfirm;
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Dialog
        open={!!req}
        onClose={() => done(false)}
        title={req?.title ?? ''}
        footer={
          <>
            <Button variant="secondary" onClick={() => done(false)}>
              Cancel
            </Button>
            <Button variant={req?.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => done(true)} autoFocus={!req?.typeToConfirm}>
              {req?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {req?.body && <div className="text-sm text-pretty text-muted">{req.body}</div>}
        {req?.typeToConfirm && (
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) done(true);
            }}
          >
            <Label htmlFor="confirm-word">
              Type <span className="font-mono font-semibold">{req.typeToConfirm}</span> to confirm
            </Label>
            <Input id="confirm-word" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus />
          </form>
        )}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

// ---------------------------------------------------------------- Toasts

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (text: string, tone: Toast['tone'] = 'info') => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, text, tone }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 3500);
    },
    [dismiss],
  );
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={cx('toast-in pointer-events-auto flex max-w-md items-start gap-2.5 rounded-xl py-2.5 pr-2 pl-3.5 text-sm shadow-pop', t.tone === 'error' ? 'bg-danger text-danger-fg' : 'bg-primary text-primary-fg')}
          >
            {t.tone === 'error' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : t.tone === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : null}
            <span className="min-w-0 flex-1 text-pretty">{t.text}</span>
            <button type="button" onClick={() => dismiss(t.id)} className="-my-0.5 rounded-md p-0.5 opacity-60 transition-opacity hover:opacity-100" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- misc

export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const t = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
