'use client';

import { Skeleton, SkeletonList } from '../ui';

/**
 * An app page on its way (app/app/loading.tsx): its title and a list, where every page has them, so a click on
 * a link the app hasn't fetched yet moves at once instead of waiting for the server.
 */
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="mb-6 space-y-2.5 pt-1">
        <Skeleton className="h-8 w-44 rounded-lg" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <SkeletonList rows={4} />
    </div>
  );
}
