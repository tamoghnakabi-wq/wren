import { Fragment } from 'react';

/**
 * Text from step, approval and notification titles ("Run `ls -la`"): the backtick spans show as
 * inline code instead of literal backticks.
 */
export function CodeText({ text }: { text: string }) {
  const parts = text.split(/`([^`\n]+)`/);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <code key={i} className="rounded bg-bg-subtle px-1 py-px font-mono text-[0.9em]">
            {p}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
