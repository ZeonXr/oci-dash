"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type { CpuHour, CpuReport } from "../lib/cpu-contracts";
import { instanceHref, number } from "./format";
import { Button, EmptyState } from "./ui";

// Keep chart geometry and intensity next to the chart markup.
const styles = {
  root: "w-full min-w-0 [--heat-0:#edf4ff] [--heat-1:#d1e2fc] [--heat-2:#92b7f0] [--heat-3:#4a86dc] [--heat-4:#1e57a4] [--heat-missing:#edf0f4] dark:[--heat-0:#1f2c40] dark:[--heat-1:#24436b] dark:[--heat-2:#2d5c92] dark:[--heat-3:#4b85ca] dark:[--heat-4:#79adf1] dark:[--heat-missing:#303640]",
  description:
    "mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] leading-normal text-muted-foreground",
  scroll:
    "relative min-w-0 max-w-full overflow-x-auto overscroll-x-contain pt-[3px] pb-[5px] scrollbar-thin [scrollbar-color:var(--border)_transparent] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  grid: "grid min-w-[717px] gap-2",
  row: "grid min-w-0 grid-cols-[156px_minmax(477px,1fr)_60px] items-center gap-x-3",
  axis: "mb-0.5 min-h-[15px] text-[10px] leading-[15px] text-muted-foreground",
  hours: "grid min-w-0 grid-cols-[repeat(24,minmax(17px,1fr))] gap-[3px]",
  hourLabel:
    "min-w-0 text-center whitespace-nowrap tabular-nums first:text-left last:flex last:justify-end",
  instance:
    "min-w-0 text-[11px] leading-[1.4] [&>a]:block [&>a]:w-fit [&>a]:max-w-full [&>a]:truncate [&>a]:text-foreground [&>a:hover]:text-primary [&>a:hover]:underline [&>a:hover]:underline-offset-[3px]",
  state: "block text-[9px] leading-3 text-muted-foreground",
  cellWrap: "h-[27px] min-w-0",
  cell: "block m-0 h-[27px] w-full cursor-pointer touch-manipulation appearance-none rounded-[3px] border-0 p-0 hover:ring-1 hover:ring-foreground/35 hover:ring-inset data-selected:ring-1 data-selected:ring-foreground/35 data-selected:ring-inset focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-[level=0]:bg-(--heat-0) data-[level=1]:bg-(--heat-1) data-[level=2]:bg-(--heat-2) data-[level=3]:bg-(--heat-3) data-[level=4]:bg-(--heat-4) data-[level=5]:bg-(--heat-missing)",
  average: "text-right text-[10px] whitespace-nowrap text-muted-foreground tabular-nums",
  footer:
    "mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 text-[10px] leading-[1.4] text-muted-foreground",
  legend:
    "flex flex-wrap items-center gap-x-3 gap-y-[7px] [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1 [&>span]:whitespace-nowrap",
  swatch:
    "inline-block h-[9px] w-[13px] shrink-0 rounded-[2px] data-[level=0]:bg-(--heat-0) data-[level=1]:bg-(--heat-1) data-[level=2]:bg-(--heat-2) data-[level=3]:bg-(--heat-3) data-[level=4]:bg-(--heat-4) data-[level=5]:bg-(--heat-missing)",
  peak: "ml-auto whitespace-nowrap [&>strong]:font-medium [&>strong]:text-foreground [&>strong]:tabular-nums",
  expand: "mt-2.5 flex justify-center",
  expandButton: "text-xs",
  tooltip:
    "fixed z-100 flex w-[278px] max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] flex-col gap-[5px] overflow-auto rounded-lg border border-border bg-popover px-3.5 py-3 text-xs leading-normal text-popover-foreground shadow-md wrap-anywhere",
  tooltipName: "text-xs font-semibold text-foreground",
  tooltipContext: "text-[10px] text-muted-foreground",
  tooltipTime: "mt-[3px] text-[10px] text-muted-foreground tabular-nums",
  tooltipValues:
    "mt-[5px] grid gap-1 border-t border-border pt-2 text-[11px] [&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-2 [&_dt]:shrink-0 [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:text-right [&_dd]:font-semibold [&_dd]:tabular-nums",
  tooltipNote: "mt-1 text-[11px] text-warning",
  tooltipHint: "mt-[3px] text-[10px] text-muted-foreground",
  srOnly: "sr-only",
} as const;

const HOUR = 60 * 60 * 1000;
const VISIBLE_ROWS = 6;
const LEGEND = ["<5%", "5–10%", "10–25%", "25–50%", "≥50%", "无样本"];

interface SelectedCell {
  instanceId: string;
  timestamp: number;
  anchor: HTMLButtonElement;
  pinned: boolean;
}

function observedCpu(point?: CpuHour): number | null {
  const value = point?.cpuPercent;
  return value != null &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100 &&
    point!.sampleCount > 0
    ? value
    : null;
}

function intensity(value: number | null): number {
  if (value === null) return 5;
  if (value < 5) return 0;
  if (value < 10) return 1;
  if (value < 25) return 2;
  if (value < 50) return 3;
  return 4;
}

const utcTime = (timestamp: number) =>
  new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
const percent = (value: number | null) => (value === null ? "—" : `${number(value, 1)}%`);
const cellKey = (instanceId: string, timestamp: number) => `${instanceId}:${timestamp}`;

export function CpuHeatmap({ report }: { report: CpuReport }) {
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState({ row: 0, column: 0 });
  const [selected, setSelected] = useState<SelectedCell | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const instructionsId = useId();
  const tooltipId = useId();
  const gridId = useId();

  const start = Date.parse(report.range.startTime);
  const hours = Number.isFinite(start)
    ? Array.from({ length: 24 }, (_, index) => start + index * HOUR)
    : [];
  const rows = expanded ? report.rows : report.rows.slice(0, VISIBLE_ROWS);
  const focusRow = Math.min(cursor.row, Math.max(0, rows.length - 1));
  const rowPoints = rows.map(
    (row) => new Map(row.points.map((point) => [Date.parse(point.timestamp), point])),
  );
  const selectedRowIndex = selected
    ? rows.findIndex((row) => row.instanceId === selected.instanceId)
    : -1;
  const selectedRow = rows[selectedRowIndex];
  const selectedPoint = selected ? rowPoints[selectedRowIndex]?.get(selected.timestamp) : undefined;
  const selectedValue = observedCpu(selectedPoint);
  const hasTooltip = Boolean(selected && selectedRow && hours.includes(selected.timestamp));

  function clearHideTimer() {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }

  function showCell(
    instanceId: string,
    timestamp: number,
    anchor: HTMLButtonElement,
    fromFocus = false,
  ) {
    clearHideTimer();
    setSelected((current) => {
      if (current?.pinned && !fromFocus) return current;
      if (current?.anchor === anchor) return current;
      return { instanceId, timestamp, anchor, pinned: false };
    });
  }

  function scheduleHide() {
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      setSelected((current) => {
        if (current?.pinned) return current;
        if (current?.anchor === document.activeElement && current.anchor.matches(":focus-visible"))
          return current;
        return null;
      });
    }, 120);
  }

  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!selected) return;
    function dismiss(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (tooltipRef.current?.contains(event.target) || selected?.anchor.contains(event.target))
        return;
      setSelected(null);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setSelected(null);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [selected]);

  useLayoutEffect(() => {
    if (!hasTooltip || !selected) return;
    const anchor = selected.anchor;
    function placeTooltip() {
      const tooltip = tooltipRef.current;
      if (!tooltip || !anchor.isConnected) return;
      const cell = anchor.getBoundingClientRect();
      const scroll = scrollRef.current?.getBoundingClientRect();
      if (
        scroll &&
        (cell.right <= scroll.left ||
          cell.left >= scroll.right ||
          cell.bottom <= 0 ||
          cell.top >= window.innerHeight)
      ) {
        setSelected(null);
        return;
      }
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      const left = Math.max(
        8,
        Math.min(cell.left + cell.width / 2 - width / 2, window.innerWidth - width - 8),
      );
      const preferredTop = cell.bottom + 9;
      const top = Math.max(
        8,
        preferredTop + height <= window.innerHeight - 8 ? preferredTop : cell.top - height - 9,
      );
      setPosition((current) =>
        current.left === left && current.top === top ? current : { left, top },
      );
    }
    placeTooltip();
    window.addEventListener("resize", placeTooltip);
    document.addEventListener("scroll", placeTooltip, true);
    return () => {
      window.removeEventListener("resize", placeTooltip);
      document.removeEventListener("scroll", placeTooltip, true);
    };
  }, [hasTooltip, selected, report]);

  function navigateCell(event: KeyboardEvent<HTMLButtonElement>, row: number, column: number) {
    let nextRow = row;
    let nextColumn = column;
    switch (event.key) {
      case "ArrowRight":
        nextColumn = Math.min(23, column + 1);
        break;
      case "ArrowLeft":
        nextColumn = Math.max(0, column - 1);
        break;
      case "ArrowDown":
        nextRow = Math.min(rows.length - 1, row + 1);
        break;
      case "ArrowUp":
        nextRow = Math.max(0, row - 1);
        break;
      case "Home":
        nextColumn = 0;
        if (event.ctrlKey) nextRow = 0;
        break;
      case "End":
        nextColumn = 23;
        if (event.ctrlKey) nextRow = rows.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = cellRefs.current.get(cellKey(rows[nextRow].instanceId, hours[nextColumn]));
    setCursor({ row: nextRow, column: nextColumn });
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  if (!rows.length || !hours.length) {
    return (
      <EmptyState
        title="暂无 CPU 监控数据"
        description="同步实例后，将显示最近 24 个完整 UTC 小时的 CPU 使用情况。"
      />
    );
  }

  return (
    <div className={styles.root}>
      <div
        className={styles.description}
        title={`${utcTime(start)} – ${utcTime(start + 24 * HOUR)} UTC`}
      >
        <span>近 24 小时 · UTC</span>
        <span>每格为小时平均 CPU</span>
      </div>
      <p id={instructionsId} className={styles.srOnly}>
        使用方向键查看各小时和实例，Home 或 End 跳至该行首尾，Ctrl 加 Home 或 End 跳至全表首尾。 按
        Enter 或点击固定详情，按 Escape 关闭。无样本与实际 0% 分别显示。
      </p>
      <div
        ref={scrollRef}
        className={styles.scroll}
        role="region"
        aria-label="按实例和 UTC 小时显示 CPU 使用率，可横向滚动"
        tabIndex={0}
      >
        <div
          id={gridId}
          className={styles.grid}
          role="grid"
          aria-label="最近 24 小时 CPU 热力图"
          aria-readonly="true"
          aria-rowcount={report.rows.length + 1}
          aria-colcount={26}
          aria-describedby={instructionsId}
        >
          <div role="row" className={`${styles.row} ${styles.axis}`} aria-rowindex={1}>
            <span role="columnheader" aria-colindex={1}>
              实例
            </span>
            <div className={styles.hours} role="presentation">
              {hours.map((timestamp, index) => (
                <span
                  key={timestamp}
                  role="columnheader"
                  aria-colindex={index + 2}
                  className={styles.hourLabel}
                >
                  <span className={styles.srOnly}>{utcTime(timestamp)} UTC</span>
                  <span aria-hidden="true">
                    {index % 4 === 0 || index === 23
                      ? `${new Date(timestamp).getUTCHours().toString().padStart(2, "0")}:00`
                      : ""}
                  </span>
                </span>
              ))}
            </div>
            <span role="columnheader" aria-colindex={26} className={styles.average}>
              平均
            </span>
          </div>
          {rows.map((row, rowIndex) => (
            <div
              key={row.instanceId}
              role="row"
              aria-rowindex={rowIndex + 2}
              className={styles.row}
            >
              <div role="rowheader" aria-colindex={1} className={styles.instance}>
                <Link
                  href={instanceHref(row.instanceId)}
                  title={`${row.instanceName} · ${row.accountName} · ${row.region}`}
                >
                  {row.instanceName}
                </Link>
                {row.state === "STOPPED" && <small className={styles.state}>已停止</small>}
              </div>
              <div className={styles.hours} role="presentation">
                {hours.map((timestamp, column) => {
                  const point = rowPoints[rowIndex].get(timestamp);
                  const value = observedCpu(point);
                  const isSelected =
                    hasTooltip &&
                    selected?.instanceId === row.instanceId &&
                    selected.timestamp === timestamp;
                  const label = `${row.instanceName}，${utcTime(timestamp)} 至 ${utcTime(timestamp + HOUR)} UTC，${value === null ? "无样本" : `CPU ${number(value, 2)}%`}，采样 ${point?.sampleCount ?? 0}/${point?.expectedSamples ?? 12}${point?.coverage === "partial" ? "，部分样本" : ""}`;
                  return (
                    <div
                      key={timestamp}
                      role="gridcell"
                      aria-colindex={column + 2}
                      className={styles.cellWrap}
                    >
                      <button
                        ref={(element) => {
                          const key = cellKey(row.instanceId, timestamp);
                          if (element) cellRefs.current.set(key, element);
                          else cellRefs.current.delete(key);
                        }}
                        type="button"
                        className={styles.cell}
                        data-level={intensity(value)}
                        data-selected={isSelected || undefined}
                        aria-label={label}
                        aria-describedby={isSelected ? tooltipId : undefined}
                        aria-pressed={Boolean(isSelected && selected?.pinned)}
                        tabIndex={rowIndex === focusRow && column === cursor.column ? 0 : -1}
                        onPointerEnter={(event) => {
                          if (event.pointerType !== "touch")
                            showCell(row.instanceId, timestamp, event.currentTarget);
                        }}
                        onPointerLeave={scheduleHide}
                        onFocus={(event) => {
                          setCursor({ row: rowIndex, column });
                          showCell(row.instanceId, timestamp, event.currentTarget, true);
                        }}
                        onBlur={scheduleHide}
                        onKeyDown={(event) => navigateCell(event, rowIndex, column)}
                        onClick={(event) => {
                          clearHideTimer();
                          const anchor = event.currentTarget;
                          setSelected((current) =>
                            current?.anchor === anchor && current.pinned
                              ? null
                              : { instanceId: row.instanceId, timestamp, anchor, pinned: true },
                          );
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <span role="gridcell" aria-colindex={26} className={styles.average}>
                {percent(row.averageCpuPercent)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.footer}>
        <div className={styles.legend} aria-label="CPU 使用率图例">
          {LEGEND.map((label, index) => (
            <span key={label}>
              <i className={styles.swatch} data-level={index} aria-hidden="true" />
              {label}
            </span>
          ))}
        </div>
        <span className={styles.peak}>
          最高 <strong>{percent(report.summary.peakCpuPercent)}</strong>
        </span>
      </div>
      {report.rows.length > VISIBLE_ROWS && (
        <div className={styles.expand}>
          <Button
            variant="ghost"
            className={styles.expandButton}
            aria-expanded={expanded}
            aria-controls={gridId}
            onClick={() => {
              setExpanded(!expanded);
              setSelected(null);
              if (expanded && cursor.row >= VISIBLE_ROWS)
                setCursor({ row: 0, column: cursor.column });
            }}
          >
            {expanded ? "收起" : `展开全部 ${report.rows.length} 个实例`}
          </Button>
        </div>
      )}
      {hasTooltip &&
        selected &&
        selectedRow &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className={styles.tooltip}
            style={position}
            onPointerEnter={clearHideTimer}
            onPointerLeave={scheduleHide}
          >
            <strong className={styles.tooltipName}>{selectedRow.instanceName}</strong>
            <span className={styles.tooltipContext}>
              {selectedRow.accountName} · {selectedRow.region}
            </span>
            <span className={styles.tooltipTime}>
              {utcTime(selected.timestamp)} –<br />
              {utcTime(selected.timestamp + HOUR)} UTC
            </span>
            <dl className={styles.tooltipValues}>
              <div>
                <dt>平均 CPU</dt>
                <dd>{selectedValue === null ? "无数据" : `${number(selectedValue, 2)}%`}</dd>
              </div>
              <div>
                <dt>采样数</dt>
                <dd>
                  {selectedPoint?.sampleCount ?? 0} / {selectedPoint?.expectedSamples ?? 12}
                </dd>
              </div>
            </dl>
            {selectedValue === null ? (
              <p className={styles.tooltipNote}>无有效样本，不按 0% 处理。</p>
            ) : selectedPoint?.coverage === "partial" ||
              selectedPoint?.sampleCount !== selectedPoint?.expectedSamples ? (
              <p className={styles.tooltipNote}>部分样本，均值仅基于已取得的数据。</p>
            ) : null}
            {selected.pinned && (
              <span className={styles.tooltipHint}>再次点击、点击外部或按 Esc 关闭</span>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
