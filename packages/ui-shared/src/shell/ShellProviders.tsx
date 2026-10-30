// 应用壳的"无 DOM"部分：公共配置、标注平台登录态、专注模式三个 Context，
// 以及它们的探测逻辑和登录弹窗。消费者端（web/）和评测工作台（admin/）都用它；
// 顶栏导航、MCP 说明等只属于评测工作台的 chrome 在 admin/src/AppShell.tsx。
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fetchPublicConfig, PublicConfigContext, type PublicConfigState } from "../lib/config";
import type { AnnotationUser } from "../annotationV2";


export type ShellSection = "workspace" | "results" | "annotation" | "showcase";

type AnnotationFocusModeValue = {
  focusMode: boolean;
  setFocusMode: (focusMode: boolean) => void;
};

type AnnotationIdentityValue = {
  user: AnnotationUser | null;
  loading: boolean;
  requestLogin: () => void;
};

export type ShellStateValue = {
  pathname: string;
  section: ShellSection;
  configState: PublicConfigState;
  annotationUser: AnnotationUser | null;
  setAnnotationUser: (user: AnnotationUser | null) => void;
  annotationUserLoading: boolean;
  focusMode: boolean;
  setFocusMode: (focusMode: boolean) => void;
  openLogin: () => void;
};

const AnnotationFocusModeContext = createContext<AnnotationFocusModeValue>({
  focusMode: false,
  setFocusMode: () => undefined,
});

const AnnotationIdentityContext = createContext<AnnotationIdentityValue>({
  user: null,
  loading: true,
  requestLogin: () => undefined,
});

const ShellStateContext = createContext<ShellStateValue | null>(null);

export function useAnnotationFocusMode() {
  return useContext(AnnotationFocusModeContext);
}

export function useAnnotationIdentity() {
  return useContext(AnnotationIdentityContext);
}

// 给壳 chrome（admin 顶栏）用：拿到登录态与专注模式的读写。
export function useShellState() {
  const value = useContext(ShellStateContext);
  if (!value) throw new Error("useShellState must be used inside <ShellProviders>");
  return value;
}

export function normalizeShellPath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

export function sectionForPath(pathname: string): ShellSection {
  if (
    pathname === "/" ||
    pathname === "/s" ||
    pathname.startsWith("/s/") ||
    pathname === "/history" ||
    pathname.startsWith("/history/") ||
    pathname.startsWith("/ui-showcase")
  ) {
    return "showcase";
  }
  if (pathname.startsWith("/admin/results")) return "results";
  // 用户反馈管理页挂在结果比较分组下（路径为 /admin/feedbacks）。
  if (pathname.startsWith("/admin/feedbacks")) return "results";
  if (pathname.startsWith("/admin/annotation")) return "annotation";
  return "workspace";
}

export const annotationLoginPath = "/admin/annotation/login";

export default function ShellProviders({
  children,
  pathname: pathnameProp,
  section: sectionProp,
}: {
  children: ReactNode;
  pathname?: string;
  section?: ShellSection;
}) {
  const pathname = normalizeShellPath(pathnameProp ?? window.location.pathname);
  const section = sectionProp ?? sectionForPath(pathname);
  const [configState, setConfigState] = useState<PublicConfigState>({
    config: null,
    loadFailed: false,
  });
  const [annotationUser, setAnnotationUser] = useState<AnnotationUser | null>(null);
  const [annotationUserLoading, setAnnotationUserLoading] = useState(
    section === "annotation" && pathname !== annotationLoginPath,
  );
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchPublicConfig({ signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setConfigState({ config: next, loadFailed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setConfigState({ config: null, loadFailed: true });
      });
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => { setAnnotationUserLoading(false); setAnnotationUser(null); }, []);

  useEffect(() => {
    if (!focusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocusMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusMode]);

  const focusModeValue = useMemo(() => ({ focusMode, setFocusMode }), [focusMode]);
  const identityValue = useMemo(
    () => ({
      user: annotationUser,
      loading: annotationUserLoading,
      requestLogin: () => setLoginDialogOpen(true),
    }),
    [annotationUser, annotationUserLoading],
  );
  const shellState = useMemo<ShellStateValue>(
    () => ({
      pathname,
      section,
      configState,
      annotationUser,
      setAnnotationUser,
      annotationUserLoading,
      focusMode,
      setFocusMode,
      openLogin: () => setLoginDialogOpen(true),
    }),
    [pathname, section, configState, annotationUser, annotationUserLoading, focusMode],
  );

  return (
    <PublicConfigContext.Provider value={configState}>
      <AnnotationFocusModeContext.Provider value={focusModeValue}>
        <AnnotationIdentityContext.Provider value={identityValue}>
          <ShellStateContext.Provider value={shellState}>
            {children}
          </ShellStateContext.Provider>
        </AnnotationIdentityContext.Provider>
      </AnnotationFocusModeContext.Provider>
    </PublicConfigContext.Provider>
  );
}
