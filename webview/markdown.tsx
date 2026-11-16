import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** Agent text is untrusted: render it as markdown and strip anything active. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    // Nothing that styles the panel, asks for input or sends a form.
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'option'],
    FORBID_ATTR: ['style'],
  });
}

export function Markdown({ text }: { text: string }) {
  return <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
