import { SiteFooter, SiteNav } from '@/components/site';

export const metadata = { title: 'Terms & privacy' };

export default function LegalPage() {
  return (
    <div>
      <SiteNav />
      <main className="prose-wren mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <h1 className="font-display text-[40px] leading-tight tracking-tight">Terms & privacy</h1>
        <p className="text-muted">Plain-language summary for this Wren instance. Wren is open-source software (MIT licence).</p>
        <h2>What Wren does with your data</h2>
        <ul>
          <li>Your agents, tasks, task history, files and settings are stored in this instance’s database and private file storage so you can see them on every device.</li>
          <li>Task content is sent to the model provider you choose for each agent (OpenAI, Anthropic, xAI, Vercel AI Gateway, or a local model on your computer) to do the work.</li>
          <li>API keys you add are encrypted at rest and only used to call that provider for your agents.</li>
          <li>ChatGPT, Claude Code and Grok Build sign-ins happen on your own computer through those providers’ official flows. Their credentials stay on your computer; Wren’s servers never receive them.</li>
          <li>Push notification subscriptions are stored so we can notify you; you can turn them off in Settings.</li>
          <li>Deleting your account removes your agents, tasks, files, connections and linked devices.</li>
        </ul>
        <h2>Your responsibilities</h2>
        <ul>
          <li>Agents act on your behalf. Review approval requests carefully and only allow actions you would take yourself.</li>
          <li>Use Wren in line with your model providers’ terms and usage policies (for example OpenAI’s, Anthropic’s and xAI’s).</li>
          <li>Don’t use Wren to break laws, harm others, or access systems you aren’t authorised to use.</li>
        </ul>
        <h2>No warranty</h2>
        <p>Wren is provided “as is”, without warranty of any kind. AI agents can make mistakes; verify important results.</p>
        <h2>Contact</h2>
        <p>
          Questions: open an issue at <a href="https://github.com/tamoghnakabi-wq/wren">github.com/tamoghnakabi-wq/wren</a>.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
