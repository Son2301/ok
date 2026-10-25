import { Skeleton } from '@/components/ui';

/** Instant feedback while a console page's data loads; same footprint as a typical page (no layout jump). */
export default function ConsoleLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-9 w-48" />
          <Skeleton className="mt-4 h-4 w-64 max-w-full" />
        </div>
        <div className="rounded-xl border border-line bg-surface p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-3 w-full" />
          <Skeleton className="mt-3 h-3 w-5/6" />
          <Skeleton className="mt-3 h-3 w-2/3" />
        </div>
      </div>
      <div className="mt-6 rounded-xl border border-line bg-surface p-5">
        <Skeleton className="h-4 w-40" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="mt-4 h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
