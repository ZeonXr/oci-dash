"use client";
import {
  createElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Inbox,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { clsx } from "clsx";
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  icon?: ReactNode;
  loadingIcon?: ReactNode;
};

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

export function Button({
  children,
  variant = "secondary",
  loading,
  icon,
  loadingIcon,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={props.type || "button"}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
      className={clsx("button", `button-${variant}`, className)}
    >
      {(icon || loading) && (
        <span className="button-icon" aria-hidden="true">
          {loading ? (loadingIcon ?? <Spinner />) : icon}
        </span>
      )}
      {children}
    </button>
  );
}
export function RefreshButton({
  iconOnly = false,
  label,
  children = "刷新",
  className,
  variant = iconOnly ? "ghost" : "secondary",
  ...props
}: Omit<ButtonProps, "icon" | "loadingIcon"> & { iconOnly?: boolean; label?: string }) {
  return (
    <Button
      {...props}
      variant={variant}
      className={clsx(iconOnly && "icon-button", className)}
      aria-label={label ?? props["aria-label"] ?? (iconOnly ? "刷新" : undefined)}
      title={props.title || label}
      icon={<RefreshCw size={16} />}
      loadingIcon={<RefreshCw size={16} className="spin" />}
    >
      {iconOnly ? null : children}
    </Button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: Omit<ButtonProps, "icon" | "loadingIcon"> & { label: string }) {
  return (
    <Button
      {...props}
      className={clsx("icon-button", props.className)}
      variant="ghost"
      aria-label={label}
      title={props.title || label}
      icon={children}
    />
  );
}
export function Card({
  children,
  title,
  description,
  action,
  className,
}: {
  children: ReactNode;
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("card", className)}>
      {(title || action) && (
        <div className="card-heading">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function PageHeader({
  title,
  description,
  children,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="heading-actions">{children}</div>}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
  className,
  required,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
  required?: boolean;
}) {
  return (
    <label className={clsx("field", className)}>
      <span className="field-label">
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const [customizable, setCustomizable] = useState(false);
  useEffect(() => {
    setCustomizable(
      CSS.supports("appearance", "base-select") && CSS.supports("selector(select::picker(select))"),
    );
  }, []);
  const enhanced = customizable && !props.multiple && (props.size ?? 1) <= 1;
  return (
    <select {...props} className={clsx("select", enhanced && "select-enhanced", className)}>
      {enhanced && (
        <button type="button" className="select-value" tabIndex={-1}>
          {/* The browser keeps this label in sync with the selected option. */}
          {createElement("selectedcontent")}
        </button>
      )}
      {children}
    </select>
  );
}
export function Alert({
  children,
  tone = "warning",
  action,
}: {
  children: ReactNode;
  tone?: "warning" | "error" | "info" | "success";
  action?: ReactNode;
}) {
  return (
    <div className={clsx("alert", `alert-${tone}`)} role={tone === "error" ? "alert" : "status"}>
      <AlertCircle size={17} />
      <div>{children}</div>
      {action}
    </div>
  );
}
const statuses: Record<string, [string, string]> = {
  RUNNING: ["运行中", "success"],
  STOPPED: ["已停止", "neutral"],
  STARTING: ["启动中", "info"],
  STOPPING: ["停止中", "warning"],
  PROVISIONING: ["创建中", "info"],
  TERMINATED: ["已终止", "neutral"],
  TERMINATING: ["终止中", "warning"],
  AVAILABLE: ["可用", "success"],
  ATTACHED: ["已附加", "success"],
  unchecked: ["待连接", "neutral"],
  connected: ["已连接", "success"],
  error: ["连接异常", "danger"],
  queued: ["等待执行", "neutral"],
  running: ["执行中", "info"],
  retrying: ["等待重试", "warning"],
  succeeded: ["已完成", "success"],
  failed: ["失败", "danger"],
  cancel_requested: ["正在取消", "warning"],
  cancelled: ["已取消", "neutral"],
  interrupted: ["执行中断", "danger"],
};
export function Status({ value }: { value: string }) {
  const [label, tone] = statuses[value] || [value, "neutral"];
  return (
    <span className={`badge badge-${tone}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function EmptyState({
  title = "暂无数据",
  description,
  action,
  icon,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <Inbox size={25} />}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function LoadingState({ label = "正在获取数据…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <Spinner size={24} />
      <span>{label}</span>
    </div>
  );
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Alert
      tone="error"
      action={
        retry && (
          <Button variant="ghost" onClick={retry}>
            重试
          </Button>
        )
      }
    >
      {message}
    </Alert>
  );
}
export function MetricCard({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-note">{note || "\u00a0"}</div>
    </div>
  );
}
export function CopyButton({
  value,
  label = "复制",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!copied && !error) return;
    const t = window.setTimeout(() => {
      setCopied(false);
      setError(false);
    }, 1800);
    return () => window.clearTimeout(t);
  }, [copied, error]);
  return (
    <span className={clsx("copy-control", className)}>
      <IconButton
        label={error ? "无法复制，请手动选择文本" : copied ? "已复制" : label}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setError(true);
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
      {error && (
        <span className="copy-error" role="status">
          请手动复制
        </span>
      )}
    </span>
  );
}
export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  busy = false,
  wide = false,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Capture the trigger before a newly mounted child's autoFocus runs.
  const returnFocus = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !d.contains(active)) returnFocus.current = active;
      d.showModal();
    } else if (!open && d.open) d.close();
    return () => {
      if (d.open) d.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={clsx("modal", wide && "modal-wide")}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <IconButton label="关闭对话框" disabled={busy} onClick={onClose}>
          <X size={19} />
        </IconButton>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </dialog>
  );
}
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(1, Math.min(page, pages));
  return (
    <nav className="pagination" aria-label="表格分页">
      <span>
        {total
          ? `显示 ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, total)} 条，共 ${total} 条`
          : "共 0 条"}
      </span>
      <div>
        {onPageSize && (
          <Select
            aria-label="每页条数"
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
          >
            <option value={10}>每页 10 条</option>
            <option value={20}>每页 20 条</option>
            <option value={50}>每页 50 条</option>
          </Select>
        )}
        <IconButton
          label="上一页"
          disabled={currentPage <= 1}
          onClick={() => onPage(currentPage - 1)}
        >
          <ChevronLeft size={16} />
        </IconButton>
        <span>
          {currentPage} / {pages}
        </span>
        <IconButton
          label="下一页"
          disabled={currentPage >= pages}
          onClick={() => onPage(currentPage + 1)}
        >
          <ChevronRight size={16} />
        </IconButton>
      </div>
    </nav>
  );
}
