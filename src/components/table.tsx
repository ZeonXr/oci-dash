"use client";
import { TableHead } from "@/components/ui/table";
import { Card } from "@/components/ui/card";

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
  const Container = embedded ? "section" : Card;
  return (
    <Container
      role="region"
      className={clsx(
        "min-w-0 gap-0 overflow-hidden py-0",
        !embedded && "card table-card",
        className,
      )}
      aria-label={label}
      aria-busy={loading || refreshing}
    >
      {toolbar}
      {hasRows ? (
        <>
          <div
            className="table-scroll min-w-0 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            role="region"
            aria-label={`${label}表格`}
            tabIndex={0}
          >
            {children}
          </div>
          {footer}
        </>
      ) : loading ? (
        <LoadingState />
      ) : (
        empty
      )}
    </Container>
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
    <TableHead scope="col" aria-sort={direction}>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-sm whitespace-nowrap hover:text-foreground"
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
    </TableHead>
  );
}
