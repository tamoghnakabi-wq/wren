'use client';

import { Skeleton } from '../ui';

// The task page's loading state: shown by the page while its task loads, and by the route's loading.tsx while
// the page itself is on its way (a task opened from a list isn't prefetched whole).

export function SessionSkeleton() {
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden" aria-busy="true">
      <div className="flex items-center gap-3 border-b border-border px-3 py-3 sm:px-5">
        <Skeleton className="h-7 w-7 rounded-lg" />
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-1/2 max-w-xs" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl flex-1 px-3 py-6 sm:px-6">
        <TimelineSkeleton />
      </div>
    </div>
  );
}

export function TimelineSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading activity">
      <div className="flex justify-end">
        <Skeleton className="h-11 w-2/3 rounded-[20px]" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
