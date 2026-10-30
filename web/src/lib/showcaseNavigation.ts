export function showcaseHomePath(pathname: string): '/' | '/ui-showcase' {
  return pathname === '/ui-showcase' || pathname.startsWith('/ui-showcase/')
    ? '/ui-showcase'
    : '/'
}
