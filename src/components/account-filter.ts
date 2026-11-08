"use client";

import { useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useApp } from "./app-provider";

/** Keep drilldowns, the account selector and browser history in the same scope. */
export function useAccountFilter() {
  const params = useSearchParams();
  const { accounts, accountsLoading } = useApp();
  const requested = params.get("accountId") || "";
  const account =
    accountsLoading || accounts.some((item) => item.id === requested) ? requested : "";

  useEffect(() => {
    if (accountsLoading || !requested || account) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("accountId") !== requested) return;
    url.searchParams.delete("accountId");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [account, accountsLoading, requested]);

  const setAccount = useCallback(
    (id: string) => {
      if (accountsLoading) return;
      const next = accounts.some((item) => item.id === id) ? id : "";
      const url = new URL(window.location.href);
      if ((url.searchParams.get("accountId") || "") === next) return;
      if (next) url.searchParams.set("accountId", next);
      else url.searchParams.delete("accountId");
      // Next.js integrates native history changes with useSearchParams. Keep
      // other query parameters and avoid a server navigation for this filter.
      window.history.pushState(null, "", url.pathname + url.search + url.hash);
    },
    [accounts, accountsLoading],
  );
  return [account, setAccount] as const;
}
