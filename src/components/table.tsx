"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { clsx } from "clsx";
import { LoadingState } from "./ui";

/** Shared presentation only; each page owns its data, filters and selection. */
export function TablePanel({
  label,
  loading = false,
  refreshing = false,
  hasRows,
  empty,
  children,
  toolbar,
  footer,
  className,
  embedded = false,
}: {
  label: string;
  loading?: boolean;
  refreshing?: boolean;
  hasRows: boolean;
  empty: ReactNode;
  children: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Reuse table behavior inside an existing Card without adding another border. */
  embedded?: boolean;
}) {
  return (
    <section
      className={clsx(!embedded && "card", !embedded && "table-card", className)}
      aria-label={label}
      aria-busy={loading || refreshing}
    >
      {toolbar}
      {hasRows ? (
        <>
          <div className="table-scroll" role="region" aria-label={`${label}表格`} tabIndex={0}>
            {children}
          </div>
          {footer}
        </>
      ) : loading ? (
        <LoadingState />
      ) : (
        empty
      )}
    </section>
  );
}

export function SortableHeader({
  label,
  direction,
  onSort,
}: {
  label: string;
  direction: "ascending" | "descending";
  onSort: () => void;
}) {
  const nextOrder = direction === "ascending" ? "降序" : "升序";
  return (
    <th scope="col" aria-sort={direction}>
      <button
        type="button"
        className="table-sort"
        title={`按${label}${nextOrder}排列`}
        onClick={onSort}
      >
        {label}
        {direction === "ascending" ? (
          <ArrowUp size={13} aria-hidden="true" />
        ) : (
          <ArrowDown size={13} aria-hidden="true" />
        )}
      </button>
    </th>
  );
}
