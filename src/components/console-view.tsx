"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, Keyboard, Maximize2, Minimize2, Monitor, Plug, Unplug } from "lucide-react";
import type RFB from "@novnc/novnc";
import type { InstanceSummary } from "@/lib/contracts";
import type { ConsoleSessionSummary, ConsoleSocketTicket } from "@/lib/console-contracts";
import { api, errorMessage, useResource } from "./api";
import { Badge, Button, ErrorState, LoadingState, PageHeader, Status } from "./ui";
import { formatDate } from "./format";
import { RegionLabel } from "./region-label";

type SessionResponse = {
  session: ConsoleSessionSummary | null;
};
type TransportState = "idle" | "connecting" | "connected" | "disconnected";
const stateLabels = {
  preparing: "正在准备",
  ready: "通道已就绪",
  connected: "会话正在使用",
  closing: "正在断开",
  closed: "已断开",
  failed: "连接失败",
};
function isActive(session: ConsoleSessionSummary | null) {
  return Boolean(
    session && (session.cleanupPending || !["closed", "failed"].includes(session.state)),
  );
}
function sessionUrl(id: string) {
  return `/api/console/sessions/${encodeURIComponent(id)}`;
}

// Used only for a session this page created. It also handles a create response
// arriving after navigation, when the React tree can no longer own the session.
function closeOnLeave(id: string) {
  const url = `${sessionUrl(id)}/close`;
  try {
    if (navigator.sendBeacon(url, new Blob(["{}"], { type: "application/json" }))) return;
  } catch {
    // A keepalive request is the fallback when sendBeacon is unavailable/full.
  }
  void fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    keepalive: true,
  }).catch(() => undefined);
}

export function ConsoleView({ instanceId }: { instanceId: string }) {
  const resource = useResource<{ instance: InstanceSummary }>(
    `/api/instances/${encodeURIComponent(instanceId)}`,
    30000,
  );
  const instance = resource.data?.instance;
  const terminated = instance?.state === "TERMINATED" || instance?.state === "TERMINATING";
  const [session, setSession] = useState<ConsoleSessionSummary | null>(null);
  const [ownedId, setOwnedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [transport, setTransport] = useState<TransportState>("idle");
  const [fit, setFit] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const screen = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const alive = useRef(false);
  const owned = useRef<string | null>(null);
  const currentSession = useRef<ConsoleSessionSummary | null>(null);
  const currentTransport = useRef<TransportState>("idle");
  const rfb = useRef<RFB | null>(null);
  const disposeRfb = useRef<(() => void) | null>(null);
  const mutation = useRef(0);
  const creatingRef = useRef(false);
  const closingRef = useRef(false);
  const pollingRef = useRef(false);
  const lastTouch = useRef(0);
  const fitRef = useRef(true);

  const showTransport = useCallback((value: TransportState) => {
    currentTransport.current = value;
    if (alive.current) setTransport(value);
  }, []);
  const stopRfb = useCallback(() => {
    disposeRfb.current?.();
    disposeRfb.current = null;
    rfb.current = null;
  }, []);
  const receive = useCallback((value: ConsoleSessionSummary | null) => {
    if (!alive.current) return;
    // Retain the last completed result after the global slot becomes empty.
    const next = value || (isActive(currentSession.current) ? null : currentSession.current);
    currentSession.current = next;
    setSession(next);
    setLoaded(true);
    setFetchError(null);
    if (owned.current && value?.id === owned.current && !isActive(value)) {
      owned.current = null;
      setOwnedId(null);
    }
  }, []);
  const refresh = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const revision = mutation.current;
    const id = owned.current;
    try {
      const result = await api<SessionResponse>(id ? sessionUrl(id) : "/api/console/session", {
        signal: AbortSignal.timeout(10000),
      });
      if (alive.current && revision === mutation.current && !creatingRef.current)
        receive(result.session);
    } catch (reason) {
      if (alive.current && revision === mutation.current) setFetchError(errorMessage(reason));
    } finally {
      pollingRef.current = false;
    }
  }, [receive]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    const leave = () => {
      mutation.current += 1;
      stopRfb();
      if (owned.current) closeOnLeave(owned.current);
      owned.current = null;
    };
    window.addEventListener("pagehide", leave);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [refresh, stopRfb]);

  const closeSession = useCallback(
    async (id: string) => {
      if (closingRef.current) return;
      closingRef.current = true;
      mutation.current += 1;
      setClosing(true);
      stopRfb();
      showTransport("disconnected");
      try {
        const result = await api<SessionResponse>(sessionUrl(id), {
          method: "DELETE",
        });
        if (alive.current) {
          mutation.current += 1;
          receive(result.session);
        }
      } catch (reason) {
        if (alive.current) {
          mutation.current += 1;
          setError(`断开未完成：${errorMessage(reason)}。可以重试断开。`);
        }
      } finally {
        closingRef.current = false;
        if (alive.current) setClosing(false);
      }
    },
    [receive, showTransport, stopRfb],
  );

  const connect = async () => {
    if (
      creatingRef.current ||
      closingRef.current ||
      !loaded ||
      fetchError ||
      isActive(currentSession.current) ||
      !instance ||
      terminated
    )
      return;
    creatingRef.current = true;
    mutation.current += 1;
    const revision = mutation.current;
    setCreating(true);
    setError(null);
    showTransport("idle");
    try {
      // Do not abort this request on navigation: its eventual id is needed to
      // close a session that the server may already have created.
      const result = await api<{ session: ConsoleSessionSummary }>("/api/console/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceId }),
      });
      if (!alive.current || revision !== mutation.current) {
        closeOnLeave(result.session.id);
        return;
      }
      owned.current = result.session.id;
      setOwnedId(result.session.id);
      receive(result.session);
    } catch (reason) {
      if (alive.current) {
        setError(errorMessage(reason));
        // A conflict or lost response may mean another session owns the slot.
        // Recheck before allowing another create request.
        setLoaded(false);
      }
    } finally {
      creatingRef.current = false;
      if (alive.current) {
        setCreating(false);
        void refresh();
      }
    }
  };

  const attachable = Boolean(
    ownedId &&
    session?.id === ownedId &&
    ["ready", "connected"].includes(session.state) &&
    !session.cleanupPending,
  );
  useEffect(() => {
    if (!ownedId || !attachable) return;
    let cancelled = false;
    let client: RFB | null = null;
    let handshakeTimer: number | undefined;
    const id = ownedId;
    const revision = mutation.current;
    const valid = () =>
      !cancelled &&
      alive.current &&
      owned.current === id &&
      !closingRef.current &&
      revision === mutation.current;
    showTransport("connecting");
    const fail = (message: string) => {
      if (!valid()) return;
      setError(message);
      showTransport("disconnected");
      void closeSession(id);
    };
    void (async () => {
      try {
        const { default: Rfb } = await import("@novnc/novnc");
        if (!valid()) return;
        const ticket = await api<ConsoleSocketTicket>(`${sessionUrl(id)}/ticket`, {
          method: "POST",
        });
        if (!valid() || !screen.current) return;
        const url = new URL(ticket.path, window.location.origin);
        const expiry = Date.parse(ticket.expiresAt);
        if (
          url.origin !== window.location.origin ||
          url.search ||
          url.hash ||
          !ticket.ticket ||
          !Number.isFinite(expiry) ||
          expiry <= Date.now()
        ) {
          throw new Error("Invalid console ticket");
        }
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        client = new Rfb(screen.current, url.href, {
          wsProtocols: ["oci-console", `ticket.${ticket.ticket}`],
        });
        rfb.current = client;
        client.scaleViewport = fitRef.current;
        client.resizeSession = false;
        client.focusOnClick = true;
        const connected = () => {
          if (!valid()) return;
          window.clearTimeout(handshakeTimer);
          lastTouch.current = 0;
          showTransport("connected");
          client?.focus();
        };
        const disconnected = () => fail("控制台连接已断开。会话清理完成后可重试连接。");
        const securityFailure = () => fail("控制台认证未通过。会话清理完成后可重试连接。");
        client.addEventListener("connect", connected);
        client.addEventListener("disconnect", disconnected);
        client.addEventListener("securityfailure", securityFailure);
        const thisClient = client;
        handshakeTimer = window.setTimeout(
          () => fail("控制台连接超时。会话清理完成后可重试连接。"),
          20000,
        );
        disposeRfb.current = () => {
          window.clearTimeout(handshakeTimer);
          thisClient.removeEventListener("connect", connected);
          thisClient.removeEventListener("disconnect", disconnected);
          thisClient.removeEventListener("securityfailure", securityFailure);
          thisClient.disconnect();
        };
      } catch {
        fail("无法建立控制台连接。请检查网络，待会话清理完成后重试。");
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(handshakeTimer);
      if (client && rfb.current === client) stopRfb();
    };
  }, [ownedId, attachable, closeSession, showTransport, stopRfb]);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === panel.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const touch = () => {
    const id = owned.current;
    if (!id || currentTransport.current !== "connected" || Date.now() - lastTouch.current < 30000)
      return;
    lastTouch.current = Date.now();
    void api(`${sessionUrl(id)}/touch`, { method: "POST" }).catch(() => undefined);
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === panel.current) await document.exitFullscreen();
      else await panel.current?.requestFullscreen();
    } catch {
      setError("当前浏览器无法进入全屏模式，请使用适应窗口。");
    }
  };

  if (resource.loading) return <LoadingState label="正在加载实例…" />;
  if (!instance)
    return <ErrorState message={resource.error || "未找到此实例。"} retry={resource.reload} />;
  const active = isActive(session);
  const occupied = active && session?.id !== ownedId;
  const connected = transport === "connected" && ownedId === session?.id && active && !closing;
  const stateText = session?.cleanupPending
    ? "等待清理"
    : closing
      ? "正在断开"
      : creating
        ? "正在准备"
        : connected
          ? "已连接"
          : transport === "connecting" && active
            ? "正在连接画面"
            : session
              ? stateLabels[session.state]
              : "未连接";
  const canConnect = loaded && !fetchError && !active && !creating && !closing && !terminated;
  const placeholder = occupied
    ? "已有控制台会话正在使用"
    : session?.cleanupPending
      ? "正在回收控制台资源"
      : creating || session?.state === "preparing"
        ? "正在准备控制台"
        : transport === "connecting" && active
          ? "正在连接远程画面"
          : "连接到实例控制台";

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href="/instances">实例</Link>
            <ChevronRight size={12} />
            <Link href={`/instances/${encodeURIComponent(instanceId)}`}>
              {instance.displayName}
            </Link>
            <ChevronRight size={12} />
            <span>VNC 控制台</span>
          </>
        }
        title={
          <>
            {instance.displayName}
            <Status value={instance.state} />
          </>
        }
        description={
          <>
            <RegionLabel region={instance.region} /> · {instance.accountName} · VNC 控制台
          </>
        }
      >
        <Link href={`/instances/${encodeURIComponent(instanceId)}`} className="button">
          返回实例
        </Link>
      </PageHeader>
      <div className="console-notices">
        {terminated && <p className="console-notice">实例已终止或正在终止，无法连接控制台。</p>}
        {!terminated && instance.state !== "RUNNING" && (
          <p className="console-notice">
            实例当前未运行，控制台可能暂无画面。可在实例页启动后查看开机过程。
          </p>
        )}
        {occupied && (
          <p className="console-notice">
            全站同时只能使用一个 VNC 会话。当前会话：
            <strong>{session?.instanceName}</strong>
            。请先断开现有会话，再连接此实例。
          </p>
        )}
        {session?.cleanupPending && (
          <p className="console-notice">
            上一次会话尚未完成清理，暂时无法新建连接。可点击“重试断开”。
          </p>
        )}
        {fetchError && <ErrorState message={fetchError} retry={() => void refresh()} />}
        {error && <ErrorState message={error} />}
        {session?.lastError && session.lastError !== error && (
          <ErrorState message={session.lastError} />
        )}
      </div>
      <section className="console-panel" ref={panel} aria-label="VNC 控制台">
        <div className="console-toolbar">
          <div className="console-status" aria-live="polite" role="status">
            <Monitor size={17} />
            <Badge
              tone={
                connected
                  ? "success"
                  : session?.cleanupPending || session?.state === "failed"
                    ? "warning"
                    : "neutral"
              }
            >
              {stateText}
            </Badge>
          </div>
          <div className="console-actions">
            <Button
              disabled={!connected}
              onClick={() => {
                touch();
                rfb.current?.sendCtrlAltDel();
                rfb.current?.focus();
              }}
            >
              <Keyboard size={15} />
              Ctrl+Alt+Del
            </Button>
            <Button
              aria-pressed={fit}
              onClick={() => {
                const value = !fit;
                fitRef.current = value;
                setFit(value);
                if (rfb.current) rfb.current.scaleViewport = value;
              }}
            >
              适应窗口
            </Button>
            <Button
              onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? "退出全屏" : "全屏"}
            >
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              <span>{fullscreen ? "退出全屏" : "全屏"}</span>
            </Button>
            {active ? (
              <Button
                disabled={creating}
                loading={closing}
                onClick={() => {
                  if (session) {
                    setError(null);
                    void closeSession(session.id);
                  }
                }}
              >
                <Unplug size={15} />
                {session?.cleanupPending ? "重试断开" : occupied ? "断开现有会话" : "断开"}
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!canConnect}
                loading={creating}
                onClick={() => void connect()}
              >
                <Plug size={15} />
                {session ? "重试连接" : "连接"}
              </Button>
            )}
          </div>
        </div>
        <div
          className="console-viewport"
          onPointerDown={touch}
          onPointerMove={touch}
          onKeyDownCapture={touch}
          onWheel={touch}
        >
          <div className="console-screen" ref={screen} aria-label="远程控制台画面" />
          {!connected && (
            <div className="console-placeholder">
              <Monitor size={34} />
              <h2>{placeholder}</h2>
              <p>
                {active || creating
                  ? "状态会自动更新。"
                  : "点击连接后创建安全会话，离开此页面将断开连接。"}
              </p>
            </div>
          )}
        </div>
        <div className="console-footer">
          <span>全站限一个会话 · 长时间无操作将自动断开</span>
          <span>
            {active && session
              ? `会话到期 ${formatDate(session.expiresAt, true)}`
              : "点击远程画面后可使用键盘"}
          </span>
        </div>
      </section>
    </>
  );
}
