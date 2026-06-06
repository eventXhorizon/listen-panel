import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

/// Reusable renderer for LLM-style sample answers. The seed JSON and the
/// generation prompt both produce markdown — bold for sub-headers, fenced
/// code blocks for snippets, dash lists for enumerations, ASCII boxes inside
/// code blocks for diagrams — so we route the text through react-markdown
/// with a small component map tuned for the existing design tokens.
interface Props {
  text: string;
  /// 'foreground' for primary answers, 'muted' for secondary commentary
  /// (Chinese summary, follow-ups, etc.).
  tone?: 'foreground' | 'muted';
  className?: string;
}

function AnswerMarkdownImpl({ text, tone = 'foreground', className }: Props) {
  const baseColor =
    tone === 'foreground' ? 'text-foreground' : 'text-muted-foreground';
  return (
    <div
      className={cn(
        'text-sm leading-relaxed space-y-3 [&_p]:my-0 [&_p+p]:mt-3',
        baseColor,
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className: cls, children, ...props }) => {
            // react-markdown 9 routes both inline and block to `code`; the
            // surrounding `pre` distinguishes them. We detect via className
            // (block code has `language-*`) and the presence of newlines.
            const content = String(children ?? '');
            const isBlock = /\n/.test(content) || /language-/.test(cls ?? '');
            if (isBlock) {
              return (
                <code className={cn(cls, 'font-mono')} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-md border border-border bg-muted/60 p-3 text-[0.85em] leading-snug">
              {children}
            </pre>
          ),
          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc space-y-1 marker:text-muted-foreground/60">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1 marker:text-muted-foreground/60">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          h1: ({ children }) => (
            <h4 className="mt-4 text-base font-semibold text-foreground">
              {children}
            </h4>
          ),
          h2: ({ children }) => (
            <h4 className="mt-4 text-base font-semibold text-foreground">
              {children}
            </h4>
          ),
          h3: ({ children }) => (
            <h5 className="mt-3 text-sm font-semibold text-foreground">
              {children}
            </h5>
          ),
          h4: ({ children }) => (
            <h5 className="mt-3 text-sm font-semibold text-foreground">
              {children}
            </h5>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const AnswerMarkdown = memo(AnswerMarkdownImpl);
