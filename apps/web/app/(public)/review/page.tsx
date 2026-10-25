import { redirect } from 'next/navigation';

/** The review service's GitHub setup callback redirects to `$CONSOLE_URL/review?linked=<id>`. */
export default async function ReviewAlias({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const linked = typeof sp.linked === 'string' && /^\d+$/.test(sp.linked) ? sp.linked : null;
  redirect(linked ? `/console/review?linked=${linked}` : '/console/review');
}
