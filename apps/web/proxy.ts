import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'minh_session';
const PROTECTED = ['/console', '/billing', '/review'];

/**
 * Cheap pre-routing: bounce signed-out visitors of console pages to /login
 * (keeping where they wanted to go), and pass the current path to server
 * components (layouts can't read it otherwise). The session itself is
 * validated against the database in the console layout.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const path = `${pathname}${search}`;

  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isProtected && !request.cookies.get(SESSION_COOKIE)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(url);
  }

  const headers = new Headers(request.headers);
  headers.set('x-pathname', path);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)'],
};
