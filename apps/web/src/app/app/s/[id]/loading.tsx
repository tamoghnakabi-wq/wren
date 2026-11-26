import { SessionSkeleton } from '@/components/app/task-skeleton';

// A task opened from a list moves at once to its shape while the page arrives.
export default function Loading() {
  return <SessionSkeleton />;
}
