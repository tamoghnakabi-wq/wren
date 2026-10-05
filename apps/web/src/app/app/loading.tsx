import { Skeleton, SkeletonList } from '@/components/ui';

/** Shown inside the app shell while a page loads. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="mt-2 mb-6 h-4 w-80 max-w-full" />
      <SkeletonList rows={5} />
    </div>
  );
}
