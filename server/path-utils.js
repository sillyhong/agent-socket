export const APP_BASE_PATH = "/agent-socket";

export function normalizeAppPath(pathname) {
  if (pathname === APP_BASE_PATH) {
    return { pathname: "/", redirectTo: `${APP_BASE_PATH}/` };
  }

  if (pathname.startsWith(`${APP_BASE_PATH}/`)) {
    return {
      pathname: pathname.slice(APP_BASE_PATH.length) || "/",
      redirectTo: null
    };
  }

  return { pathname, redirectTo: null };
}

export function isSupportedWebSocketPath(pathname) {
  return pathname === "/ws" || pathname === `${APP_BASE_PATH}/ws`;
}
