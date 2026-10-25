import { NextResponse } from 'next/server';
import { platform } from '@/lib/platform';
import { gatewayApi } from '@/lib/services';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Poll a top-up's status (the browser never talks to the gateway directly). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: { code: 'unauthorized', message: 'Sign in' } }, { status: 401 });
  const { id } = await ctx.params;
  const res = await gatewayApi.topup(session.org.id, id);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.error.status || 503 });
  }
  let balanceMicros: number | null = null;
  if (res.data.status === 'paid') {
    balanceMicros = await platform()
      .then(({ core }) => core.getBalance(session.org.id))
      .catch(() => null);
  }
  return NextResponse.json({ topup: res.data, balanceMicros }, { headers: { 'cache-control': 'no-store' } });
}
