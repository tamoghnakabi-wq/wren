import { PageSkeleton } from '@/components/app/page-skeleton';

// Shown the moment an app page is opened while the page is still on its way (every app page is dynamic, so only
// what's above this is prefetched for an ordinary link; the sidebar's links prefetch everything).
export default function Loading() {
  return <PageSkeleton />;
}
