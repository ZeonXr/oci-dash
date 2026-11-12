"use client";

import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
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
import { cn } from "@/lib/utils";
import { Button as UiButton } from "./ui/button";
import { Badge as UiBadge } from "./ui/badge";
import {
  Card as UiCard,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Alert as UiAlert, AlertDescription } from "./ui/alert";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type ButtonProps = Omit<ComponentProps<typeof UiButton>, "variant"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  icon?: ReactNode;
  loadingIcon?: ReactNode;
};
const buttonVariant = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  danger: "destructive",
} as const;

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <LoaderCircle width={size} height={size} className="shrink-0 animate-spin" aria-hidden="true" />
  );
}

export function Button({
  children,
  variant = "secondary",
  loading,
  icon,
  loadingIcon,
  ...props
}: ButtonProps) {
  return (
    <UiButton
      {...props}
      type={props.type ?? "button"}
      variant={buttonVariant[variant]}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
    >
      {props.asChild ? (
        children
      ) : (
        <>
          {(icon || loading) && (
            <span
              data-icon="inline-start"
              aria-hidden="true"
              className="inline-flex size-4 shrink-0 items-center justify-center [&>svg]:size-full"
            >
              {loading ? (loadingIcon ?? <Spinner />) : icon}
            </span>
          )}
          {children}
        </>
      )}
    </UiButton>
  );
}

export function RefreshButton({
  iconOnly = false,
  label,
  children = "刷新",
  variant = iconOnly ? "ghost" : "secondary",
  ...props
}: Omit<ButtonProps, "icon" | "loadingIcon"> & { iconOnly?: boolean; label?: string }) {
  return (
    <Button
      {...props}
      variant={variant}
      size={iconOnly ? "icon" : props.size}
      aria-label={label ?? props["aria-label"] ?? (iconOnly ? "刷新" : undefined)}
      title={props.title || label}
      icon={<RefreshCw />}
      loadingIcon={<RefreshCw className="animate-spin" />}
    >
      {iconOnly ? null : children}
    </Button>
  );
}

export function IconButton({
  label,
  children,
  title,
  ...props
}: Omit<ButtonProps, "icon" | "loadingIcon"> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...props}
          size={props.size ?? "icon"}
          variant={props.variant ?? "ghost"}
          aria-label={label}
          icon={children}
        />
      </TooltipTrigger>
      <TooltipContent>{title ?? label}</TooltipContent>
    </Tooltip>
  );
}

export function Card({
  children,
  title,
  description,
  action,
  contentClassName,
  ...props
}: Omit<ComponentProps<typeof UiCard>, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  contentClassName?: string;
}) {
  return (
    <UiCard {...props}>
      {(title || description || action) && (
        <CardHeader data-slot="card-heading">
          {title && (
            <CardTitle role="heading" aria-level={2}>
              {title}
            </CardTitle>
          )}
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={contentClassName}>{children}</CardContent>
    </UiCard>
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
    <div
      data-slot="page-heading"
      className="page-heading mb-6.5 flex flex-wrap items-start justify-between gap-4"
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {eyebrow}
          </div>
        )}
        <h1 className="flex flex-wrap items-center gap-3 text-2xl leading-[1.4] font-semibold text-foreground">
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && (
        <div
          data-slot="heading-actions"
          className="heading-actions flex flex-wrap items-center gap-2"
        >
          {children}
        </div>
      )}
    </div>
  );
}

const FieldLabelContext = createContext<string | undefined>(undefined);

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
  const labelId = useId();
  return (
    <Label
      data-slot="field"
      className={cn(
        "grid items-start gap-2 font-normal leading-normal **:data-[slot=select-trigger]:w-full",
        className,
      )}
    >
      <span id={labelId} className="text-sm font-medium">
        {label}
        {required && (
          <span className="ml-1 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </span>
      <FieldLabelContext.Provider value={labelId}>{children}</FieldLabelContext.Provider>
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </Label>
  );
}

type Option = { value: string; label: ReactNode; disabled: boolean };
function selectOptions(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        value?: string | number;
        label?: string;
        disabled?: boolean;
        children?: ReactNode;
      }>(child)
    )
      return [];
    if (child.type === Fragment || child.type === "optgroup")
      return selectOptions(child.props.children);
    if (child.type !== "option") return [];
    return [
      {
        value: String(child.props.value ?? child.props.children ?? ""),
        label: child.props.label ?? child.props.children,
        disabled: Boolean(child.props.disabled),
      },
    ];
  });
}

type SelectProps = Omit<
  ComponentProps<typeof SelectTrigger>,
  "children" | "value" | "defaultValue" | "onChange" | "onSelect" | "dir"
> & {
  children: ReactNode;
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  form?: string;
};

/** Existing option declarations are translated into the accessible shadcn Select. */
export function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled,
  name,
  required,
  form,
  className,
  ...props
}: SelectProps) {
  const labelId = useContext(FieldLabelContext);
  const emptyValue = `__empty_${useId()}`;
  const [localValue, setLocalValue] = useState(String(defaultValue ?? ""));
  const selected = value === undefined ? localValue : String(value);
  const options = selectOptions(children);
  return (
    <UiSelect
      value={selected === "" ? emptyValue : selected}
      onValueChange={(next) => {
        const decoded = next === emptyValue ? "" : next;
        setLocalValue(decoded);
        onValueChange?.(decoded);
      }}
      disabled={disabled}
      name={name}
      required={required}
      form={form}
    >
      <SelectTrigger
        {...props}
        className={cn("min-w-0", className)}
        data-value={selected}
        aria-labelledby={props["aria-labelledby"] ?? (props["aria-label"] ? undefined : labelId)}
      >
        <SelectValue placeholder="请选择" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value === "" ? emptyValue : option.value}
            data-value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
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
    <UiAlert
      data-tone={tone}
      variant={tone === "error" ? "destructive" : "default"}
      role={tone === "error" ? "alert" : "status"}
    >
      <AlertCircle />
      <AlertDescription>{children}</AlertDescription>
      {action && <div className="col-start-2 mt-2">{action}</div>}
    </UiAlert>
  );
}

type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";
const badgeTones: Record<BadgeTone, string> = {
  neutral: "",
  info: "bg-primary/10 text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-destructive/10 text-destructive",
};
const statuses: Record<string, [string, BadgeTone]> = {
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
  const [label, tone] = statuses[value] ?? [value, "neutral"];
  return (
    <Badge tone={tone}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
export function Badge({
  children,
  tone = "neutral",
  className,
  ...props
}: Omit<ComponentProps<typeof UiBadge>, "variant"> & { tone?: BadgeTone }) {
  return (
    <UiBadge {...props} variant="secondary" className={cn(badgeTones[tone], className)}>
      {children}
    </UiBadge>
  );
}

export function EmptyState({
  title = "暂无数据",
  description,
  action,
  icon,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border bg-muted text-muted-foreground">
        {icon ?? <Inbox className="size-6" />}
      </div>
      <h3 className="text-base font-medium">{title}</h3>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
export function LoadingState({ label = "正在获取数据…" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-3 px-6 py-12 text-sm text-muted-foreground"
      role="status"
    >
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
    <UiCard data-slot="metric-card">
      <CardHeader>
        <CardDescription className="flex items-center justify-between gap-2">
          {label}
          {icon}
        </CardDescription>
        <CardTitle data-slot="metric-value" className="text-2xl font-semibold tabular-nums">
          {value}
        </CardTitle>
      </CardHeader>
      {note && (
        <CardContent data-slot="metric-note" className="text-xs text-muted-foreground">
          {note}
        </CardContent>
      )}
    </UiCard>
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
    const timer = window.setTimeout(() => {
      setCopied(false);
      setError(false);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [copied, error]);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <IconButton
        label={error ? "无法复制，请手动选择文本" : copied ? "已复制" : label}
        size="icon-sm"
        onClick={async (event) => {
          event.stopPropagation();
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setError(true);
          }
        }}
      >
        {copied ? <Check /> : <Copy />}
      </IconButton>
      {error && (
        <span className="text-xs text-destructive" role="status">
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
  returnFocusRef,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const descriptionId = useId();
  const previouslyOpen = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  if (open && !previouslyOpen.current && typeof document !== "undefined") {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  previouslyOpen.current = open;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden",
          wide && "sm:max-w-3xl",
        )}
        aria-modal="true"
        aria-describedby={description ? descriptionId : undefined}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const trigger = returnFocusRef?.current ?? returnFocus.current;
          if (trigger?.isConnected) {
            event.preventDefault();
            trigger.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription id={descriptionId}>{description}</DialogDescription>}
        </DialogHeader>
        <div data-slot="dialog-body" className="grid min-h-0 min-w-0 gap-4 overflow-y-auto">
          {children}
        </div>
        {footer && <DialogFooter className="shrink-0">{footer}</DialogFooter>}
        <DialogClose asChild>
          <UiButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            disabled={busy}
            aria-label="关闭对话框"
          >
            <X />
          </UiButton>
        </DialogClose>
      </DialogContent>
    </Dialog>
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
  const current = Math.max(1, Math.min(page, pages));
  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground"
      aria-label="表格分页"
    >
      <span>
        {total
          ? `显示 ${(current - 1) * pageSize + 1}–${Math.min(current * pageSize, total)} 条，共 ${total} 条`
          : "共 0 条"}
      </span>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <Select
            aria-label="每页条数"
            value={pageSize}
            onValueChange={(value) => onPageSize(Number(value))}
          >
            <option value={10}>每页 10 条</option>
            <option value={20}>每页 20 条</option>
            <option value={50}>每页 50 条</option>
          </Select>
        )}
        <IconButton label="上一页" disabled={current <= 1} onClick={() => onPage(current - 1)}>
          <ChevronLeft />
        </IconButton>
        <span className="whitespace-nowrap tabular-nums">
          {current} / {pages}
        </span>
        <IconButton label="下一页" disabled={current >= pages} onClick={() => onPage(current + 1)}>
          <ChevronRight />
        </IconButton>
      </div>
    </nav>
  );
}
